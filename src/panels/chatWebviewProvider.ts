import * as vscode from 'vscode';
import { McpServerManager } from '../services/McpServerManager.js';
import { ConfigStorage } from '../services/ConfigStorage.js';
import { logDebug, logError, logInfo, logWarning, getErrorMessage } from '../utils/logger.js';
import { ServerConfig, ModelRequest, ServerStatus, ServerStatusEvent, CapabilityManifest } from '../models/Types.js'; // Import ServerConfig and ModelRequest
import { getWebviewContent } from '../utils/webviewUtils.js'; // Correct path

// Define local types based on usage
type ServerAbility = {
    name: string;
    description: string;
    parameters?: Record<string, any>;
};

type ServerListEntry = {
    id: string;
    config: ServerConfig;
    status: ServerStatus;
    isRunning: boolean;
    error?: string;
    capabilities?: CapabilityManifest;
};

type ServerDetailsPayload = {
    serverId: string;
    config: ServerConfig;
    status: ServerStatus;
    capabilities?: CapabilityManifest;
    error?: string;
};

export class ChatWebviewProvider implements vscode.WebviewViewProvider, vscode.WebviewPanelSerializer {
    public static readonly viewType = 'mcpChatView'; // Use view ID from package.json

    public static instance: ChatWebviewProvider | undefined;
    private _view?: vscode.WebviewView; // Store WebviewView
    private _panel?: vscode.WebviewPanel; // For deserializeWebviewPanel
    private _disposables: vscode.Disposable[] = [];

    private readonly _extensionUri: vscode.Uri;
    private readonly _context: vscode.ExtensionContext;
    private readonly _serverManager: McpServerManager;
    private readonly _configStorage: ConfigStorage; // Added ConfigStorage member

    // State managed by the provider
    private _chatHistory: { role: string; text: string }[] = [];
    private _serverAbilities = new Map<string, ServerAbility[]>();

