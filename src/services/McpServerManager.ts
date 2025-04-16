import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import { ServerStatus, ServerStatusEvent, ServerConfig, ModelRequest, ModelResponse } from '../models/Types';
import { StdioServer, IServer } from './StdioServer';
import * as cp from 'child_process';
import { logInfo, logError, logDebug, logWarning, getErrorMessage } from '../utils/logger';
import { ConfigStorage } from './ConfigStorage';
import { extensionContext } from '../extension';

// Hardcoded default is no longer the primary fallback, but might be kept for internal use if needed
// const hardcodedDefaultConfig: ServerConfig = { ... };

/**
 * Interface for server status change listeners
 */
export interface IServerStatusListener {
    statusChange(serverId: string, status: string): void;
}

/**
 * Manager for MCP Servers
 */
export class McpServerManager extends EventEmitter {
    private static instance: McpServerManager;
    private servers: Map<string, IServer> = new Map();
    // Map to store configurations entered dynamically during the session
    private dynamicConfigs: Map<string, ServerConfig> = new Map();
    private healthCheckIntervals: Map<string, NodeJS.Timeout> = new Map();
    
    // Track server warmup state and response times
    private _serverWarmedUp: Map<string, boolean> = new Map();
    private _lastServerResponseTime: Map<string, number> = new Map();
    private _serverPingAttempts: Map<string, number> = new Map();
    private _lastPurgeTime: number = 0;

    private statusListeners: IServerStatusListener[] = [];
    private statusUpdateTimeout: NodeJS.Timeout | null = null;
    private lastServerPingTimes: Map<string, number> = new Map();
    private serverResponseTimes: Map<string, number[]> = new Map();

    private configStorage: ConfigStorage;
    private serverStatuses: Map<string, ServerStatus> = new Map();
    private serverUptimes: Map<string, number> = new Map();

    private constructor(configStorage: ConfigStorage) {
        super();
        this.configStorage = configStorage;
    }

    public static getInstance(configStorage?: ConfigStorage): McpServerManager {
        if (!McpServerManager.instance) {
            if (!configStorage) {
                logError("[McpServerManager] getInstance called without configStorage during initial creation!");
                if (extensionContext) {
                     configStorage = ConfigStorage.getInstance(extensionContext);
                 } else {
                     throw new Error("McpServerManager requires ConfigStorage for initialization.");
                 }
            }
            McpServerManager.instance = new McpServerManager(configStorage);
        }
        return McpServerManager.instance;
    }

    /**
     * Register a status listener
     */
    public registerStatusListener(listener: IServerStatusListener): void {
        this.statusListeners.push(listener);
    }

    /**
     * Register a callback function to be called when server status changes
     */
    public addStatusCallback(callback: (serverId: string, status: string) => void): void {
        const adapter: IServerStatusListener = {
            statusChange: callback
        };
        
        this.registerStatusListener(adapter);
    }

    /**
     * Update the status of a server
     */
    private updateServerStatus(serverId: string, newStatus: ServerStatus, error?: string): void {
        const currentStatus = this.serverStatuses.get(serverId);
        if (currentStatus === newStatus && !(newStatus === ServerStatus.Error && error)) {
            return;
        }

        this.serverStatuses.set(serverId, newStatus);
        logInfo(`[ServerManager] [${serverId}] Status changed to: ${newStatus}`);

        if (newStatus === ServerStatus.Connected) {
            this.serverUptimes.set(serverId, Date.now());
        } else if (newStatus === ServerStatus.Disconnected || newStatus === ServerStatus.Error) {
            this.serverUptimes.delete(serverId);
        }

        const event: ServerStatusEvent = {
            serverId: serverId,
            status: newStatus,
            error: error,
            uptime: this.serverUptimes.get(serverId)
        };

        try {
            this.emit('status', event);
            this.notifyStatusListeners(serverId, newStatus);
        } catch (emitError) {
            logError(`[ServerManager] [${serverId}] Failed to emit status event: ${getErrorMessage(emitError)}`);
        }
    }

    /**
     * Notify all registered status listeners
     */
    private notifyStatusListeners(serverId: string, status: ServerStatus): void {
        for (const listener of this.statusListeners) {
            try {
                listener.statusChange(serverId, status.toString());
            } catch (error) {
                logError(`[ServerManager] Error in status listener: ${getErrorMessage(error)}`);
            }
        }
    }

