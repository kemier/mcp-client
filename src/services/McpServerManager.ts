import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import { ConfigStorage } from './ConfigStorage.js';
import { ServerConfig, ServerStatus, ServerStatusEvent, CapabilityManifest, ServerCapability } from '../models/Types.js';
import { logDebug, logError, logInfo, logWarning, getErrorMessage } from '../utils/logger.js';
import { LogManager } from '../utils/LogManager.js';
// @ts-ignore - TS2307 Suppressing persistent import error during refactoring
import { z } from 'zod';

// === REVERT TO STANDARD SUBPATH IMPORT ===
import { Client } from '@modelcontextprotocol/sdk/client/index.js'; // Import only Client
// =========================================

// Standard transport import
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Standard types import - Import specific types directly from /types
import type { 
    ListResourcesRequest, 
    ListResourcesResult, 
    ReadResourceRequest, 
    ReadResourceResult 
    // ListResourcesResultSchema and ReadResourceResultSchema seem missing from SDK exports?
} from '@modelcontextprotocol/sdk/types.js';
// --- End SDK Imports ---

// Interface representing a managed server instance using the SDK
interface ManagedServer {
    serverId: string;
    config: ServerConfig;
    status: ServerStatus;
    client?: Client; // SDK Client instance
    transport?: StdioClientTransport; // Specifically StdioClientTransport for stdio type
    capabilities?: CapabilityManifest; // Store discovered capabilities
    statusEmitter: EventEmitter; // Emitter for this specific server's status
    lastError?: string; // Store last known error message
}

export class McpServerManager extends EventEmitter {
    private static instance: McpServerManager;
    private servers: Map<string, ManagedServer> = new Map();
    private configStorage: ConfigStorage;
    public autoStartServers: boolean = true; // Or load from config

    private constructor(configStorage: ConfigStorage) {
        super();
        this.configStorage = configStorage;
        // Load autoStart setting from config if necessary
        // this.autoStartServers = vscode.workspace.getConfiguration('mcp').get('autoStartServers', true);
    }

    // --- Singleton Pattern ---
    public static getInstance(configStorage?: ConfigStorage): McpServerManager {
        if (!McpServerManager.instance) {
             if (!configStorage) {
                 // Attempt to get instance from extensionContext if available during initialization
                 // This might require passing extensionContext differently or ensuring it's set early.
                 // For simplicity, let's assume ConfigStorage is initialized before getInstance is first called neededly.
                 // Consider refactoring initialization flow if this becomes problematic.
                 throw new Error("McpServerManager requires ConfigStorage for initialization.");
             }
            McpServerManager.instance = new McpServerManager(configStorage);
        }
        // If configStorage is provided later, maybe update the instance's storage?
        // else if (configStorage && McpServerManager.instance.configStorage !== configStorage) {
        //    LogManager.warn('McpServerManager', 'getInstance called with different ConfigStorage instance.');
        //    McpServerManager.instance.configStorage = configStorage;
        // }
        return McpServerManager.instance;
    }
    // --- End Singleton Pattern ---


    public async initialize(): Promise<void> {
        logInfo('[McpServerManager] Initializing...');
        const serverConfigs = this.configStorage.getAllServers();
        logDebug(`[McpServerManager] Found server configs: ${Object.keys(serverConfigs).join(', ')}`);

        this.servers.clear(); // Clear any previous state

        for (const serverId in serverConfigs) {
            const config = serverConfigs[serverId];
            // Initialize server entry without starting
             this.servers.set(serverId, {
                 serverId: serverId,
                 config: config,
                 status: ServerStatus.Disconnected,
                 statusEmitter: new EventEmitter() // Each server gets its own status emitter
             });
            logDebug(`[McpServerManager] Registered server: ${serverId}`);
        }

        if (this.autoStartServers) {
            logInfo('[McpServerManager] Auto-start enabled. Starting configured servers...');
            await this.startAllServers();
        } else {
             logInfo('[McpServerManager] Auto-start disabled.');
        }
    }

