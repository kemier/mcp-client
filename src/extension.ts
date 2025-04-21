import * as vscode from 'vscode';
import * as path from 'path'; // Needed for LogManager initialization
import { LogManager } from './utils/LogManager.js';

// --- MCP Server Manager Imports ---
import { McpServerManager } from './services/McpServerManager.js';
import { ConfigStorage } from './services/ConfigStorage.js';
import { ChatViewProvider } from './panels/ChatViewProvider.js';
import { ServerDashboard } from './panels/ServerDashboard.js';
import { parseArgumentsString, configureEnvironmentVariables } from './commands/ServerCommands.js';
import { ServerStatusEvent, ServerConfig, ModelRequest, ServerCapability, CapabilityItem } from './models/Types.js';

// --- Local LLM Client Import ---
import { MCPClient as LocalLLMClient } from './mcp-local-llm-client/client.js';

// --- Declare instances accessible within the module ---
let configStorage: ConfigStorage;
let mcpServerManager: McpServerManager;
export let extensionContext: vscode.ExtensionContext;

// --- Local LLM Client Instance ---
let localLLMClient: LocalLLMClient | undefined;

// --- Export MCP Client for ChatViewProvider access ---
export function getMcpClient(): LocalLLMClient | undefined {
    return localLLMClient;
}