    /**
     * Set a dynamic configuration explicitly (used when loading from ConfigStorage)
     */
    public setDynamicConfig(serverName: string, config: ServerConfig): void {
        logInfo(`[ServerManager] Setting dynamic configuration for ${serverName}: ${JSON.stringify(config)}`);
        this.dynamicConfigs.set(serverName, config);
    }

    /**
     * Load server configuration from settings or dynamic configs
     * Now focuses solely on loading, not prompting
     */
    public async loadServerConfig(serverName: string): Promise<ServerConfig> {
        logInfo(`[ServerManager] Loading configuration for server: ${serverName}`);

        const configSectionKey = 'mcpClient';
        const serversKey = 'servers';
        const mainConfig = vscode.workspace.getConfiguration(configSectionKey);
        const serversConfig = mainConfig.get<Record<string, ServerConfig>>(serversKey);

        if (serversConfig && typeof serversConfig === 'object' && serversConfig[serverName]) {
            const settingsConfig = serversConfig[serverName];
            logInfo(`[ServerManager] Found config for ${serverName} in VS Code settings.`);
            if (settingsConfig.command && typeof settingsConfig.command === 'string') {
                 settingsConfig.shell = settingsConfig.shell ?? true;
                 settingsConfig.windowsHide = settingsConfig.windowsHide ?? true;
                 settingsConfig.heartbeatEnabled = settingsConfig.heartbeatEnabled ?? false;
                 settingsConfig.args = settingsConfig.args ?? [];
                 settingsConfig.type = settingsConfig.type ?? 'stdio';
                 
                 if (settingsConfig.command.includes('python') && !settingsConfig.args.includes('-u')) {
                     logInfo(`[ServerManager] Detected Python command, adding -u flag for unbuffered mode`);
                     settingsConfig.args = ['-u', ...settingsConfig.args];
                 }
                 
                return settingsConfig;
            } else {
                 logWarning(`[ServerManager] Config for ${serverName} found in settings but missing 'command'. Proceeding to check dynamic configs.`);
            }
        } else {
             logInfo(`[ServerManager] Config for ${serverName} not found in VS Code settings.`);
        }

        if (this.dynamicConfigs.has(serverName)) {
            const dynamicConfig = this.dynamicConfigs.get(serverName)!;
            logInfo(`[ServerManager] Using dynamically stored configuration for ${serverName}.`);
            
            if (!dynamicConfig.args) {
                dynamicConfig.args = [];
            }
            
            if (dynamicConfig.command.includes('python') && !dynamicConfig.args.includes('-u')) {
                logInfo(`[ServerManager] Detected Python command in dynamic config, adding -u flag for unbuffered mode`);
                dynamicConfig.args = ['-u', ...dynamicConfig.args];
            }
            
            return dynamicConfig;
        }

        logError(`[ServerManager] No configuration found for server: ${serverName}`);
        throw new Error(`No configuration found for server: ${serverName}. Please add this server configuration first.`);
    }

