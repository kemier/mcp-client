import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import { ServerStatus, ServerStatusEvent, ServerConfig, ModelRequest, ModelResponse } from '../models/Types';
import { LogManager } from '../utils/LogManager';
import { StdioServer, IServer } from './StdioServer';
import { availableServers, ServerName } from '../config/defaultConfig';
import * as cp from 'child_process';

export class ServerManager extends EventEmitter {
    private static instance: ServerManager;
    private status: ServerStatus = { isReady: false };
    private servers: Map<string, IServer> = new Map();

    private constructor() {
        super();
    }

    public static getInstance(): ServerManager {
        if (!ServerManager.instance) {
            ServerManager.instance = new ServerManager();
        }
        return ServerManager.instance;
    }

    public getStatus(): ServerStatus {
        return { ...this.status };
    }

    private updateStatus(newStatus: Partial<ServerStatus>, serverName: string = 'default') {
        this.status = {
            ...this.status,
            ...newStatus,
            lastUpdate: Date.now()
        };

        const event: ServerStatusEvent = {
            serverId: serverName,
            isReady: this.status.isReady,
            status: this.status.isReady ? 'connected' : 'disconnected',
            pid: this.status.pid,
            models: this.status.models,
            error: this.status.lastError
        };

        LogManager.debug('ServerManager', `[${serverName}] 服务器状态更新`, {
            ...this.status,
            event
        });

        try {
            this.emit('status', event);
        } catch (error) {
            LogManager.error('ServerManager', `[${serverName}] 状态事件发送失败`, error);
        }
    }

    /**
     * 启动指定服务器
     * @param serverName 服务器名称，默认为 'default'
     */
    public async startServer(serverName: string = 'default'): Promise<void> {
        try {
            // 清理旧状态
            this.updateStatus({
                isReady: false,
                lastError: undefined,
                pid: undefined
            }, serverName);

            // 只加载一次配置
            const config = await this.loadServerConfig(serverName);
            
            // 检查配置有效性
            this.validateServerConfig(config, serverName);
            
            LogManager.info('ServerManager', `正在启动服务器: ${serverName}`, config);

            const server = await this.createServerInstance(config, serverName);
            await server.start();
            
            this.servers.set(serverName, server);
            
            this.updateStatus({
                isReady: true,
                uptime: Date.now(),
                pid: (server as any).process?.pid
            }, serverName);

            LogManager.info('ServerManager', `服务器 ${serverName} 启动成功`);

        } catch (error) {
            const errorMsg = error instanceof Error ? 
                            error.message.replace('default', serverName) : 
                            `服务器 ${serverName} 初始化失败`;

            LogManager.error('ServerManager', `服务器 ${serverName} 启动失败`, error);
            
            this.updateStatus({
                isReady: false,
                lastError: errorMsg,
                uptime: undefined
            }, serverName);
            
            throw new Error(errorMsg);
        }
    }

    private validateServerConfig(config: ServerConfig, serverName: string): void {
        const errors: string[] = [];

        // 检查必要参数
        if (!config.command) {
            errors.push('命令不能为空');
        }

        // 如果是 llm-context 包，检查可执行文件名是否有效
        if (config.args?.includes('llm-context')) {
            const validExecutables = [
                'lc-changed',
                'lc-clip-files',
                'lc-clip-implementations',
                'lc-context',
                'lc-init',
                'lc-mcp',
                'lc-outlines',
                'lc-prompt',
                'lc-sel-files',
                'lc-sel-outlines',
                'lc-set-rule',
                'lc-version'
            ];

            const executable = config.args[config.args.indexOf('llm-context') + 1];
            if (!validExecutables.includes(executable?.replace('.exe', ''))) {
                errors.push(`无效的可执行文件: ${executable}。可用的选项: ${validExecutables.join(', ')}`);
            }
        }

        if (errors.length > 0) {
            const errorMsg = `服务器 ${serverName} 配置无效:\n${errors.join('\n')}`;
            LogManager.error('ServerManager', errorMsg);
            throw new Error(errorMsg);
        }
    }

    /**
     * 发送消息到指定服务器
     * @param serverName 服务器名称
     * @param request 消息请求
     * @returns 服务器响应
     */
    public async sendMessage(serverName: string, request: ModelRequest): Promise<ModelResponse> {
        try {
            // 先检查配置是否存在
            await this.loadServerConfig(serverName);
            
            // 确保服务器已启动
            await this.ensureServerStarted(serverName);
            
            const server = this.servers.get(serverName);
            if (!server) {
                throw new Error(`服务器 ${serverName} 未初始化`);
            }

            const response = await server.send(request);
            
            // 更新状态
            this.updateStatus({
                isReady: true,
                lastError: undefined,
                lastActivityTime: Date.now()
            }, serverName);

            return response;

        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            
            this.updateStatus({
                isReady: false,
                lastError: errorMsg,
                lastActivityTime: Date.now()
            }, serverName);

            throw new Error(errorMsg);
        }
    }