// Activate function
export async function activate(context: vscode.ExtensionContext) {
    extensionContext = context; // Store context globally if needed elsewhere

    // Initialize LogManager FIRST
    try {
        LogManager.initialize(context.extensionPath);
        LogManager.info('Extension', 'MCP Server Manager activating...');
    } catch (e: any) {
        console.error("!!! FAILED TO INITIALIZE LogManager !!!", e);
        vscode.window.showErrorMessage(`MCP Activation Failed (LogManager Init): ${LogManager.getErrorMessage(e)}`);
        return; // Stop activation if logging fails
    }

    // Initialize Core Services
    try {
        LogManager.debug('Extension', 'Initializing ConfigStorage...');
        configStorage = ConfigStorage.getInstance(context);

        LogManager.debug('Extension', 'Initializing McpServerManager...');
        mcpServerManager = McpServerManager.getInstance(configStorage);

        LogManager.debug('Extension', 'Setting up McpServerManager status listener...');
        mcpServerManager.on('status', (event: ServerStatusEvent) => {
            LogManager.info('Extension', `Server Status Event: ${event.serverId} -> ${event.status}`, {
                error: event.error ? LogManager.getErrorMessage(event.error) : undefined,
                statusEnum: event.status
            });
            // Forward status - Requires changes in ChatViewProvider and ServerDashboard
            // Format event to match expected types
            const formattedEvent = {
                serverId: event.serverId,
                status: event.status,
                error: event.error ? (typeof event.error === 'string' ? new Error(event.error) : event.error) : undefined
            };
            
            ChatViewProvider.instance?.handleStatusUpdate(formattedEvent);
            // TODO: Add 'public static currentPanel: ServerDashboard | undefined;' to ServerDashboard class (if not present)
            // TODO: Add 'public handleStatusUpdate(event: ServerStatusEvent): void;' method to ServerDashboard class
            ServerDashboard.currentPanel?.handleStatusUpdate(formattedEvent);
        });

        LogManager.info('Extension', 'McpServerManager initialized. Checking auto-start...');
        const config = vscode.workspace.getConfiguration('mcpServerManager');
        const autoStartEnabled = config.get<boolean>('autoStartServers', false);

        if (autoStartEnabled) {
            LogManager.info('Extension', 'Auto-start enabled. Starting configured servers...');
            const serverNames = configStorage.getServerNames();

            if (serverNames.length > 0) {
                LogManager.info('Extension', `Attempting to auto-start servers: ${serverNames.join(', ')}`);
                for (const serverId of serverNames) {
                    try {
                        mcpServerManager.startServer(serverId).catch((err: any) => {
                            LogManager.error('Extension', `Auto-start failed for server '${serverId}'`, err); // Pass error obj as data
                        });
                    } catch (error) {
                        LogManager.error('Extension', `Synchronous error during auto-start attempt for '${serverId}'`, error); // Pass error obj as data
                    }
                }
            } else {
                LogManager.info('Extension', 'Auto-start enabled, but no servers are configured.');
            }
        } else {
            LogManager.info('Extension', 'Auto-start disabled.');
        }

    } catch (error: any) {
        console.error("!!! FAILED DURING CORE SERVICE INIT !!!", error);
        LogManager.error('Extension', 'Core services (ConfigStorage/McpServerManager) initialization failed', error); // Pass error obj as data
        vscode.window.showErrorMessage(`Core services failed to initialize: ${LogManager.getErrorMessage(error)}`);
        return;
    }

    LogManager.info('Extension', 'Core services initialization block finished.');

    // Initialize Local LLM Client
    LogManager.info('Extension', 'Initializing Local LLM Client...');
    localLLMClient = new LocalLLMClient(mcpServerManager, context);
    const inferenceServerIp = vscode.workspace.getConfiguration('mcpClient').get<string>('inferenceServerIp') || '127.0.0.1';
    const inferenceServerPort = vscode.workspace.getConfiguration('mcpClient').get<number>('inferenceServerPort') || 8000;
    localLLMClient.setConfig(inferenceServerIp, inferenceServerPort);
    LogManager.info('Extension', `Read IP/Port settings: IP = '${inferenceServerIp}', Port = ${inferenceServerPort}`);
    LogManager.info('Extension', `Local LLM Client configured for ${inferenceServerIp}:${inferenceServerPort}. Connection will be established on first query.`);
    // We no longer connect immediately, connection happens on first query via processQuery
    // try {

    // Register Chat View Provider (Sidebar)
    try {
        LogManager.info('Extension', 'Registering ChatViewProvider (Sidebar)...');
        const chatProvider = new ChatViewProvider(context.extensionUri, context);
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatProvider, {
                webviewOptions: { retainContextWhenHidden: true }
            })
        );
        if (!ChatViewProvider.instance) {
            ChatViewProvider.instance = chatProvider;
            LogManager.warn('Extension', 'ChatViewProvider.instance was not set by constructor, setting now.');
        }
        LogManager.info('Extension', 'ChatViewProvider (Sidebar) registered.');
    } catch (error: any) {
        console.error("!!! FAILED DURING ChatViewProvider INIT !!!", error);
        LogManager.error('Extension', 'ChatViewProvider (Sidebar) registration failed', error);
        vscode.window.showErrorMessage(`Sidebar Chat View failed to initialize: ${LogManager.getErrorMessage(error)}`);
    }

    // Register Commands
    try {
        LogManager.info('Extension', 'Registering mcpServerManager.showDashboard...');
        context.subscriptions.push(
            vscode.commands.registerCommand('mcpServerManager.showDashboard', () => {
                LogManager.debug('Command', 'Executing mcpServerManager.showDashboard');
                // Assuming createOrShow takes (context). Dashboard should get dependencies internally.
                ServerDashboard.createOrShow(context);
            })
        );
        LogManager.info('Extension', 'mcpServerManager.showDashboard registered.');

        LogManager.info('Extension', 'Registering mcpServerManager.addServer...');
        context.subscriptions.push(
            vscode.commands.registerCommand('mcpServerManager.addServer', async () => {
                LogManager.debug('Command', 'Executing mcpServerManager.addServer');
                try {
                    const serverName = await vscode.window.showInputBox({
                        prompt: 'Enter a unique name for the server',
                        placeHolder: 'e.g., my-local-llm',
                        ignoreFocusOut: true
                    });
                    if (!serverName) return; // User cancelled

                    // Validate server name uniqueness
                    if (configStorage.getServer(serverName)) {
                        vscode.window.showErrorMessage(`Server name "${serverName}" already exists.`);
                        return;
                    }

                    const command = await vscode.window.showInputBox({
                        prompt: 'Enter the command to start the server',
                        placeHolder: 'e.g., python or npx',
                        ignoreFocusOut: true,
                        validateInput: (input) => input ? null : 'Command cannot be empty'
                    });
                    if (command === undefined) return; // User cancelled

                    const argsInput = await vscode.window.showInputBox({
                        prompt: 'Enter command arguments (optional, space-separated)',
                        placeHolder: 'e.g., -m my_module --port 8080',
                        ignoreFocusOut: true
                    });
                    // No need to check if undefined, empty string is valid
                    const args = argsInput ? parseArgumentsString(argsInput) : [];

                    // Prompt for shell setting
                    const useShell = await vscode.window.showQuickPick(['Yes', 'No'], {
                        placeHolder: `Use shell to execute command? (Recommended: Yes for npx/complex commands)`, 
                        ignoreFocusOut: true
                    });
                    if (useShell === undefined) return; // User cancelled
                    const shell = useShell === 'Yes';

                    // Prompt for hideWindow setting
                    const hideWindow = await vscode.window.showQuickPick(['Yes', 'No'], {
                        placeHolder: `Hide command window (Windows only)? (Recommended: Yes)`,
                        ignoreFocusOut: true
                    });
                    if (hideWindow === undefined) return; // User cancelled
                    const windowsHide = hideWindow === 'Yes';

                    // Prompt for environment variables
                    let env: Record<string, string> = {};
                    const configureEnvChoice = await vscode.window.showQuickPick(['Yes', 'No'], {
                        placeHolder: 'Configure environment variables now?',
                        ignoreFocusOut: true
                    });

                    if (configureEnvChoice === undefined) return; // User cancelled

                    if (configureEnvChoice === 'Yes') {
                        // Use the imported helper function
                        env = await configureEnvironmentVariables({}); // Start with empty env
                    }

                    // Construct the full server config
                    const serverConfig: ServerConfig = { 
                        type: 'stdio', 
                        command, 
                        args, 
                        shell, 
                        windowsHide, 
                        env // Include collected env vars
                    }; 

                    // Use addOrUpdateServer to save the config
                    await configStorage.addOrUpdateServer(serverName, serverConfig);
                    vscode.window.showInformationMessage(`Server "${serverName}" added successfully.`);
                    // Trigger dashboard update
                    ServerDashboard.currentPanel?.updateWebviewContent();
                    // Optionally attempt to start the server?
                    // await mcpServerManager.startServer(serverName);

                } catch (error) {
                    const errorMessage = LogManager.getErrorMessage(error);
                    vscode.window.showErrorMessage(`Failed to add server: ${errorMessage}`);
                    LogManager.error('Command:addServer', 'Error adding server', error);
                }
            })
        );
        LogManager.info('Extension', 'mcpServerManager.addServer registered.');

        LogManager.info('Extension', 'Registering mcpServerManager.removeServer...');
        context.subscriptions.push(
            vscode.commands.registerCommand('mcpServerManager.removeServer', async (serverId?: string) => {
                LogManager.debug('Command:removeServer', 'Executing', { serverId });
                 try {
                    if (!serverId) {
                        const servers = configStorage.getAllServers(); // Assumes getAllServers exists
                        const serverNames = Object.keys(servers);
                        if (serverNames.length === 0) {
                            vscode.window.showInformationMessage('No servers configured to remove.');
                            return;
                        }
                        serverId = await vscode.window.showQuickPick(serverNames, { placeHolder: 'Select a server to remove' });
                        if (!serverId) return;
                    }

                    const confirm = await vscode.window.showWarningMessage(
                        `Are you sure you want to remove server "${serverId}"? This cannot be undone.`, { modal: true }, 'Yes' );

                    if (confirm === 'Yes' && serverId) {
                        const success = await mcpServerManager.removeServerConfiguration(serverId);
                        if (success) {
                            vscode.window.showInformationMessage(`Server "${serverId}" removed.`);
                            ServerDashboard.currentPanel?.updateWebviewContent();
                        } else {
                            vscode.window.showErrorMessage(`Failed to remove server "${serverId}". Check logs.`);
                        }
                    }
                 } catch(error) {
                     const errorMessage = LogManager.getErrorMessage(error);
                     vscode.window.showErrorMessage(`Error removing server: ${errorMessage}`);
                     LogManager.error('Command:removeServer', 'Failed to remove server', { serverId, error }); // Pass error obj as data
                 }
            })
        );
        LogManager.info('Extension', 'mcpServerManager.removeServer registered.');

        LogManager.info('Extension', 'Registering mcpServerManager.startServer...');
        context.subscriptions.push(
            vscode.commands.registerCommand('mcpServerManager.startServer', async (serverId?: string) => {
                 LogManager.debug('Command:startServer', 'Executing', { serverId });
                if (!serverId) { vscode.window.showWarningMessage('Server ID needed for startServer.'); return; }
                 try {
                     // This message is okay
                     vscode.window.showInformationMessage(`Starting server "${serverId}"...`);
                     
                     // This awaits the process spawn, which might succeed even if the server errors out immediately
                     await mcpServerManager.startServer(serverId); 
                     
                 } catch (err) {
                     const message = LogManager.getErrorMessage(err);
                     vscode.window.showErrorMessage(`Failed to start ${serverId}: ${message}`);
                     LogManager.error('Command:startServer', `Failed to start server ${serverId}`, err);
                 }
            })
        );
        LogManager.info('Extension', 'mcpServerManager.startServer registered.');

        LogManager.info('Extension', 'Registering mcpServerManager.stopServer...');
        context.subscriptions.push(
            vscode.commands.registerCommand('mcpServerManager.stopServer', async (serverId?: string) => {
                LogManager.debug('Command:stopServer', 'Executing', { serverId }); // Changed component name & message
                if (!serverId) { vscode.window.showWarningMessage('Server ID needed for stopServer.'); return; }
                try {
                    await mcpServerManager.stopServer(serverId);
                    vscode.window.showInformationMessage(`Attempting to stop server "${serverId}"...`);
                } catch (err) {
                    const message = LogManager.getErrorMessage(err);
                    vscode.window.showErrorMessage(`Failed to stop ${serverId}: ${message}`);
                    LogManager.error('Command:stopServer', `Failed to stop server ${serverId}`, err); // Pass error obj as data
                }
            })
        );
        LogManager.info('Extension', 'mcpServerManager.stopServer registered.');

        LogManager.info('Extension', 'Registering mcpServerManager.refreshCapabilities...');
         context.subscriptions.push(
            vscode.commands.registerCommand('mcpServerManager.refreshCapabilities', async (serverId?: string) => {
                LogManager.debug('Command:refreshCapabilities', 'Executing', { serverId }); 
                 if (!serverId) { vscode.window.showWarningMessage('Server ID needed for refreshCapabilities.'); return; }
                 try {
                     // This "Refreshing..." message is okay
                     vscode.window.showInformationMessage(`Refreshing capabilities for "${serverId}"...`); 
                     
                     // This only sends the request
                     await mcpServerManager.refreshCapabilities(serverId); 

                 } catch (err) {
                     const message = LogManager.getErrorMessage(err);
                     vscode.window.showErrorMessage(`Failed to refresh capabilities for ${serverId}: ${message}`);
                     LogManager.error('Command:refreshCapabilities', `Failed to refresh capabilities ${serverId}`, err); 
                 }
            })
        );
        LogManager.info('Extension', 'mcpServerManager.refreshCapabilities registered.');

        LogManager.info('Extension', 'Registering mcpServerManager.showLogs...');
         context.subscriptions.push(
            vscode.commands.registerCommand('mcpServerManager.showLogs', () => {
                LogManager.debug('Command:showLogs', 'Executing'); // Changed component name & message
                LogManager.showOutputChannel();
            })
        );
        LogManager.info('Extension', 'mcpServerManager.showLogs registered.');

    } catch (error: any) {
         console.error("!!! FAILED DURING COMMAND REGISTRATION !!!", error);
         LogManager.error('Extension', 'Command registration failed', error); // Pass error obj as data
         vscode.window.showErrorMessage(`Command registration failed: ${LogManager.getErrorMessage(error)}`);
    }

     // Disposable for cleanup on extension deactivation
    context.subscriptions.push({
        dispose: async () => {
            LogManager.info('Extension', 'Deactivating extension, disposing resources...');
            try {
                // Cleanup Local LLM Client
                if (localLLMClient) {
                    LogManager.info('Extension', 'Cleaning up Local LLM Client...');
                    await localLLMClient.cleanup();
                    LogManager.info('Extension', 'Local LLM Client cleaned up.');
                }

                // Dispose McpServerManager
                mcpServerManager?.dispose();
                LogManager.info('Extension', 'McpServerManager disposed.');

            } catch (disposeError: any) {
                 LogManager.error('Extension', `Error during deactivation cleanup`, disposeError);
            }
        }
    });

    LogManager.info('Extension', 'MCP Manager Activation Complete.');
}