    public async startAllServers(): Promise<void> {
        const serverIds = Array.from(this.servers.keys());
        logInfo(`[McpServerManager] Attempting to auto-start servers: ${serverIds.join(', ')}`);
        for (const serverId of serverIds) {
            const existing = this.servers.get(serverId);
            // Only start if disconnected or errored
            if (existing && (existing.status === ServerStatus.Disconnected || existing.status === ServerStatus.Error)) {
                 try {
                     await this.startServer(serverId);
                 } catch (error) {
                     logError(`[McpServerManager] Failed to auto-start server ${serverId}: ${getErrorMessage(error)}`);
                     // Status should be updated within startServer on failure
                 }
            } else if (existing) {
                 logInfo(`[McpServerManager] Server ${serverId} already in state ${existing.status}, skipping auto-start.`);
            } else {
                 logWarning(`[McpServerManager] Config found for ${serverId} but no entry in manager during auto-start (should not happen after initialize).`);
            }
        }
    }


    public async startServer(serverId: string): Promise<void> {
        let managedServer = this.servers.get(serverId);
        const config = managedServer?.config ?? this.configStorage.getServer(serverId);

        if (!config) {
            throw new Error(`Configuration for server ${serverId} not found.`);
        }
        // Ensure entry exists if called directly without initialize finding it (edge case)
        if (!managedServer) {
             logWarning(`[McpServerManager] Server entry for ${serverId} not found during startServer, creating dynamically.`);
             managedServer = { serverId, config, status: ServerStatus.Disconnected, statusEmitter: new EventEmitter() };
             this.servers.set(serverId, managedServer);
        }

        // Prevent starting if already connected/connecting
        if (managedServer.status === ServerStatus.Connected || managedServer.status === ServerStatus.Connecting) {
            logWarning(`[McpServerManager] Server ${serverId} is already starting or connected.`);
            return;
        }

        // Reset error state before starting
        managedServer.lastError = undefined;
        this.updateServerStatus(serverId, ServerStatus.Connecting); // Set status to Connecting

        // --- SDK Integration for stdio ---
        if (config.type === 'stdio') {
            logInfo(`[McpServerManager] Starting server: ${serverId} (Type: stdio) using SDK (targeting ESM)`);
            try {
                // Ensure previous transport/client are cleaned up if retrying after error
                if (managedServer.transport) await managedServer.transport.close().catch(()=>{});
                managedServer.client = undefined;
                managedServer.transport = undefined;

                // Filter out undefined values from process.env BEFORE creating transport options
                const processEnvFiltered: Record<string, string> = {};
                for (const key in process.env) {
                    if (process.env[key] !== undefined) {
                        processEnvFiltered[key] = process.env[key]!;
                    }
                }

                // 1. Create StdioClientTransport (using ESM import)
                const transport = new StdioClientTransport({
                    command: config.command,
                    args: config.args || [],
                    env: { ...processEnvFiltered, ...config.env },
                });
                managedServer.transport = transport;

                // 2. Create Client (using ESM import)
                const client = new Client({
                    name: `vscode-ext-${serverId}`,
                    version: vscode.extensions.getExtension('mcp-server-manager.mcp-server-manager')?.packageJSON?.version || '0.0.0',
                });
                managedServer.client = client;

                // 4. Start the connection
                logInfo(`[McpServerManager-${serverId}] Attempting to connect SDK Client...`);
                await client.connect(transport);

                // --- ASSUME CONNECTED FOR NOW (NEEDS EVENT HANDLING) ---
                // Since event handlers are commented out, manually update status after connect attempt.
                // This is TEMPORARY and needs to be replaced by proper event handling.
                logWarning(`[McpServerManager-${serverId}] TEMPORARY: Assuming connection successful after connect() call. Status manually set.`);
                this.updateServerStatus(serverId, ServerStatus.Connected, undefined /* No PID access yet */);
                await this.fetchAndStoreCapabilities(serverId);
                // --- END TEMPORARY STATUS ---

                // Initial check if connection failed immediately (e.g., command not found)
                 const postConnectServer = this.servers.get(serverId);
                 if (postConnectServer && postConnectServer.status === ServerStatus.Connecting) {
                     // If still connecting after await client.connect(), it might have failed silently or is slow.
                     // The onerror/onclose handlers should eventually catch it.
                     // We could add a short timeout here for faster feedback on immediate failures.
                     logDebug(`[McpServerManager-${serverId}] client.connect() returned, waiting for transport events...`);
                 }


            } catch (error) {
                 logError(`[McpServerManager-${serverId}] Error during SDK client setup/connection: ${getErrorMessage(error)}`);
                 // Ensure status is set to Error
                 this.updateServerStatus(serverId, ServerStatus.Error, undefined, getErrorMessage(error));
                 // Clean up potentially partially created client/transport
                 const failedServer = this.servers.get(serverId);
                 if (failedServer) {
                     failedServer.transport?.close().catch((e: Error) => logError(`[McpServerManager-${serverId}] Error closing transport during cleanup: ${e.message}`));
                     failedServer.client = undefined;
                     failedServer.transport = undefined;
                 }
                 // Do not re-throw here, as startServer's signature doesn't return Promise<IServer> anymore
                 // The error state is captured in the status.
            }
        } else {
            // Handle other server types if needed in the future
            logWarning(`[McpServerManager] Server type '${config.type}' not currently supported for starting via SDK.`);
            this.updateServerStatus(serverId, ServerStatus.Error, undefined, `Unsupported server type: ${config.type}`);
            // throw new Error(`Unsupported server type: ${config.type}`); // Don't throw
        }
    }

