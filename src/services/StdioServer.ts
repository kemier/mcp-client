import { Readable, Writable } from 'stream';
import { ProcessManager } from './ProcessManager';
import { StdioConfig, ModelRequest, ModelResponse, ServerConfig, ServerStatus, ServerStatusEvent } from '../models/Types';
import { ProcessHandle, ProcessInputStream } from '../types/ProcessTypes';
import { isProcessHandle, ProcessLogger } from '../utils/ProcessUtils';
import { LogManager } from '../utils/LogManager';
import * as cp from 'child_process';
import { EventEmitter } from 'events';
import { logDebug, logError, logInfo, logWarning, getErrorMessage } from '../utils/logger';
import * as vscode from 'vscode';

/**
 * Interface for Server implementations
 */
export interface IServer {
    /**
     * Whether the server is ready to receive messages
     */
    isReady: boolean;
    
    /**
     * Start the server
     */
    start(): Promise<void>;
    
    /**
     * Send a message to the server
     * @param message The message to send (string or object)
     */
    send?(message: string | any): Promise<any>;
    
    /**
     * Send a message to the server (alternative method name)
     * @param message The message to send (string or object)
     */
    sendMessage?(message: string): Promise<void>;
    
    /**
     * Get information about the server process
     */
    getProcessInfo(): {pid: number, startTime?: number} | null;
    
    /**
     * Dispose of the server (stop it)
     */
    dispose(): void;
    
    /**
     * Event emitter interface
     */
    on(event: string, listener: (...args: any[]) => void): this;
    
    /**
     * Remove event listener
     */
    off?(event: string, listener: (...args: any[]) => void): this;
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
    private process: cp.ChildProcess | null = null;
    private processStartTime: number = 0;
    private buffer: string = "";
    private isDisposed: boolean = false;
    private readonly config: ServerConfig;
    public readonly serverId: string;
    private outputChannel: vscode.OutputChannel;
    private status: ServerStatus = ServerStatus.Disconnected;

    constructor(serverId: string, config: ServerConfig) {
        super();
        this.config = {...config, args: config.args || []};
        this.serverId = serverId;
        this.outputChannel = vscode.window.createOutputChannel(`MCP Server: ${serverId}`);
        
        this.outputChannel.appendLine(`[DEBUG] [StdioServer] [${serverId}] Created server instance with config: ${JSON.stringify(this.config)}`);
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
        if (this.process) {
            logWarning(`[StdioServer-${this.serverId}] Start called, but process already exists. Attempting to stop first.`);
            await this.dispose();
        }

        logInfo(`[StdioServer-${this.serverId}] Starting server process... Command: ${this.config.command}, Args: ${this.config.args.join(' ')}`);
        this.setStatus(ServerStatus.Connecting);

        const options: cp.SpawnOptions = {
            shell: this.config.shell,
            windowsHide: this.config.windowsHide,
            env: { ...process.env, ...this.config.env }, // Merge environment variables
            stdio: ['pipe', 'pipe', 'pipe'] // Ensure pipes for stdin, stdout, stderr
        };

        try {
            this.processStartTime = Date.now();
            this.process = cp.spawn(this.config.command, this.config.args, options);
            logInfo(`[StdioServer-${this.serverId}] Process spawned with PID: ${this.process.pid}`);

            this.process.stdout?.on('data', (data) => {
                const message = data.toString();
                logDebug(`[StdioServer-${this.serverId}][stdout] Received chunk: ${message.length} bytes`);
                if (this.status === ServerStatus.Connecting) {
                    this.setStatus(ServerStatus.Connected);
                }
                this.handleStdoutData(message);
            });

            this.process.stderr?.on('data', (data) => {
                const errorMessage = data.toString().trim();
                logError(`[StdioServer-${this.serverId}][stderr] ${errorMessage}`);
                this.emit('error', new Error(errorMessage));
            });

            this.process.on('error', (err) => {
                logError(`[StdioServer-${this.serverId}] Process error: ${err.message}`);
                this.setStatus(ServerStatus.Error);
                this.emit('error', err);
                this.cleanupProcess();
            });

            this.process.on('exit', (code, signal) => {
                logWarning(`[StdioServer-${this.serverId}] Process exited with code ${code}, signal ${signal}`);
                if (this.status !== ServerStatus.Disconnected && this.status !== ServerStatus.Error) {
                    this.setStatus(ServerStatus.Disconnected);
                }
                this.emit('exit', code, signal);
                this.cleanupProcess();
            });

            // Add a small delay to allow the process to potentially fail immediately
            await new Promise(resolve => setTimeout(resolve, 100));
            if (this.status === ServerStatus.Connecting) {
                logDebug(`[StdioServer-${this.serverId}] Process started, waiting for first output to confirm connection.`);
            }

        } catch (error) {
            logError(`[StdioServer-${this.serverId}] Failed to spawn process: ${getErrorMessage(error)}`);
            this.setStatus(ServerStatus.Error);
            this.emit('error', error instanceof Error ? error : new Error(String(error)));
            this.cleanupProcess();
            throw error; // Re-throw start error
        }
    }