    /**
     * Start a server with the given ID
     * @param serverId The ID of the server to start
     * @returns A promise that resolves when the server is started
     */
    async startServer(serverId: string): Promise<void> {
        logInfo(`[ServerManager] Attempting to start server ${serverId}...`);
        if (this.servers.has(serverId) && this.isServerRunning(serverId)) {
            logWarning(`[ServerManager] Server ${serverId} is already running.`);
            return;
        }

        const config = this.dynamicConfigs.get(serverId) || this.configStorage.getServer(serverId);
        if (!config) {
            throw new Error(`Configuration for server ${serverId} not found.`);
        }
        logDebug(`[ServerManager] Found config for ${serverId}: ${JSON.stringify(config)}`);

        if (this.servers.has(serverId)) {
             logDebug(`[ServerManager] Disposing existing (non-running) instance of ${serverId} before restart.`);
            await this.stopServer(serverId);
        }

        try {
            const server = new StdioServer(serverId, config);
            this.servers.set(serverId, server);

            server.on('status', (status: ServerStatus) => {
                logInfo(`[ServerManager] Server ${serverId} status changed: ${status}`);
                this.updateServerStatus(serverId, status);
            });
            server.on('data', (data: string) => {
                logDebug(`[ServerManager] Data received from ${serverId}: ${data}`);
                this.emit('data', { serverId, data });
                try {
                    const jsonData = JSON.parse(data);
                    if (jsonData.command === 'abilities_response' && jsonData.abilities) {
                        logInfo(`[ServerManager] Detected abilities_response from ${serverId}.`);
                        this.emit('abilities_response', { serverId, abilities: jsonData.abilities });
                    } else if (jsonData.command === 'message_response') {
                        logDebug(`[ServerManager] Received message_response from ${serverId}`);
                        this.emit('message_response', { serverId, response: jsonData.response });
                    }
                } catch (e) {
                    logDebug(`[ServerManager] Non-JSON or non-ability data from ${serverId}`);
                }
            });
            server.on('error', (error: Error) => {
                logError(`[ServerManager] Error from ${serverId}: ${error.message}`);
                this.emit('error', { serverId, error });
                this.updateServerStatus(serverId, ServerStatus.Error, error.message);
            });
            server.on('exit', (code: number | null, signal: string | null) => {
                logWarning(`[ServerManager] Server ${serverId} exited with code ${code}, signal ${signal}`);
                this.emit('exit', { serverId, code, signal });
                this.updateServerStatus(serverId, ServerStatus.Disconnected, `Exited with code ${code}, signal ${signal}`);
                this.servers.delete(serverId);
            });

            logInfo(`[ServerManager] Starting server process for ${serverId}...`);
            await server.start();
            logInfo(`[ServerManager] Server ${serverId} start initiated.`);

        } catch (error) {
            logError(`[ServerManager] Failed to create or start StdioServer for ${serverId}: ${getErrorMessage(error)}`);
            this.updateServerStatus(serverId, ServerStatus.Error, getErrorMessage(error));
            throw error;
        }
    }

    /**
     * Restart a server with the given ID
     * @param serverId The ID of the server to restart
     * @returns A promise that resolves when the server is restarted
     */
    async restartServer(serverId: string): Promise<void> {
        logInfo(`[ServerManager] Restarting server ${serverId}...`);
        
        try {
            await this.stopServer(serverId);
            
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            await this.startServer(serverId);
            
            logInfo(`[ServerManager] Server ${serverId} restarted successfully`);
        } catch (error) {
            logError(`[ServerManager] Error restarting server ${serverId}: ${getErrorMessage(error)}`);
            throw error;
        }
    }

    /**
     * Wait for server to become ready with improved error handling
     * and diagnostics
     */
    async waitForServerReady(serverId: string, timeout: number = 30000): Promise<void> {
        logInfo(`[ServerManager] Waiting for server ${serverId} to become ready (timeout: ${timeout}ms)`);
        
        const startTime = Date.now();
        const server = this.getServer(serverId);
        
        if (!server) {
            const error = new Error(`Server '${serverId}' not found`);
            logError(error.message);
            throw error;
        }
        
        if (server.isReady) {
            logInfo(`[ServerManager] Server ${serverId} is already ready`);
            return;
        }
        
        const processInfo = server.getProcessInfo();
        if (!processInfo || !processInfo.pid) {
            const error = new Error(`Server '${serverId}' is not running (no process found)`);
            logError(error.message);
            throw error;
        }
        
        logInfo(`[ServerManager] Server ${serverId} has process (PID: ${processInfo.pid}), waiting for ready state`);
        
        let attempt = 1;
        const maxAttempts = 10;
        
        while (attempt <= maxAttempts) {
            if (Date.now() - startTime > timeout) {
                const error = new Error(`Timeout waiting for server '${serverId}' to become ready (${timeout}ms elapsed)`);
                logError(error.message);
                throw error;
            }
            
            try {
                if (server.isReady) {
                    logInfo(`[ServerManager] Server ${serverId} is now ready (attempt ${attempt})`);
                    return;
                }
                
                logInfo(`[ServerManager] Attempt ${attempt}/${maxAttempts}: Pinging server ${serverId}...`);
                const pingResult = await this.pingServer(serverId);
                
                if (pingResult) {
                    logInfo(`[ServerManager] Server ${serverId} responded to ping on attempt ${attempt}`);
                    return;
                }
                
                const delay = Math.min(100 * Math.pow(2, attempt - 1), 5000);
                logInfo(`[ServerManager] Server ${serverId} not ready on attempt ${attempt}, waiting ${delay}ms before retry`);
                
                await new Promise(resolve => setTimeout(resolve, delay));
                attempt++;
            } catch (error) {
                logWarning(`[ServerManager] Error checking server ${serverId} readiness (attempt ${attempt}/${maxAttempts}): ${getErrorMessage(error)}`);
                
                if (attempt >= maxAttempts) {
                    throw new Error(`Failed to connect to server '${serverId}' after ${maxAttempts} attempts: ${getErrorMessage(error)}`);
                }
                
                const delay = Math.min(100 * Math.pow(2, attempt - 1), 5000);
                await new Promise(resolve => setTimeout(resolve, delay));
                attempt++;
            }
        }
        
        const error = new Error(`Server '${serverId}' failed to become ready after ${maxAttempts} attempts`);
        logError(error.message);
        throw error;
    }