    // Fetch capabilities using client.listTools()
    private async fetchAndStoreCapabilities(serverId: string): Promise<void> {
        const managedServer = this.servers.get(serverId);
        if (!managedServer || !managedServer.client || managedServer.status !== ServerStatus.Connected) {
            logWarning(`[McpServerManager-${serverId}] Cannot fetch capabilities, client not ready or not connected.`);
            return;
        }

        try {
            logInfo(`[McpServerManager-${serverId}] Fetching capabilities via SDK client...`);
            const client = managedServer.client;
            if (!client) {
                logWarning(`[McpServerManager-${serverId}] Cannot fetch capabilities, client not available.`);
                return;
            }
            // listTools returns an object like { tools: [...] }
            const listToolsResult = await client.listTools(); 
            // Extract the actual tools array from the result object
            const tools = listToolsResult?.tools;

            logInfo(`[McpServerManager-${serverId}] Received ${tools?.length ?? 0} tools from SDK client.`);
            
            // Check if the extracted 'tools' is an array before mapping
            if (Array.isArray(tools)) {
                managedServer.capabilities = {
                    models: [], // Placeholder for models
                    // Use the correct type from the SDK (implicitly, based on usage)
                    capabilities: tools.map((tool: { name: string; description?: string; inputSchema: any; type?: string }) => ({ 
                        name: tool.name,
                        // Handle potentially missing description
                        description: tool.description ?? '', 
                        // Store under 'inputSchema' to match CapabilityItem type
                        inputSchema: tool.inputSchema, 
                        type: 'feature' // Map SDK 'tool' type to our 'feature' type
                    })),
                    contextTypes: ['text'], // Placeholder for context types
                    discoveredAt: Date.now()
                };
                // Save the successfully fetched capabilities to storage
                this.configStorage.setServerCapabilities(serverId, managedServer.capabilities);
            } else {
                // Log the actual received value if it's not an array or doesn't have the tools property
                logWarning(`[McpServerManager-${serverId}] Tools array not found or invalid in listTools result. Received: ${JSON.stringify(listToolsResult)}`);
                managedServer.capabilities = {
                    models: [],
                    capabilities: [],
                    contextTypes: ['text'],
                    discoveredAt: Date.now()
                };
            }

            // Note: This line used to emit 'capabilitiesUpdated', but the emitter is defined differently now.
            // Ensure the update is propagated correctly. The ManagedServer object itself might be the source of truth.
            // If using the EventEmitter setup:
            // this.emitter.fire(managedServer); // If this.emitter is defined and used for updates.

            logDebug(`[McpServerManager-${serverId}] Capabilities stored.`);
        } catch (error) {
             logError(`[McpServerManager-${serverId}] Failed to fetch/store capabilities: ${getErrorMessage(error)}`);
             // Should this set server to Error? Maybe not, it might still be usable.
             // Clear potentially outdated capabilities
             managedServer.capabilities = undefined;
             // Replace transport.process.pid with undefined as it no longer exists
             this.updateServerStatus(serverId, managedServer.status, undefined, `Failed to get capabilities: ${getErrorMessage(error)}`);
        }
    }

