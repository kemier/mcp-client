import * as vscode from 'vscode';
import { ConfigStorage } from '../services/ConfigStorage.js';
import { ServerConfig } from '../models/Types.js';
import { LogManager } from '../utils/LogManager.js';
import { logInfo, logError, getErrorMessage } from '../utils/logger.js';
import { inputServerDetails } from '../utils/inputUtils.js';

export function registerAddServerCommand(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.commands.registerCommand('mcpClient.addServerWizard', async () => {
        logInfo('[ServerCommands] Executing command: mcpClient.addServerWizard');
        try {
            const configStorage = ConfigStorage.getInstance(context);

            const details = await inputServerDetails(context);

            if (details) {
                const { id: serverName, config: serverConfig } = details;
                logInfo(`[ServerCommands] Received details for server: ${serverName}`);

                await configStorage.addOrUpdateServer(serverName, serverConfig);

                vscode.window.showInformationMessage(`Server configuration '${serverName}' added/updated successfully.`);

                // Optionally trigger other actions like starting the server via McpServerManager
                // Example: McpServerManager.getInstance().startServer(serverName);

            } else {
                logInfo('[ServerCommands] Add server wizard cancelled by user.');
            }
        } catch (error) {
            logError('[ServerCommands] Error in add server command:', getErrorMessage(error));
            vscode.window.showErrorMessage(`Failed to add/update server: ${getErrorMessage(error)}`);
        }
    });
}

// Helper function to validate server name
export function validateServerName(name: string): string | undefined {
    if (!name) {
        return 'Server name is required';
    }
    
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        return 'Server name can only contain letters, numbers, hyphens, and underscores';
    }
    
    // Check if name already exists
    const configStorage = ConfigStorage.getInstance();
    const existingServers = configStorage.getAllServers();
    
    if (existingServers[name]) {
        return `Server "${name}" already exists`;
    }
    
    return undefined; // Valid
}

// Helper function to parse command arguments
export function parseArgumentsString(argsString: string): string[] {
    const args: string[] = [];
    let current = '';
    let inQuotes = false;
    let escapeNext = false;
    
    for (let i = 0; i < argsString.length; i++) {
        const char = argsString[i];
        
        if (escapeNext) {
            current += char;
            escapeNext = false;
            continue;
        }
        
        if (char === '\\') {
            escapeNext = true;
            continue;
        }
        
        if (char === '"' || char === "'") {
            inQuotes = !inQuotes;
            continue;
        }
        
        if (char === ' ' && !inQuotes) {
            if (current) {
                args.push(current);
                current = '';
            }
            continue;
        }
        
        current += char;
    }
    
    if (current) {
        args.push(current);
    }
    
    return args;
}

// Helper function to configure environment variables
export async function configureEnvironmentVariables(initialEnv: Record<string, string> = {}): Promise<Record<string, string>> {
    const env: Record<string, string> = { ...initialEnv };
    let configuring = true;

    while (configuring) {
        // LogManager.debug('[configureEnvironmentVariables]', 'Loop start. Current env:', env);
        const varName = await vscode.window.showInputBox({
            prompt: 'Enter environment variable name (leave empty to finish)',
            placeHolder: 'e.g., API_KEY',
            ignoreFocusOut: true
        });
        // LogManager.debug('[configureEnvironmentVariables]', `Got varName: ${varName}`);

        if (!varName) {
            // LogManager.debug('[configureEnvironmentVariables]', 'varName is empty, setting configuring = false.');
            configuring = false;
            continue;
        }

        try {
            // LogManager.debug('[configureEnvironmentVariables]', 'Prompting for varValue...');
            const varValue = await vscode.window.showInputBox({
                prompt: `Enter value for ${varName}`,
                placeHolder: `Current: ${env[varName] || 'Not set'}`,
                ignoreFocusOut: true
                // value: env[varName], // Keep this line removed/commented
            });
            // LogManager.debug('[configureEnvironmentVariables]', `Returned from varValue input. varValue = ${varValue}`);

            if (varValue !== undefined) {
                // LogManager.debug('[configureEnvironmentVariables]', 'varValue is defined, updating env.');
                env[varName] = varValue;

                // LogManager.debug('[configureEnvironmentVariables]', 'Preparing to ask "Add or edit another?"...');
                const addAnother = await vscode.window.showQuickPick(['Yes', 'No'], {
                    placeHolder: `Variable ${varName} set. Add or edit another?`
                });
                // LogManager.debug('[configureEnvironmentVariables]', `Got addAnother: ${addAnother}`);

                if (addAnother === 'No' || addAnother === undefined) {
                    // LogManager.debug('[configureEnvironmentVariables]', 'User chose No or cancelled addAnother, setting configuring = false.');
                    configuring = false;
                } else {
                    // LogManager.debug('[configureEnvironmentVariables]', 'User chose Yes for addAnother, continuing loop.');
                }
            } else {
                // LogManager.debug('[configureEnvironmentVariables]', 'varValue is undefined (cancelled), showing warning and continuing loop.');
                vscode.window.showWarningMessage(`Value input cancelled for ${varName}, keeping previous value.`);
            }
        } catch (error) {
            LogManager.error('[configureEnvironmentVariables]', 'Caught error after varName input:', error);
            vscode.window.showErrorMessage(`An unexpected error occurred while editing environment variables: ${getErrorMessage(error)}`);
            configuring = false; // Stop the loop on error
        }

        // LogManager.debug('[configureEnvironmentVariables]', `End of loop iteration. configuring = ${configuring}`);
    }

    // LogManager.debug('[configureEnvironmentVariables]', 'Exited loop. Returning env:', env);
    return env;
}

// Placeholder for edit/remove commands if they exist in this file
export function registerEditServerCommand(/* ... */): vscode.Disposable {
    // Replace saveServerConfig with addOrUpdateServer here too if used
    throw new Error("registerEditServerCommand not implemented");
}

export function registerRemoveServerCommand(/* ... */): vscode.Disposable {
    // Uses configStorage.removeServer - should be okay
     throw new Error("registerRemoveServerCommand not implemented");
}

// Example possible usage within an edit function (replace if found):
async function handleEditServer(context: vscode.ExtensionContext, serverId: string) {
     const configStorage = ConfigStorage.getInstance(context);
     const existingConfig = configStorage.getServer(serverId);
     if (!existingConfig) { /* ... */ return; }
     // ... prompt user for changes, resulting in updatedConfig ...
     const updatedConfig = { ...existingConfig /* ... applied changes ... */ };
     // Replace this line:
     // await configStorage.saveServerConfig(serverId, updatedConfig);
     // With this:
     await configStorage.addOrUpdateServer(serverId, updatedConfig);
     // ...
}