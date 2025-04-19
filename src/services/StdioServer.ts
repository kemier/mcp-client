import { Readable, Writable } from 'stream';
import { ProcessManager } from './ProcessManager.js';
import { StdioConfig, ModelRequest, ModelResponse, ServerConfig, ServerStatus, ServerStatusEvent, CapabilityManifest, ServerCapability } from '../models/Types.js';
import { ProcessHandle, ProcessInputStream } from '../types/ProcessTypes.js';
import { isProcessHandle, ProcessLogger } from '../utils/ProcessUtils.js';
import { LogManager } from '../utils/LogManager.js';
import * as cp from 'child_process';
import { EventEmitter } from 'events';
import { logDebug, logError, logInfo, logWarning, getErrorMessage } from '../utils/logger.js';
import * as vscode from 'vscode';
import { ConfigStorage } from './ConfigStorage.js';
import spawn from 'cross-spawn';
import { ChildProcess } from 'node:child_process';

/**
 * Interface for Server implementations
 */
export interface IServer extends EventEmitter {
    /**
     * Whether the server is ready to receive messages
     */
    isReady: boolean;
    
    /**
     * Start the server
     */
    start(): Promise<void>;
    
    /**
     * Send a message request to the server
     * @param request The ModelRequest object to send
     * @returns A promise that resolves to the server's response string
     */
    sendMessage(request: ModelRequest): Promise<string>;
    
    /**
     * Get information about the server process
     */
    getProcessInfo(): {pid: number, startTime?: number} | null;
    
    /**
     * Dispose of the server (stop it)
     */
    dispose(): void;
    
    /**
     * Request the server to send its capabilities again.
     */
    refreshCapabilities(): Promise<void>;

    /**
     * Get the status of the server
     */
    getStatus(): ServerStatus;
}

export interface StdioServerConfig {
    command: string;
    args: string[];
    shell?: boolean;
    windowsHide?: boolean;
    heartbeat?: boolean;
    env?: Record<string, string>; // Add env to the interface
}

/**
 * Implementation of IServer using child_process stdio communication
 */
export class StdioServer extends EventEmitter implements IServer {
    private process: ChildProcess | null = null;
    private processStartTime: number = 0;
    private buffer: string = "";
    private isDisposed: boolean = false;
    private readonly config: ServerConfig;
    public readonly serverId: string;
    private outputChannel: vscode.OutputChannel;
    private status: ServerStatus = ServerStatus.Disconnected;
    private responseTimeout = 30000; // 30秒超时
    private responseQueue: Map<string, {
        resolve: (value: ModelResponse) => void;
        reject: (reason: any) => void;
        timer: NodeJS.Timeout;
        timestamp?: number;
    }> = new Map();
    private lastRequestTime: number = 0;
    private startTime: number = Date.now();
    private heartbeatTimer?: NodeJS.Timeout;
    private lastHeartbeat: number = 0;
    private availableModels: string[] = [];
    private capabilityNegotiationTimer?: NodeJS.Timeout;
    private capabilityManifest?: CapabilityManifest;
    private capabilitiesAttempted: boolean = false;
    private responseBuffer: string = '';
    private handleStdoutData: (data: Buffer | string) => void;
    private finalizeConnection: () => void;

    constructor(serverId: string, config: ServerConfig) {
        super();
        this.config = {...config, args: config.args || []};
        this.serverId = serverId;
        this.outputChannel = vscode.window.createOutputChannel(`MCP Server: ${serverId}`);
        
        this.outputChannel.appendLine(`[DEBUG] [StdioServer] [${serverId}] Created server instance with config: ${JSON.stringify(this.config)}`);

        this.handleStdoutData = (data: Buffer | string) => {
             logDebug(`[StdioServer-${this.serverId}][stdout] RAW DATA RECEIVED: ${data.toString()}`);
             this.responseBuffer += data.toString();

            let boundary = this.responseBuffer.indexOf('\n');
            while (boundary !== -1) {
                const messageStr = this.responseBuffer.substring(0, boundary).trim();
                this.responseBuffer = this.responseBuffer.substring(boundary + 1);

                if (messageStr) {
                    try {
                        const message = JSON.parse(messageStr);
                        logDebug(`[StdioServer-${this.serverId}][stdout] Parsed message:`, message);

                        if (message.type === 'capability_response' && this.status === ServerStatus.Connecting) {
                            this.handleCapabilityResponse(message);
                        } else {
                             this.emit('message', message);
                        }

                    } catch (error) {
                         logError(`[StdioServer-${this.serverId}][stdout] Error parsing JSON: ${getErrorMessage(error)} - Data: "${messageStr}"`);
                         this.emit('error', new Error(`Error parsing server message: ${getErrorMessage(error)}`));
                    }
                }
                boundary = this.responseBuffer.indexOf('\n');
            }
         };

         this.finalizeConnection = () => {
             if (this.capabilityNegotiationTimer) {
                 clearTimeout(this.capabilityNegotiationTimer);
                 this.capabilityNegotiationTimer = undefined;
             }
             if (this.status === ServerStatus.Connecting) {
                 logInfo(`[StdioServer-${this.serverId}] Finalizing connection. Status set to Connected.`);
                 this.setStatus(ServerStatus.Connected);
                 this.emit('capabilities', this.capabilityManifest || { models: [], capabilities: [], contextTypes: ['text'], discoveredAt: Date.now() });
             } else {
                 logWarning(`[StdioServer-${this.serverId}] finalizeConnection called, but status is ${this.status}. Not changing status.`);
             }
         };
    }