    // New method to send requests using the SDK client
    public async callServerMethod(serverId: string, method: string, params?: any): Promise<any> {
        const managedServer = this.servers.get(serverId);
        // Check if the server exists and is connected
        if (!managedServer || !managedServer.client || managedServer.status !== ServerStatus.Connected) {
            logError(`[McpServerManager-${serverId}] Cannot call method '${method}': Server not connected or available.`);
            throw new Error(`Server ${serverId} is not connected or available.`);
        }

        logDebug(`[McpServerManager-${serverId}] Calling SDK client method '${method}' with params:`, params);
        try {
            // Use client.callTool for generic tool calls
            // Using z.any() bypasses specific SDK response validation for this generic method
            const { z } = await import('zod'); // Dynamic import
            const response = await managedServer.client.callTool({
                name: method,
                arguments: params || {}
            }, undefined); // Use undefined to let the SDK handle validation internally

            logDebug(`[McpServerManager-${serverId}] Received result for '${method}':`, response);
            return response;
        } catch (error) {
             logError(`[McpServerManager-${serverId}] Error calling method '${method}' via SDK: ${getErrorMessage(error)}`);
            // Check for JSON-RPC error structure from the SDK/server
             if (error instanceof Error && 'code' in error && typeof (error as any).code === 'number') {
                 const rpcError = error as any;
                 logError(`[McpServerManager-${serverId}] RPC Error details: Code=${rpcError.code}, Message=${rpcError.message}, Data=${JSON.stringify(rpcError.data)}`);
                 throw new Error(`RPC Error from ${serverId} (${method}): ${rpcError.message} (Code: ${rpcError.code})`);
             }
            // Re-throw other generic errors
            throw error;
        }
    }

    public async stopServer(serverId: string): Promise<void> {
        const managedServer = this.servers.get(serverId);
        if (!managedServer) {
            logWarning(`[McpServerManager] Attempted to stop server ${serverId}, but it was not found.`);
            return;
        }

        // Prevent stopping if already disconnected
        if (managedServer.status === ServerStatus.Disconnected) {
             logInfo(`[McpServerManager] Server ${serverId} is already disconnected. Skipping stop.`);
             // Ensure refs are cleared if stop is called on an already disconnected server entry
             managedServer.client = undefined;
             managedServer.transport = undefined;
             managedServer.capabilities = undefined;
             return;
        }

        logInfo(`[McpServerManager] Stopping server: ${serverId} (Current Status: ${managedServer.status})`);
        const oldStatus = managedServer.status;
        // Set status to disconnecting immediately? Or wait for confirmation? Let's wait.

        try {
            if (managedServer.transport) {
                 logDebug(`[McpServerManager-${serverId}] Closing SDK transport...`);
                 await managedServer.transport.close();
                 logInfo(`[McpServerManager-${serverId}] SDK transport close initiated.`);
            } else {
                 logDebug(`[McpServerManager-${serverId}] No active transport to stop.`);
            }
            // The onclose handler should set the final Disconnected state.
            // However, if disconnect() or close() throws, or if onclose doesn't fire,
            // we might need to manually set the status.
            // Let's optimistically assume onclose will fire. If issues persist, add manual update here.

        } catch (error) {
             logError(`[McpServerManager-${serverId}] Error during disconnect/close: ${getErrorMessage(error)}`);
             // Replace transport.process.pid with undefined
             this.updateServerStatus(serverId, ServerStatus.Error, undefined, `Failed to stop cleanly: ${getErrorMessage(error)}`);
        } finally {
             // Explicitly clear refs here in case onclose doesn't fire reliably after forceful stop/error
             if (managedServer) { // Check again, might have been removed by event handlers
                 managedServer.client = undefined;
                 managedServer.transport = undefined;
                 managedServer.capabilities = undefined;
                 // If status wasn't set to Error or Disconnected by handlers, force Disconnected here?
                 if (![ServerStatus.Error, ServerStatus.Disconnected].includes(managedServer.status)) {
                      logWarning(`[McpServerManager-${serverId}] Forcing status to Disconnected after stop attempt.`);
                      this.updateServerStatus(serverId, ServerStatus.Disconnected);
                 }
             }
        }
    }

