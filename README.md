# MCP Config Assistant - VS Code Extension

This Visual Studio Code extension provides tools to manage Model Context Protocol (MCP) servers and facilitates interaction with a **local Large Language Model (LLM) inference server**. Communication with the local LLM server happens via **WebSocket JSON-RPC**, while communication with MCP tool servers primarily happens via standard I/O (stdio).

## Core Features

*   **MCP Tool Server Management:**
    *   Add new MCP tool servers (e.g., filesystem, time, github) by specifying their start command, arguments, etc.
    *   Persistently store tool server configurations.
    *   Start and stop managed tool server processes directly from VS Code using `McpServerManager`.
    *   Automatically start configured tool servers when VS Code launches (optional setting).
    *   Remove tool server configurations.
*   **Server Dashboard:**
    *   A dedicated panel (`MCP Server Manager: Show Dashboard` command) to view all configured MCP tool servers.
    *   Displays the real-time status (Connecting, Connected, Disconnected, Error) and Process ID (PID) of each managed tool server.
    *   Provides buttons to Start, Stop, Remove, and Refresh Capabilities for each tool server.
*   **Capability Negotiation (for Tool Servers):**
    *   Automatically sends `capability_request` to MCP tool servers upon connection.
    *   Receives and stores `capability_response` from servers, detailing available capabilities (tools).
    *   Allows manual refreshing of capabilities via the dashboard or command palette.
*   **Local LLM Integration (via WebSocket JSON-RPC):**
    *   Connects to a **running** local LLM inference process via a specified **IP address and Port** using WebSocket.
    *   Requires configuring the IP and Port in VS Code settings (`mcpServerManager.inferenceServerIp`, `mcpServerManager.inferenceServerPort`).
    *   Handles communication between the extension's chat interface and the local LLM process by sending JSON-RPC requests over WebSocket. The server should expose methods like `generate` and handle notifications.
*   **Dynamic Tool Use (LLM + MCP Servers):**
    *   The integrated `MCPClient` library discovers capabilities (tools) from:
        *   All currently *connected* MCP tool servers managed by `McpServerManager`.
        *   An optional `tools-matcher` server can be used to rank/filter relevant tools.
    *   This combined list of tools is sent to the local LLM within the `generate` request's `tools` parameter (OpenAI format).
    *   The local LLM decides when to use these tools, responding with a `function_call_request` notification, which includes a `tool_call` object containing an `id`, `tool` (name), and `parameters`.
    *   The `MCPClient` executes requested tool calls:
        *   Calls to *managed MCP servers* (e.g., `github@search_repositories`) are dispatched via `McpServerManager`.
    *   Results (or errors) from tool executions are sent back to the LLM via a `tool_result` JSON-RPC request. Each item in the `results` array includes the original `tool_call_id`, the `tool_name`, and the `result` or `error`.
    *   **Multi-Step Tool Calls:** The client supports loops where the LLM can make multiple sequential tool calls (each resulting in a `function_call_request` and subsequent `tool_result`) before generating the final textual response (signaled by an `end` notification with `final_text`).
    *   **Result Summarization:** For specific tools like `github@search_repositories`, the client may summarize or truncate large results before sending them back to the LLM.
*   **Conversation History Management:**
    *   The `MCPClient` maintains conversation history across multiple turns within a single session.
    *   The history (including the latest user message, assistant tool call requests, and tool results) is sent to the LLM with each `generate` request.
        *   User messages are `role: "user"`.
        *   Assistant messages requesting tools include `role: "assistant"` and a `tool_calls` array (OpenAI format).
        *   Tool execution results are sent as `role: "tool"` messages, including the `tool_call_id` and `tool_name` corresponding to the request, and the `content` (stringified result or error).
    *   The LLM server is expected to handle this history format.
    *   **New Chat Functionality:** A "New Chat" button in the UI allows clearing the client-side conversation history (`MCPClient.startNewChat()`) to start a fresh context with the LLM.
*   **Chat Interface:**
    *   A dedicated Chat View in the VS Code sidebar (`MCP Chat`).
    *   Send messages to the configured local LLM.
    *   View the LLM's responses, potentially generated after using MCP tools.
    *   Displays status updates for managed MCP tool servers and the connection status to the local inference server.
