import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

// --- Add a flag ---
let isInitialized = false;
let outputChannel: vscode.OutputChannel | undefined;
let logFilePath: string | undefined;
// ---

export class LogManager {
    public static initialize(extensionPath: string): void {
        if (isInitialized) {
            // Maybe log a warning?
            return;
        }
        try {
            outputChannel = vscode.window.createOutputChannel('MCP Server Manager');
            
            // Create logs directory
            const logsDir = path.join(extensionPath, 'logs');
            if (!fs.existsSync(logsDir)) {
                fs.mkdirSync(logsDir, { recursive: true });
            }
            
            // Set up log file
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            logFilePath = path.join(logsDir, `mcp-manager-${timestamp}.log`);
            isInitialized = true; // --- Set flag ---
            LogManager.info('LogManager', `Logging initialized. Log file: ${logFilePath}`);
        } catch (error) {
            console.error("Failed to initialize LogManager:", error);
            // Avoid using LogManager here as it might fail again
        }
    }
    
    public static info(component: string, message: string, data?: any): void {
        LogManager.log('INFO', component, message, data);
    }
    
    public static warn(component: string, message: string, data?: any): void {
        LogManager.log('WARN', component, message, data);
    }
    
    public static error(component: string, message: string, error?: any): void {
        // Handle potential error objects passed as 'data'
        let data: any = {};
        if (error) {
            if (error instanceof Error) {
                // Include stack trace if available
                data.errorMessage = error.message;
                data.errorStack = error.stack;
            } else {
                // Handle non-Error objects
                data.errorDetails = error;
            }
        }
         // Combine message and error details for logging
         const combinedMessage = `${message}${error ? `: ${error.message || error}` : ''}`;
        LogManager.log('ERROR', component, combinedMessage, data.errorStack ? { stack: data.errorStack } : data.errorDetails ? {details: data.errorDetails} : undefined);
    }
    
    public static debug(component: string, message: string, data?: any): void {
        // Add conditional check for debug logging if needed later
        LogManager.log('DEBUG', component, message, data);
    }
    
    private static log(level: string, component: string, message: string, data?: any): void {
        if (!isInitialized) { // <-- Check flag
            console.warn(`[${level.toUpperCase()}] LogManager not initialized. Log attempt: [${component}] ${message}`, data);
            return;
        }
        if (!outputChannel || !logFilePath) {
             console.error("LogManager state invalid (outputChannel or logFilePath missing).");
             return;
        }

        const timestamp = new Date().toISOString();
        const logData = data ? ` ${JSON.stringify(data)}` : '';
        const logEntry = `[${timestamp}] [${level.toUpperCase()}] [${component}] - ${message}${logData}\n`;

        try {
            outputChannel.appendLine(`[${level.toUpperCase()}] [${component}] ${message}${logData}`);
            fs.appendFileSync(logFilePath, logEntry);
        } catch (error) {
            console.error("Failed to write log entry:", error);
            // Avoid using LogManager here
        }
    }
    
    public static getErrorMessage(error: unknown): string {
        if (error instanceof Error) {
            return error.message;
        }
        return String(error);
    }
    
    public static showOutputChannel(): void {
        if (!isInitialized) {
            vscode.window.showWarningMessage("LogManager not initialized, cannot show output channel.");
            return;
        }
        outputChannel?.show(true); // Preserve focus on the editor
    }
}