// Import necessary modules
import * as vscode from 'vscode';
import * as cp from 'child_process';
// import { CommandManager } from './commands/CommandManager'; // CommandManager might not be needed now
import { McpServerManager } from './services/McpServerManager';
import { ServerStatusEvent, ServerConfig } from './models/Types';
// import { StdioServer, IServer } from './services/StdioServer'; // Not directly used in extension.ts now
// import { getWebviewContent } from './panels/webview/chatWebview'; // Handled by Provider
import { ConfigStorage } from './services/ConfigStorage';
// Import new logger utility
import { initializeLogger, logDebug, logError, logInfo, logWarning, getErrorMessage } from './utils/logger';
// Import the new webview provider
import { ChatWebviewProvider } from './panels/chatWebviewProvider';

// Export logger functions if needed by other modules directly
// (Alternatively, they can import directly from './utils/logger')
export { logDebug, logError, logInfo, logWarning, getErrorMessage };

// Global variables previously related to chat panel are removed:
// let chatPanel: vscode.WebviewPanel | undefined = undefined;
// let chatHistory: { role: string; text: string }[] = [];
// const serverAbilities = new Map<string, any[]>(); -> Managed by ChatWebviewProvider now

// Flag to track if extension is activated
let isExtensionActivated = false;

// Global instance of the server manager (still needed)
let serverManager: McpServerManager;

// Store a reference to the extension context (still needed)
let extensionContext: vscode.ExtensionContext;
export { extensionContext };

// Global instance of the webview provider
let chatWebviewProvider: ChatWebviewProvider;

// --- Helper functions still needed in extension.ts --- 

// Utility for env vars formatting (keep here or move to utils?)
function formatEnvironmentVariables(input: string): string {
    if (!input.trim()) return '{}';
    if (!input.trim().startsWith('{')) {
        const parts = input.split(':', 2);
        if (parts.length === 2) return `{"${parts[0].trim()}":"${parts[1].trim()}"}`;
        if (!input.includes(':') && !input.includes('{') && !input.includes('}')) return `{"GITHUB_TOKEN":"${input.trim()}"}`;
        return `{${input}}`;
    }
    return input;
}

// Command cleanup helper
async function cleanupExistingCommands() {
    try {
        const allCommands = await vscode.commands.getCommands();
        const ourCommands = [
            'mcpClient.startChat',
            'mcpClient.addServer',
            'mcpClient.configureServer',
            'mcpClient.deleteCurrentServer', // Added based on previous code
            'mcpClient.deleteGithubServer', // Added based on previous code
            'mcpClient.deleteServerByName', // Added based on previous code
             'mcpClient.executeDeleteServer' // New command for provider interaction
        ];
        logDebug(`[Extension] Checking for existing commands: ${ourCommands.join(', ')}`);
        for (const cmd of ourCommands) {
            if (allCommands.includes(cmd)) {
                logWarning(`[Extension] Command potentially already exists: ${cmd}. Registration might overwrite or fail silently.`);
            }
        }
    } catch (error: unknown) {
        logError(`[Extension] Error checking commands: ${getErrorMessage(error)}`);
    }
}