    /**
     * Clear health check interval for a server
     * @param serverName The name of the server
     */
    private clearHealthCheckInterval(serverName: string): void {
        if (this.healthCheckIntervals.has(serverName)) {
            clearInterval(this.healthCheckIntervals.get(serverName)!);
            this.healthCheckIntervals.delete(serverName);
            logInfo(`[ServerManager] Cleared health check interval for server: ${serverName}`);
        }
    }

    /**
     * Start a periodic health check for a server
     * @param serverName The name of the server to check
     */
    private startHealthCheck(serverName: string): void {
        this.clearHealthCheckInterval(serverName);
        
        const interval = setInterval(() => {
            this.checkServerHealth(serverName);
            
            const now = Date.now();
            const purgeInterval = 10 * 60 * 1000;
            const lastPurge = this._lastPurgeTime || 0;
            
            if (now - lastPurge > purgeInterval) {
                this._lastPurgeTime = now;
                this.purgeStalledServers();
            }
        }, 3000);
        
        this.healthCheckIntervals.set(serverName, interval);
        logInfo(`[ServerManager] Started health check interval for server: ${serverName}`);
    }

    /**
     * Check the health of a server
     * @param serverName The name of the server to check
     */
    private async checkServerHealth(serverName: string): Promise<void> {
        const server = this.servers.get(serverName);
        if (!server) {
            logWarning(`[ServerManager] Health check: Server ${serverName} not found.`);
            this.clearHealthCheckInterval(serverName);
            return;
        }

        try {
            const processInfo = server.getProcessInfo();
            if (!processInfo) {
                logWarning(`[ServerManager] Health check: Server ${serverName} has no process info.`);
                this.updateServerStatus(serverName, ServerStatus.Disconnected, 'Server process not found');
                return;
            }
            
            const pid = processInfo.pid;
            
            if (!pid) {
                logWarning(`[ServerManager] Health check: Server ${serverName} has no PID.`);
                this.updateServerStatus(serverName, ServerStatus.Disconnected, 'Server process not found');
                return;
            }

            let isProcessRunning = false;
            
            try {
                if (process.platform === 'win32') {
                    const { error } = cp.spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH']);
                    isProcessRunning = !error;
                } else {
                    const { error } = cp.spawnSync('kill', ['-0', pid.toString()]);
                    isProcessRunning = !error;
                }
                
                const isServerReady = await this.isReady(serverName);
                if (!isServerReady) {
                    logWarning(`[ServerManager] Health check: Server ${serverName} reports not ready.`);
                }
                
            } catch (checkError) {
                logError(`[ServerManager] Health check: Error checking process ${pid} for server ${serverName}: ${checkError}`);
                isProcessRunning = false;
            }
            
            if (!isProcessRunning) {
                logWarning(`[ServerManager] Health check: Server ${serverName} (PID: ${pid}) is no longer running.`);
                
                this.updateServerStatus(serverName, ServerStatus.Disconnected, 'Server process was terminated externally');
                
                server.dispose();
                this.servers.delete(serverName);
                
                this.clearHealthCheckInterval(serverName);
                return;
            }
            
            logInfo(`[ServerManager] Health check: Server ${serverName} (PID: ${pid}) is alive.`);
            
            this.updateServerStatus(serverName, ServerStatus.Connected, undefined);
            
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            logError(`[ServerManager] Health check failed for server ${serverName}: ${errorMsg}`);
            this.updateServerStatus(serverName, ServerStatus.Error, `Health check failed: ${errorMsg}`);
        }
    }