    /**
     * Handle stdout data chunk from the process, processing line by line
     */
    private handleStdoutData(dataChunk: string): void {
        this.buffer += dataChunk;
        let newlineIndex;
        while ((newlineIndex = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.substring(0, newlineIndex).trim();
            this.buffer = this.buffer.substring(newlineIndex + 1);

            if (line) {
                logDebug(`[StdioServer-${this.serverId}][stdout process] Line: ${line}`);
                this.emit('data', line);
            } else {
                logDebug(`[StdioServer-${this.serverId}][stdout process] Empty line ignored.`);
            }
        }
        if (this.buffer.length > 1024 * 10) {
            logWarning(`[StdioServer-${this.serverId}] Stdout buffer exceeds 10KB without newline. Potential issue? Buffer size: ${this.buffer.length}`);
        }
    }

    /**
     * Send a message string to the server 
     */
    public async sendMessage(message: string): Promise<void> {
        if (!this.process || !this.process.stdin || this.process.stdin.destroyed) {
            logError(`[StdioServer-${this.serverId}] Cannot send message: Process not running or stdin not available.`);
            throw new Error(`Server ${this.serverId} is not running or stdin is closed.`);
        }
        if (this.status !== ServerStatus.Connected) { 
             logWarning(`[StdioServer-${this.serverId}] Attempting to send message while status is ${this.status}.`);
        }

        logDebug(`[StdioServer-${this.serverId}][stdin] Sending: ${message}`);
        try {
            const formattedMessage = message.endsWith('\n') ? message : message + '\n';
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
            return;
        }
        
        this.isDisposed = true;
        this.outputChannel.appendLine(`[INFO] [StdioServer] [${this.serverId}] Disposing server instance`);
        
        try {
            if (this.process) {
                const pid = this.process.pid;
                this.cleanupProcess();
                
                if (pid) {
                    try {
                        process.kill(pid, 0);
                        logWarning(`[StdioServer-${this.serverId}] Process ${pid} still exists after cleanup, attempting kill...`);
                        try {
                            process.kill(pid, 'SIGTERM');
                            setTimeout(() => {
                                try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); logWarning(`[StdioServer-${this.serverId}] Process ${pid} force killed (SIGKILL).`); }
                                catch(e) { /* Already exited after SIGTERM */ }
                            }, 1000);
                        } catch (killError) {
                            logError(`[StdioServer-${this.serverId}] Error sending kill signal to ${pid}: ${getErrorMessage(killError)}`);
                        }
                    } catch (e) {
                        logDebug(`[StdioServer-${this.serverId}] Process ${pid} likely exited during cleanup.`);
                    }
                }
                this.process = null;
            }
            
            // Clear other state
            this.buffer = "";
            
            this.outputChannel.appendLine(`[DEBUG] [StdioServer] [${this.serverId}] Server instance disposed`);
        } catch (error) {
            this.outputChannel.appendLine(`[ERROR] [StdioServer] [${this.serverId}] Error disposing server instance: ${error}`);
        }
    }

    private setStatus(newStatus: ServerStatus): void {
        if (this.status !== newStatus) {
            logInfo(`[StdioServer-${this.serverId}] Status changing from ${this.status} to ${newStatus}`);
            this.status = newStatus;
            this.emit('status', this.status);
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
}