import * as vscode from 'vscode';
import { ConfigStorage } from '../services/ConfigStorage';
import { ServerConfig } from '../models/Types';
import { LogManager } from '../utils/LogManager';

export function registerAddServerCommand(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.commands.registerCommand('mcpClient.addServer', async () => {
        // Step 1: Get server name
        const serverName = await vscode.window.showInputBox({
            prompt: 'Enter a unique name for the server',
            placeHolder: 'e.g., my-mcp-server',
            validateInput: validateServerName
        });
        
        if (!serverName) return; // User cancelled
        
        // Step 2: Get server type
        const serverType = await vscode.window.showQuickPick(['stdio'], {
            placeHolder: 'Select server communication type'
        });
        
        if (!serverType) return; // User cancelled
        
        // Step 3: Get command
        const command = await vscode.window.showInputBox({
            prompt: 'Enter the command to start the server',
            placeHolder: 'e.g., python -m mcp_server.py'
        });
        
        if (!command) return; // User cancelled
        
        // Step 4: Get arguments
        const argsInput = await vscode.window.showInputBox({
            prompt: 'Enter command arguments (separate with spaces, use quotes for arguments with spaces)',
            placeHolder: 'e.g., --port 8000 --log-level debug'
        });
        
        const args = argsInput ? parseArgumentsString(argsInput) : [];
        
        // Step 5: Configure environment variables (optional)
        const configureEnv = await vscode.window.showQuickPick(['Yes', 'No'], {
            placeHolder: 'Configure environment variables?'
        });
        
        let env: Record<string, string> = {};
        if (configureEnv === 'Yes') {
            env = await configureEnvironmentVariables();
        }
        
        // Step 6: Configure shell options
        const useShell = await vscode.window.showQuickPick(['Yes', 'No'], {
            placeHolder: 'Use shell to execute command?'
        });
        
        const shell = useShell === 'Yes';
        
        // Step 7: Configure window hide (Windows only)
        const hideWindow = await vscode.window.showQuickPick(['Yes', 'No'], {
            placeHolder: 'Hide command window (Windows only)?'
        });
        
        const windowsHide = hideWindow === 'Yes';
        
        // Step 8: Create server configuration
        const serverConfig: ServerConfig = {
            type: serverType as 'stdio' | 'sse',
            command,
            args,
            shell,
            windowsHide,
            env,
            heartbeatEnabled: true
        };
        
        // Save configuration
        try {
            const configStorage = ConfigStorage.getInstance(context);
            await configStorage.saveServerConfig(serverName, serverConfig);
            
            vscode.window.showInformationMessage(`Server "${serverName}" added successfully.`);
            LogManager.info('ServerCommands', `Added new server: ${serverName}`, { config: serverConfig });
            
            // Offer to test the server
            const testServer = await vscode.window.showQuickPick(['Yes', 'No'], {
                placeHolder: 'Test server connection now?'
            });
            
            if (testServer === 'Yes') {
                vscode.commands.executeCommand('mcpConfig.diagnoseServer', serverName);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to add server: ${error instanceof Error ? error.message : String(error)}`);
            LogManager.error('ServerCommands', 'Failed to add server', error);
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

    // Add a message indicating current env vars if desired
    // vscode.window.showInformationMessage('Current Env Vars: ' + JSON.stringify(env) + '. Add/Modify below, leave name empty to finish.');

    while (configuring) {
        const varName = await vscode.window.showInputBox({
            prompt: 'Enter environment variable name (leave empty to finish)',
            placeHolder: 'e.g., API_KEY',
            ignoreFocusOut: true // Keep open on focus loss
        });

        if (!varName) {
            configuring = false;
            continue;
        }

        const varValue = await vscode.window.showInputBox({
            prompt: `Enter value for ${varName}`,
            placeHolder: `Current: ${env[varName] || 'Not set'}`,
            value: env[varName],
            ignoreFocusOut: true // Keep open on focus loss
        });

        if (varValue !== undefined) {
            env[varName] = varValue;
        } else {
            vscode.window.showWarningMessage(`Value input cancelled for ${varName}, keeping previous value.`);
        }
    }

    return env;
} 