*   **Logging:**
    *   Detailed logging to a dedicated Output Channel (`MCP Server Manager`).
    *   Logs are also written to timestamped files in the extension's global storage directory (`MCP Server Manager: Show Logs` command).

## Requirements

*   Visual Studio Code (latest version recommended).
*   **A running local LLM inference server:**
    *   This server must be running independently and listening on a specific IP address and port.
    *   It **must** support WebSocket connections (e.g., at an endpoint like `/ws/{session_id}`).
    *   It **must** implement JSON-RPC 2.0 over WebSocket.
    *   Key interactions include:
        *   An initial HTTP endpoint (e.g., `/create_session`) that might accept a list of available tools and returns a `session_id`.
        *   A `generate` JSON-RPC method: Accepts `history` (array of messages) and `tools` (array of available tools in OpenAI format).
            *   The `history` messages should conform to roles: `user`, `assistant` (can include `tool_calls`), and `tool` (must include `tool_call_id`, `tool_name`, and `content`).
        *   It should send notifications back to the client over WebSocket, such as:
            *   `function_call_request`: When the LLM wants to call a tool. Params should include `task_id`, `session_id`, and `tool_call` (with `id`, `tool` name, `parameters`).
            *   `text_chunk`: For streaming parts of the textual response.
            *   `end`: To signal the end of a turn, providing `final_text` if applicable, or indicating an error.
*   Necessary environment and libraries for your chosen inference server.
*   Access to one or more MCP-compatible tool servers (e.g., filesystem, github, time) that you want the local LLM to use.

## Configuration

*   **Inference Server IP and Port:** **Crucially**, configure the IP address and port where your local LLM inference server is listening. Go to VS Code Settings (`Ctrl+,`) and set:
    *   `Extensions > MCP Server Manager > Inference Server Ip` (e.g., `127.0.0.1`)
    *   `Extensions > MCP Server Manager > Inference Server Port` (e.g., `8000`)
*   **Auto-Start Tool Servers:** Enable/disable automatic startup of managed MCP tool servers via the `Extensions > MCP Server Manager > Auto Start Servers` setting.
*   **Adding MCP Tool Servers:**
    *   Use the command `MCP Server Manager: Add Server`.
    *   Alternatively, use the "Add Server" button within the Server Dashboard. You will be prompted for a unique name, the start command, and optional arguments for the *tool server*.

## Usage

1.  **Start Local Inference Server:** Ensure your local LLM HTTP server is running, listening on the configured IP/port, and implementing the required `/ws/{session_id}` endpoint and methods (`generate`).
2.  **Configure Extension:** Set the correct `Inference Server Ip` and `Inference Server Port` in VS Code settings.
3.  **Add MCP Tool Servers:** Use the `MCP Server Manager: Add Server` command or the dashboard to configure any MCP *tool servers* you want the LLM to use.
    *   *Example Tool Server Command (Filesystem):* `npx -y @modelcontextprotocol/server-filesystem C:\path\to\allowed\dir`
    *   *Example Tool Server Command (Time):* `uvx mcp-server-time --local-timezone=Your/Timezone`
    *   *Example Tool Server Command (GitHub):* `uvx mcp-server-github` (requires authentication setup)
4.  **Reload VS Code:** Use `Developer: Reload Window` after configuring the extension.
5.  **Open Dashboard:** Use the `MCP Server Manager: Show Dashboard` command. Verify that the extension attempts to connect to your inference server (check logs/chat status) and starts any configured tool servers.
6.  **Start Tool Servers:** Ensure any MCP tool servers you want to use are "Connected" in the dashboard.
7.  **Open Chat View:** Find the MCP Chat View in the sidebar.
8.  **Interact:** Send messages to the local LLM. Use the "New Chat" button to clear context.

## Development

*(The core logic for interacting with the local LLM and MCP servers is in `src/mcp-local-llm-client/client.ts`. The main extension code is in `src/extension.ts`. UI components are in `src/panels`.)*

To set up for development:
1. Clone the repository.
2. Run `npm install`.
3. Run `npm run compile` (or `npm run watch` for continuous compilation).
4. Press `F5` in VS Code to launch the Extension Development Host.

---

*Note: This extension is under active development. Features and protocols may evolve.*
