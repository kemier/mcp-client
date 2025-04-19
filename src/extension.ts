import * as vscode from 'vscode';
import * as path from 'path'; // Needed for LogManager initialization
import { LogManager } from './utils/LogManager.js';

// --- MCP Server Manager Imports ---
import { McpServerManager } from './services/McpServerManager.js';
import { ConfigStorage } from './services/ConfigStorage.js';
import { ChatViewProvider } from './panels/ChatViewProvider.js';
import { ServerDashboard } from './panels/ServerDashboard.js';
import { parseArgumentsString } from './commands/ServerCommands.js';
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

    // Initialize and Connect Local LLM Client
    try {
        LogManager.info('Extension', 'Initializing Local LLM Client...');
        const config = vscode.workspace.getConfiguration('mcpServerManager');
        const inferenceServerIp = config.get<string>('inferenceServerIp');
        const inferenceServerPort = config.get<number>('inferenceServerPort');
        LogManager.info('Extension', `Read IP/Port settings: IP = '${inferenceServerIp}', Port = ${inferenceServerPort}`); // Use IP/Port log

        if (!inferenceServerIp || !inferenceServerPort) { // Check both IP and Port
            LogManager.warn('Extension', 'Local LLM inference server IP or Port not configured. Local LLM features disabled.');
            vscode.window.showWarningMessage('MCP: Inference Server IP and/or Port are not set in VS Code settings. Local LLM chat disabled.');
        } else {
            localLLMClient = new LocalLLMClient(mcpServerManager); // Ensure LLMClient is instantiated
            LogManager.info('Extension', `Attempting to connect Local LLM Client to server at: ${inferenceServerIp}:${inferenceServerPort}`);
            ChatViewProvider.instance?.updateChat(`Connecting to local inference server at ${inferenceServerIp}:${inferenceServerPort}...`);
            await localLLMClient.connectToServer(inferenceServerIp, inferenceServerPort); // Pass IP and Port
            LogManager.info('Extension', 'Local LLM Client connected successfully.');
            ChatViewProvider.instance?.updateChat("Connected to local inference server. Ready for queries.");
        }
    } catch (error: any) {
        console.error("!!! FAILED TO CONNECT LOCAL LLM CLIENT !!!", error);
        LogManager.error('Extension', 'Failed to initialize or connect Local LLM Client', error);
        vscode.window.showErrorMessage(`Failed to connect to local inference server: ${LogManager.getErrorMessage(error)}`);
        ChatViewProvider.instance?.updateChat(`Error connecting to local inference server: ${LogManager.getErrorMessage(error)}`);
        localLLMClient = undefined; // Ensure client is not used if connection failed
    }

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
                    if (!serverName) return;
                    const command = await vscode.window.showInputBox({
                        prompt: 'Enter the command to start the server',
                        placeHolder: 'e.g., python -m my_server --port 8080',
                        ignoreFocusOut: true
                    });
                    if (!command) return;
                    const argsInput = await vscode.window.showInputBox({
                        prompt: 'Enter command arguments (optional, space-separated)',
                        placeHolder: '--verbose --model llama3',
                        ignoreFocusOut: true
                    });
                    const args = argsInput ? parseArgumentsString(argsInput) : [];

                    const serverConfig: ServerConfig = { type: 'stdio', command, args, shell: true, windowsHide: true, env: {} };

                    await configStorage.saveServerConfig(serverName, serverConfig);
                    vscode.window.showInformationMessage(`Server "${serverName}" added successfully.`);
                    ServerDashboard.currentPanel?.updateWebviewContent();

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

    if (!localLLMClient) { // Check if the client object exists and is connected (implicitly checked by processQuery)
        LogManager.error(componentName, "Local LLM Client not initialized or connection failed.");
        webviewProvider.updateChat("Error: Local LLM Client is not ready. Check configuration and logs.");
        return;
    }

    try {
        LogManager.debug(componentName, 'Sending query to Local LLM Client...');
        webviewProvider.updateChat("Processing with local LLM..."); // Indicate processing

        // Call the Local LLM Client's processQuery method
        // This method now internally handles LLM calls and MCP tool execution
        const result = await localLLMClient.processQuery(message.text);
        LogManager.info(componentName, 'Received final response from Local LLM Client');

        // Display the final result
        webviewProvider.updateChat(result); // Display the text response from the client

    } catch (error: any) {
        LogManager.error(componentName, `Error in handleSendMessage with Local LLM Client`, error);
        webviewProvider.updateChat(`An unexpected error occurred: ${LogManager.getErrorMessage(error)}`);
    }
}