// Deactivate function
export async function deactivate() {
    console.log('MCP Manager Deactivating...');
    // Use static LogManager method, check if logger might be disposed already if necessary
    try {
        LogManager.info('Extension', 'Deactivate function called.');
    } catch(e) {
        // LogManager might be unavailable during shutdown
        console.error("Error logging deactivation", e);
    }
}

// --- Refactored handleSendMessage function ---
export async function handleSendMessage(message: { text: string }, webviewProvider: ChatViewProvider) {
    const componentName = 'handleSendMessage(LocalLLM)';
    LogManager.debug(componentName, `Triggered via ChatViewProvider`, message);

    const mcpClient = getMcpClient(); // Get client instance

    if (!mcpClient) { // Check if the client object exists
        LogManager.error(componentName, "Local LLM Client not initialized or connection failed.");
        // No client, so no session ID. Pass null or fallback.
        webviewProvider.updateChat("Error: Local LLM Client is not ready. Check configuration and logs.", 'global'); 
        return;
    }

    // --- Get session ID for potential early errors --- 
    const currentSessionId = mcpClient.getActiveSessionId() ?? 'global';

    try {
        LogManager.debug(componentName, 'Sending query to Local LLM Client...');
        // Call the Local LLM Client's processQuery method, passing the provider
        // No need to store result as it's void
        await mcpClient.processQuery(message.text, webviewProvider);
        LogManager.debug('handleSendMessage(LocalLLM)', `mcpClient.processQuery completed for message: ${message.text.substring(0, 20)}...`);
    } catch (error: any) {
        // Errors during the processQuery loop should now be caught within processQuery
        // and sent to the UI via updateChatStream.
        // This catch block might only handle errors during client lookup or initial checks.
        LogManager.error(componentName, `Error in handleSendMessage or initial client checks`, error);
        // Send a general error message if processQuery itself failed catastrophically
        webviewProvider.updateChat(`An unexpected error occurred before processing could start: ${LogManager.getErrorMessage(error)}`, currentSessionId); // Use fetched session ID
    }
}

