import * as vscode from 'vscode';

/**
 * Generates the HTML content for a webview panel or view.
 * Includes basic structure, CSP, and placeholders for toolkit and custom scripts/styles.
 */
export function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    // --- Generate URIs for local resources ---

    // Base URI for webview resources (like toolkit)
    const baseUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview'));

    // Example: URI for VS Code Toolkit (assuming it's copied to dist/webview)
    // const toolkitUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'toolkit.min.js'));

    // Example: URI for your custom webview script bundle
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'webview.js'));

    // Example: URI for your custom webview CSS
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'styles.css'));

    // Example: URI for codicons CSS
    const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css'));

    // Use a nonce for inline scripts/styles as per CSP best practices
    const nonce = getNonce();

    // --- Content Security Policy ---
    // Adjust accordingly based on external resources, fonts, etc. you might load
    const cspSource = webview.cspSource;
    const fontSrc = `${cspSource} ${webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'node_modules', '@vscode/codicons'))}`;
    const styleSrc = `${cspSource} 'unsafe-inline' ${webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'node_modules', '@vscode/codicons'))}`;
    const csp = `
        default-src 'none';
        script-src 'nonce-${nonce}' ${cspSource} 'unsafe-eval';
        style-src ${styleSrc};
        font-src ${fontSrc};
        img-src ${cspSource} https: data:;
        connect-src ${cspSource};
    `.replace(/\s{2,}/g, ' ').trim(); // Format CSP string

    // --- HTML Content ---
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="${csp}">

    <title>MCP Client</title>

    <link href="${codiconsUri}" rel="stylesheet" />
    <link href="${styleUri}" rel="stylesheet" />

    <base href="${baseUri}/">

    <!-- Toolkit script (if needed) would be loaded here -->
    <!-- Example: <script type="module" nonce="${nonce}" src="path/to/toolkit.min.js"></script> -->
</head>
<body>
    <h1>MCP Client Webview</h1>
    <p>Loading content...</p>
    <div id="root"></div>

    <!-- Add the bundled webview script -->
    <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

// Function to generate a random nonce string
function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
} 