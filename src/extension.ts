import * as vscode from 'vscode';
import * as path from 'path'; // Needed for LogManager initialization
import { LogManager } from './utils/LogManager';

// --- Restore necessary imports ---
import { McpServerManager } from './services/McpServerManager';
import { ConfigStorage } from './services/ConfigStorage';
import { ChatViewProvider } from './panels/ChatViewProvider';
import { ServerDashboard } from './panels/ServerDashboard';
import { parseArgumentsString } from './commands/ServerCommands';
import { ServerStatusEvent, ServerConfig, ModelRequest, ServerCapability, CapabilityItem } from './models/Types';
import { determineAppropriateServers } from './utils'; // Restore if needed for server selection later

// --- Anthropic SDK Imports ---
import { Anthropic } from "@anthropic-ai/sdk";
// --- Try importing directly from the resources level ---
import {
  MessageParam,
  Tool,
  ToolUseBlock,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources"; // Removed '/messages.mjs'

// --- Declare instances accessible within the module ---
let configStorage: ConfigStorage;
let mcpServerManager: McpServerManager;
// Remove logManager instance variable, as we'll use static methods

export let extensionContext: vscode.ExtensionContext;

// --- Anthropic Client Instance ---
// Instantiate later when API key is available
let anthropic: Anthropic | undefined;

// Define the simpler type needed for matching
type SimpleServerAbility = {
    name: string;
    description: string;
};

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
        dispose: () => {
            LogManager.info('Extension', 'Deactivating extension, disposing McpServerManager...');
            try {
                mcpServerManager?.dispose(); // Use optional chaining
                LogManager.info('Extension', 'McpServerManager disposed.');
            } catch (disposeError: any) {
                 LogManager.error('Extension', `Error disposing McpServerManager`, disposeError); // Pass error obj as data
            }
        }
    });

    LogManager.info('Extension', 'MCP Manager Activation Complete.');
}