    public async stopAllServers(): Promise<void> {
        logInfo('[McpServerManager] Stopping all managed servers...');
        const stopPromises = [];
        for (const serverId of this.servers.keys()) {
            stopPromises.push(this.stopServer(serverId).catch(e => {
                logError(`[McpServerManager] Error stopping server ${serverId} during stopAll: ${getErrorMessage(e)}`);
                // Don't let one failure stop others
            }));
        }
        await Promise.allSettled(stopPromises);
        logInfo('[McpServerManager] Finished stopping all servers.');
    }

    public getServerStatus(serverId: string): ServerStatusEvent | null {
         const managedServer = this.servers.get(serverId);
         if (!managedServer) return null;

         // Replace transport.process.pid with undefined
         const pid = undefined; // TEMP: managedServer.transport?.process?.pid;
         const status = managedServer.status;
         const error = managedServer.lastError; // Use stored error

         // Get capabilities from storage as the primary source after initial fetch
         const capabilities = this.configStorage.getServerCapabilities(serverId) || managedServer.capabilities;

         return {
             serverId: serverId,
             status: status,
             pid: pid,
             // Use models from the fetched capabilities manifest
             models: capabilities?.models || [],
             capabilities: capabilities, // Include the full manifest
             error: status === ServerStatus.Error ? error : undefined // Show error only if status is Error
         };
    }

    public getAllServerStatuses(): ServerStatusEvent[] {
        const statuses: ServerStatusEvent[] = [];
        for (const serverId of this.servers.keys()) {
            const status = this.getServerStatus(serverId);
            if (status) {
                statuses.push(status);
            }
        }
        return statuses;
    }

