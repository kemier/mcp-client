import { Readable, Writable } from 'stream';
import { ProcessManager } from './ProcessManager';
import { StdioConfig, ModelRequest, ModelResponse, ServerConfig, ServerStatus, ServerStatusEvent, CapabilityManifest, ServerCapability } from '../models/Types';
import { ProcessHandle, ProcessInputStream } from '../types/ProcessTypes';
import { isProcessHandle, ProcessLogger } from '../utils/ProcessUtils';
import { LogManager } from '../utils/LogManager';
import * as cp from 'child_process';
import { EventEmitter } from 'events';
import { logDebug, logError, logInfo, logWarning, getErrorMessage } from '../utils/logger';
import * as vscode from 'vscode';
import { ConfigStorage } from './ConfigStorage';

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
    private process: cp.ChildProcess | null = null;
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
    private stdoutBuffer: string = ''; // Added buffer instance variable
    private lastRequestTime: number = 0;
    private startTime: number = Date.now();
    private heartbeatTimer?: NodeJS.Timeout;
    private lastHeartbeat: number = 0;
    private availableModels: string[] = [];
    private capabilityNegotiationTimer?: NodeJS.Timeout;
    private capabilityManifest?: CapabilityManifest;
    private capabilitiesAttempted: boolean = false;

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
            env: { ...process.env, ...this.config.env }, // Merge environment variables
            stdio: ['pipe', 'pipe', 'pipe'] // Ensure pipes for stdin, stdout, stderr
        };

        try {
            this.processStartTime = Date.now();
            this.process = cp.spawn(this.config.command, this.config.args || [], options);
            logInfo(`[StdioServer-${this.serverId}] Process spawned with PID: ${this.process.pid}`);

            this.process.stdout?.on('data', (data) => {
                const message = data.toString();
                logDebug(`[StdioServer-${this.serverId}][stdout] Received chunk: ${message.length} bytes`);
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
                logDebug(`[StdioServer-${this.serverId}] Process started, initiating capability negotiation.`);
                this.beginCapabilityNegotiation();
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
        if (this.isDisposed) return; // Ignore data if disposed

        this.stdoutBuffer += dataChunk; // Append the incoming string chunk
        LogManager.debug('StdioServer', `[${this.serverId}] Received stdout chunk, buffer size: ${this.stdoutBuffer.length}`);

        let lines = this.stdoutBuffer.split(/\r?\n/);
        this.stdoutBuffer = lines.pop() || ''; // Keep incomplete line

        if (lines.length > 0) {
          LogManager.debug('StdioServer', `[${this.serverId}] Processing ${lines.length} complete line(s) from buffer`);

          for (const line of lines) {
              if (!line.trim()) {
                  LogManager.debug('StdioServer', `[${this.serverId}] Skipping empty line.`);
                  continue;
              }

              LogManager.debug('StdioServer', `[${this.serverId}] Attempting to parse line`, { line: line.trim() });

              try {
                  const message = JSON.parse(line.trim());
                  LogManager.debug('StdioServer', `[${this.serverId}] Successfully parsed JSON`, { message });

                  // --- Response Handling ---
                  if (message.id && this.responseQueue.has(message.id)) {
                      const requestInfo = this.responseQueue.get(message.id)!;
                      clearTimeout(requestInfo.timer);
                      this.responseQueue.delete(message.id);
                      const elapsedTime = Date.now() - (requestInfo.timestamp || Date.now());
                      LogManager.debug('StdioServer', `[${this.serverId}] Matched response for request ${message.id}`, { response: message, elapsedMs: elapsedTime });
                      if (typeof requestInfo.resolve === 'function') {
                           requestInfo.resolve(message);
                      } else {
                           LogManager.warn('StdioServer', `[${this.serverId}] No resolver found for request ID ${message.id}`);
                      }
                  }
                  // --- Heartbeat Handling ---
                  else if (message.type === 'heartbeat') {
                      const wasReady = this.isReady;
                      this.lastHeartbeat = Date.now();
                      // Don't set status directly, rely on the fact that we received data
                      // If it was connecting, the stdout handler already set it to connected
                      if (this.status === ServerStatus.Connecting) {
                         this.setStatus(ServerStatus.Connected); // Ensure connected if first message is heartbeat
                      }
                      this.availableModels = message.models || this.availableModels;

                      if (!wasReady && this.isReady) { // Check if status *changed* to ready
                          LogManager.info('StdioServer', `[${this.serverId}] Heartbeat received, server (re)connected.`);
                          this.emit('statusChange', { // Emit a more specific event if needed
                              serverId: this.serverId,
                              status: ServerStatus.Connected,
                              pid: this.process?.pid,
                              models: this.availableModels
                          });
                      } else {
                           LogManager.debug('StdioServer', `[${this.serverId}] Heartbeat received (server status: ${this.status})`);
                      }
                  }
                  // --- Capability Response Handling ---
                  else if (message.type === 'capability_response') {
                      this.handleCapabilityResponse(message);
                      continue; // Skip the rest of the loop iteration
                  }
                  // --- Other Message Types ---
                  else {
                       LogManager.warn('StdioServer', `[${this.serverId}] Received unhandled/unmatched message`, { message });
                       // Optionally emit as generic data
                       this.emit('data', message);
                  }

              } catch (parseError) {
                  LogManager.warn('StdioServer', `[${this.serverId}] JSON parsing failed for line`, { line: line.trim(), error: parseError instanceof Error ? parseError.message : String(parseError) });
                  // Emit raw line if parsing fails?
                  // this.emit('data', line.trim());
              }
          } // End for loop over lines
        }
        // Check buffer size (moved from old handler)
        if (this.stdoutBuffer.length > 1024 * 100) { // Increased buffer limit
            logWarning(`[StdioServer-${this.serverId}] Stdout buffer exceeds 100KB without newline. Potential issue? Buffer size: ${this.stdoutBuffer.length}. Clearing buffer.`);
            this.stdoutBuffer = ''; // Clear buffer to prevent memory leak
            this.emit('error', new Error("Stdout buffer exceeded limit"));
            this.setStatus(ServerStatus.Error);
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
        this.isDisposed = true; // Mark as disposed immediately
        LogManager.info('StdioServer', `[${this.serverId}] Disposing server instance.`);

        // 1. Clear Timers
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
            LogManager.debug('StdioServer', `[${this.serverId}] Cleared heartbeat timer.`);
        }
        // Clear any pending response timeouts
        this.responseQueue.forEach((requestInfo, requestId) => {
            clearTimeout(requestInfo.timer);
            // Check if reject exists before calling
            if (typeof requestInfo.reject === 'function') {
                 requestInfo.reject(new Error(`Server ${this.serverId} is disposing.`)); // Reject pending requests
            }
             LogManager.debug('StdioServer', `[${this.serverId}] Cleared timer and rejected request ${requestId}`);
        });
        this.responseQueue.clear();
        LogManager.debug('StdioServer', `[${this.serverId}] Cleared response queue timers and rejected pending requests.`);


        // 2. Remove Listeners & Kill Process
        if (this.process) {
            const pid = this.process.pid;
            LogManager.debug('StdioServer', `[${this.serverId}] Removing process listeners and attempting to kill PID: ${pid}`);
            // Remove specific listeners added by this class
            this.process.stdout?.removeAllListeners('data');
            this.process.stderr?.removeAllListeners('data');
            this.process.removeAllListeners('error');
            this.process.removeAllListeners('close');
            this.process.removeAllListeners('exit'); // Add exit listener removal

            // Attempt to kill the process
            if (pid && !this.process.killed) {
                try {
                    // Use tree-kill or specific platform commands if necessary for stubborn processes
                    const killed = this.process.kill('SIGTERM'); // Try graceful termination first
                    LogManager.debug('StdioServer', `[${this.serverId} PID: ${pid}] process.kill('SIGTERM') called, result: ${killed}`);
                    // Optionally, add a timeout and force kill (SIGKILL) if SIGTERM doesn't work
                    setTimeout(() => {
                        // Check process again in case it exited quickly
                        if (this.process && this.process.pid === pid && !this.process.killed) {
                            LogManager.warn('StdioServer', `[${this.serverId} PID: ${pid}] Process did not exit after SIGTERM, sending SIGKILL.`);
                            this.process.kill('SIGKILL');
                        }
                    }, 1000); // Wait 1 second before force killing
                } catch (error) {
                    LogManager.error('StdioServer', `[${this.serverId}] Error attempting to kill process PID ${pid}`, error);
                }
            }
            this.process = null; // Clear the reference
        } else {
             LogManager.debug('StdioServer', `[${this.serverId}] No process associated or already null during dispose.`);
        }

        // 3. Clear internal state
        this.setStatus(ServerStatus.Disconnected);
        this.stdoutBuffer = '';
        try {
            this.removeAllListeners(); // Remove listeners added via this.on()
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
            // Emit the status event expected by ServerManager
            this.emit('status', {
                serverId: this.serverId,
                status: newStatus, // The new status enum value
                pid: this.process?.pid,
                models: this.availableModels, // Include models if available
                error: newStatus === ServerStatus.Error ? 'Server Error' : undefined // Provide generic error if needed
            } satisfies ServerStatusEvent); // Ensure it satisfies the type
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
            type: 'capability_request',
            client: 'mcp-client',
            version: '1.0.0',
            timestamp: Date.now()
        };
    }

    private beginCapabilityNegotiation(): void {
        if (this.isDisposed || !this.process || this.capabilitiesAttempted) {
            return;
        }
        
        this.capabilitiesAttempted = true;
        LogManager.info('StdioServer', `[${this.serverId}] Beginning capability negotiation.`);
        
        const capabilityRequest = this.getCapabilityRequestPayload();
        
        try {
            // Send the request
            this.sendMessage(capabilityRequest as ModelRequest).catch(err => {
                LogManager.error('StdioServer', `[${this.serverId}] Failed to send capability request: ${err.message}`);
            });
            
            // Set timeout for capability response
            this.capabilityNegotiationTimer = setTimeout(() => {
                LogManager.warn('StdioServer', `[${this.serverId}] Capability negotiation timed out.`);
                // Proceed anyway, assuming basic capabilities
                this.finalizeConnection();
            }, 5000); // 5 second timeout
        } catch (error) {
            LogManager.error('StdioServer', `[${this.serverId}] Error during capability negotiation: ${getErrorMessage(error)}`);
            this.finalizeConnection(); // Proceed with connection anyway
        }
    }

    private handleCapabilityResponse(message: any): void {
        if (this.capabilityNegotiationTimer) {
            clearTimeout(this.capabilityNegotiationTimer);
            this.capabilityNegotiationTimer = undefined;
        }
        
        LogManager.info('StdioServer', `[${this.serverId}] Received capability response message:`, message); // Log raw message

        try {
            const capabilities: CapabilityManifest = {
                models: message.models || [],
                capabilities: message.capabilities || [],
                contextTypes: message.contextTypes || ['text'],
                discoveredAt: Date.now()
            };
            
            LogManager.debug('StdioServer', `[${this.serverId}] Parsed capabilities object:`, capabilities); // Log parsed object

            // Store the capability information
            this.capabilityManifest = capabilities;
            this.availableModels = capabilities.models;
            
            // Save to persistent storage
            ConfigStorage.getInstance().storeServerCapabilities(this.serverId, capabilities)
                .catch(err => logError(`[StdioServer-${this.serverId}] Failed to store capabilities: ${err.message}`));
            
            // Emit an event for the new capabilities
            this.emit('capabilities', {
                serverId: this.serverId,
                capabilities: capabilities
            });
            
            LogManager.debug('StdioServer', `[${this.serverId}] Emitting capabilities event...`); // Log before emitting
            this.emit('capabilities', {
                serverId: this.serverId,
                capabilities: capabilities
            });
            
            logInfo(`[StdioServer-${this.serverId}] Capability negotiation complete. Models: ${capabilities.models.join(', ')}`);
        } catch (error) {
            logError(`[StdioServer-${this.serverId}] Error processing capability response: ${getErrorMessage(error)}`);
        }
        
        // Finalize the connection
        this.finalizeConnection();
    }

    private finalizeConnection(): void {
        if (this.status === ServerStatus.Connecting) {
            this.setStatus(ServerStatus.Connected);
            logInfo(`[StdioServer-${this.serverId}] Server connection finalized.`);
        }
    }

    /**
     * Request the server to send its capabilities again.
     */
    public async refreshCapabilities(): Promise<void> {
        if (!this.isReady) {
            const message = `Cannot refresh capabilities: Server ${this.serverId} is not connected.`;
            LogManager.warn('StdioServer', `[${this.serverId}] ${message}`);
            throw new Error(message);
        }

        LogManager.info('StdioServer', `[${this.serverId}] Sending capability refresh request.`);
        const capabilityRequest = this.getCapabilityRequestPayload();

        try {
            await this.sendMessage(capabilityRequest as ModelRequest);
            LogManager.debug('StdioServer', `[${this.serverId}] Capability refresh request sent.`);
        } catch (error) {
            const errorMessage = getErrorMessage(error);
            LogManager.error('StdioServer', `[${this.serverId}] Failed to send capability refresh request: ${errorMessage}`);
            throw error;
        }
    }

    /**
     * Get the status of the server
     */
    public getStatus(): ServerStatus {
        return this.status;
    }
}