    /**
     * Get information about the process
     * @returns Process information or null if no process
     */
    public getProcessInfo(): { pid: number; startTime: number } | null {
        if (!this.process || !this.process.pid) {
            return null;
        }
        return { 
            pid: this.process.pid,
            startTime: this.processStartTime 
        };
    }

    /**
     * Get the ready state of the server
     */
    public get isReady(): boolean {
        return this.status === ServerStatus.Connected && !this.isDisposed;
    }

    /**
     * Start the server process
     */
    public async start(): Promise<void> {
        if (this.isDisposed) {
             throw new Error(`Server ${this.serverId} is disposed and cannot be started.`);
        }
        if (this.process) {
            logWarning(`[StdioServer-${this.serverId}] Start called, but process already exists. Attempting to stop first.`);
            await this.dispose();
        }

        logInfo(`[StdioServer-${this.serverId}] Starting server process... Command: ${this.config.command}, Args: ${this.config.args?.join(' ') || ''}`);
        this.setStatus(ServerStatus.Connecting);

        const options: cp.SpawnOptions = {
            shell: this.config.shell,
            windowsHide: this.config.windowsHide,
            env: { ...process.env, ...this.config.env },
            stdio: ['pipe', 'pipe', 'pipe']
        };

        try {
            this.processStartTime = Date.now();
            this.process = spawn(this.config.command, this.config.args || [], options);

            if (!this.process || !this.process.pid) {
                 logError(`[StdioServer-${this.serverId}] Failed to spawn process or get PID using cross-spawn.`);
                 throw new Error('Failed to spawn process or get PID.');
            }
             logInfo(`[StdioServer-${this.serverId}] Process spawned with PID: ${this.process.pid}`);

            if (!this.process.stdout || !this.process.stderr || !this.process.stdin) {
                 logError(`[StdioServer-${this.serverId}] Failed to get stdio streams from spawned process.`);
                 this.cleanupProcess();
                 throw new Error('Failed to get stdio streams from spawned process.');
            }

            this.process.stdout.setEncoding('utf8');
            this.process.stdout.on('data', this.handleStdoutData);

            this.process.stderr.setEncoding('utf8');
            this.process.stderr.on('data', (data) => {
                const errorMessage = data.toString().trim();
                logError(`[StdioServer-${this.serverId}][stderr] ${errorMessage}`);
                if (this.status === ServerStatus.Connecting) {
                    this.setStatus(ServerStatus.Error);
                    this.emit('error', new Error(`Server stderr during connection: ${errorMessage}`));
                    this.cleanupProcess();
                } else {
                    this.emit('error', new Error(`Server stderr: ${errorMessage}`));
                }
            });

            this.process.on('error', (err) => {
                logError(`[StdioServer-${this.serverId}] Process 'error' event: ${err.message}`);
                 this.setStatus(ServerStatus.Error);
                 this.emit('error', err);
                 this.cleanupProcess();
            });

            this.process.on('exit', (code, signal) => {
                logWarning(`[StdioServer-${this.serverId}] Process 'exit' event: code ${code}, signal ${signal}`);
                 if (this.status !== ServerStatus.Error && this.status !== ServerStatus.Disconnected) {
                     this.setStatus(ServerStatus.Disconnected);
                 }
                 this.emit('exit', code, signal);
                 this.cleanupProcess();
            });

            await new Promise(resolve => setTimeout(resolve, 150));

            if (this.status === ServerStatus.Connecting) {
                logDebug(`[StdioServer-${this.serverId}] Process seems stable after delay, initiating capability negotiation.`);
                this.beginCapabilityNegotiation();
            } else {
                 logWarning(`[StdioServer-${this.serverId}] Process status changed to ${this.status} immediately after spawn or during delay. Aborting capability negotiation.`);
            }

        } catch (error) {
             logError(`[StdioServer-${this.serverId}] Failed to spawn process: ${getErrorMessage(error)}`);
             if (this.status !== ServerStatus.Error) {
                this.setStatus(ServerStatus.Error);
             }
             this.emit('error', error instanceof Error ? error : new Error(String(error)));
             if (!this.process) {
                 this.cleanupProcess();
             }
             throw error;
        }
    }