    private async getOrCreateServer(serverName: string): Promise<IServer> {
        try {
            if (!this.servers.has(serverName)) {
                LogManager.info('ServerManager', `正在初始化服务器: ${serverName}`);
                
                const config = await this.loadServerConfig(serverName);
                const server = await this.createServerInstance(config, serverName);
                await server.start();
                
                this.servers.set(serverName, server);
                LogManager.info('ServerManager', `服务器 ${serverName} 初始化完成`);
            }
            
            return this.servers.get(serverName)!;
        } catch (error) {
            LogManager.error('ServerManager', `创建服务器实例失败: ${serverName}`, error);
            throw error;
        }
    }

    private async createServerInstance(config: ServerConfig, serverName: string): Promise<IServer> {
        const server = new StdioServer(config, serverName);
        
        // 监听服务器状态变更
        server.on('status', (status: ServerStatusEvent) => {
            this.updateStatus({
                isReady: status.isReady,
                lastError: status.error,
                lastActivityTime: Date.now(),
                models: status.models
            }, serverName);
        });

        return server;
    }

    // 保留这个异步版本的方法
    private async loadServerConfig(serverName: string): Promise<ServerConfig> {
        // 先检查自定义配置
        const config = vscode.workspace.getConfiguration('mcpClient.servers');
        let serverConfig = config.get<ServerConfig>(serverName);

        // 如果没有找到自定义配置，检查内置配置
        if (!serverConfig && serverName in availableServers) {
            LogManager.info('ServerManager', `使用内置服务器配置: ${serverName}`);
            // 创建一个新对象来避免 readonly 问题
            const baseConfig = availableServers[serverName as ServerName];
            serverConfig = {
                ...baseConfig,
                args: [...baseConfig.args] // 创建一个新的可变数组
            };
        }

        if (!serverConfig) {
            throw new Error(`找不到服务器 ${serverName} 的配置`);
        }

        return serverConfig;
    }

    private async ensureServerStarted(serverName: string = 'default'): Promise<void> {
        try {
            // Only try to start if the server is not in the map at all
            if (!this.servers.has(serverName)) {
                LogManager.info('ServerManager', `服务器 ${serverName} 不存在，正在启动...`);
                // Wait for the start process to complete here
                await this.startServer(serverName);
                // Verify it's actually ready after starting
                const newServer = this.servers.get(serverName);
                if (!newServer || !newServer.isReady) {
                     throw new Error(`服务器 ${serverName} 启动后仍未就绪`);
                }
                 LogManager.info('ServerManager', `服务器 ${serverName} 确认已启动并就绪`);
            } else {
                // Server exists, check readiness but DON'T restart here
                const server = this.servers.get(serverName)!;
                if (!server.isReady) {
                     LogManager.warn('ServerManager', `服务器 ${serverName} 存在但当前未就绪 (可能正在等待心跳恢复)...`);
                     // IMPORTANT: Decide if sending should fail immediately or wait.
                     // Option A: Fail Fast - Throw error if not ready
                     throw new Error(`服务器 ${serverName} 未就绪，请稍后重试`);
                     // Option B: Wait (Implement a short wait/retry loop here if needed, more complex)
                } else {
                     LogManager.debug('ServerManager', `服务器 ${serverName} 确认已存在且就绪`);
                }
            }
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            LogManager.error('ServerManager', `服务器 ${serverName} 启动/检查失败`, error);
            // Re-throw the error so the caller (sendMessage) knows it failed
            throw error;
        }
    }

    // Add the dispose method
    public dispose(): void {
        LogManager.info('ServerManager', '正在清理服务器实例...');
        for (const [name, server] of this.servers) {
            try {
                LogManager.info('ServerManager', `正在停止服务器: ${name}`);
                // Ensure the IServer interface or StdioServer class actually has a dispose method
                server.dispose();
            } catch (error) {
                LogManager.error('ServerManager', `停止服务器 ${name} 时出错`, error);
            }
        }
        this.servers.clear();
        LogManager.info('ServerManager', '服务器实例清理完毕。');
    }
}

export { ServerStatus };