// Activate function
export async function activate(context: vscode.ExtensionContext) {
    extensionContext = context;
    if (isExtensionActivated) {
        console.log('MCP Client extension already activated, skipping activation');
        return;
    }
    console.log('Activating MCP Client extension...');
    initializeLogger(context);
    logInfo("--- MCP Client Activation Sequence Start ---");
    logInfo('>>> activate function started');
    logInfo('Congratulations, your extension "mcp-client" is now active!');

    await cleanupExistingCommands();

    // Initialize core services
    const configStorage = ConfigStorage.getInstance(context);
    logInfo('[Extension] Configuration storage initialized');
    serverManager = McpServerManager.getInstance();
    logInfo('[Extension] Server manager initialized');

    // Initialize the Webview Provider (Pass dependencies)
    chatWebviewProvider = new ChatWebviewProvider(context, serverManager, configStorage);
    context.subscriptions.push(chatWebviewProvider); // Add provider to subscriptions for disposal
    logInfo('[Extension] ChatWebviewProvider initialized');

    // --- Auto-start configured servers --- 
    try {
        logInfo("[Activate] Starting background process to ensure all configured servers are started...");
        const serverNames = configStorage.getServerNames();
        logInfo(`[Activate] Found configured servers: ${serverNames.join(', ') || 'None'}`);
        for (const serverName of serverNames) {
            (async () => { 
                try {
                    logInfo(`[Activate Background] Ensuring server '${serverName}' is started...`);
                    const config = configStorage.getServer(serverName);
                    if (config) {
                        serverManager.setDynamicConfig(serverName, config);
                        await serverManager.ensureServerStarted(serverName); 
                        logInfo(`[Activate Background] Successfully ensured server '${serverName}'.`);
                    } else {
                        logWarning(`[Activate Background] No config found for '${serverName}'.`);
                    }
                } catch (error) {
                    logError(`[Activate Background] Failed to start server '${serverName}': ${getErrorMessage(error)}`);
                }
            })(); 
        }
        logInfo("[Activate] Background server startup process initiated."); 
    } catch (error) {
        logError(`[Activate] Error initiating auto-start: ${getErrorMessage(error)}`);
    }
    // --- End Auto-start ---

    // --- Set up server status listener FOR ABILITIES (Provider also listens) --- 
    // We might need to pass abilities TO the provider if fetched here.
    // Alternative: Provider handles fetching AND storage entirely.
    // Let's assume the provider handles ability fetching based on its own status listener for now.
    /* // Remove direct ability handling from activate? Provider does this now.
    try {
        serverManager.on('status', async (event: ServerStatusEvent) => {
            logDebug(`[Activate Status Listener] Event: ${event.serverId} -> ${event.status}`);
            // If the provider needs abilities fetched here, we could call a method on it:
            // if (event.status === 'connected') {
            //     chatWebviewProvider.fetchAbilitiesForServer(event.serverId);
            // }
             // Provider handles its own status updates and ability fetching internally
        });
    } catch (error: unknown) {
        logError(`[Extension] Error setting up central status listener: ${getErrorMessage(error)}`);
    }
    */

    // --- Register Commands --- 
    logInfo('[Extension] Registering commands...');

    // Command to open the chat panel (now calls the provider)
    try {
        context.subscriptions.push(vscode.commands.registerCommand('mcpClient.startChat', () => {
            logInfo('[Extension] Command executed: mcpClient.startChat');
            chatWebviewProvider.showPanel(); // Delegate to provider
        }));
        logInfo('[Extension] Registered command: mcpClient.startChat');
    } catch (error: unknown) {
        logError(`[Extension] Failed to register mcpClient.startChat: ${getErrorMessage(error)}`);
    }

    // Command to add a new server configuration
    try {
        const addServerDisposable = vscode.commands.registerCommand('mcpClient.addServer', async () => {
            logInfo('[Extension] Command executed: mcpClient.addServer');
            
            const serverName = await vscode.window.showInputBox({ prompt: 'Enter server name', placeHolder: 'e.g., echo', ignoreFocusOut: true });
            if (!serverName) return;

            const command = await vscode.window.showInputBox({ prompt: 'Enter command to run MCP server', placeHolder: 'e.g., npx', ignoreFocusOut: true });
            if (!command) return;

            const args = await vscode.window.showInputBox({ prompt: 'Enter command arguments (comma separated)', placeHolder: 'e.g., -y, @modelcontextprotocol/server-echo', ignoreFocusOut: true });
            if (args === undefined) return; // Check for undefined in case user escapes

            const envVars = await vscode.window.showInputBox({ prompt: 'Enter environment variables (JSON format)', placeHolder: 'e.g., {"GITHUB_TOKEN":"ghp_123abc"}', ignoreFocusOut: true });
            let parsedEnv: Record<string, string> = {};
            if (envVars) {
                try {
                    const formattedEnvVars = formatEnvironmentVariables(envVars);
                    parsedEnv = JSON.parse(formattedEnvVars);
                    // Validate values are strings
                    for (const key in parsedEnv) {
                        if (typeof parsedEnv[key] !== 'string') parsedEnv[key] = String(parsedEnv[key]);
                    }
                    vscode.window.showInformationMessage('Environment variables parsed successfully.');
                 } catch (jsonError) {
                     const errorMsg = getErrorMessage(jsonError);
                     logError(`Failed to parse env vars: ${errorMsg}`);
                     vscode.window.showErrorMessage(`Invalid JSON for environment variables: ${errorMsg}. Please use {"KEY":"VALUE"} format.`);
                     // Optionally re-prompt or return
                     return; // Stop if env vars are invalid
                 }
            }

            const useShell = await vscode.window.showQuickPick(['Yes', 'No'], { placeHolder: 'Use shell for execution?', ignoreFocusOut: true });
            if (!useShell) return;

            const windowsHide = await vscode.window.showQuickPick(['Yes', 'No'], { placeHolder: 'Hide window on Windows?', ignoreFocusOut: true });
            if (!windowsHide) return;

            // Heartbeat option removed based on StdioServer capabilities
            // const heartbeat = await vscode.window.showQuickPick(['Yes', 'No'], { placeHolder: 'Use heartbeat?', ignoreFocusOut: true });
            // if (!heartbeat) return;

            const serverConfig: ServerConfig = {
                type: 'stdio',
                command,
                args: args.split(',').map(arg => arg.trim()),
                shell: useShell === 'Yes',
                windowsHide: windowsHide === 'Yes',
                env: parsedEnv
                // heartbeatEnabled: heartbeat === 'Yes' // Heartbeat likely managed by server implementation
            };

            await configStorage.addServer(serverName, serverConfig);
            serverManager.setDynamicConfig(serverName, serverConfig); // Inform manager immediately
            vscode.window.showInformationMessage(`Server ${serverName} added successfully`);

            // Update WebView via provider IF the panel is open
            chatWebviewProvider.updateWebviewServerList(); // Add a public method to provider

        });
        context.subscriptions.push(addServerDisposable);
        logInfo('[Extension] Registered command: mcpClient.addServer');
    } catch (error: unknown) {
        logError(`[Extension] Failed to register mcpClient.addServer: ${getErrorMessage(error)}`);
    }

    // Command to list and select a server to configure (simplified - just sets config)
    try {
        const configureServerDisposable = vscode.commands.registerCommand('mcpClient.configureServer', async () => {
            logInfo('[Extension] Command executed: mcpClient.configureServer');
            const serverNames = configStorage.getServerNames();
            if (serverNames.length === 0) {
                const addNew = await vscode.window.showInformationMessage('No servers found. Add one?', 'Yes', 'No');
                if (addNew === 'Yes') await vscode.commands.executeCommand('mcpClient.addServer');
                return;
            }
            const selectedServer = await vscode.window.showQuickPick([...serverNames, '+ Add New Server'], { placeHolder: 'Select a server to configure or add new', ignoreFocusOut: true });
            if (!selectedServer) return;
            if (selectedServer === '+ Add New Server') {
                await vscode.commands.executeCommand('mcpClient.addServer');
                return;
            }
            try {
                const config = configStorage.getServer(selectedServer);
                if (!config) throw new Error(`Config for "${selectedServer}" not found.`);
                serverManager.setDynamicConfig(selectedServer, config); // Ensure manager has config
                vscode.window.showInformationMessage(`Server "${selectedServer}" configuration loaded for use.`);
                logInfo(`[Extension] Server "${selectedServer}" config loaded.`);
                 // No direct action needed beyond loading config into manager? 
                 // Perhaps ensure it's started?
                await serverManager.ensureServerStarted(selectedServer); 
                chatWebviewProvider.updateWebviewServerList(); // Update UI
            } catch (error: any) {
                const errorMsg = getErrorMessage(error);
                logError(`[Extension] Failed to configure server "${selectedServer}": ${errorMsg}`);
                vscode.window.showErrorMessage(`Failed to configure server "${selectedServer}": ${errorMsg}`);
            }
        });
        context.subscriptions.push(configureServerDisposable);
        logInfo('[Extension] Registered command: mcpClient.configureServer');
    } catch (error: unknown) {
        logError(`[Extension] Failed to register mcpClient.configureServer: ${getErrorMessage(error)}`);
    }

    // --- Server Deletion Command --- 
    // New command that handles the full deletion logic, callable by provider
    try {
        const executeDeleteServerDisposable = vscode.commands.registerCommand('mcpClient.executeDeleteServer', async (serverId: string) => {
            logInfo(`[Extension] Command executed: mcpClient.executeDeleteServer for ID: ${serverId}`);
            if (!serverId) {
                logError('[executeDeleteServer] No server ID provided.');
                vscode.window.showErrorMessage('Cannot delete server: No server ID specified.');
                return;
            }
            
            // Optional: Double-check confirmation (though provider might do this)
            // const confirmation = await vscode.window.showWarningMessage(...);
            // if (confirmation !== 'Delete') return;
            
            logDebug(`[executeDeleteServer] Starting deletion process for: ${serverId}`);
            try {
                // 1. Stop the server process via manager
                if (serverManager.hasServer(serverId)) {
                    logDebug(`[executeDeleteServer] Stopping server process: ${serverId}`);
                    await serverManager.stopServer(serverId);
                    logInfo(`[executeDeleteServer] Stopped server process: ${serverId}`);
                }
                // 2. Remove configuration from manager (redundant if stopServer does it, but safe)
                await serverManager.removeServerConfiguration(serverId);
                logInfo(`[executeDeleteServer] Removed config from ServerManager for: ${serverId}`);

                // 3. Remove from persistent storage
                await configStorage.removeServer(serverId);
                logInfo(`[executeDeleteServer] Removed config from ConfigStorage for: ${serverId}`);

                // 4. Notify provider/webview to update UI
                chatWebviewProvider.handleServerRemoved(serverId); // Add method to provider

                vscode.window.showInformationMessage(`Server "${serverId}" has been deleted.`);
                logInfo(`[executeDeleteServer] Deletion completed successfully for: ${serverId}`);

            } catch (error) {
                const errorMsg = getErrorMessage(error);
                logError(`[executeDeleteServer] Error deleting server ${serverId}: ${errorMsg}`);
                vscode.window.showErrorMessage(`Failed to delete server ${serverId}: ${errorMsg}`);
                 // Notify provider of failure?
                 chatWebviewProvider.handleServerDeletionError(serverId, errorMsg);
            }
        });
        context.subscriptions.push(executeDeleteServerDisposable);
        logInfo('[Extension] Registered command: mcpClient.executeDeleteServer');

    } catch (error: unknown) { 
        logError(`[Extension] Failed to register mcpClient.executeDeleteServer: ${getErrorMessage(error)}`);
    }

    // Command to *trigger* deletion via quick pick (calls the execute command)
    try {
        const deleteServerByNameDisposable = vscode.commands.registerCommand('mcpClient.deleteServerByName', async () => {
            logInfo('[Extension] Command executed: mcpClient.deleteServerByName');
            const serverNames = configStorage.getServerNames();
            if (serverNames.length === 0) {
                vscode.window.showInformationMessage('No servers available to delete.');
                return;
            }
            const selectedServer = await vscode.window.showQuickPick(serverNames, { placeHolder: 'Select a server to delete', ignoreFocusOut: true });
            if (!selectedServer) return; // User cancelled

            const confirmation = await vscode.window.showWarningMessage(`Are you sure you want to delete "${selectedServer}"?`, { modal: true }, 'Delete', 'Cancel');
            if (confirmation !== 'Delete') return;

            // Execute the actual deletion command
            await vscode.commands.executeCommand('mcpClient.executeDeleteServer', selectedServer);
        });
        context.subscriptions.push(deleteServerByNameDisposable);
        logInfo('[Extension] Registered command: mcpClient.deleteServerByName');
    } catch (error: unknown) {
        logError(`[Extension] Failed to register mcpClient.deleteServerByName: ${getErrorMessage(error)}`);
    }

    // Remove older/specific deletion commands if executeDeleteServer covers all cases
     // context.subscriptions.push(vscode.commands.registerCommand('mcpClient.deleteCurrentServer', ...));
     // context.subscriptions.push(vscode.commands.registerCommand('mcpClient.deleteGithubServer', ...));
     // context.subscriptions.push(vscode.commands.registerCommand('mcpClient.removeServer', ...)); // May be redundant


    // Monitor configuration changes (optional, provider might handle UI updates)
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('mcpClient')) {
                logInfo('[Extension] Configuration changed (mcpClient section affected).');
                // Potentially trigger a refresh in the provider
                chatWebviewProvider.handleConfigChange(); // Add method to provider
            }
        })
    );

    // Register cleanup function
    context.subscriptions.push({
        dispose: () => {
            logInfo('[Extension] Disposing extension resources.');
            // Provider disposal is handled by adding it to subscriptions
            if (McpServerManager.getInstance) {
                McpServerManager.getInstance().dispose();
            }
        }
    });

    logInfo('[Extension] MCP Client extension activation completed.');
    isExtensionActivated = true;
}

// Deactivate function
export function deactivate() {
    logInfo('[Extension] Deactivating extension.');
    // Provider and output channel disposal are handled via context.subscriptions
    // Clean up server manager explicitly if needed (its dispose might be in provider disposal)
    if (serverManager && typeof serverManager.dispose === 'function') {
        // serverManager.dispose(); // Potentially redundant if provider disposes it
    }
    isExtensionActivated = false;
    logInfo('[Extension] Deactivation sequence finished.');
}

// --- Removed Functions (Moved to Provider) ---
// handleSendMessage(...)
// updateWebviewWithServerList(...)
// openChatPanel(...)
// executeServerDeletion(...) -> Logic moved to mcpClient.executeDeleteServer command
// determineTargetAndFormatMessage(...)
// setupChatPanelListeners(...)
// sendErrorToWebview(...)