    /**
     * Purge any stale server connections that haven't responded in a while
     * This can help recover from stuck servers that appear connected but aren't responsive
     */
    private purgeStalledServers(): void {
        const now = Date.now();
        const maxAge = 5 * 60 * 1000;
        
        for (const [serverName, lastResponseTime] of this._lastServerResponseTime.entries()) {
            const age = now - lastResponseTime;
            if (age > maxAge) {
                logWarning(`[ServerManager] Server ${serverName} hasn't responded in ${age/1000} seconds, purging connection`);
                this.restartServer(serverName).catch(error => {
                    logError(`[ServerManager] Failed to restart stalled server ${serverName}: ${getErrorMessage(error)}`);
                });
            }
        }
    }

    /**
     * Ping server to check if it's responsive
     */
    async pingServer(serverId: string, timeout: number = 5000): Promise<boolean> {
        logInfo(`[ServerManager] Pinging server ${serverId} (timeout: ${timeout}ms)`);
        
        const server = this.getServer(serverId);
        if (!server) {
            logWarning(`[ServerManager] Cannot ping server '${serverId}': Server not found`);
            return false;
        }
        
        const processInfo = server.getProcessInfo();
        if (!processInfo || !processInfo.pid) {
            logWarning(`[ServerManager] Cannot ping server '${serverId}': No active process`);
            return false;
        }
        
        try {
            // Ping requires request/response which sendMessage doesn't directly support now
            // Option 1: Assume server responds to a simple newline or basic JSON
            // Option 2: Implement a specific ping command/response if servers support it
            // Option 3: Rely solely on process check (isServerRunning)
            
            // Let's try sending a simple newline as a basic liveness check for stdio
            if (typeof server.sendMessage === 'function') {
                logDebug(`[ServerManager] Sending newline to ${serverId} as basic ping.`);
                await server.sendMessage('\n'); // Send newline
                // We can't easily wait for a specific response here with the current setup
                // Assume success if sending didn't throw an immediate error
                logInfo(`[ServerManager] Basic ping (newline sent) to ${serverId} succeeded.`);
                return true; 
            } else {
                logWarning(`[ServerManager] Cannot ping server '${serverId}': No suitable sendMessage method.`);
                return false;
            }

        } catch (error) {
            logWarning(`[ServerManager] Server ${serverId} ping failed: ${getErrorMessage(error)}`); 
            return false;
        }
    }

    /**
     * Private helper method for consistent logging
     */
    private log(message: string, isError: boolean = false): void {
        if (isError) {
            logError(message);
        } else {
            logInfo(message);
        }
    }

    /**
     * Send a message to a server
     * @param serverId The ID of the server to send the message to
     * @param message The message to send - can be string or object
     * @param options Optional parameters including message ID
     * @returns A promise that resolves to the server's response
     */
    public sendMessage(serverId: string, message: string | any, options: { id?: string } = {}): Promise<string> {
        return new Promise(async (resolve, reject) => {
            const server = this.getServer(serverId);
            if (!server) {
                throw new Error(`Server ${serverId} not found`);
            }

            await this.ensureServerStarted(serverId);
            
            let messageObj: any;
            
            if (typeof message === 'string') {
                messageObj = options.id ? { text: message, id: options.id } : message;
            } else {
                messageObj = { ...message };
                if (options.id) {
                    messageObj.id = options.id;
                }
            }
            
            const messageString = JSON.stringify(messageObj);
            logDebug(`[ServerManager] Sending message to ${serverId} with ID ${options.id}: ${messageString}`);

            const responseListener = (response: { serverId: string; data: string }) => {
                if (response.serverId === serverId) {
                    resolve(response.data);
                }
            };

            this.on('data', responseListener);

            if (typeof server.sendMessage === 'function') {
                server.sendMessage(messageString);
            } else {
                reject(new Error(`Server ${serverId} does not support sending messages via sendMessage.`));
            }
        });
    }

    private validateServerConfig(config: ServerConfig, serverName: string): void {
        const errors: string[] = [];

        if (!config || typeof config.command !== 'string' || !config.command.trim()) {
            errors.push('Configuration is missing or invalid: "command" property is required.');
        }

        if (errors.length > 0) {
            const errorMsg = `Server ${serverName} configuration invalid:\n- ${errors.join('\n- ')}`;
            logError(errorMsg);
            throw new Error(errorMsg);
        }
        logInfo(`[ServerManager] Configuration validated for ${serverName}`);
    }