// Deactivate function
export function deactivate() {
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
    const componentName = 'handleSendMessage(Anthropic)';
    LogManager.debug(componentName, `Triggered via ChatViewProvider`, message);

    if (!configStorage || !mcpServerManager) {
        LogManager.error(componentName, "Core services not initialized!");
        webviewProvider.updateChat("Error: Core services not ready.");
        return;
    }

    // --- Get Anthropic API Key & Initialize Client (Keep at the top) ---
    const config = vscode.workspace.getConfiguration('mcpServerManager');
    const apiKey = config.get<string>('anthropicApiKey');
    if (!apiKey) {
        LogManager.error(componentName, 'Anthropic API Key not configured.');
        vscode.window.showErrorMessage('Anthropic API Key is not configured. Please set it in VS Code settings (MCP Server Manager > Anthropic Api Key).');
        webviewProvider.updateChat("Error: Anthropic API Key not configured.");
        return;
    }
    if (!anthropic) {
        try {
            anthropic = new Anthropic({
                apiKey: apiKey,
                timeout: 60 * 1000,
            });
            LogManager.info(componentName, 'Anthropic client initialized.');
        } catch (err: any) {
             LogManager.error(componentName, 'Failed to initialize Anthropic client', err);
             webviewProvider.updateChat(`Error initializing Anthropic client: ${LogManager.getErrorMessage(err)}`);
             return;
        }
    }

    try {
        // --- Initial Anthropic Call Setup ---
        const messages: MessageParam[] = [{ role: "user", content: message.text }];
        LogManager.debug(componentName, 'Preparing initial call to Anthropic');
        webviewProvider.updateChat("Thinking..."); // Indicate processing

        // --- MODIFICATION: Gather Tools JUST BEFORE the API call ---
        const availableTools: Tool[] = [];
        const serverNames = configStorage.getServerNames();
        LogManager.debug(componentName, 'Gathering tools from currently connected servers...');

        for (const serverId of serverNames) {
            const serverInstance = mcpServerManager.getServer(serverId);
            // Check CURRENT status right before the API call
            if (serverInstance?.getStatus() === 'connected') {
                const manifest = configStorage.getServerCapabilities(serverId);
                if (manifest?.capabilities) {
                    LogManager.debug(componentName, `Adding tools from connected server: ${serverId}`);
                    manifest.capabilities.forEach((cap: CapabilityItem) => {
                        const prefixedToolName = `${serverId}__${cap.name}`;

                        // --- FIX: Ensure valid input_schema structure ---
                        let finalInputSchema: Tool['input_schema'] = { type: 'object', properties: {} }; // Default empty object schema

                        if (cap.inputSchema) {
                            // Check if it already has a 'type' property (likely a valid schema)
                            if (typeof cap.inputSchema === 'object' && 'type' in cap.inputSchema) {
                                // Assume it's already a valid schema structure
                                finalInputSchema = cap.inputSchema as Tool['input_schema'];
                            }
                            // Check if it's just a Record (treat as properties)
                            else if (typeof cap.inputSchema === 'object' && !('type' in cap.inputSchema)) {
                                finalInputSchema = {
                                    type: 'object',
                                    properties: cap.inputSchema as Record<string, any>,
                                    // We don't know required fields here, so omit 'required' unless provided separately
                                };
                            }
                             // Add more checks if other formats are possible for cap.inputSchema
                        }
                        // --- END FIX ---

                        availableTools.push({
                            name: prefixedToolName,
                            description: cap.description || `Tool ${cap.name} on server ${serverId}`,
                            input_schema: finalInputSchema, // Use the validated/constructed schema
                        });
                    });
                } else {
                     LogManager.debug(componentName, `Connected server ${serverId} reported no capabilities.`);
                }
            } else {
                 LogManager.debug(componentName, `Skipping tools for server ${serverId} (Status: ${serverInstance?.getStatus() ?? 'Not Found'})`);
            }
        }

        if (availableTools.length === 0) {
            LogManager.warn(componentName, 'No tools available from connected servers AT THIS TIME.');
            // Inform the user maybe? Or proceed without tools.
            // Let's proceed without tools, Anthropic will respond naturally.
        } else {
             LogManager.debug(componentName, `Gathered ${availableTools.length} tools for Anthropic call`, { toolNames: availableTools.map(t => t.name) });
        }
        // --- END TOOL GATHERING MODIFICATION ---


        // --- Make the Initial Anthropic Call ---
        let response = await anthropic.messages.create({
            model: "claude-3-5-sonnet-20240620",
            max_tokens: 1024,
            messages: messages,
            tools: availableTools.length > 0 ? availableTools : undefined, // Pass tools if gathered
        });

        LogManager.debug(componentName, 'Received initial response from Anthropic', { stopReason: response.stop_reason });

        // --- Handle Potential Tool Calls (Logic remains the same) ---
        while (response.stop_reason === "tool_use" && response.content.some((c: any) => c.type === "tool_use")) {
            const toolUses = response.content.filter((c: any): c is ToolUseBlock => c.type === "tool_use");
            const toolResults: ToolResultBlockParam[] = [];

            messages.push({ role: "assistant", content: response.content }); // Add assistant's turn (including tool_use requests)

            for (const toolUse of toolUses) {
                const fullToolName = toolUse.name;
                const toolInput = toolUse.input;
                const toolUseId = toolUse.id;

                // --- MODIFICATION: Parse Server ID and Tool Name using double underscore ---
                const nameParts = fullToolName.split('__'); // Split by double underscore
                if (nameParts.length < 2) {
                    LogManager.error(componentName, `Invalid tool name format from Anthropic: ${fullToolName}. Expected 'serverId__toolName'.`);
                    toolResults.push({ type: "tool_result", tool_use_id: toolUseId, content: `Error: Invalid tool name format received: ${fullToolName}` });
                    continue;
                }
                const targetServerId = nameParts[0];
                const actualToolName = nameParts.slice(1).join('__'); // Re-join if tool name contained '__'
                // --- END MODIFICATION ---

                LogManager.info(componentName, `Anthropic requested tool call`, { serverId: targetServerId, toolName: actualToolName, input: toolInput });
                webviewProvider.updateChat(`Calling tool ${actualToolName} on ${targetServerId}...`);

                 // --- Execute Tool Call via McpServerManager ---
                let toolOutputContent: string;
                let isError = false;
                 try {
                    // Re-ensure server is started (good practice)
                    await mcpServerManager.ensureServerStarted(targetServerId);

                    const mcpRequestPayload: ModelRequest = {
                        prompt: JSON.stringify({ tool: actualToolName, params: toolInput || {} }),
                        model: targetServerId,
                    };

                    const responseString = await mcpServerManager.sendMessage(targetServerId, mcpRequestPayload);
                    LogManager.info(componentName, `Raw response from MCP server ${targetServerId}: ${responseString}`);

                    // Attempt to parse the server response. Assume it might be JSON containing the actual result.
                    try {
                         const serverResponseJson = JSON.parse(responseString);
                         // Look for common output patterns (adapt as needed based on actual server responses)
                         if (serverResponseJson.content && Array.isArray(serverResponseJson.content) && serverResponseJson.content[0]?.text) {
                            toolOutputContent = serverResponseJson.content[0].text;
                         } else if (typeof serverResponseJson === 'object') {
                            // Fallback: stringify the whole JSON object
                            toolOutputContent = JSON.stringify(serverResponseJson);
                         } else {
                            toolOutputContent = responseString; // Use raw string if not parseable or unexpected structure
                         }
                         isError = serverResponseJson.isError === true; // Check if server explicitly marked it as error

                    } catch (parseError) {
                        LogManager.warn(componentName, `Failed to parse JSON response from MCP server, using raw string.`, { responseString, parseError });
                        toolOutputContent = responseString; // Use the raw response if JSON parsing fails
                    }

                 } catch (execError) {
                    LogManager.error(componentName, `Error executing tool ${actualToolName} on ${targetServerId}`, execError);
                    toolOutputContent = `Error: ${LogManager.getErrorMessage(execError)}`;
                    isError = true;
                 }

                // Add the result back for the next Anthropic call
                 toolResults.push({
                    type: "tool_result",
                    tool_use_id: toolUseId,
                    content: toolOutputContent, // Send the extracted/raw content
                    is_error: isError, // Indicate if the tool execution failed
                });
            } // End loop through toolUses

            // Add the tool results to messages
            messages.push({ role: "user", content: toolResults });

            // Call Anthropic again
             LogManager.debug(componentName, 'Making follow-up call to Anthropic with tool results');
             webviewProvider.updateChat("Processing tool results...");
             response = await anthropic.messages.create({
                model: "claude-3-5-sonnet-20240620",
                max_tokens: 1024,
                messages: messages,
                tools: availableTools.length > 0 ? availableTools : undefined,
            });
            LogManager.debug(componentName, 'Received follow-up response from Anthropic', { stopReason: response.stop_reason });

        } // End while loop for tool calls

        // --- Process Final Response ---
        let finalText = "";
        if (response.content.length > 0 && response.content[0].type === "text") {
            finalText = response.content[0].text;
        } else if (response.stop_reason === 'max_tokens') {
             finalText = "[Response truncated due to maximum token limit]";
             LogManager.warn(componentName, 'Anthropic response truncated due to max_tokens');
        } else {
             finalText = "[Received non-text final response or empty response]";
             LogManager.warn(componentName, 'Anthropic final response was not text or was empty', { response });
        }

        webviewProvider.updateChat(finalText);

    } catch (error: any) {
        LogManager.error(componentName, `Unhandled error in handleSendMessage`, error);
        // Check for Anthropic specific errors
        if (error instanceof Anthropic.APIError) {
             webviewProvider.updateChat(`An API error occurred (Status: ${error.status}): ${error.message}`);
        } else {
             webviewProvider.updateChat(`An unexpected error occurred: ${LogManager.getErrorMessage(error)}`);
        }
    }
}