    // Helper to update status and emit events
     private updateServerStatus(serverId: string, status: ServerStatus, pid?: number, error?: string): void {
         const managedServer = this.servers.get(serverId);
         if (!managedServer) {
              logWarning(`[McpServerManager] Tried to update status for unknown server ${serverId}`);
              return;
         }

         const oldStatus = managedServer.status;
         // Store the error message if provided, especially for Error status
         if (error) {
             managedServer.lastError = error;
         } else if (status !== ServerStatus.Error) {
             // Clear last error if status changes to non-error state
             managedServer.lastError = undefined;
         }

         // Prevent redundant updates unless it's an error update for an existing error state
         if (oldStatus === status && status !== ServerStatus.Error) {
             // Allow pid update even if status is same (e.g., Connecting -> Connecting with PID)
             // But avoid emitting event if only PID changes without status change? Debatable.
             // Let's emit if PID changes significantly (e.g., from undefined to a number)
             const oldPid = undefined; // managedServer.transport?.process?.pid;
             if (pid === oldPid) {
                 // Check if capabilities have changed before returning
                 const oldCaps = managedServer.capabilities;
                 const newCaps = this.configStorage.getServerCapabilities(serverId); // Get latest from storage
                 if (JSON.stringify(oldCaps) === JSON.stringify(newCaps)) {
                     return; // Nothing changed
                 }
             }
         }

         logInfo(`[McpServerManager-${serverId}] Status changing from ${oldStatus} to ${status}` + (error ? ` (Error: ${error})` : '') + (pid ? ` (PID: ${pid})` : ''));
         managedServer.status = status;

         // Retrieve potentially updated capabilities from storage
         const capabilities = this.configStorage.getServerCapabilities(serverId) || managedServer.capabilities;

         const statusEvent: ServerStatusEvent = {
             serverId: serverId,
             status: status,
             pid: undefined, // pid ?? managedServer.transport?.process?.pid,
             models: capabilities?.models ?? [],
             capabilities: capabilities, // Include latest capabilities
             error: status === ServerStatus.Error ? managedServer.lastError : undefined // Use stored error for Error status
         };

         // Emit global status update
         this.emit('serverStatusChanged', statusEvent);
         // Emit specific server status update
         managedServer.statusEmitter.emit('status', statusEvent);

         // Clear capabilities and PID from instance if disconnected/errored
         if (status === ServerStatus.Disconnected || status === ServerStatus.Error) {
              managedServer.capabilities = undefined; // Clear instance capabilities
              // Don't clear storage here, keep last known good capabilities? Or clear? Let's keep.
              // PID should naturally become undefined when transport is gone, but ensure event reflects it
              if (!pid && statusEvent.pid) {
                    statusEvent.pid = undefined; // Ensure event payload is accurate if PID is gone
              }
         }
     }


    // Method to get capabilities (uses stored manifest)
    public getCapabilities(serverId: string): CapabilityManifest | undefined {
         // Prioritize ConfigStorage as the source of truth after initial fetch
         return this.configStorage.getServerCapabilities(serverId) || this.servers.get(serverId)?.capabilities;
    }

    // Dispose method for singleton cleanup
    public async dispose(): Promise<void> {
        logInfo('[McpServerManager] Disposing...');
        await this.stopAllServers();
        this.servers.clear();
        this.removeAllListeners();
        // Reset singleton instance? Optional.
        // McpServerManager.instance = undefined;
        logInfo('[McpServerManager] Disposal complete.');
    }

    // --- Add methods for compatibility or specific needs ---

    // Example: Explicitly refresh capabilities (re-triggers fetch)
    public async refreshCapabilities(serverId: string): Promise<void> {
        logInfo(`[McpServerManager-${serverId}] Explicitly refreshing capabilities...`);
        await this.fetchAndStoreCapabilities(serverId);
        // Re-emit status after refresh to ensure UI updates with latest capabilities
        const managedServer = this.servers.get(serverId);
        if (managedServer) {
             this.updateServerStatus(serverId, managedServer.status, undefined); // Pass pid
        }
    }

    // Get status without full event object (legacy compatibility?)
    public getServerStatusEnum(serverId: string): ServerStatus {
        return this.servers.get(serverId)?.status ?? ServerStatus.Disconnected;
    }

    // --- ADD BACK for compatibility ---
    public async removeServerConfiguration(serverId: string): Promise<boolean> {
        LogManager.info('McpServerManager', `Attempting to remove configuration and stop server: ${serverId}`);
        try {
            await this.stopServer(serverId); // Stop the server first
            const success = await this.configStorage.removeServer(serverId); // Use ConfigStorage method
            if (success) {
                this.servers.delete(serverId); // Remove from internal map
                this.configStorage.setServerCapabilities(serverId, undefined); // Clear capabilities
                LogManager.info('McpServerManager', `Successfully removed configuration for server: ${serverId}`);
                 // Emit a final disconnected status?
                 this.emit('serverStatusChanged', { serverId, status: ServerStatus.Disconnected });
            } else {
                LogManager.warn('McpServerManager', `ConfigStorage failed to remove configuration for server: ${serverId}`);
            }
            return success;
        } catch (error) {
            LogManager.error('McpServerManager', `Error removing server configuration for ${serverId}`, error);
            // Access PID via transport.process?.pid (though unlikely to exist here)
            this.updateServerStatus(serverId, ServerStatus.Error, undefined, `Failed to remove configuration: ${getErrorMessage(error)}`); // PID likely undefined
            return false;
        }
    }

