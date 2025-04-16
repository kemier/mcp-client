import * as vscode from 'vscode';

// Declare the output channel at the module level
let outputChannel: vscode.OutputChannel | undefined;

/**
 * Initializes the VS Code output channel for the extension.
 * Should be called once during activation.
 */
export function initializeLogger(context: vscode.ExtensionContext): void {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel("MCP Client");
        context.subscriptions.push(outputChannel); // Ensure it's disposed on deactivation
        logInfo("--- MCP Client Output Channel Initialized ---"); // Log initialization
    } else {
        logWarning("Logger already initialized.");
    }
}

/**
 * Gets the shared output channel instance.
 * Ensures the logger has been initialized.
 */
function getOutputChannel(): vscode.OutputChannel {
    if (!outputChannel) {
        // This should ideally not happen if initializeLogger is called correctly during activation.
        // As a fallback, try to create it, but this might miss context registration.
        console.warn("Logger accessed before initialization!");
        outputChannel = vscode.window.createOutputChannel("MCP Client");
    }
    return outputChannel;
}

// Utility function to extract message from any error type
export function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}

// Utility functions for logging
export function logDebug(message: string): void {
    console.log(message);
    try {
        getOutputChannel().appendLine(`[DEBUG] ${message}`);
    } catch (e) {
        console.error("Failed to write DEBUG log to output channel:", getErrorMessage(e));
    }
}

export function logError(message: string): void {
    console.error(message);
    try {
        getOutputChannel().appendLine(`[ERROR] ${message}`);
        // Optionally show the output channel when an error occurs
        // getOutputChannel().show(true); // Keep view column
    } catch (e) {
        console.error("Failed to write ERROR log to output channel:", getErrorMessage(e));
    }
}

export function logInfo(message: string): void {
    console.log(message);
    try {
        getOutputChannel().appendLine(`[INFO] ${message}`);
    } catch (e) {
        console.error("Failed to write INFO log to output channel:", getErrorMessage(e));
    }
}

export function logWarning(message: string): void {
    console.warn(message);
    try {
        getOutputChannel().appendLine(`[WARN] ${message}`);
    } catch (e) {
        console.error("Failed to write WARN log to output channel:", getErrorMessage(e));
    }
}

// Re-export outputChannel for potential direct use (though functions are preferred)
export { outputChannel }; 