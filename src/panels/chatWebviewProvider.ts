import * as vscode from 'vscode';
import { McpServerManager } from '../services/McpServerManager';
import { ConfigStorage } from '../services/ConfigStorage';
import { logDebug, logError, logInfo, logWarning, getErrorMessage } from '../utils/logger';
import { ServerConfig, ModelRequest } from '../models/Types'; // Import ServerConfig and ModelRequest
import { getWebviewContent } from './webview/chatWebview'; // Assuming this is separate


// Potential types for abilities (replace 'any' later)
// Match the ServerCapability definition more closely if available
type ServerAbility = {
    name: string;
    description: string;
    parameters?: Record<string, any>; // If server provides parameter info
};

export class ChatWebviewProvider implements vscode.WebviewPanelSerializer {
    private static readonly viewType = 'mcpChat';

    // Add static instance property for extension.ts references
    public static instance: ChatWebviewProvider | undefined;

    private _panel: vscode.WebviewPanel | undefined;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];

    // Dependencies injected via constructor
    private readonly _context: vscode.ExtensionContext;
    private readonly _serverManager: McpServerManager;
    private readonly _configStorage: ConfigStorage;

    // State managed by the provider
    private _chatHistory: { role: string; text: string }[] = [];
    private _serverAbilities = new Map<string, ServerAbility[]>();

    constructor(
        context: vscode.ExtensionContext,
        serverManager: McpServerManager,
        configStorage: ConfigStorage
    ) {
        // Set the static instance
        ChatWebviewProvider.instance = this;

        this._context = context;
        this._extensionUri = context.extensionUri;
        this._serverManager = serverManager;
        this._configStorage = configStorage;

        // Registration is now handled in extension.ts
        // vscode.window.registerWebviewPanelSerializer(ChatWebviewProvider.viewType, this);

        // Listen to server status changes to update abilities and panel
        this._serverManager.on('status', this.handleServerStatusChange.bind(this));
        logInfo('[ChatProvider] Initialized and listening to server status.');
    }

    public showPanel(): void {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : vscode.ViewColumn.One;

        logInfo(`[ChatProvider] showPanel called. Target column: ${column}`);

        if (this._panel) {
            // If we already have a panel, show it.
            logInfo('[ChatProvider] Revealing existing chat panel.');
            try {
                this._panel.reveal(column);
                logInfo('[ChatProvider] Existing panel revealed successfully.');
            } catch (revealError) {
                logError(`[ChatProvider] Error revealing existing panel: ${getErrorMessage(revealError)}`);
            }
        } else {
            // Otherwise, create a new panel.
            logInfo('[ChatProvider] Creating new chat panel.');
            try {
                this._panel = vscode.window.createWebviewPanel(
                    ChatWebviewProvider.viewType,
                    'MCP Chat',
                    column || vscode.ViewColumn.One,
                    {
                        enableScripts: true,
                        retainContextWhenHidden: true,
                        localResourceRoots: [
                            vscode.Uri.joinPath(this._extensionUri, 'media'),
                            vscode.Uri.joinPath(this._extensionUri, 'dist')
                        ]
                    }
                );
                logInfo('[ChatProvider] New panel created successfully.');

                // Set the webview's initial html content
                logInfo('[ChatProvider] Setting webview HTML content...');
                this._panel.webview.html = getWebviewContent(this._panel.webview, this._extensionUri);
                logInfo('[ChatProvider] Webview content set.');

                // Set up message listeners
                this.setupChatPanelListeners(this._panel);
                logInfo('[ChatProvider] Listeners set up.');

                // Listen for when the panel is disposed
                // This happens when the user closes the panel or when the panel is closed programmatically
                this._panel.onDidDispose(() => this.disposePanel(), null, this._disposables);
                logInfo('[ChatProvider] Dispose listener set up.');

                // Send initial state shortly after creation
                setTimeout(() => {
                    logInfo('[ChatProvider] Sending initial server list update to webview.');
                    this.updateWebviewWithServerList(this._panel);
                    // Send any other initial state like chat history if needed
                }, 500); // Delay to ensure webview is ready
            } catch (creationError) {
                logError(`[ChatProvider] Error creating new webview panel: ${getErrorMessage(creationError)}`);
                this._panel = undefined; // Ensure panel is reset on error
                vscode.window.showErrorMessage(`Failed to create MCP Chat panel: ${getErrorMessage(creationError)}`);
            }
        }
    }

    // Handle panel disposal
    private disposePanel(): void {
        logInfo('[ChatProvider] Disposing chat panel resources.');
        this._panel = undefined;
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
        // Dispose other resources like event listeners if necessary
        // (Server status listener might be handled elsewhere or kept for lifetime)
    }

    // --- Webview Message Handling --- 

    private setupChatPanelListeners(panel: vscode.WebviewPanel): void {
        logInfo('[ChatProvider] Setting up chat panel listeners');
        panel.webview.onDidReceiveMessage(
            async (message) => {
                logDebug(`[ChatProvider][WebView->Ext] Received command: ${message.command}, Data: ${JSON.stringify(message)}`);
                try {
                    switch (message.command) {
                        case 'sendMessage':
                            await this.handleSendMessage(message, panel);
                            break;
                        case 'getInitialState':
                             logInfo('[ChatProvider] Webview requested initial state.');
                            this.updateWebviewWithServerList(panel);
                            // Send history if needed: panel.webview.postMessage({ command: 'loadHistory', history: this._chatHistory });
                            panel.webview.postMessage({ command: 'connectionTest', status: 'success', time: new Date().toISOString() });
                            break;
                        case 'refreshServers':
                             logDebug('[ChatProvider] Webview requested server list refresh.');
                            await this.updateWebviewWithServerList(panel);
                            panel.webview.postMessage({ command: 'showStatus', status: 'success', message: 'Server list refreshed' });
                            break;
                        case 'requestRemoveServerConfirmation':
                             logDebug(`[ChatProvider] Webview requested remove confirmation for: ${message.serverId}`);
                            await this.handleRequestRemoveServerConfirmation(message.serverId, panel);
                            break;
                        case 'checkServerStatus':
                             logDebug(`[ChatProvider] Webview requested status check for: ${message.serverId}`);
                            await this.handleCheckServerStatus(message.serverId, panel);
                            break;
                         case 'testConnection':
                            logDebug(`[ChatProvider] Webview requested connection test for: ${message.serverId}`);
                            await this.handleTestConnection(message.serverId, panel);
                            break;
                         case 'abilities_response':
                            // This is unusual - abilities response should come from the serverManager listener
                            // However, if a server sends it directly as a message, handle it.
                            logWarning(`[ChatProvider] Received 'abilities_response' via webview message for ${message.serverId}. Handling it, but expected via server event.`);
                            this.storeAbilities(message.serverId, message.abilities);
                            break;
                        case 'clearChat':
                            logInfo('[ChatProvider] Chat cleared by user.');
                            this._chatHistory = []; // Clear history if managing it here
                            break;
                        // Forward simple commands directly to VS Code command execution
                        case 'addServer':
                            logDebug('[ChatProvider] Forwarding addServer command.');
                            vscode.commands.executeCommand('mcpClient.addServer');
                            break;
                        case 'removeServer': // Consider removing this if using specific deletion
                            logDebug('[ChatProvider] Forwarding removeServer command (may be deprecated).');
                            vscode.commands.executeCommand('mcpClient.removeServer');
                            break;
                        // Deprecated/Internal commands previously handled here might be removed or logged
                        case 'debugForceDeleteServer':
                        case 'removeSpecificServer':
                            logWarning(`[ChatProvider] Received deprecated command: ${message.command}`);
                            panel.webview.postMessage({ command: 'error', error: `Command ${message.command} is no longer supported directly.` });
                            break;
                        default:
                            logWarning('[ChatProvider] Received unknown command from webview: ' + message.command);
                    }
                } catch (error) {
                    const errorMsg = getErrorMessage(error);
                    logError(`[ChatProvider] Error processing command ${message.command}: ${errorMsg}`);
                    this.sendErrorToWebview(panel, `Error processing command ${message.command}: ${errorMsg}`);
                }
            },
            undefined,
            this._disposables // Use panel-specific disposables
        );
    }

    // --- Specific Message Handlers --- 

    private async handleSendMessage(message: any, panel: vscode.WebviewPanel): Promise<void> {
        const originalText = message.text || '';
        logDebug(`[ChatProvider][sendMessage] Handling text: "${originalText}"`);

        // Add user message to history (optional, if you implement history display)
        // this._chatHistory.push({ role: 'user', text: originalText });
        // panel.webview.postMessage({ command: 'addMessage', message: { role: 'user', text: originalText } });

        const { targetServerId, messageToSend, isToolCall } = await this.determineTargetAndFormatMessage(
            originalText,
            this._serverAbilities,
            this._serverManager,
            this._configStorage,
            this._context
        );

        if (targetServerId && messageToSend) {
            logInfo(`[ChatProvider][sendMessage] Determined target: ${targetServerId}, Tool Call: ${isToolCall}. Sending...`);
             panel.webview.postMessage({ command: 'systemMessage', message: `Sending command to ${targetServerId}...`, type: 'info', duration: 2000 }); // Give feedback
            try {
                logDebug(`[ChatProvider][sendMessage] Ensuring server ${targetServerId} is ready.`);
                await this._serverManager.ensureServerStarted(targetServerId); // Ensure server is running

                // --- Construct ModelRequest ---
                let requestObject: ModelRequest;
                try {
                    // messageToSend is the JSON string {"tool": "...", "params": {...}}
                    const toolPayload = JSON.parse(messageToSend); // We parse it mainly to potentially grab an ID if needed

                    requestObject = {
                        // The entire structured JSON for the tool call becomes the prompt
                        prompt: messageToSend,
                        // Use a specific model name if appropriate for the server, e.g., 'filesystem'
                        // Or keep it generic if the server routes based on the prompt content
                        model: "filesystem", // Using server name as model hint
                        id: toolPayload.id // Add an ID if the tool payload had one (optional)
                    };
                    logDebug(`[ChatProvider][sendMessage] Constructed ModelRequest: ${JSON.stringify(requestObject)}`);

                } catch (parseError) {
                    logError(`[ChatProvider][sendMessage] Failed to parse the determined messageToSend: ${messageToSend}. Error: ${getErrorMessage(parseError)}`);
                    this.sendErrorToWebview(panel, `Internal error: Failed to format message before sending.`);
                    return; // Stop processing
                }
                // --- End Construct ModelRequest ---

                logDebug(`[ChatProvider][sendMessage] Sending ModelRequest to ${targetServerId}`);
                const responseString = await this._serverManager.sendMessage(targetServerId, requestObject);
                logInfo(`[ChatProvider][sendMessage] Raw response received from ${targetServerId}: ${responseString}`);

                // --- Process and display response ---
                try {
                    const responseData = JSON.parse(responseString);
                    logDebug(`[ChatProvider][sendMessage] Parsed response: ${JSON.stringify(responseData)}`);
                    // Send structured data to the webview for rendering
                    panel.webview.postMessage({ command: 'addMessage', message: { role: 'server', serverId: targetServerId, data: responseData } });
                } catch (jsonError) {
                    logError(`[ChatProvider][sendMessage] Failed to parse JSON response from ${targetServerId}: ${responseString} - Error: ${getErrorMessage(jsonError)}`);
                    // Display raw response as text if parsing fails
                    panel.webview.postMessage({ command: 'addMessage', message: { role: 'server', serverId: targetServerId, text: `(Raw/Invalid JSON response): ${responseString}` } });
                }
                // --- End Process response ---

            } catch (sendError: unknown) {
                const errorMsg = getErrorMessage(sendError);
                logError(`[ChatProvider][sendMessage] Error sending message to ${targetServerId}: ${errorMsg}`);
                this.sendErrorToWebview(panel, `Failed to send command to ${targetServerId}: ${errorMsg}`);
            }
        } else {
            // Handle the case where determineTargetAndFormatMessage decided not to send (no tool match / missing params)
            logInfo('[ChatProvider][sendMessage] No target server or formatted message determined. Informing user.');
             panel.webview.postMessage({ command: 'addMessage', message: { role: 'system', text: "Sorry, I couldn't understand that command, find a suitable tool, or extract the required parameters." } });
        }
    }

    private async handleRequestRemoveServerConfirmation(serverId: string | undefined, panel: vscode.WebviewPanel): Promise<void> {
         if (!serverId) {
            logError("[ChatProvider][handleRequestRemoveServerConfirmation] No serverId provided.");
            this.sendErrorToWebview(panel, 'Cannot request deletion confirmation: Missing server ID.');
            return;
        }
        const confirmation = await vscode.window.showWarningMessage(
            `Are you sure you want to delete the server "${serverId}"? This cannot be undone.`,
            { modal: true },
            'Delete',
            'Cancel'
        );

        if (confirmation === 'Delete') {
            logInfo(`[ChatProvider] User confirmed deletion for: ${serverId}. Executing deletion...`);
            // Call the central deletion function (now likely needs context)
            // This might need to become a command or be passed the dependencies
             try {
                // Option 1: Execute a command that handles deletion
                 await vscode.commands.executeCommand('mcpClient.executeDeleteServer', serverId);

                // Option 2: If executeServerDeletion is moved/exposed (less ideal)
                // await executeServerDeletion(serverId, panel, this._context); 

                 // Give feedback (deletion command should handle its own feedback ideally)
                 panel.webview.postMessage({ command: 'systemMessage', message: `Deletion process initiated for ${serverId}.`, type: 'info' });

            } catch (error) {
                 const errorMsg = getErrorMessage(error);
                 logError(`[ChatProvider] Error initiating deletion for ${serverId}: ${errorMsg}`);
                 this.sendErrorToWebview(panel, `Failed to start deletion for ${serverId}: ${errorMsg}`);
             }
        } else {
            logInfo(`[ChatProvider] User cancelled deletion for: ${serverId}`);
            panel.webview.postMessage({ command: 'systemMessage', message: `Deletion cancelled for ${serverId}.`, type: 'info' });
        }
    }

    private async handleCheckServerStatus(serverId: string | undefined, panel: vscode.WebviewPanel): Promise<void> {
        if (!serverId) {
            this.sendErrorToWebview(panel, "No server specified for status check.");
            return;
        }
        logInfo(`[ChatProvider] Checking status for server ${serverId}`);
        try {
            const serverConfig = this._configStorage.getServer(serverId);
            if (!serverConfig) {
                throw new Error(`Configuration not found for server "${serverId}".`);
            }
            this._serverManager.setDynamicConfig(serverId, serverConfig);

            const hasServer = this._serverManager.hasServer(serverId);
            let isRunning = false;
            if (hasServer) {
                try {
                    isRunning = this._serverManager.isServerRunning?.(serverId) || false;
                } catch (err) {
                    logWarning(`[ChatProvider] Error checking if server "${serverId}" is running: ${getErrorMessage(err)}`);
                }
            }
            logDebug(`[ChatProvider] Server ${serverId} - Has: ${hasServer}, Running: ${isRunning}`);

            if (!isRunning) {
                logInfo(`[ChatProvider] Server ${serverId} not running, attempting auto-start.`);
                panel.webview.postMessage({ command: 'updateServerStatus', serverId: serverId, status: 'connecting', text: `Attempting to start ${serverId}...` });
                try {
                    await this._serverManager.ensureServerStarted(serverId); // ensure handles start/restart
                    logInfo(`[ChatProvider] Server ${serverId} started/restarted successfully.`);
                    panel.webview.postMessage({ command: 'updateServerStatus', serverId: serverId, status: 'connected', text: `Server ${serverId} started successfully.` });
                } catch (startError) {
                     logError(`[ChatProvider] Failed to auto-start server ${serverId}: ${getErrorMessage(startError)}`);
                     panel.webview.postMessage({ command: 'updateServerStatus', serverId: serverId, status: 'disconnected', text: `Failed to start server ${serverId}: ${getErrorMessage(startError)}` });
                 }
            } else {
                logInfo(`[ChatProvider] Server ${serverId} is running. Pinging...`);
                // Optionally ping if you have such a method
                 try {
                    await this._serverManager.pingServer(serverId); // Assumes pingServer exists
                    panel.webview.postMessage({ command: 'updateServerStatus', serverId: serverId, status: 'connected', text: `Server ${serverId} is connected and responsive.` });
                 } catch (pingError) {
                     logWarning(`[ChatProvider] Server ${serverId} running but failed ping: ${getErrorMessage(pingError)}`);
                     panel.webview.postMessage({ command: 'updateServerStatus', serverId: serverId, status: 'connected', text: `Server ${serverId} is connected (ping failed).` }); // Still connected, but maybe issue
                 }
            }
        } catch (err: unknown) {
            logError(`[ChatProvider] Error checking server status for ${serverId}: ${getErrorMessage(err)}`);
            panel.webview.postMessage({ command: 'updateServerStatus', serverId: serverId, status: 'disconnected', text: `Error checking status: ${getErrorMessage(err)}` });
        }
    }

     private async handleTestConnection(serverId: string | undefined, panel: vscode.WebviewPanel): Promise<void> {
        if (!serverId) {
            this.sendErrorToWebview(panel, "No server specified for connection test.");
            return;
        }
        logDebug(`[ChatProvider][testConnection] Testing connection to ${serverId}...`);
        try {
            panel.webview.postMessage({ command: 'systemMessage', message: `Testing connection to ${serverId}...`, type: 'info' });
            await this._serverManager.ensureServerStarted(serverId);
            logInfo(`[ChatProvider][testConnection] Successfully connected to server: ${serverId}`);
            panel.webview.postMessage({
                command: 'systemMessage',
                message: `Successfully connected to server: ${serverId}`,
                type: 'success',
                duration: 5000
            });
        } catch (error) {
            const errorMsg = getErrorMessage(error);
            logError(`[ChatProvider][testConnection] Failed to connect to server ${serverId}: ${errorMsg}`);
            panel.webview.postMessage({
                command: 'systemMessage',
                message: `Failed to connect to server ${serverId}: ${errorMsg}`,
                type: 'error'
            });
        }
    }


    // --- Server Status Handling --- 

    private async handleServerStatusChange(event: { serverId: string; status: string }): Promise<void> {
        logDebug(`[ChatProvider] Handling server status event: ${event.serverId} -> ${event.status}`);

        // Update webview status
        if (this._panel && this._panel.visible) {
            this._panel.webview.postMessage({
                command: 'updateSingleServerStatus',
                serverId: event.serverId,
                status: event.status
            });
        }

        // Fetch abilities on connect
        const readyStatus = 'connected'; // Or whatever status indicates readiness
        if (event.status === readyStatus) {
            logInfo(`[ChatProvider] Server ${event.serverId} connected. Fetching abilities.`);
            try {
                // Create a proper ModelRequest object for the abilities request
                const abilityRequestObject: ModelRequest = {
                    prompt: JSON.stringify({ command: "get_abilities" }), // Stringify the command data for the prompt
                    model: "system" // Use a specific model name or "default" for system requests
                    // id can be added if needed for tracking: id: uuidv4()
                };
                await this._serverManager.sendMessage(event.serverId, abilityRequestObject);
                logInfo(`[ChatProvider] Sent get_abilities request to ${event.serverId}.`);
            } catch (error) {
                logError(`[ChatProvider] Failed to send get_abilities to ${event.serverId}: ${getErrorMessage(error)}`);
            }
        } else {
            // Clear abilities on disconnect
            if (this._serverAbilities.has(event.serverId)) {
                logInfo(`[ChatProvider] Server ${event.serverId} disconnected. Clearing abilities.`);
                this._serverAbilities.delete(event.serverId);
            }
        }
    }

    // Method to store abilities (could be called by server manager or response handler)
    public storeAbilities(serverId: string, abilities: ServerAbility[]): void {
         if (serverId && abilities && Array.isArray(abilities)) {
            logInfo(`[ChatProvider] Storing ${abilities.length} abilities for ${serverId}.`);
            this._serverAbilities.set(serverId, abilities);
            logDebug(`[ChatProvider] Stored abilities for ${serverId}: ${JSON.stringify(abilities)}`);
            // Optionally notify webview if needed
            if (this._panel) {
                 this._panel.webview.postMessage({ command: 'abilitiesUpdated', serverId, abilities });
             }
        } else {
            logWarning(`[ChatProvider] Invalid abilities data received for server ${serverId}.`);
        }
    }

    // --- Helper Methods --- 

    // Public method to trigger a server list update in the webview
    public updateWebviewServerList(): void {
        logDebug('[ChatProvider] Public updateWebviewServerList called.');
        // Call the private method, ensuring the panel exists
        if (this._panel) {
            this.updateWebviewWithServerList(this._panel);
        } else {
            logDebug('[ChatProvider] Panel not open, skipping webview update.');
        }
    }

    // Private method that actually performs the update
    private async updateWebviewWithServerList(panel: vscode.WebviewPanel | undefined): Promise<void> {
        if (!panel || !panel.webview) {
            logDebug('[ChatProvider] Cannot update webview server list: panel or webview is undefined');
            return;
        }

        try {
            const serverNames = this._configStorage.getServerNames();
            logInfo(`[ChatProvider] Updating webview with ${serverNames.length} servers from config.`);
            const serverListPromises = serverNames.map(async (serverName) => {
                const serverConfig = this._configStorage.getServer(serverName);
                if (!serverConfig) {
                    logWarning(`[ChatProvider] Config for "${serverName}" not found, skipping.`);
                    return null; // Skip if no config
                }
                let status = 'disconnected';
                try {
                    // Ensure config is known to manager before checking status
                    this._serverManager.setDynamicConfig(serverName, serverConfig);
                    let isRunning = false;
                    if (this._serverManager.hasServer(serverName)) {
                        try {
                            isRunning = this._serverManager.isServerRunning?.(serverName) || false;
                        } catch (err) {
                            logWarning(`[ChatProvider] Error checking if server "${serverName}" is running: ${getErrorMessage(err)}`);
                        }
                    }
                    status = isRunning ? 'connected' : 'disconnected';
                } catch (err) {
                    logWarning(`[ChatProvider] Failed to get status for server "${serverName}": ${getErrorMessage(err)}`);
                }
                return {
                    id: serverName,
                    name: serverName,
                    // config: serverConfig, // Avoid sending full config unless needed
                    status: status
                };
            });

            const serverListResults = await Promise.all(serverListPromises);
            const serverList = serverListResults.filter(item => item !== null); // Filter out nulls

            logDebug(`[ChatProvider] Sending updated server list to webview: ${JSON.stringify(serverList)}`);
            panel.webview.postMessage({
                command: 'updateServerList',
                servers: serverList
            });
        } catch (error) {
            logError(`[ChatProvider] Error updating webview with server list: ${getErrorMessage(error)}`);
            this.sendErrorToWebview(panel, `Failed to update server list: ${getErrorMessage(error)}`);
        }
    }

    // Method called when a server is successfully removed
    public handleServerRemoved(serverId: string): void {
        logInfo(`[ChatProvider] Handling notification that server ${serverId} was removed.`);
        // Clear abilities for the removed server
        if (this._serverAbilities.has(serverId)) {
            this._serverAbilities.delete(serverId);
            logDebug(`[ChatProvider] Cleared abilities for removed server ${serverId}.`);
        }
        // Trigger a UI update if the panel is open
        this.updateWebviewServerList(); 
    }

    // Method called when there's an error during server deletion
    public handleServerDeletionError(serverId: string, errorMessage: string): void {
        logError(`[ChatProvider] Handling error during deletion of server ${serverId}: ${errorMessage}`);
        // Show error in the webview if it's open
        if (this._panel) {
            this.sendErrorToWebview(this._panel, `Failed to delete server ${serverId}: ${errorMessage}`);
        }
        // Optionally, refresh the server list in case the state is inconsistent
        this.updateWebviewServerList();
    }
    
    // Method called when the extension configuration changes
    public handleConfigChange(): void {
        logInfo('[ChatProvider] Handling configuration change notification.');
        // Potentially re-read server configs or just update the list
        this.updateWebviewServerList(); 
    }

    private sendErrorToWebview(panel: vscode.WebviewPanel | undefined, message: string): void {
        if (panel && panel.webview) {
            panel.webview.postMessage({
                command: 'systemMessage',
                message: message,
                type: 'error' // Use a consistent type like 'error'
            });
        }
    }

    // --- Message Determination Logic (REVISED) ---
    private async determineTargetAndFormatMessage(
        originalText: string,
        serverAbilities: Map<string, ServerAbility[]>,
        serverManager: McpServerManager,
        configStorage: ConfigStorage,
        extensionContext: vscode.ExtensionContext
    ): Promise<{ targetServerId: string | undefined; messageToSend: string | undefined; isToolCall: boolean }> {
        logDebug('[ChatProvider][determineTarget] Starting determination...');
        let targetServerId: string | undefined = undefined;
        let messageToSend: string | undefined = undefined;
        let isToolCall = false;
        let bestMatch = { score: 0, toolName: '', serverId: '' };

        // Log current state
        logDebug(`[ChatProvider][determineTarget] Original text: "${originalText}"`);
        logDebug(`[ChatProvider][determineTarget] Current abilities: ${JSON.stringify(Array.from(serverAbilities.entries()))}`);

        // --- Tool Detection (Existing Logic) ---
        const promptWords = originalText.toLowerCase().split(/\s+/).filter((w: string) => w.length > 2);
        for (const [serverId, abilities] of serverAbilities.entries()) {
            // Ensure server is connected before checking its abilities
            let isConnected = false;
            try {
                // Check status directly on the server instance
                const serverInstance = serverManager.getServer(serverId);
                // Assuming 'connected' is the string representation from ServerStatus enum
                isConnected = !!serverInstance && serverInstance.getStatus() === 'connected';
            } catch (e) { logWarning(`[ChatProvider][determineTarget] Status check failed for ${serverId}: ${getErrorMessage(e)}`); }

            if (!isConnected) {
                logDebug(`[ChatProvider][determineTarget] Skipping server ${serverId} as it's not connected.`);
                continue;
            }
            if (!abilities || abilities.length === 0) {
                logDebug(`[ChatProvider][determineTarget] No abilities found for connected server ${serverId}.`);
                continue;
            }

            logDebug(`\n[ChatProvider][determineTarget] Checking connected server: ${serverId}`);
            logDebug(`[ChatProvider][determineTarget] Abilities on ${serverId}: ${abilities.map(a => a.name).join(', ')}`);
            for (const ability of abilities) {
                if (!ability.name || !ability.description) continue;
                let currentScore = 0;
                const toolNameWords = ability.name.toLowerCase().split(/\s+/);
                const toolDescWords = ability.description.toLowerCase().split(/\s+/);
                const allToolWords = [...new Set([...toolNameWords, ...toolDescWords])].filter(w => w.length > 0);
                promptWords.forEach(promptWord => { if (allToolWords.includes(promptWord)) currentScore++; });
                logDebug(`[ChatProvider][determineTarget] -> Score for '${ability.name}' on ${serverId}: ${currentScore}`);
                if (currentScore > bestMatch.score) {
                    bestMatch = { score: currentScore, toolName: ability.name, serverId: serverId };
                    logDebug(`[ChatProvider][determineTarget] ---> New best: ${ability.name} on ${serverId}`);
                }
            }
        }
        logDebug('[ChatProvider][determineTarget] Tool matching finished.');

        // --- Format message BASED ON API ---
        if (bestMatch.score > 0) {
            logInfo(`[ChatProvider][determineTarget] Match found: Tool='${bestMatch.toolName}' on Server='${bestMatch.serverId}'`);
            targetServerId = bestMatch.serverId;
            isToolCall = true;

            const toolName = bestMatch.toolName;
            const text = originalText;
            let params: any = {}; // Parameters for the tool

            // --- Simple Parameter Extraction Heuristics (Needs Improvement!) ---
            try {
                // Basic path extraction (example - needs refinement)
                if (['list_directory', 'read_file', 'get_file_info', 'create_directory'].includes(toolName)) {
                    // Looks for things starting with C:\, D:\, /, or \ followed by non-space chars
                    const pathMatch = text.match(/([a-zA-Z]:\\|\/|\\)([\w\-\.\s\\\/~]+)/);
                    if (pathMatch && pathMatch[0]) {
                        // Basic trim and cleanup
                        params.path = pathMatch[0].trim().replace(/[?'",]*$/, '');
                        logDebug(`[ChatProvider][determineTarget] Extracted 'path': ${params.path} for tool ${toolName}`);
                    } else {
                        // If no path found, but tool expects one, maybe default? Or signal error?
                        // For list_directory, defaulting to '.' might be reasonable if allowed by server
                        if (toolName === 'list_directory') {
                            params.path = '.'; // Default to current/root allowed dir
                            logWarning(`[ChatProvider][determineTarget] Could not extract 'path' for list_directory from: "${text}". Defaulting to '.'`);
                        } else {
                            logWarning(`[ChatProvider][determineTarget] Could not extract 'path' for tool ${toolName} from: "${text}". Required parameter missing.`);
                            // Set target to undefined so we don't send a bad request
                            targetServerId = undefined;
                            messageToSend = undefined;
                        }
                    }
                } else if (toolName === 'write_file' || toolName === 'edit_file' || toolName === 'move_file' || toolName === 'search_files') {
                    logWarning(`[ChatProvider][determineTarget] Parameter extraction for tool '${toolName}' is complex and not implemented. Cannot proceed.`);
                    targetServerId = undefined;
                    messageToSend = undefined;
                } else if (toolName === 'list_allowed_directories') {
                    logDebug(`[ChatProvider][determineTarget] Tool '${toolName}' requires no parameters.`);
                    // params remains empty {}
                } else {
                    logWarning(`[ChatProvider][determineTarget] Unknown tool or no specific parameter logic for tool '${toolName}'. Treating as error.`);
                    targetServerId = undefined;
                    messageToSend = undefined;
                }

                // Only construct message if we still have a target
                if (targetServerId) {
                    messageToSend = JSON.stringify({ tool: toolName, params: params });
                }

            } catch (extractionError) {
                 logError(`[ChatProvider][determineTarget] Error during parameter extraction for ${toolName}: ${getErrorMessage(extractionError)}`);
                 targetServerId = undefined;
                 messageToSend = undefined;
            }
            // --- End Parameter Extraction ---

        } else {
            // --- REVISED Fallback: No Tool Match ---
            logInfo('[ChatProvider][determineTarget] No tool match found. Command not understood.');
            targetServerId = undefined;
            messageToSend = undefined;
            isToolCall = false;
        }

        logDebug(`[ChatProvider][determineTarget] Result: serverId=${targetServerId}, isToolCall=${isToolCall}, messageToSend=${messageToSend}`);
        return { targetServerId, messageToSend, isToolCall };
    }

    // --- Serialization Logic (for restoring panel) ---

    async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel, state: any): Promise<void> {
        logInfo(`[ChatProvider] Deserializing webview panel. State: ${JSON.stringify(state)}`);
        // Restore the panel reference
        this._panel = webviewPanel;

        // Restore the content
        this._panel.webview.html = getWebviewContent(this._panel.webview, this._extensionUri);

        // Re-setup listeners
        this.setupChatPanelListeners(this._panel);

        // Restore any necessary state from `state` if you saved anything
        // e.g., this._chatHistory = state?.chatHistory || [];

        // Restore dispose listener
        this._panel.onDidDispose(() => this.disposePanel(), null, this._disposables);

        // Send updated server list after restoring
         setTimeout(() => {
            this.updateWebviewWithServerList(this._panel);
            // Send history if needed: panel.webview.postMessage({ command: 'loadHistory', history: this._chatHistory });
        }, 500);
    }

    // Add missing updateChat method referenced in extension.ts
    public updateChat(message: string): void {
        if (!this._panel) {
            logWarning('[ChatProvider] Cannot update chat - panel not initialized');
            return;
        }
        
        logInfo(`[ChatProvider] Updating chat with message: ${message}`);
        this._panel.webview.postMessage({
            command: 'addMessage',
            message: { role: 'system', text: message }
        });
    }

    // Add missing handleStatusUpdate method referenced in extension.ts
    public handleStatusUpdate(event: { serverId: string; status: string; error?: any }): void {
        logInfo(`[ChatProvider] Handling status update for ${event.serverId}: ${event.status}`);
        
        // Forward to our internal status handler
        this.handleServerStatusChange(event);
        
        // Additional status-specific handling (like displaying messages)
        if (event.error) {
            if (this._panel) {
                this.sendErrorToWebview(
                    this._panel, 
                    `Server ${event.serverId} error: ${typeof event.error === 'string' ? event.error : getErrorMessage(event.error)}`
                );
            }
            logError(`[ChatProvider] Error with server ${event.serverId}: ${getErrorMessage(event.error)}`);
        }
    }

} 