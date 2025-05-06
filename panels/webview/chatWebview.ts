import * as vscode from 'vscode';

// Function to generate the HTML content for the webview
export function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri, nonce: string): string {
    // Get resource paths
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'));
    const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'styles.css'));

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} https:;">
  <title>MCP Chat</title>
  <link href="${stylesUri}" rel="stylesheet">
</head>
// ... existing code ... 