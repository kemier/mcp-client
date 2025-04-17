import { Anthropic } from "@anthropic-ai/sdk";
import {
  MessageParam,
  Tool,
} from "@anthropic-ai/sdk/resources/messages/messages.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as readline from 'node:readline';
import dotenv from "dotenv";

dotenv.config();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  throw new Error("ANTHROPIC_API_KEY is not set");
}

class MCPClient {
  private mcp: Client;
  private anthropic: Anthropic;
  private transport: StdioClientTransport | null = null;
  private tools: Tool[] = [];
  private rl: readline.Interface | null = null;

  constructor() {
    this.anthropic = new Anthropic({
      apiKey: ANTHROPIC_API_KEY,
    });
    this.mcp = new Client({ name: "mcp-client-cli", version: "1.0.0" });
  }

  async connectToServer(serverScriptPath: string) {
    try {
      const isJs = serverScriptPath.endsWith(".js");
      const isPy = serverScriptPath.endsWith(".py");
      if (!isJs && !isPy) {
        throw new Error("Server script must be a .js or .py file");
      }
      const command = isPy
        ? process.platform === "win32"
          ? "python"
          : "python3"
        : process.execPath;
      
      this.transport = new StdioClientTransport({
        command,
        args: [serverScriptPath],
      });
      this.mcp.connect(this.transport);
      
      const toolsResult = await this.mcp.listTools();
      this.tools = toolsResult.tools.map((tool: any) => {
        return {
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema || { type: 'object', properties: {} },
        };
      });
      console.log(
        "Connected to server with tools:",
        this.tools.map(({ name }: { name: any }) => name)
      );
    } catch (e) {
      console.log("Failed to connect to MCP server: ", e);
      throw e;
    }
  }

  async processQuery(query: string) {
    const messages: MessageParam[] = [
      {
        role: "user",
        content: query,
      },
    ];
  
    let response = await this.anthropic.messages.create({
      model: "claude-3-5-sonnet-20240620",
      max_tokens: 1000,
      messages,
      tools: this.tools,
    });
  
    const toolCalls: any[] = [];
    for (const content of response.content) {
      if (content.type === "text") {
        return content.text;
      } else if (content.type === "tool_use") {
        toolCalls.push({ name: content.name, input: content.input });
      }
    }
  
    if (toolCalls.length > 0) {
        return `[Tool use requested by model: ${JSON.stringify(toolCalls)}. Tool execution not implemented in this CLI example.]`;
    }
  
    return "[No text response received]";
  }

  async cleanup() {
    console.log("MCP Client cleaning up...");
    this.rl?.close();
    console.log("MCP Client transport potentially cleaned up on exit.");
  }

  async chatLoop() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'Enter query (or "exit")> '
    });

    this.rl.prompt();

    this.rl.on('line', async (line) => {
      const query = line.trim();
      if (query.toLowerCase() === 'exit') {
        this.rl?.close();
        return;
      }

      if (!query) {
          this.rl?.prompt();
          return;
      }

      try {
        console.log("Processing...");
        const result = await this.processQuery(query);
        console.log("\nClaude:", result);
      } catch (error) {
        console.error("\nError processing query:", error);
      }
      this.rl?.prompt();
    });

    this.rl.on('close', () => {
      console.log('\nExiting chat loop.');
    });

    await new Promise(() => {});
  }
}

async function main() {
  if (process.argv.length < 3) {
    console.log("Usage: node index.ts <path_to_server_script>");
    return;
  }
  const mcpClient = new MCPClient();
  try {
    await mcpClient.connectToServer(process.argv[2]);
    await mcpClient.chatLoop();
  } catch (error) {
      console.error("Fatal error during setup:", error);
  } finally {
    await mcpClient.cleanup();
    process.exit(0);
  }
}

main();