    /**
     * Check if a server is ready to receive messages
     * @param serverName The name of the server to check
     * @returns boolean indicating if the server is ready
     */
    async isReady(serverName: string): Promise<boolean> {
        logDebug(`[ServerManager] Checking if server ${serverName} is ready`);
        
        const server = this.servers.get(serverName);
        if (!server) {
            logWarning(`[ServerManager] Server ${serverName} not found when checking readiness`);
            return false;
        }
        
        try {
            const currentStatus = this.serverStatuses.get(serverName);
            if (currentStatus === ServerStatus.Connected) {
                 logDebug(`[ServerManager] Server ${serverName} status in manager is Connected.`);
                 return true;
            }
            
            const processInfo = server.getProcessInfo();
            if (processInfo && processInfo.pid) {
                 const serverUptime = this.serverUptimes.get(serverName);
                 const uptimeMs = serverUptime ? (Date.now() - serverUptime) : 0;
                if (serverUptime && uptimeMs < 3000) { 
                    logDebug(`[ServerManager] Server ${serverName} has recent process (${uptimeMs}ms old), assuming it's ready`);
                    return true;
                }
                
                logDebug(`[ServerManager] Server ${serverName} has a process but no explicit ready status, checking process...`);
                try {
                    if (process.platform === 'win32') {
                        const { error } = cp.spawnSync('tasklist', ['/FI', `PID eq ${processInfo.pid}`, '/NH']);
                        if (!error) {
                            logDebug(`[ServerManager] Server ${serverName} process ${processInfo.pid} is running`);
                            return true;
                        }
                    } else {
                        const { error } = cp.spawnSync('kill', ['-0', processInfo.pid.toString()]);
                        if (!error) {
                            logDebug(`[ServerManager] Server ${serverName} process ${processInfo.pid} is running`);
                            return true;
                        }
                    }
                } catch (e) {
                    logWarning(`[ServerManager] Error checking process status for ${serverName}: ${e}`);
                }
            }
            
            logWarning(`[ServerManager] Server ${serverName} does not appear to be ready`);
            return false;
        } catch (error) {
            logError(`[ServerManager] Error checking if server ${serverName} is ready: ${getErrorMessage(error)}`);
            return false;
        }
    }

    private async getOrCreateServer(serverName: string): Promise<IServer> {
        logInfo(`[ServerManager] getOrCreateServer called for ${serverName} (potentially redundant).`);
        try {
            if (!this.servers.has(serverName)) {
                logInfo(`[ServerManager] Creating server instance (via getOrCreateServer): ${serverName}`);
                await this.startServer(serverName);
            }

            const server = this.servers.get(serverName);
            if (!server) {
                throw new Error(`Failed to get server instance ${serverName} after creation attempt.`);
            }
            return server;
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            logError(`[ServerManager] Failed in getOrCreateServer for ${serverName}: ${errorMsg}`);
            throw error;
        }
    }

    /**
     * Gets the process information for a given server.
     * @param serverName The name of the server
     * @returns Process information or null if server is not running
     */
    public getProcessInfo(serverName: string): { pid: number } | null {
        const server = this.servers.get(serverName);
        if (!server) {
            logWarning(`Server ${serverName} not found`);
            return null;
        }
        
        return server.getProcessInfo();
    }

    /**
     * Checks if a server is running by checking its process information.
     * @param serverName The name of the server to check
     * @returns Boolean indicating if the server is running
     */
    public isServerRunning(serverName: string): boolean {
        const processInfo = this.getProcessInfo(serverName);
        const status = this.serverStatuses.get(serverName);
        return (processInfo !== null && typeof processInfo.pid === 'number') || 
               (status === ServerStatus.Connected || status === ServerStatus.Connecting);
    }

    /**
     * Ensure server is started and ready before sending messages
     */
    public async ensureServerStarted(serverId: string): Promise<void> {
        logInfo(`[ServerManager] Ensuring server ${serverId} is started and ready`);
        let server = this.servers.get(serverId);

        if (!server || !this.isServerRunning(serverId)) {
            logWarning(`[ServerManager] Server ${serverId} not found or not running in ensureServerStarted. Attempting to start...`);
            try {
                await this.startServer(serverId);
                server = this.servers.get(serverId);
                if (!server) {
                     throw new Error(`Server ${serverId} could not be created or found after start attempt.`);
                 }
                 logInfo(`[ServerManager] Server ${serverId} started successfully during ensure.`);
             } catch (error) {
                 logError(`[ServerManager] Failed to start server ${serverId} during ensure: ${getErrorMessage(error)}`);
                 throw error;
             }
        }

        logInfo(`[ServerManager] Server ${serverId} is assumed ready (or start completed).`);
    }

