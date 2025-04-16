import * as cp from 'child_process';
import { EventEmitter } from 'events';
import * as vscode from 'vscode';

interface ServerConfig {
    type: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
}

export class McpServerManager extends EventEmitter {
    private static instance: McpServerManager;
    private servers: Map<string, cp.ChildProcess> = new Map();

    private constructor() {
        super();
    }

    public static getInstance(): McpServerManager {
        if (!McpServerManager.instance) {
            McpServerManager.instance = new McpServerManager();
        }
        return McpServerManager.instance;
    }

    public async getOrCreateServer(serverName: string, config: ServerConfig): Promise<cp.ChildProcess> {
        if (this.servers.has(serverName)) {
            const existingServer = this.servers.get(serverName)!;
            // 检查服务器是否还在运行
            try {
                if (existingServer.pid) {
                    process.kill(existingServer.pid, 0);
                    return existingServer;
                }
            } catch (e) {
                // 如果进程不存在，删除记录
                this.servers.delete(serverName);
            }
        }

        console.log(`Starting new server: ${serverName}`);
        const child = cp.spawn(config.command, config.args || [], {
            env: { ...process.env, ...config.env },
            shell: true
        });

        child.stdout.on('data', (data) => {
            console.log(`[${serverName}] stdout:`, data.toString());
            this.emit('output', { server: serverName, data: data.toString() });
        });

        child.stderr.on('data', (data) => {
            console.error(`[${serverName}] stderr:`, data.toString());
            this.emit('error', { server: serverName, data: data.toString() });
        });

        child.on('exit', (code) => {
            console.log(`Server ${serverName} exited with code ${code}`);
            this.servers.delete(serverName);
            this.emit('status', { server: serverName, status: 'disconnected' });
        });

        this.servers.set(serverName, child);
        this.emit('status', { server: serverName, status: 'connected' });
        return child;
    }

    public async sendMessage(serverName: string, text: string): Promise<string> {
        const server = this.servers.get(serverName);
        if (!server) {
            throw new Error(`Server ${serverName} not found`);
        }

        // 使用类型断言确保 stdin 不为空
        const stdin = server.stdin;
        if (!stdin) {
            throw new Error(`Server ${serverName} stdin is not available`);
        }

        return new Promise((resolve, reject) => {
            let output = '';
            let isComplete = false;
            
            const outputHandler = (data: { server: string, data: string }) => {
                if (data.server === serverName) {
                    output += data.data;
                    console.log(`[${serverName}] 接收到输出:`, data.data);
                    
                    try {
                        // 尝试解析 JSON 响应
                        const jsonResponse = JSON.parse(output);
                        isComplete = true;
                        this.removeListener('output', outputHandler);
                        resolve(jsonResponse.text || jsonResponse.response || output);
                    } catch (e) {
                        // 如果不是完整的 JSON，继续等待
                    }
                }
            };

            const errorHandler = (data: { server: string, data: string }) => {
                if (data.server === serverName) {
                    console.error(`[${serverName}] 错误:`, data.data);
                }
            };

            this.on('output', outputHandler);
            this.on('error', errorHandler);

            try {
                const input = JSON.stringify({ text }) + '\n';
                console.log(`[${serverName}] 发送消息:`, input);
                
                // 使用已经检查过的 stdin
                stdin.write(input, (error) => {
                    if (error) {
                        this.removeListener('output', outputHandler);
                        this.removeListener('error', errorHandler);
                        reject(error);
                    }
                });
            } catch (error) {
                this.removeListener('output', outputHandler);
                this.removeListener('error', errorHandler);
                reject(error);
            }

            // 设置超时
            setTimeout(() => {
                if (!isComplete) {
                    this.removeListener('output', outputHandler);
                    this.removeListener('error', errorHandler);
                    resolve(output.trim() || '服务器响应超时');
                }
            }, 10000); // 10秒超时
        });
    }

    public dispose() {
        for (const [name, server] of this.servers) {
            console.log(`Shutting down server ${name}`);
            server.kill();
        }
        this.servers.clear();
    }

    /**
     * Stops the server process if running and removes it from the internal map.
     * NOTE: This does NOT remove the persistent configuration. That must be
     * handled separately by the caller (e.g., using ConfigStorage).
     * @param serverName The name of the server process to stop and remove.
     * @returns Promise that resolves to true if the process was stopped/removed successfully or didn't exist.
     */
    public async removeServerConfiguration(serverName: string): Promise<boolean> {
        console.log(`Attempting to stop and remove server process: ${serverName}`);

        if (!serverName) {
            const error = 'Cannot remove server process: No server name provided';
            console.error(error);
            vscode.window.showErrorMessage(error);
            return false;
        }

        try {
            // Stop the running server process if it exists in the map
            if (this.servers.has(serverName)) {
                console.log(`Server process ${serverName} found, stopping it.`);
                const server = this.servers.get(serverName);
                if (server) {
                    server.kill(); // Send kill signal
                }
                // Remove from the in-memory map *after* attempting kill
                this.servers.delete(serverName);
                // Emit status update
                this.emit('status', { server: serverName, status: 'disconnected' });
                console.log(`Stopped and removed server process entry: "${serverName}"`);
            } else {
                 console.log(`Server process ${serverName} not found in memory map.`);
            }

            // Emit event indicating the process was removed (or wasn't running)
            // Callers can use this, but primary config/UI updates happen elsewhere.
            this.emit('serverRemoved', { serverId: serverName }); // Consistent key 'serverId' or 'serverName'

            return true; // Indicate success in stopping/removing the process entry
        } catch (error: any) {
            console.error(`Error stopping/removing server process ${serverName}: ${error}`);
            // Don't show error message here, let caller handle based on context
            // vscode.window.showErrorMessage(`Failed to stop server process ${serverName}: ${error.message || error}`);
            return false; // Indicate failure
        }
    }
}