    /**
     * Send a message request to the server
     * @param request The ModelRequest object to send
     * @returns A promise that resolves to the server's response string
     */
    public async sendMessage(request: ModelRequest): Promise<string> {
        if (!this.process || !this.process.stdin || this.process.stdin.destroyed) {
            logError(`[StdioServer-${this.serverId}] Cannot send message: Process not running or stdin not available.`);
            throw new Error(`Server ${this.serverId} is not running or stdin is closed.`);
        }
        if (this.status !== ServerStatus.Connected) { 
             logWarning(`[StdioServer-${this.serverId}] Attempting to send message while status is ${this.status}.`);
        }

        logDebug(`[StdioServer-${this.serverId}][stdin] Sending: ${JSON.stringify(request)}`);
        try {
            const formattedMessage = JSON.stringify(request) + '\n';
            await new Promise<void>((resolve, reject) => {
                this.process!.stdin!.write(formattedMessage, (err) => {
                    if (err) {
                        logError(`[StdioServer-${this.serverId}] Error writing to stdin: ${err.message}`);
                        this.setStatus(ServerStatus.Error); 
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            });
            return formattedMessage;
        } catch (error) {
            logError(`[StdioServer-${this.serverId}] Failed to send message: ${getErrorMessage(error)}`);
            this.setStatus(ServerStatus.Error); 
            this.emit('error', error instanceof Error ? error : new Error(String(error)));
            throw error;
        }
    }

    /**
     * Dispose of the server (clean up resources)
     */
    public dispose(): void {
        if (this.isDisposed) {
            LogManager.debug('StdioServer', `[${this.serverId}] Dispose called but already disposed.`);
            return;
        }
        this.isDisposed = true;
        LogManager.info('StdioServer', `[${this.serverId}] Disposing server instance.`);

        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
            LogManager.debug('StdioServer', `[${this.serverId}] Cleared heartbeat timer.`);
        }
        this.responseQueue.forEach((requestInfo, requestId) => {
            clearTimeout(requestInfo.timer);
            if (typeof requestInfo.reject === 'function') {
                 requestInfo.reject(new Error(`Server ${this.serverId} is disposing.`));
            }
             LogManager.debug('StdioServer', `[${this.serverId}] Cleared timer and rejected request ${requestId}`);
        });
        this.responseQueue.clear();
        LogManager.debug('StdioServer', `[${this.serverId}] Cleared response queue timers and rejected pending requests.`);

        if (this.process) {
            const pid = this.process.pid;
            LogManager.debug('StdioServer', `[${this.serverId}] Removing process listeners and attempting to kill PID: ${pid}`);
            this.process.stdout?.removeAllListeners('data');
            this.process.stderr?.removeAllListeners('data');
            this.process.removeAllListeners('error');
            this.process.removeAllListeners('close');
            this.process.removeAllListeners('exit');

            if (pid && !this.process.killed) {
                try {
                    const killed = this.process.kill('SIGTERM');
                    LogManager.debug('StdioServer', `[${this.serverId} PID: ${pid}] process.kill('SIGTERM') called, result: ${killed}`);
                    setTimeout(() => {
                        if (this.process && this.process.pid === pid && !this.process.killed) {
                            LogManager.warn('StdioServer', `[${this.serverId} PID: ${pid}] Process did not exit after SIGTERM, sending SIGKILL.`);
                            this.process.kill('SIGKILL');
                        }
                    }, 1000);
                } catch (error) {
                    LogManager.error('StdioServer', `[${this.serverId}] Error attempting to kill process PID ${pid}`, error);
                }
            }
            this.process = null;
        } else {
             LogManager.debug('StdioServer', `[${this.serverId}] No process associated or already null during dispose.`);
        }

        this.setStatus(ServerStatus.Disconnected);
        this.buffer = '';
        try {
            this.removeAllListeners();
        } catch(e) {
            LogManager.warn('StdioServer', `[${this.serverId}] Error removing listeners during dispose`, e);
        }

        LogManager.info('StdioServer', `[${this.serverId}] Disposal complete.`);
    }

    private setStatus(newStatus: ServerStatus): void {
        if (this.isDisposed && newStatus !== ServerStatus.Disconnected) {
            logDebug(`[StdioServer-${this.serverId}] Ignoring status change to ${newStatus} because server is disposed.`);
            return;
        }
        const oldStatus = this.status;
        if (oldStatus !== newStatus) {
            logInfo(`[StdioServer-${this.serverId}] Status changing from ${oldStatus} to ${newStatus}`);
            this.status = newStatus;
            this.emit('status', {
                serverId: this.serverId,
                status: newStatus,
                pid: this.process?.pid,
                models: this.availableModels,
                error: newStatus === ServerStatus.Error ? 'Server Error' : undefined
            } satisfies ServerStatusEvent);
        }
    }

    private cleanupProcess(): void {
        logDebug(`[StdioServer-${this.serverId}] Cleaning up process listeners and reference.`);
        if (this.process) {
            this.process.removeAllListeners();
            this.process.stdin?.removeAllListeners();
            this.process.stdout?.removeAllListeners();
            this.process.stderr?.removeAllListeners();
            if (this.process.stdin && !this.process.stdin.destroyed) {
                this.process.stdin.end();
            }
        }
        this.process = null;
    }

    private getCapabilityRequestPayload(): object {
        return {
            jsonrpc: "2.0",
            method: "mcp.getCapabilities",
            params: {
                client: {
                    name: 'mcp-client',
                    version: '1.0.0'
                }
            },
            id: `cap-${Date.now()}`
        };
    }

    private beginCapabilityNegotiation(): void {
        if (this.isDisposed || !this.process || this.capabilitiesAttempted) {
             logDebug(`[StdioServer-${this.serverId}] Skipping capability negotiation (disposed=${this.isDisposed}, no process=${!this.process}, attempted=${this.capabilitiesAttempted})`);
            return;
        }

        this.capabilitiesAttempted = true;
        logInfo(`[StdioServer-${this.serverId}] Beginning capability negotiation.`);

        const capabilityRequest = this.getCapabilityRequestPayload();

        try {
            this.sendMessage(capabilityRequest as ModelRequest).catch(err => {
                logError(`[StdioServer-${this.serverId}] Failed to send capability request: ${err.message}`);
            });

            if (this.capabilityNegotiationTimer) clearTimeout(this.capabilityNegotiationTimer);
            this.capabilityNegotiationTimer = setTimeout(() => {
                logWarning(`[StdioServer-${this.serverId}] Capability negotiation timed out after 30 seconds.`);
                if (this.status === ServerStatus.Connecting) {
                    this.finalizeConnection();
                }
                this.capabilityNegotiationTimer = undefined;
            }, 30000);
        } catch (error) {
            logError(`[StdioServer-${this.serverId}] Error initiating capability negotiation: ${getErrorMessage(error)}`);
             if (this.status === ServerStatus.Connecting) {
                 this.finalizeConnection();
             }
        }
    }

    private handleCapabilityResponse(message: any): void {
        if (this.capabilityNegotiationTimer) {
            clearTimeout(this.capabilityNegotiationTimer);
            this.capabilityNegotiationTimer = undefined;
        }
        logInfo(`[StdioServer-${this.serverId}] Received potential capability response:`, message);

        if (message.result && typeof message.result === 'object') {
            const result = message.result;
            try {
                this.capabilityManifest = {
                    models: result.models || [],
                    capabilities: result.capabilities || [],
                    contextTypes: result.contextTypes || ['text'],
                    discoveredAt: Date.now()
                };
                logInfo(`[StdioServer-${this.serverId}] Parsed capabilities: ${JSON.stringify(this.capabilityManifest.models)}`);

                this.finalizeConnection();

            } catch (error) {
                logError(`[StdioServer-${this.serverId}] Error parsing capability response content: ${getErrorMessage(error)}`);
                 if (this.status === ServerStatus.Connecting) {
                     this.finalizeConnection();
                 }
            }
        } else {
            logWarning(`[StdioServer-${this.serverId}] Received message during negotiation, but not a valid capability response format. ID: ${message.id}`);
              if (!this.capabilityNegotiationTimer && this.status === ServerStatus.Connecting) {
                  logWarning(`[StdioServer-${this.serverId}] Finalizing connection after unexpected message during negotiation.`);
                  this.finalizeConnection();
              }
         }
    }

    public getStatus(): ServerStatus {
        return this.status;
    }

    public async refreshCapabilities(): Promise<void> {
        if (!this.isReady) {
             logWarning(`[StdioServer-${this.serverId}] Cannot refresh capabilities, server not ready (status: ${this.status}).`);
             return;
        }
         logInfo(`[StdioServer-${this.serverId}] Refreshing capabilities...`);
         this.capabilitiesAttempted = false;
         this.beginCapabilityNegotiation();
    }
}