    /**
     * Stop a running server
     * @param serverName server name to stop
     */
    public async stopServer(serverName: string): Promise<void> {
        logInfo(`[ServerManager] Stopping server: ${serverName}`);
        this.clearHealthCheckInterval(serverName);
        
        const server = this.servers.get(serverName);
        if (server) {
            try {
                server.dispose();
                this.servers.delete(serverName);
                this.updateServerStatus(serverName, ServerStatus.Disconnected);
                logInfo(`[ServerManager] Server ${serverName} stopped successfully.`);
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                logError(`[ServerManager] Error stopping server ${serverName}: ${errorMsg}`);
                throw new Error(`Failed to stop server ${serverName}: ${errorMsg}`);
            }
        } else {
            logWarning(`[ServerManager] Cannot stop server ${serverName}: not found or already stopped.`);
        }
    }

    public dispose(): void {
        logInfo(`[ServerManager] Disposing ServerManager instance...`);
        for (const serverName of this.healthCheckIntervals.keys()) {
            this.clearHealthCheckInterval(serverName);
        }
        
        const serverNames = Array.from(this.servers.keys());
        logInfo(`[ServerManager] Stopping ${serverNames.length} server(s): ${serverNames.join(', ')}`);
        for (const name of serverNames) {
            const server = this.servers.get(name);
            if (server) {
                try {
                    logInfo(`[ServerManager] Disposing server: ${name}`);
                    server.dispose();
                } catch (error) {
                    const errorMsg = error instanceof Error ? error.message : String(error);
                    logError(`[ServerManager] Error disposing server ${name}: ${errorMsg}`);
                }
            }
        }
        this.servers.clear();
        logInfo(`[ServerManager] Server instances disposed and map cleared.`);
    }

    /**
     * Gets a server by name
     * @param serverName The name of the server to get
     * @returns The server instance, or undefined if not found
     */
    public getServer(serverName: string): IServer | undefined {
        return this.servers.get(serverName);
    }

    /**
     * Checks if a server with the given ID exists
     * @param serverName The name of the server to check
     * @returns Boolean indicating if the server exists
     */
    public hasServer(serverName: string): boolean {
        return this.servers.has(serverName);
    }

    public getAllServers(): IServer[] {
        return Array.from(this.servers.values());
    }

    /**
     * Add a dynamic configuration for a server
     * @param serverName The name of the server to configure
     * @returns A promise that resolves to the server configuration
     */
    public async addDynamicConfiguration(serverName: string): Promise<ServerConfig> {
        logInfo(`[ServerManager] Prompting user to add dynamic configuration for server: ${serverName}`);

        // Prompt for Command (Required)
        const command = await vscode.window.showInputBox({
            prompt: `Enter the execution command for server "${serverName}"`,
            placeHolder: 'e.g., npx, /path/to/executable, python',
            ignoreFocusOut: true,
            validateInput: (value) => {
                return value && value.trim() ? null : 'Command cannot be empty.';
            }
        });

        if (!command) {
            logWarning(`[ServerManager] User cancelled configuration prompt for ${serverName} at command step.`);
            throw new Error(`Configuration cancelled by user for server: ${serverName}`);
        }

        // Prompt for Arguments (Optional)
        const argsInput = await vscode.window.showInputBox({
            prompt: `Enter command arguments for "${serverName}" (comma-separated)`,
            placeHolder: 'e.g., -y, my-package, --port, 8080',
            ignoreFocusOut: true
        });
        const args = argsInput ? argsInput.split(',').map(arg => arg.trim()).filter(arg => arg) : [];

        // Prompt for Shell (Optional)
        const shellPick = await vscode.window.showQuickPick(['Yes', 'No'], {
            title: `Use shell to execute command for "${serverName}"? (Recommended: Yes)`,
            placeHolder: 'Select Yes or No',
            canPickMany: false,
            ignoreFocusOut: true
        });
        const shell = shellPick === 'Yes';

        // Prompt for Windows Hide (Optional)
        const windowsHidePick = await vscode.window.showQuickPick(['Yes', 'No'], {
            title: `Hide command window for "${serverName}" on Windows? (Recommended: Yes)`,
            placeHolder: 'Select Yes or No',
            canPickMany: false,
            ignoreFocusOut: true
        });
        const windowsHide = windowsHidePick === 'Yes';

        // Prompt for Heartbeat (Optional)
        const heartbeatPick = await vscode.window.showQuickPick(['Yes', 'No'], {
            title: `Does server "${serverName}" support heartbeat? (Default: No)`,
            placeHolder: 'Select Yes or No',
            canPickMany: false,
            ignoreFocusOut: true
        });
        const heartbeatEnabled = heartbeatPick === 'Yes';

        // Construct the new config
        const newConfig: ServerConfig = {
            type: 'stdio',
            command: command.trim(),
            args: args,
            shell: shell,
            windowsHide: windowsHide,
            heartbeatEnabled: heartbeatEnabled
        };

        logInfo(`[ServerManager] Storing dynamically entered configuration for ${serverName}: ${JSON.stringify(newConfig)}`);
        this.dynamicConfigs.set(serverName, newConfig);

        return newConfig;
    }

