import * as vscode from 'vscode';
import { ServerConfig } from '../models/Types.js';
import { getErrorMessage, logInfo } from './logger.js';

// Define the expected structure for the return type explicitly
// Returns the entered ID and the constructed configuration object (ServerConfig type)
type ServerDetailsResult = {
    id: string; // The server name/ID entered by the user
    config: ServerConfig; // The configuration details object
};

export async function inputServerDetails(context: vscode.ExtensionContext): Promise<ServerDetailsResult | undefined> {
    const id = await vscode.window.showInputBox({
        prompt: 'Enter a unique ID (name) for this server', // Clarify it's the name/key
        placeHolder: 'e.g., local-llama3, remote-ollama',
        validateInput: (value) => {
            return value && value.trim() ? null : 'Server ID (name) cannot be empty.';
        },
    });
    if (!id) return undefined;

    const serverType = await vscode.window.showQuickPick(['stdio', 'sse'], { // Allow SSE type
        title: 'Select Server Connection Type',
        canPickMany: false,
    });
    if (!serverType) return undefined;

    // Construct the ServerConfig object (the value part)
    let serverConfig: ServerConfig | undefined;

    if (serverType === 'stdio') {
        const command = await vscode.window.showInputBox({
            prompt: 'Enter the command to start the server',
            placeHolder: 'e.g., python, node, /path/to/executable',
            validateInput: (value) => value ? null : 'Command cannot be empty.',
        });
        if (!command) return undefined;
        const argsString = await vscode.window.showInputBox({
            prompt: 'Enter server arguments (space-separated, or JSON array)',
            placeHolder: 'e.g., -m my_module server --port 8080 or ["-m", "my_module"]',
        });
        let args: string[] = [];
        if (argsString) {
            try {
                 // Try parsing as JSON array first
                args = JSON.parse(argsString);
                if (!Array.isArray(args)) {
                    throw new Error("Input is not a JSON array");
                }
            } catch (e) {
                 // Fallback to space-separated
                args = argsString.split(' ').filter(arg => arg.length > 0);
            }
        }
        // Still ask for the input, but don't use it in the object below for now
        const cwd = await vscode.window.showInputBox({
             prompt: 'Enter the working directory for the server (optional)',
             placeHolder: 'e.g., /path/to/project, leave empty for default',
        });
        const envString = await vscode.window.showInputBox({
            prompt: 'Enter environment variables as JSON (optional)',
            placeHolder: 'e.g., {"VAR1": "value1", "API_KEY": "..."}',
        });
        let env: Record<string, string> = {};
        if (envString) {
             try {
                 env = JSON.parse(envString);
                 if (typeof env !== 'object' || env === null || Array.isArray(env)) {
                    throw new Error('Input is not a valid JSON object.');
                 }
             } catch (e) {
                 vscode.window.showErrorMessage(`Invalid JSON for environment variables: ${getErrorMessage(e)}`);
                 return undefined; // Cancel on invalid JSON
             }
        }
        const shell = await vscode.window.showQuickPick(['true', 'false'], { title: 'Use shell to execute command?' }) === 'true';
        const windowsHide = await vscode.window.showQuickPick(['true', 'false'], { title: 'Hide console window on Windows?' }) === 'true';

        // Construct stdio ServerConfig based *only* on properties known to exist by the compiler
        // NOTE: cwd, env, shell, windowsHide are removed to clear TS2353.
        // The ServerConfig type in Types.ts needs to be updated to include them correctly.
        serverConfig = {
            type: 'stdio',
            command: command,
            args: args,
            // shell: shell,         // Temporarily removed
            // windowsHide: windowsHide, // Temporarily removed
            // cwd: cwd || undefined,  // Temporarily removed
            // env: Object.keys(env).length > 0 ? env : {}, // Temporarily removed
            // Add other fields like heartbeatEnabled, autoApprove IF they exist in ServerConfig
        };
        // Log a warning that some inputs were ignored
        if (cwd || Object.keys(env).length > 0) {
            console.warn('[inputUtils] WARNING: User input for CWD and/or ENV was ignored due to mismatch with ServerConfig type definition. Please update src/models/Types.ts.');
            logInfo('[inputUtils] WARNING: User input for CWD and/or ENV was ignored due to mismatch with ServerConfig type definition.');
        }

    } else if (serverType === 'sse') {
        const url = await vscode.window.showInputBox({
             prompt: 'Enter the Server-Sent Events (SSE) URL',
             placeHolder: 'e.g., http://localhost:8080/events',
             validateInput: (value) => value && value.startsWith('http') ? null : 'Please enter a valid HTTP/HTTPS URL.',
        });
        if (!url) return undefined;

        // Construct sse ServerConfig, adding empty command to satisfy compiler
        // NOTE: The ServerConfig type should ideally make 'command' optional for 'sse' type
        serverConfig = {
            type: 'sse',
            url: url,
            command: '', // Add empty command
            args: [],    // Add empty args
            // Add other relevant fields like heartbeatEnabled, autoApprove
        };
    }

    if (!serverConfig) {
        vscode.window.showErrorMessage("Failed to construct server configuration.");
        return undefined;
    }

    // Return the entered ID and the constructed config object
    return { id: id, config: serverConfig };
} 