    public getConnectedServerIdsAndCapabilities(): { serverId: string, capabilities: CapabilityManifest | undefined }[] {
        const connectedServers: { serverId: string, capabilities: CapabilityManifest | undefined }[] = [];
        LogManager.debug('McpServerManager', 'Getting connected server IDs and capabilities...');
        const statuses = this.getAllServerStatuses();
        for (const statusEvent of statuses) {
            if (statusEvent.status === ServerStatus.Connected) {
                 LogManager.debug('McpServerManager', `Server ${statusEvent.serverId} is connected. Including capabilities.`);
                 connectedServers.push({ serverId: statusEvent.serverId, capabilities: statusEvent.capabilities });
            } else {
                 LogManager.debug('McpServerManager', `Skipping server ${statusEvent.serverId}, status: ${statusEvent.status}`);
            }
        }
        LogManager.debug('McpServerManager', `Returning ${connectedServers.length} connected servers with capability info.`);
        return connectedServers;
    }
    // --- END ADD BACK ---

    // --- NEW SDK Wrapper Methods for Resources ---

    /**
     * Lists resources available on a specific connected MCP server.
     * Uses the SDK's listResources method.
     */
    public async listResourcesFromServer(serverId: string, params?: ListResourcesRequest["params"]): Promise<ListResourcesResult> {
        const managedServer = this.servers.get(serverId);
        // Check if the server exists and is connected
        if (!managedServer || !managedServer.client || managedServer.status !== ServerStatus.Connected) {
            logError(`[McpServerManager-${serverId}] Cannot list resources: Server not connected or available.`);
            throw new Error(`Server ${serverId} is not connected or available.`);
        }

        logDebug(`[McpServerManager-${serverId}] Calling SDK client.listResources with params:`, params);
        try {
            // Optional: Check server capabilities if desired
            // managedServer.client.assertCapability('resources', 'resources/list'); // Might throw if capability missing

            const resources = await managedServer.client.listResources(params);
            logDebug(`[McpServerManager-${serverId}] Received listResources result:`, resources);
            return resources;
        } catch (error) {
            logError(`[McpServerManager-${serverId}] Error calling listResources via SDK: ${getErrorMessage(error)}`);
            // Re-throw SDK errors (they might already be structured JSON-RPC errors)
            throw error;
        }
    }

    /**
     * Reads the content of a specific resource from a connected MCP server.
     * Uses the SDK's readResource method.
     */
    public async readResourceFromServer(serverId: string, params: ReadResourceRequest["params"]): Promise<ReadResourceResult> {
        const managedServer = this.servers.get(serverId);
         // Check if the server exists and is connected
        if (!managedServer || !managedServer.client || managedServer.status !== ServerStatus.Connected) {
            logError(`[McpServerManager-${serverId}] Cannot read resource: Server not connected or available.`);
            throw new Error(`Server ${serverId} is not connected or available.`);
        }

        logDebug(`[McpServerManager-${serverId}] Calling SDK client.readResource with params:`, params);
        try {
             // Optional: Check server capabilities if desired
            // managedServer.client.assertCapability('resources', 'resources/read');

            const resourceContent = await managedServer.client.readResource(params);
            logDebug(`[McpServerManager-${serverId}] Received readResource result.`); // Avoid logging potentially large content
            return resourceContent;
        } catch (error) {
             logError(`[McpServerManager-${serverId}] Error calling readResource via SDK: ${getErrorMessage(error)}`);
             // Re-throw SDK errors
             throw error;
        }
    }

    // --- End NEW SDK Wrapper Methods ---
}