    /**
     * Removes a server configuration from storage
     * @param serverId The unique identifier of the server to remove
     * @returns A boolean indicating if the server was successfully removed
     */
    async removeServerConfiguration(serverId: string): Promise<boolean> {
        logInfo(`[ServerManager] Removing configuration for server: ${serverId}`);
        
        if (!serverId) {
            logError('[ServerManager] Cannot remove server: No server ID provided');
            return false;
        }
        
        try {
            // Stop the server first if it's running
            await this.stopServer(serverId);
            
            // Get current configurations from storage
            const configStorage = ConfigStorage.getInstance(extensionContext);
            const configs = configStorage.getAllServers();
            
            // Check if server exists
            if (!configs[serverId]) {
                logWarning(`[ServerManager] Server "${serverId}" not found in configurations, nothing to remove`);
                return true; // Nothing to remove, so consider it success
            }
            
            // Delete the server from the configurations
            configStorage.removeServer(serverId);
            
            // Also remove the server from the servers map if it exists
            if (this.servers.has(serverId)) {
                this.servers.delete(serverId);
                logInfo(`[ServerManager] Removed server "${serverId}" from active servers map`);
            }
            
            // Verify server was removed
            const updatedConfigs = configStorage.getAllServers();
            const wasRemoved = !updatedConfigs[serverId];
            
            if (wasRemoved) {
                logInfo(`[ServerManager] Successfully removed server "${serverId}" from configurations`);
            } else {
                // This case might indicate an issue with ConfigStorage.removeServer
                logError(`[ServerManager] Failed to remove server "${serverId}" from configurations despite finding it initially.`);
            }
            
            // Notify listeners about the removal
            // FIX: Use ServerStatus enum instead of string
            this.emit('status', {
                serverId,
                status: ServerStatus.Disconnected, 
                message: `Server ${serverId} has been removed`
            });
            
            return wasRemoved;
        } catch (error) {
            // FIX: Combine error into the log message string
            logError(`[ServerManager] Error removing server configuration for ${serverId}: ${getErrorMessage(error)}`);
            return false;
        }
    }

    // --- Public Getters for Status Information ---

    /**
     * Get the current status of a specific server.
     * @param serverId The ID of the server.
     * @returns The ServerStatus enum value, or undefined if the server is unknown.
     */
    public getServerStatus(serverId: string): ServerStatus | undefined {
        return this.serverStatuses.get(serverId);
    }

    /**
     * Get the uptime timestamp (when it connected) for a specific server.
     * @param serverId The ID of the server.
     * @returns The timestamp (milliseconds since epoch) when the server connected, or undefined.
     */
    public getServerUptime(serverId: string): number | undefined {
        return this.serverUptimes.get(serverId);
    }

    /**
     * Get the timestamp of the last known response received from a specific server.
     * @param serverId The ID of the server.
     * @returns The timestamp (milliseconds since epoch) of the last response, or undefined.
     */
    public getLastServerResponseTime(serverId: string): number | undefined {
        return this._lastServerResponseTime.get(serverId);
    }

    // --- End Public Getters ---
}