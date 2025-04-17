# MCP Config Assistant - VS Code Extension

This Visual Studio Code extension provides tools to manage and interact with servers implementing the Model Context Protocol (MCP), primarily focusing on communication via standard I/O (stdio). It also features an integrated AI assistant (powered by Anthropic Claude) that can dynamically use connected MCP servers as tools.

## Core Features

*   **Server Management:**
    *   Add new MCP servers by specifying their start command, arguments, and environment variables.
    *   Persistently store server configurations.
    *   Start and stop managed server processes directly from VS Code.
    *   Automatically start configured servers when VS Code launches (optional setting).
    *   Remove server configurations.
*   **Server Dashboard:**
    *   A dedicated panel (`MCP Server Manager: Show Dashboard` command) to view all configured servers.
    *   Displays the real-time status of each server (Connecting, Connected, Disconnected, Error) and its Process ID (PID).
    *   Provides buttons to Start, Stop, Remove, and Refresh Capabilities for each server.
*   **Capability Negotiation:**
    *   Automatically sends `capability_request` to servers upon connection.
    *   Receives and stores `capability_response` from servers, detailing available models, tools, and context types.
    *   Allows manual refreshing of capabilities via the dashboard or command palette.
*   **AI Assistant Integration (Anthropic Claude):**
    *   Integrates with Anthropic's API (currently using Claude 3.5 Sonnet).
    *   Requires configuring your Anthropic API key in VS Code settings (`mcpServerManager.anthropicApiKey`).
*   **Dynamic Tool Use:**
    *   The AI assistant automatically discovers capabilities (tools) from all currently *connected* MCP servers.
    *   It can intelligently decide to use these server-provided tools to fulfill user requests.
    *   Handles the full tool-use lifecycle: Assistant requests tool -> Extension calls server -> Server executes -> Extension sends result back to Assistant -> Assistant generates final response.
*   **Chat Interface:**
    *   A dedicated Chat View in the VS Code sidebar.
    *   Send messages to the AI assistant.
    *   View the assistant's responses, including indications of tool calls.
    *   Displays server status updates.
*   **Logging:**
    *   Detailed logging to a dedicated Output Channel (`MCP Server Manager`).
    *   Logs are also written to timestamped files in the extension's global storage directory for debugging. (`MCP Server Manager: Show Logs` command).

## Requirements

*   Visual Studio Code (latest version recommended).
*   An [Anthropic API Key](https://console.anthropic.com/settings/keys) (required for the AI Assistant feature).
*   Access to one or more MCP-compatible servers (e.g., [@modelcontextprotocol/server-filesystem](https://github.com/modelcontextprotocol/server-filesystem), [@modelcontextprotocol/server-github](https://github.com/modelcontextprotocol/server-github), [mcp-server-time](https://github.com/search?q=mcp-server-time)).

## Configuration

*   **Anthropic API Key:** Set your API key in VS Code Settings under `Extensions > MCP Server Manager > Anthropic Api Key`.
*   **Auto-Start Servers:** Enable/disable automatic server startup via the `Extensions > MCP Server Manager > Auto Start Servers` setting.
*   **Adding Servers:**
    *   Use the command `MCP Server Manager: Add Server`.
    *   Alternatively, use the "Add Server" button within the Server Dashboard. You will be prompted for a unique name, the start command, and optional arguments.

## Usage

1.  **Configure API Key:** Ensure your Anthropic API key is set in the VS Code settings.
2.  **Add Servers:** Use the `MCP Server Manager: Add Server` command or the dashboard to configure the servers you want to manage.
    *   *Example Command (Filesystem Server):* `npx -y @modelcontextprotocol/server-filesystem C:\path\to\allowed\dir D:\another\allowed\path`
    *   *Example Command (Time Server):* `uvx mcp-server-time --local-timezone=Your/Timezone`
3.  **Open Dashboard:** Use the `MCP Server Manager: Show Dashboard` command to view and control servers.
4.  **Start Servers:** Use the "Start" button on the dashboard for servers you want the AI assistant to use. Wait for their status to become "Connected".
5.  **Open Chat View:** Find the MCP Chat View in the sidebar (you might need to click the corresponding icon in the Activity Bar).
6.  **Interact:** Send messages to the assistant. If your request involves capabilities provided by a connected server (like getting the current time, listing files, etc.), the assistant should attempt to use the appropriate server tool.

## Development

*(Add details here if needed, e.g., how to clone, install dependencies (`npm install`), compile (`npm run compile`), and run in debug mode (`F5`))*

---

*Note: This extension is under active development. Features and protocols may evolve.*