    constructor(
        context: vscode.ExtensionContext,
        serverManager: McpServerManager,
        configStorage: ConfigStorage // Added configStorage parameter
    ) {
        ChatWebviewProvider.instance = this;
        this._context = context;
        this._extensionUri = context.extensionUri;
        this._serverManager = serverManager;
        this._configStorage = configStorage; // Assign configStorage

        // Listen to server status changes
        this._serverManager.on('serverStatusChanged', this.handleServerStatusChange.bind(this)); // Use the global event emitter
        logInfo('[ChatWebviewProvider] Initialized and listening to server status.');
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        logInfo('[ChatWebviewProvider] Resolving webview view...');
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._extensionUri, 'media'), // For CSS, JS, etc.
                vscode.Uri.joinPath(this._extensionUri, 'dist') // If webview code is bundled
            ]
        };

        try {
            webviewView.webview.html = getWebviewContent(webviewView.webview, this._extensionUri); // Correct path
            logInfo('[ChatWebviewProvider] Webview HTML content set.');
        } catch (e) {
             logError(`[ChatWebviewProvider] Error setting webview HTML: ${getErrorMessage(e)}. Check path for getWebviewContent.`);
             webviewView.webview.html = `<body>Error loading webview content. Check extension logs.</body>`;
        }

        this.setupWebviewListeners(webviewView); // Setup listeners for the view
        logInfo('[ChatWebviewProvider] Webview listeners set up.');

        // Send initial state shortly after resolving
        setTimeout(() => {
            logInfo('[ChatWebviewProvider] Sending initial server list update to webview.');
            this._updateServerListInWebview();
        }, 500); // Delay to ensure webview is ready

        webviewView.onDidDispose(() => {
             logInfo('[ChatWebviewProvider] Webview view disposed.');
             this._view = undefined;
             // Dispose specific disposables related to this view if necessary
        }, null, this._disposables); // Use main disposables or manage view-specific ones
    }

    // Handle panel disposal
    private disposePanel(): void {
        logInfo('[ChatProvider] Disposing chat panel resources.');
        this._panel = undefined; // Ensure reference is cleared
        // Dispose disposables specific to the panel
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    // Dispose the entire provider
    public dispose(): void {
        logInfo('[ChatProvider] Disposing provider.');
        this.disposePanel(); // Dispose the panel if it exists
        this._serverManager.off('serverStatusChanged', this.handleServerStatusChange.bind(this)); // Stop listening
    }

    // --- Webview Message Handling ---

    private setupWebviewListeners(webviewView: vscode.WebviewView): void {
        logInfo('[ChatWebviewProvider] Setting up webview listeners');
        webviewView.webview.onDidReceiveMessage(
            async (message) => {
                logDebug(`[ChatWebviewProvider][WebView->Ext] Received command: ${message.command}`, message.payload ?? '');
                try {
                    // Add checks for payload and serverId where necessary
                     const serverId = message.payload?.serverId;

                    switch (message.command) {
                        case 'getInitialState':
                            logInfo('[ChatWebviewProvider] Webview requested initial state.');
                            await this._updateServerListInWebview(); // Send server list
                            // Send history, capabilities, etc. if needed
                            break;
                        case 'saveServer':
                            if (message.payload?.serverId && message.payload?.config) {
                                await this.handleSaveServer(message.payload);
                            } else {
                                throw new Error('Missing serverId or config for saveServer.');
                            }
                            break;
                        case 'removeServer': // Removing specific server
                            if (serverId) {
                                await this.handleRequestRemoveServerConfirmation(serverId);
                            } else {
                                throw new Error('Missing serverId for removeServer.');
                            }
                            break;
                        case 'startServer':
                            if (serverId) {
                                await this._serverManager.startServer(serverId);
                            } else {
                                throw new Error('Missing serverId for startServer.');
                            }
                            break;
                        case 'stopServer':
                            if (serverId) {
                                await this._serverManager.stopServer(serverId);
                             } else {
                                throw new Error('Missing serverId for stopServer.');
                             }
                            break;
                        case 'refreshCapabilities':
                             if (serverId) {
                                await this._serverManager.refreshCapabilities(serverId);
                             } else {
                                 throw new Error('Missing serverId for refreshCapabilities.');
                             }
                             break;
                        case 'getServerDetails':
                            if (serverId) {
                                await this.handleGetServerDetails(message.payload);
                            } else {
                                 throw new Error('Missing serverId for getServerDetails.');
                            }
                            break;
                        case 'runServerTool': // Example: Used for specific actions like list files
                             if (serverId && message.payload?.request) {
                                const result = await this.handleRunServerTool(message.payload);
                                // Send result back to the specific requestor in webview
                                this._view?.webview.postMessage({
                                    command: 'toolResult', // Command webview expects
                                    payload: { success: true, result: result, originalPayload: message.payload } // Send back result
                                });
                             } else {
                                throw new Error('Missing serverId or request for runServerTool.');
                             }
                            break;
                        case 'requestAbilityList': // Explicit request for abilities
                             if (serverId) {
                                await this.handleRequestAbilityList(message.payload);
                             } else {
                                throw new Error('Missing serverId for requestAbilityList.');
                             }
                            break;
                        case 'sendMessage': // Generic message/prompt processing
                            if (message.payload?.text) {
                                await this.handleSendMessage(message.payload);
                            } else {
                                throw new Error('Missing text for sendMessage.');
                            }
                            break;
                        // Deprecated/Removed Commands
                        case 'checkServerStatus':
                        case 'testConnection':
                            logWarning(`[ChatWebviewProvider] Received obsolete command: ${message.command}. Use start/stop/refresh instead.`);
                            this._view?.webview.postMessage({ command: 'showError', payload: { message: `Command '${message.command}' is obsolete.` } });
                            break;
                        default:
                            logWarning('[ChatWebviewProvider] Received unknown command from webview: ' + message.command);
                    }
                } catch (error) {
                    const errorMsg = getErrorMessage(error);
                    logError(`[ChatWebviewProvider] Error processing command ${message.command}: ${errorMsg}`, error);
                    // Send error back to webview
                    this._view?.webview.postMessage({
                        command: 'showError', // Generic error command for webview
                        payload: { message: `Error processing command '${message.command}': ${errorMsg}` }
                    });
                     // Also show in VS Code UI for visibility
                    vscode.window.showErrorMessage(`Chat Provider Error (${message.command}): ${errorMsg}`);
                }
            },
            undefined,
            this._disposables
        );
    }

    // --- Specific Message Handlers ---

    private async handleRunServerTool(payload: { serverId: string; request: string }): Promise<any> {
        logDebug('[ChatWebviewProvider] handleRunServerTool received:', payload);
        const { serverId: targetServerId, request: requestString } = payload;
        // Validation already happened in the listener
        try {
            // Check status first to potentially avoid unnecessary start attempts
            const statusEvent = this._serverManager.getServerStatus(targetServerId);
            if (!statusEvent || statusEvent.status === ServerStatus.Disconnected || statusEvent.status === ServerStatus.Error) {
                logInfo(`[ChatWebviewProvider] Server ${targetServerId} not running for runServerTool, attempting to start...`);
                await this._serverManager.startServer(targetServerId);
                // Consider adding a brief wait or checking status again after start
                await new Promise(resolve => setTimeout(resolve, 300)); // Small delay
                const newStatus = this._serverManager.getServerStatus(targetServerId);
                if (newStatus?.status !== ServerStatus.Connected && newStatus?.status !== ServerStatus.Connecting) {
                    throw new Error(`Server ${targetServerId} failed to start or connect.`);
                }
            } else if (statusEvent.status === ServerStatus.Connecting) {
                 logInfo(`[ChatWebviewProvider] Server ${targetServerId} is still connecting, waiting briefly...`);
                 await new Promise(resolve => setTimeout(resolve, 1000)); // Wait longer if connecting
                 const newStatus = this._serverManager.getServerStatus(targetServerId);
                 if (newStatus?.status !== ServerStatus.Connected) {
                     throw new Error(`Server ${targetServerId} did not connect successfully.`);
                 }
            } else {
                logDebug(`[ChatWebviewProvider] Server ${targetServerId} status is ${statusEvent.status}. Proceeding.`);
            }

            // Use callServerMethod
            const requestObject = JSON.parse(requestString);
            if (!requestObject.method) {
                throw new Error('Invalid request payload: missing method.');
            }
            logDebug(`[ChatWebviewProvider] Calling server method ${requestObject.method} on ${targetServerId}`);
            const result = await this._serverManager.callServerMethod(
                targetServerId,
                requestObject.method,
                requestObject.params
            );
            logDebug(`[ChatWebviewProvider] Received result from ${targetServerId} for runServerTool:`, result);
            return result; // Return the parsed result directly

        } catch (error) {
            logError(`[ChatWebviewProvider] Error in handleRunServerTool for ${targetServerId}:`, getErrorMessage(error));
            throw error; // Re-throw error to be caught by the caller and sent to webview
        }
    }

    private async handleSaveServer(payload: { serverId: string, config: ServerConfig }): Promise<void> {
        const { serverId, config } = payload;
        logInfo(`[ChatWebviewProvider] Received save request for server: ${serverId}`);
        try {
            const statusEvent = this._serverManager.getServerStatus(serverId);
            let wasRunning = statusEvent?.status === ServerStatus.Connected || statusEvent?.status === ServerStatus.Connecting;

            logDebug(`[ChatWebviewProvider] Saving configuration for ${serverId} to ConfigStorage.`);
            // Use the newly implemented method
            await this._configStorage.addOrUpdateServer(serverId, config);

            this._view?.webview.postMessage({
                command: 'serverSaved',
                payload: { serverId: serverId, success: true }
            });
            logInfo(`[ChatWebviewProvider] Configuration for ${serverId} saved successfully.`);

            if (wasRunning) {
                 logInfo(`[ChatWebviewProvider] Server ${serverId} was running, stopping before applying new config...`);
                 await this._serverManager.stopServer(serverId);
                 await new Promise(resolve => setTimeout(resolve, 500));
            }

            logInfo(`[ChatWebviewProvider] Starting/Restarting server ${serverId} with new configuration...`);
            await this._serverManager.startServer(serverId);

        } catch (error) {
             logError(`[ChatWebviewProvider] Error saving or restarting server ${serverId}:`, getErrorMessage(error));
             this._view?.webview.postMessage({
                 command: 'serverSaveError',
                 payload: { serverId: serverId, success: false, error: getErrorMessage(error) }
             });
             vscode.window.showErrorMessage(`Failed to save/restart server ${serverId}: ${getErrorMessage(error)}`);
        }
    }

    private async handleRequestRemoveServerConfirmation(serverId: string): Promise<void> {
         // Validation happened in listener
         if (!serverId) return;

        const confirmation = await vscode.window.showWarningMessage(
            `Are you sure you want to delete the server configuration for "${serverId}"? The server process (if running) will be stopped. This cannot be undone.`,
            { modal: true },
            'Delete Configuration', // More specific label
            'Cancel'
        );

        if (confirmation === 'Delete Configuration') {
            logInfo(`[ChatWebviewProvider] User confirmed deletion for: ${serverId}. Executing removeServerConfiguration...`);
             try {
                 // Use the manager method which handles stopping and removing config
                 const success = await this._serverManager.removeServerConfiguration(serverId);
                 if (success) {
                      logInfo(`[ChatWebviewProvider] Successfully removed configuration and stopped server ${serverId}.`);
                      // Let status update handle UI, maybe send confirmation message
                      this._view?.webview.postMessage({ command: 'systemMessage', payload: { message: `Server configuration ${serverId} removed.`, type: 'success' } });
                 } else {
                      // This case might indicate an issue within removeServerConfiguration not throwing
                      throw new Error("Server manager reported failure during removal process.");
                 }
             } catch (error) {
                 const errorMsg = getErrorMessage(error);
                 logError(`[ChatWebviewProvider] Error removing server ${serverId}: ${errorMsg}`);
                 this._view?.webview.postMessage({ command: 'showError', payload: { message: `Failed to remove server ${serverId}: ${errorMsg}` } });
             }
        } else {
            logInfo(`[ChatWebviewProvider] User cancelled deletion for: ${serverId}`);
            this._view?.webview.postMessage({ command: 'systemMessage', payload: { message: `Deletion cancelled for ${serverId}.`, type: 'info' } });
        }
    }

     private async handleGetServerDetails(payload: { serverId: string }): Promise<void> {
        // Validation happened in listener
        const { serverId } = payload;
        if (!serverId) return;

        logDebug(`[ChatWebviewProvider] Getting details for server ${serverId}`);
        const config = this._configStorage.getServer(serverId); // Get config from storage
        const statusEvent = this._serverManager.getServerStatus(serverId); // Get status from manager

        if (!config) {
             logWarning(`[ChatWebviewProvider] Config not found for server ${serverId} during detail request.`);
             this._view?.webview.postMessage({ command: 'serverDetails', payload: { serverId, error: 'Configuration not found' } });
             return;
        }

        // Construct the payload using config and status info
        const details: ServerDetailsPayload = {
            serverId: serverId,
            config: config,
            status: statusEvent?.status ?? ServerStatus.Disconnected,
            capabilities: statusEvent?.capabilities, // Capabilities are included in statusEvent
            error: statusEvent?.error // Error is included in statusEvent
        };

        this._view?.webview.postMessage({
            command: 'serverDetails',
            payload: details
        });
    }

    private async handleRequestAbilityList(payload: { serverId: string }): Promise<void> {
         // Validation happened in listener
        const { serverId } = payload;
        if (!serverId) return;

        logDebug(`[ChatWebviewProvider] Handling request for abilities from server: ${serverId}`);
        try {
            // Check status first
            const statusEvent = this._serverManager.getServerStatus(serverId);
            if (!statusEvent || statusEvent.status === ServerStatus.Disconnected || statusEvent.status === ServerStatus.Error) {
                 logInfo(`[ChatWebviewProvider] Server ${serverId} not running for ability list, attempting to start...`);
                 await this._serverManager.startServer(serverId);
                 this._view?.webview.postMessage({ command: 'systemMessage', payload: { message: `Starting server ${serverId} to fetch capabilities...`, type: 'info' } });
                 // Let the status update handle sending capabilities once connected/refreshed
                 return;
            }

            // Server is running or connecting, check if capabilities are already known
            const capabilities = this._serverManager.getCapabilities(serverId);

            if (capabilities) {
                logInfo(`[ChatWebviewProvider] Found cached/current capabilities for ${serverId}, sending to webview.`);
                this._view?.webview.postMessage({
                    command: 'updateAbilityList',
                    payload: { serverId: serverId, abilities: capabilities }
                });
            } else {
                 // Server is running/connecting, but capabilities unknown. Trigger a refresh.
                 logWarning(`[ChatWebviewProvider] Capabilities not yet available for server ${serverId}. Triggering refresh.`);
                 await this._serverManager.refreshCapabilities(serverId); // Attempt refresh
                 this._view?.webview.postMessage({ command: 'systemMessage', payload: { message: `Refreshing capabilities for ${serverId}...`, type: 'info' } });
                 // The subsequent 'serverStatusChanged' event should contain the capabilities if successful.
            }
        } catch (error) {
            logError(`[ChatWebviewProvider] Error requesting abilities from ${serverId}:`, getErrorMessage(error));
             this._view?.webview.postMessage({
                 command: 'updateAbilityListError',
                 payload: { serverId: serverId, error: `Failed to get abilities: ${getErrorMessage(error)}` }
             });
        }
    }

     private async handleSendMessage(payload: { text: string }): Promise<void> {
         // Validation happened in listener
        const originalText = payload.text;
        if (!originalText) return;

        logDebug(`[ChatWebviewProvider][sendMessage] Handling text: "${originalText}"`);
        this._view?.webview.postMessage({ command: 'systemMessage', payload: { message: `Processing: "${originalText}"...`, type: 'info' } });

        // --- Simplified Message Sending Logic ---
        // TODO: Reimplement sophisticated tool matching and parameter extraction if needed,
        // using getCapabilities and potentially callServerMethod for tool execution.
        // For now, send to the first connected server using a generic method.

        const connectedServers = this._serverManager.getConnectedServerIdsAndCapabilities();
        const targetServer = connectedServers.length > 0 ? connectedServers[0] : null;

        if (targetServer) {
            const targetServerId = targetServer.serverId;
             logInfo(`[ChatWebviewProvider][sendMessage] Sending to first connected server: ${targetServerId}`);
            try {
                // Construct a generic request (example: treat text as a prompt)
                const method = "process_prompt"; // Server needs to handle this method
                const params = { prompt: originalText };

                logDebug(`[ChatWebviewProvider][sendMessage] Calling method '${method}' on ${targetServerId}`);
                const result = await this._serverManager.callServerMethod(
                    targetServerId,
                    method,
                    params
                );
                logInfo(`[ChatWebviewProvider][sendMessage] Received result from ${targetServerId}:`, result);

                // Send result back to webview (adapt structure as needed)
                 this._view?.webview.postMessage({
                    command: 'addMessage',
                    payload: { role: 'assistant', text: JSON.stringify(result, null, 2) } // Pretty print JSON result
                 });

            } catch (sendError: unknown) {
                const errorMsg = getErrorMessage(sendError);
                logError(`[ChatWebviewProvider][sendMessage] Error sending message to ${targetServerId}: ${errorMsg}`);
                this._view?.webview.postMessage({ command: 'showError', payload: { message: `Failed to send command to ${targetServerId}: ${errorMsg}` } });
            }
        } else {
            logWarning('[ChatWebviewProvider][sendMessage] No connected servers found to send message.');
            this._view?.webview.postMessage({ command: 'showError', payload: { message: "No connected servers available to process the message." } });
        }
    }

    // --- Server Status Handling ---

    private handleServerStatusChange(event: ServerStatusEvent): void {
        logDebug(`[ChatWebviewProvider] Handling server status event: ${event.serverId} -> ${event.status}`);

        // Update webview status (send the whole event object)
        if (this._view && this._view.visible) {
            this._view.webview.postMessage({
                command: 'updateSingleServerStatus', // Command webview expects
                payload: event // Send the full status event
            });
        }

        // NOTE: Fetching abilities on connect is handled by McpServerManager.
        // The status event already includes capabilities.
        // Clearing local ability cache on disconnect/error:
        if (event.status === ServerStatus.Disconnected || event.status === ServerStatus.Error) {
             if (this._serverAbilities.has(event.serverId)) {
                logInfo(`[ChatWebviewProvider] Server ${event.serverId} disconnected/errored. Clearing local abilities cache.`);
                this._serverAbilities.delete(event.serverId); // Clear local cache if used by determineTarget...
            }
        }
        // If using the local cache (_serverAbilities), update it when capabilities arrive
        if (event.capabilities && event.capabilities.capabilities) {
             this.storeAbilities(event.serverId, event.capabilities.capabilities as ServerAbility[]); // Update local cache
        }
    }

     // Method to store abilities (maybe used by determineTarget... logic)
    public storeAbilities(serverId: string, abilities: ServerAbility[]): void {
         // This method might be redundant if determineTarget... uses getCapabilities directly
         if (serverId && abilities && Array.isArray(abilities)) {
            logInfo(`[ChatProvider] Storing/Updating ${abilities.length} abilities in local cache for ${serverId}.`);
            this._serverAbilities.set(serverId, abilities);
            // No need to notify webview here, status event already does
        } else {
            logWarning(`[ChatProvider] Invalid abilities data provided for server ${serverId}.`);
        }
    }


    // --- Helper Methods ---

    public updateWebviewServerList(): void {
        logDebug('[ChatWebviewProvider] Public updateWebviewServerList called.');
        this._updateServerListInWebview();
    }

    private async _updateServerListInWebview(): Promise<void> {
        if (!this._view) {
            logDebug('[ChatWebviewProvider] Cannot update webview server list: view is undefined');
            return;
        }
        logDebug('[ChatWebviewProvider] Updating server list in webview...');
        try {
            const serverConfigs = this._configStorage.getAllServers(); // Get configs from storage
            const serverStatuses = this._serverManager.getAllServerStatuses(); // Get current statuses from manager

            const serverListForWebview = Object.entries(serverConfigs).map(([id, config]) => {
                const statusInfo = serverStatuses.find(s => s.serverId === id);
                const isRunning = statusInfo?.status === ServerStatus.Connected || statusInfo?.status === ServerStatus.Connecting;

                // Construct the object sent to the webview
                const serverEntry: ServerListEntry = {
                    id: id,
                    config: config, // Send full config
                    status: statusInfo?.status ?? ServerStatus.Disconnected, // Use status from event or default
                    isRunning: isRunning,
                    error: statusInfo?.error, // Include error from status event
                    capabilities: statusInfo?.capabilities // Include capabilities from status event
                };
                return serverEntry;
            });

            logDebug(`[ChatWebviewProvider] Sending ${serverListForWebview.length} server details to webview.`);
            this._view.webview.postMessage({
                command: 'updateServerList', // Command webview expects
                payload: serverListForWebview
            });
        } catch (error) {
             logError('[ChatWebviewProvider] Error fetching or sending server list:', getErrorMessage(error));
             this._view?.webview.postMessage({ command: 'showError', payload: { message: 'Failed to update server list.' } });
        }
    }

    // --- Serialization Logic ---

    async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel, state: any): Promise<void> {
        // This provider uses resolveWebviewView, so deserializeWebviewPanel might not be strictly needed
        // unless you explicitly save/restore panel state beyond the view's lifetime.
        logInfo(`[ChatWebviewProvider] Attempting to deserialize panel (state ignored). ID: ${webviewPanel.viewType}`);
        this._panel = webviewPanel; // Store the panel reference if needed for specific actions

        // Reset the webview options and content
        webviewPanel.webview.options = {
            enableScripts: true,
             localResourceRoots: [
                vscode.Uri.joinPath(this._extensionUri, 'media'),
                vscode.Uri.joinPath(this._extensionUri, 'dist')
            ]
        };
        webviewPanel.webview.html = getWebviewContent(webviewPanel.webview, this._extensionUri); // Correct path

        // Re-attach listeners
        this.setupWebviewListeners(webviewPanel.webview as any); // Cast might be needed if setup expects WebviewView

        // Restore dispose listener
        webviewPanel.onDidDispose(() => {
            logInfo('[ChatWebviewProvider] Deserialized panel disposed.');
            if (this._panel === webviewPanel) { // Ensure it's the same panel
                 this._panel = undefined;
            }
        }, null, this._disposables);

         // Send initial state after restoring
        setTimeout(() => {
            logInfo('[ChatWebviewProvider] Sending initial server list update to deserialized webview.');
            this._updateServerListInWebview();
        }, 500);
    }

     // --- Methods called by extension.ts ---

     public handleConfigChange(): void {
        logInfo('[ChatWebviewProvider] Handling configuration change notification.');
        this.updateWebviewServerList();
    }

    // Add missing updateChat method referenced in extension.ts (simple example)
    public updateChat(message: string): void {
        if (!this._view) { // Use _view now
            logWarning('[ChatWebviewProvider] Cannot update chat - view not initialized');
            return;
        }
        logInfo(`[ChatWebviewProvider] Updating chat with message: ${message}`);
        this._view.webview.postMessage({ // Use _view
            command: 'addMessage', // Use a consistent command
            payload: { role: 'system', text: message } // Use payload structure
        });
    }

    // Add missing handleStatusUpdate method (simple example - forwards to internal handler)
    public handleStatusUpdate(event: ServerStatusEvent): void { // Use ServerStatusEvent type
        logInfo(`[ChatWebviewProvider] Forwarding status update for ${event.serverId}: ${event.status}`);
        this.handleServerStatusChange(event); // Call the internal handler
    }

    // Removed determineTargetAndFormatMessage as it contained old/removed method calls
    // It needs to be reimplemented based on available server capabilities (e.g., using getCapabilities)
    // and the new callServerMethod if tool calls are intended.
} 