import { ServerConfig } from '../models/Types';

// 定义可用的服务器配置
export const availableServers = {
    // --- Start of section to remove/comment out ---
    /*
    default: {
        type: 'stdio' as const,
        command: 'uvx',
        args: ['--from', 'llm-context', 'lc-mcp'],
        shell: true,
        windowsHide: true
    },
    */
    // --- End of section to remove/comment out ---
    echo: {
        type: 'stdio' as const,
        command: 'python',
        args: [
            // Consider making this path relative or configurable if possible
            'C:\\Users\\zengn\\mcp-config-assistant\\mcp-client\\echo.py'
        ],
        shell: true,
        windowsHide: true
    }
    // Add other built-in server configurations here if needed
} satisfies Record<string, ServerConfig>;

// 导出默认配置 - Remove or comment out this line as 'default' no longer exists here
// export const defaultServerConfig: ServerConfig = availableServers.default;

// 导出服务器名称类型
export type ServerName = keyof typeof availableServers; // This will now only include 'echo' (and others if added)