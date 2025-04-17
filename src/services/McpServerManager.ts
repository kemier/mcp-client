import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import { ServerStatus, ServerStatusEvent, ServerConfig, ModelRequest, ModelResponse, CapabilityManifest } from '../models/Types';
import { StdioServer, IServer } from './StdioServer';
import * as cp from 'child_process';
import { logInfo, logError, logDebug, logWarning, getErrorMessage } from '../utils/logger';
import { ConfigStorage } from './ConfigStorage';
import { extensionContext } from '../extension';
import { LogManager } from '../utils/LogManager';
import { Tool } from '@anthropic-ai/sdk/resources';

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
    private serverTools: Map<string, Tool[]> = new Map();

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
           // --- MODIFIED: Relying on process check instead ---
           const isProcRunning = this.isServerRunning(serverId);
           logInfo(`[ServerManager] Ping check for ${serverId} relying on isServerRunning: ${isProcRunning}`);
           return isProcRunning;

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
        const server = this.servers.get(serverName);
        if (server) {
            LogManager.info('McpServerManager', `Stopping server: ${serverName}`);
            try {
                 await server.dispose(); // Assuming IServer uses dispose() for cleanup
                 this.servers.delete(serverName); // Remove the instance
                 if (this.serverTools.delete(serverName)) {
                    LogManager.info('McpServerManager', `Cleared cached tools for stopped server: ${serverName}`);
                 }
                 // Emit status update AFTER cleanup
                 this.emit('status', { serverId: serverName, status: ServerStatus.Disconnected });
                 LogManager.info('McpServerManager', `Server ${serverName} stopped and instance removed.`);
            } catch (error) {
                 LogManager.error('McpServerManager', `Error stopping server ${serverName}`, error);
                 // Emit error status even on failure to stop cleanly
                 this.emit('status', { serverId: serverName, status: ServerStatus.Error, error: error });
                 // Optionally re-throw or handle differently
                 throw error; // Re-throw allows caller to know stop failed
            }
        } else {
             LogManager.warn('McpServerManager', `Attempted to stop non-existent or already stopped server instance: ${serverName}`);
             // Emit stopped status anyway if the config exists but instance doesn't
             if (this.configStorage.getServer(serverName)) {
                 this.emit('status', { serverId: serverName, status: ServerStatus.Disconnected });
             }
        }
    }

    public dispose(): void {
        LogManager.info('McpServerManager', 'Disposing McpServerManager...');
        this.servers.forEach((server, serverName) => {
            try {
                    server.dispose();
            } catch (e) {
                LogManager.error('McpServerManager', `Error disposing server ${serverName} during dispose`, e);
                }
        });
        this.servers.clear();
        this.serverTools.clear(); // Clear the tools map
        this.removeAllListeners(); // Clean up event listeners
        LogManager.info('McpServerManager', 'Disposed.');
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
            prompt: `Enter the arguments for the command (comma-separated)`,
            placeHolder: 'e.g., --arg1 --arg2',
            ignoreFocusOut: true
        });
        const args = argsInput ? argsInput.split(',').map(arg => arg.trim()).filter(arg => arg) : [];

        // Prompt for Shell (Optional)
        const shellPick = await vscode.window.showQuickPick(['Yes', 'No'], {
            title: 'Use shell?',
            ignoreFocusOut: true
        });
        const shell = shellPick === 'Yes';

        // Prompt for Windows Hide (Optional)
        const windowsHidePick = await vscode.window.showQuickPick(['Yes', 'No'], {
            title: 'Hide window?',
            ignoreFocusOut: true
        });
        const windowsHide = windowsHidePick === 'Yes';

        // Prompt for Heartbeat (Optional)
        const heartbeatPick = await vscode.window.showQuickPick(['Yes', 'No'], {
            title: 'Enable heartbeat?',
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
            heartbeatEnabled: heartbeatEnabled,
            env: {} // Or load/prompt for environment variables if needed
        };

        logInfo(`[ServerManager] Storing dynamically entered configuration for ${serverName}: ${JSON.stringify(newConfig)}`);
        this.dynamicConfigs.set(serverName, newConfig);

        return newConfig;
    }

    public getServerStatus(serverId: string): ServerStatus {
        const server = this.getServer(serverId);
        if (!server) {
            return this.serverStatuses.get(serverId) || ServerStatus.Disconnected;
        }
        return server.getStatus();
    }

    public getServerUptime(serverId: string): number | undefined {
        return this.serverUptimes.get(serverId);
    }

    public getLastServerResponseTime(serverId: string): number | undefined {
        return this._lastServerResponseTime.get(serverId);
    }

    public async startServer(serverId: string): Promise<IServer> {
        if (this.servers.has(serverId)) {
            const existingServer = this.servers.get(serverId);
            if (existingServer && existingServer.getStatus() !== ServerStatus.Disconnected) {
                LogManager.warn('McpServerManager', `Server ${serverId} already exists and is not disconnected (${existingServer.getStatus()}). Returning existing instance.`);
                return existingServer;
            }
             LogManager.info('McpServerManager', `Disposing existing disconnected server instance for ${serverId} before restart.`);
             await existingServer?.dispose();
        }

        const serverConfig = this.configStorage.getServer(serverId) || this.dynamicConfigs.get(serverId);
        if (!serverConfig) {
            throw new Error(`Configuration for server ${serverId} not found.`);
        }

        LogManager.info('McpServerManager', `Creating new server instance for ${serverId}...`);
        const server = new StdioServer(serverId, serverConfig /*, LogManager */);

        this.servers.set(serverId, server);

        server.on('status', (event: ServerStatusEvent) => this.handleServerStatusChange(event));
        server.on('error', (error: any) => {
             LogManager.error('McpServerManager', `Error reported by server ${serverId}`, error);
             this.handleServerStatusChange({ serverId, status: ServerStatus.Error, error: LogManager.getErrorMessage(error) });
         });
        server.on('stdout', (data: string) => LogManager.debug('McpServerManager', `[${serverId}-stdout] ${data}`));
        server.on('stderr', (data: string) => LogManager.error('McpServerManager', `[${serverId}-stderr] ${data}`));
        server.on('toolsReceived', (tools: Tool[]) => {
            this.handleToolsReceived(serverId, tools);
        });

        LogManager.info('McpServerManager', `Starting server process for ${serverId}...`);
        try {
            await server.start();
            LogManager.info('McpServerManager', `Server ${serverId} process start initiated.`);
            return server;
        } catch (error) {
            LogManager.error('McpServerManager', `Failed to start server process for ${serverId}`, error);
            this.servers.delete(serverId);
            this.handleServerStatusChange({ serverId, status: ServerStatus.Error, error: LogManager.getErrorMessage(error) });
            throw error;
        }
    }

    public async removeServerConfiguration(serverId: string): Promise<boolean> {
        LogManager.info('McpServerManager', `Attempting to remove configuration and stop server: ${serverId}`);
        try {
            if (this.servers.has(serverId)) {
                await this.stopServer(serverId);
            }
            const success = await this.configStorage.removeServer(serverId);
            if (success) {
                this.serverTools.delete(serverId);
                LogManager.info('McpServerManager', `Successfully removed configuration for server: ${serverId}`);
            } else {
                LogManager.warn('McpServerManager', `ConfigStorage failed to remove configuration for server: ${serverId}`);
            }
            return success;
        } catch (error) {
            LogManager.error('McpServerManager', `Error removing server configuration for ${serverId}`, error);
            return false;
        }
    }

    public async refreshCapabilities(serverId: string): Promise<void> {
        const server = this.servers.get(serverId);
        if (!server || server.getStatus() !== ServerStatus.Connected) {
            LogManager.warn('McpServerManager', `Cannot refresh capabilities for ${serverId}: Server not connected.`);
            throw new Error(`Server ${serverId} is not connected.`);
        }
        LogManager.info('McpServerManager', `Requesting capability refresh for ${serverId}...`);
        try {
             await server.refreshCapabilities();
             LogManager.info('McpServerManager', `Capability refresh requested for ${serverId}.`);
        } catch (error) {
             LogManager.error('McpServerManager', `Failed to request capability refresh for ${serverId}`, error);
             if (this.serverTools.delete(serverId)) {
                 LogManager.info('McpServerManager', `Cleared tools for ${serverId} due to refresh request failure.`);
             }
             this.emit('status', { serverId, status: ServerStatus.Error, error: `Capability refresh failed: ${LogManager.getErrorMessage(error)}` });
             throw error;
        }
    }

    public async sendMessage(serverId: string, request: ModelRequest): Promise<string> {
        LogManager.info('McpServerManager', `Attempting to send message to server: ${serverId}`);
        let server = this.servers.get(serverId);

        if (!server || server.getStatus() === ServerStatus.Disconnected || server.getStatus() === ServerStatus.Connecting) {
             LogManager.info('McpServerManager', `Server ${serverId} not found or not connected (${server?.getStatus() ?? 'Not Found'}). Attempting start/ensure.`);
             try {
                 server = await this.startServer(serverId);
                 LogManager.debug('McpServerManager', `Pausing briefly after starting ${serverId}...`);
                 await new Promise(resolve => setTimeout(resolve, 1500));

                 if (!server || server.getStatus() !== ServerStatus.Connected) {
                     const currentStatus = this.serverStatuses.get(serverId);
                     if (currentStatus !== ServerStatus.Connected) {
                        LogManager.warn('McpServerManager', `Server ${serverId} still not connected after start attempt and pause (Status: ${currentStatus ?? server?.getStatus()}). Message send might fail.`);
                     } else {
                         LogManager.info('McpServerManager', `Server ${serverId} status map shows Connected after pause.`);
                     }
                 } else {
                     LogManager.info('McpServerManager', `Server ${serverId} instance shows Connected after pause.`);
                 }

             } catch (startError) {
                 LogManager.error('McpServerManager', `Failed to start/ready server ${serverId} for sending message`, startError);
                 throw new Error(`Failed to start or ensure readiness of server ${serverId}: ${LogManager.getErrorMessage(startError)}`);
             }
        }

        if (!server) {
             LogManager.error('McpServerManager', `Server instance for ${serverId} is unexpectedly null after checks.`);
             throw new Error(`Server ${serverId} instance is unexpectedly missing.`);
        }

        LogManager.debug('McpServerManager', `Sending message to ${serverId}: ${JSON.stringify(request)}`);
        try {
            const response = await server.sendMessage(request);
            LogManager.info('McpServerManager', `Received response from ${serverId}`);
            this._lastServerResponseTime.set(serverId, Date.now());
            return response;
        } catch (sendError) {
            LogManager.error('McpServerManager', `Error during server.sendMessage for ${serverId}`, sendError);
            if (server.getStatus() !== ServerStatus.Connected) {
                 LogManager.warn('McpServerManager', `Server ${serverId} is no longer connected after send error (Status: ${server.getStatus()}).`);
                 this.handleServerStatusChange({ serverId, status: server.getStatus(), error: LogManager.getErrorMessage(sendError) });
            }
            throw sendError;
        }
    }

    private handleServerStatusChange(event: ServerStatusEvent): void {
        const { serverId, status, error } = event;
        const currentStatus = this.serverStatuses.get(serverId);

        if (currentStatus === status && !(status === ServerStatus.Error && error)) {
            return;
        }

        LogManager.info('McpServerManager', `Handling status change for ${serverId}: ${status}`, { error: error ? LogManager.getErrorMessage(error) : undefined });
        this.serverStatuses.set(serverId, status);

        if (status === ServerStatus.Connected) {
            this.serverUptimes.set(serverId, Date.now());
            this._serverPingAttempts.delete(serverId);
            this.refreshCapabilities(serverId).catch(refreshError => {
                LogManager.error('McpServerManager', `Auto-refresh capabilities failed for ${serverId} on connect`, refreshError);
            });
        } else {
            this.serverUptimes.delete(serverId);
            if (status === ServerStatus.Disconnected || status === ServerStatus.Error) {
                 if (this.serverTools.delete(serverId)) {
                    LogManager.info('McpServerManager', `Cleared cached tools for server ${serverId} due to status change: ${status}`);
                 }
            }
            if (status === ServerStatus.Disconnected || status === ServerStatus.Error) {
                 const serverInstance = this.servers.get(serverId);
                 if (serverInstance /* && !serverInstance.isStoppingExplicitly() */) {
                     LogManager.warn('McpServerManager', `Server ${serverId} disconnected unexpectedly or errored. Removing instance.`);
                     serverInstance.dispose();
                     this.servers.delete(serverId);
                 }
            }
        }

        this.emit('status', event);
        this.notifyStatusListeners(serverId, status);
    }

    public handleToolsReceived(serverId: string, tools: Tool[]): void {
        const server = this.servers.get(serverId);
        if (server && server.getStatus() === ServerStatus.Connected) {
            LogManager.info('McpServerManager', `Storing ${tools.length} tools for connected server ${serverId}`);
            this.serverTools.set(serverId, tools);
        } else {
            LogManager.warn('McpServerManager', `Received tools for server ${serverId}, but it's not in Connected state (current: ${server?.getStatus() ?? 'N/A'}). Tools ignored.`);
            if (this.serverTools.has(serverId)) {
                 this.serverTools.delete(serverId);
            }
        }
    }
}