import { Readable, Writable } from 'stream';
import { ProcessManager } from './ProcessManager';
import { StdioConfig, ModelRequest, ModelResponse, ServerConfig } from '../models/Types';
import { ProcessHandle, ProcessInputStream } from '../types/ProcessTypes';
import { isProcessHandle, ProcessLogger } from '../utils/ProcessUtils';
import { LogManager } from '../utils/LogManager';
import * as cp from 'child_process';
import { EventEmitter } from 'events';

export interface IServer extends EventEmitter {
    isReady: boolean;
    start(): Promise<void>;
    send(request: any): Promise<any>;
    dispose(): void;
}

export class StdioServer extends EventEmitter implements IServer {
    public isReady: boolean = false;
    private process: cp.ChildProcess | null = null;
    private config: ServerConfig;
    private responseTimeout = 30000; // 30秒超时
    private responseQueue: Map<string, {
        resolve: (value: ModelResponse) => void;
        reject: (reason: any) => void;
        timer: NodeJS.Timeout;
        timestamp?: number;
    }> = new Map();
    private lastRequestTime: number = 0;
    private startTime: number = Date.now();
    private readonly serverId: string;
    private heartbeatTimer?: NodeJS.Timeout;
    private lastHeartbeat: number = 0;
    private availableModels: string[] = [];
    private stdoutBuffer: string = '';

    constructor(config: ServerConfig, serverId: string) {
        super(); // 调用父类构造函数
        this.config = config;
        this.serverId = serverId;
    }

    public async start(): Promise<void> {
        try {
            LogManager.info('StdioServer', `[${this.serverId}] 正在启动进程`, this.config);

            // 收集启动阶段的输出
            let startupOutput = '';
            
            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    LogManager.error('StdioServer', `[${this.serverId}] 进程启动超时`, { 
                        output: startupOutput 
                    });
                    reject(new Error('进程启动超时'));
                }, 5000);

                this.process = cp.spawn(
                    this.config.command,
                    this.config.args || [],
                    {
                        shell: this.config.shell ?? true,
                        windowsHide: this.config.windowsHide ?? true,
                        stdio: ['pipe', 'pipe', 'pipe']
                    }
                );

                // 收集启动输出
                this.process.stdout?.on('data', (data) => {
                    const chunk = data.toString();
                    startupOutput += chunk;
                    LogManager.debug('StdioServer', '收到启动输出', { chunk });
                });

                this.process.stderr?.on('data', (data) => {
                    const chunk = data.toString();
                    startupOutput += chunk;
                    LogManager.warn('StdioServer', '收到错误输出', { chunk });
                });

                this.process.once('spawn', () => {
                    clearTimeout(timeout);
                    LogManager.info('StdioServer', `[${this.serverId}] 进程已启动`, {
                        pid: this.process!.pid,
                        startupOutput: startupOutput.trim()
                    });
                    resolve();
                });

                this.process.once('error', (error) => {
                    clearTimeout(timeout);
                    LogManager.error('StdioServer', '进程启动错误', {
                        error,
                        startupOutput
                    });
                    reject(error);
                });
            });

            // 等待初始化完成
            await this.initialize();
            this.setupProcessHandlers();
            await this.waitForReady();

        } catch (error) {
            LogManager.error('StdioServer', `[${this.serverId}] 进程启动失败`, error);
            this.isReady = false;
            throw error;
        }
    }

    private async initialize(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                LogManager.warn('StdioServer', `[${this.serverId}] 初始化超时，超过20秒未收到心跳`);
                this.process?.stdout?.removeListener('data', onData);
                reject(new Error('初始化超时'));
            }, 20000);

            const onData = (data: Buffer) => {
                try {
                    const message = JSON.parse(data.toString());
                    
                    if (message.type === 'heartbeat') {
                        this.lastHeartbeat = Date.now();
                        this.availableModels = message.models || [];
                        this.isReady = true;
                        
                        // 移除监听器
                        this.process?.stdout?.removeListener('data', onData);
                        clearTimeout(timeout);
                        
                        // 设置心跳检查
                        this.setupHeartbeat();
                        
                        LogManager.info('StdioServer', `[${this.serverId}] 初始化成功`, {
                            models: this.availableModels
                        });
                        
                        resolve();
                    }
                } catch (error) {
                    // 忽略解析错误，继续等待有效响应
                }
            };

            this.process?.stdout?.on('data', onData);
        });
    }

    private async sendWithTimeout(message: any, timeout: number): Promise<any> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error('请求超时'));
            }, timeout);

            if (!this.process?.stdin?.writable) {
                clearTimeout(timer);
                reject(new Error('标准输入流不可用'));
                return;
            }

            // 设置响应处理器
            const onResponse = (data: Buffer) => {
                try {
                    const response = JSON.parse(data.toString());
                    if (response.id === message.id || response.type === 'init') {
                        clearTimeout(timer);
                        this.process!.stdout!.removeListener('data', onResponse);
                        resolve(response);
                    }
                } catch (e) {
                    // 忽略解析错误，继续等待有效响应
                }
            };

            this.process!.stdout!.on('data', onResponse);
            this.process!.stdin!.write(JSON.stringify(message) + '\n');
        });
    }

    public async send(request: ModelRequest): Promise<ModelResponse> {
        if (!this.isReady || !this.process) {
            throw new Error('服务器未就绪');
        }

        if (!this.process.stdin) {
            throw new Error('进程的标准输入流不可用');
        }

        return new Promise((resolve, reject) => {
            try {
                const requestId = Math.random().toString(36).substring(2);
                const input = JSON.stringify({ 
                    ...request, 
                    id: requestId,
                    timestamp: Date.now() 
                }) + '\n';
                
                // 设置更合理的超时时间
                const timer = setTimeout(() => {
                    this.responseQueue.delete(requestId);
                    LogManager.warn('StdioServer', '请求超时', { 
                        requestId, 
                        request,
                        elapsed: Date.now() - this.lastRequestTime
                    });
                    
                    // 检查服务器状态
                    this.checkServerStatus();
                    
                    reject(new Error('请求超时，服务器可能未响应'));
                }, this.responseTimeout);

                // 记录请求时间
                this.lastRequestTime = Date.now();
                
                // 保存请求信息
                this.responseQueue.set(requestId, { 
                    resolve, 
                    reject, 
                    timer,
                    timestamp: this.lastRequestTime
                });
                if (this.process?.stdin?.writable) {
                    this.process.stdin.write(input, (error) => {
                        if (error) {
                            clearTimeout(timer);
                            this.responseQueue.delete(requestId);
                            reject(new Error(`写入失败: ${error.message}`));
                        } else {
                            LogManager.debug('StdioServer', '请求已发送', { 
                                requestId,
                                timestamp: this.lastRequestTime
                            });
                        }
                    });
                } else {
                    clearTimeout(timer);
                    this.responseQueue.delete(requestId);
                    reject(new Error('标准输入流已关闭'));
                }

            } catch (error) {
                LogManager.error('StdioServer', '发送消息失败', error);
                reject(error);
            }
        });
    }

    private async checkServerStatus(): Promise<boolean> {
        if (!this.process?.stdin?.writable) {
            LogManager.warn('StdioServer', '标准输入流不可用或已关闭');
            return false;
        }

        return new Promise<boolean>((resolve) => {
            const timeout = setTimeout(() => {
                LogManager.warn('StdioServer', '健康检查超时');
                resolve(false);
            }, 3000);

            const healthCheck = {
                type: 'healthcheck',
                id: 'health_' + Date.now(),
                timestamp: Date.now()
            };

            try {
                // 添加一次性响应处理器
                if (!this.process?.stdout) {
                    clearTimeout(timeout);
                    LogManager.error('StdioServer', '标准输出流不可用');
                    resolve(false);
                    return;
                }

                this.process.stdout.once('data', () => {
                    clearTimeout(timeout);
                    this.isReady = true;
                    LogManager.info('StdioServer', '健康检查通过');
                    resolve(true);
                });

                // 使用类型断言来避免 TypeScript 的空值检查警告
                const stdin = this.process.stdin!;
                stdin.write(JSON.stringify(healthCheck) + '\n', (error) => {
                    if (error) {
                        clearTimeout(timeout);
                        LogManager.error('StdioServer', '发送健康检查失败', error);
                        resolve(false);
                    } else {
                        LogManager.debug('StdioServer', '健康检查请求已发送');
                    }
                });

            } catch (error) {
                clearTimeout(timeout);
                LogManager.error('StdioServer', '健康检查异常', error);
                this.isReady = false;
                resolve(false);
            }
        });
    }

    private checkProcessStatus(): boolean {
        if (!this.process || this.process.killed) {
            LogManager.error('StdioServer', '进程已终止');
            return false;
        }

        if (!this.process.stdin?.writable || !this.process.stdout?.readable) {
            LogManager.error('StdioServer', '进程输入输出流不可用');
            return false;
        }

        try {
            // 发送空行测试进程是否响应
            this.process.stdin.write('\n');
            return true;
        } catch (error) {
            LogManager.error('StdioServer', '进程状态检查失败', error);
            return false;
        }
    }

    private checkProcessHealth(): boolean {
        if (!this.process || !this.process.pid) {
            LogManager.error('StdioServer', '进程不存在或PID无效');
            return false;
        }

        try {
            // 检查进程是否仍在运行
            process.kill(this.process.pid, 0);
            
            // 检查标准流是否可用
            if (!this.process.stdin?.writable || !this.process.stdout?.readable) {
                LogManager.error('StdioServer', '进程标准流不可用', {
                    pid: this.process.pid,
                    stdin: !!this.process.stdin?.writable,
                    stdout: !!this.process.stdout?.readable
                });
                return false;
            }

            LogManager.debug('StdioServer', '进程健康检查通过', {
                pid: this.process.pid,
                uptime: Date.now() - this.startTime
            });

            return true;
        } catch (e) {
            LogManager.error('StdioServer', '进程已终止', {
                pid: this.process.pid,
                error: e instanceof Error ? e.message : String(e)
            });
            return false;
        }
    }

    private setupProcessHandlers(): void {
        if (!this.process) return;

        this.process.stdout?.on('data', (data: Buffer) => {
            this.handleStdoutData(data);
        });

        this.process.stderr?.on('data', (data: Buffer) => {
            LogManager.warn('StdioServer', `[${this.serverId}] Received stderr data`, { data: data.toString() });
        });

        this.process.on('error', (error: Error) => {
            LogManager.error('StdioServer', `[${this.serverId}] Process error`, { error });
            this.isReady = false;
            this.emit('status', {
                isReady: false,
                serverId: this.serverId,
                status: 'error',
                error: `Process error: ${error.message}`
            });
            this.dispose();
        });

        this.process.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
            LogManager.warn('StdioServer', `[${this.serverId}] Process closed`, { code, signal });
            const wasReady = this.isReady;
            this.isReady = false;
            if (wasReady) {
                this.emit('status', {
                    isReady: false,
                    serverId: this.serverId,
                    status: 'disconnected',
                    error: `Process closed with code ${code}, signal ${signal}`
                });
            }
            this.dispose();
        });

        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
        }
        this.heartbeatTimer = setInterval(() => {
            const timeoutThreshold = 10000;
            if (this.isReady && (Date.now() - this.lastHeartbeat > timeoutThreshold)) {
                LogManager.warn('StdioServer', `[${this.serverId}] Heartbeat timeout (>${timeoutThreshold / 1000}s)`);
                this.isReady = false;

                this.emit('status', {
                    isReady: false,
                    serverId: this.serverId,
                    status: 'disconnected',
                    error: '服务器心跳超时'
                });
            }
        }, 5000);
    }

    private async waitForReady(timeout: number = 10000): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error('初始化超时'));
            }, timeout);

            const statusHandler = (status: any) => {
                if (status.isReady) {
                    clearTimeout(timer);
                    this.removeListener('status', statusHandler);
                    resolve();
                }
            };

            this.on('status', statusHandler);
            
            // 如果已经就绪，直接返回
            if (this.isReady) {
                clearTimeout(timer);
                this.removeListener('status', statusHandler);
                resolve();
            }
        });
    }

    private setupHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
        }

        this.heartbeatTimer = setInterval(() => {
            const now = Date.now();
            if (now - this.lastHeartbeat > 10000) {
                LogManager.warn('StdioServer', `[${this.serverId}] 心跳超时`);
                this.isReady = false;
            }
        }, 5000);
    }

    public dispose(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
        }
        // 其他清理代码...
    }

    private handleStdoutData(data: Buffer) {
        const chunk = data.toString();
        LogManager.debug('StdioServer', `[${this.serverId}] Received raw stdout chunk`, { length: chunk.length });

        // Append new data to any leftover buffer from previous chunks
        this.stdoutBuffer += chunk;

        // Use regex to split by \n or \r\n
        let lines = this.stdoutBuffer.split(/\r?\n/);

        // The last element is the potentially incomplete line. Store it back in the buffer.
        this.stdoutBuffer = lines.pop() || '';

        // If there are any complete lines to process
        if (lines.length > 0) {
          LogManager.debug('StdioServer', `[${this.serverId}] Processing ${lines.length} complete line(s)`);

          for (const line of lines) {
              // Skip empty lines
              if (!line.trim()) {
                  LogManager.debug('StdioServer', `[${this.serverId}] Skipping empty line.`);
                  continue;
              }

              LogManager.debug('StdioServer', `[${this.serverId}] Attempting to parse line`, { line: line.trim() });

              try {
                  const message = JSON.parse(line.trim());
                  LogManager.debug('StdioServer', `[${this.serverId}] Successfully parsed JSON`, { message });

                  // --- Response Handling ---
                  if (message.id && this.responseQueue.has(message.id)) {
                      const requestInfo = this.responseQueue.get(message.id)!;
                      clearTimeout(requestInfo.timer); // !!! Clear the timeout !!!
                      this.responseQueue.delete(message.id);
                      const elapsedTime = Date.now() - (requestInfo.timestamp || Date.now());
                      LogManager.debug('StdioServer', `[${this.serverId}] Matched response for request ${message.id}`, { response: message, elapsedMs: elapsedTime });
                      // Resolve the promise waited on by the UI/calling code
                      requestInfo.resolve(message);
                  }
                  // --- Heartbeat Handling ---
                  else if (message.type === 'heartbeat') {
                      const wasReady = this.isReady;
                      this.lastHeartbeat = Date.now();
                      this.isReady = true;
                      this.availableModels = message.models || this.availableModels;

                      if (!wasReady) {
                          LogManager.info('StdioServer', `[${this.serverId}] Heartbeat received, server (re)connected.`);
                          this.emit('status', {
                              serverId: this.serverId,
                              isReady: true,
                              status: 'connected',
                              pid: this.process?.pid,
                              error: undefined,
                              models: this.availableModels
                          });
                      } else {
                           LogManager.debug('StdioServer', `[${this.serverId}] Heartbeat received (server already ready)`);
                      }
                  }
                  // --- Other Message Types ---
                  else {
                      // Handle health check responses or other message types if necessary
                       LogManager.warn('StdioServer', `[${this.serverId}] Received unhandled/unmatched message`, { message });
                  }

              } catch (parseError) {
                  LogManager.warn('StdioServer', `[${this.serverId}] JSON parsing failed for line`, { line: line.trim(), error: parseError instanceof Error ? parseError.message : String(parseError) });
              }
          } // End for loop over lines
        } else {
             // LogManager.debug('StdioServer', `[${this.serverId}] No complete lines found in chunk, buffering.`);
        }
    }
}

export async function executeStdioServer(
    serverConfig: StdioConfig, 
    request: ModelRequest
): Promise<ModelResponse> {
    if (!serverConfig.command) {
        throw new Error('命令不能为空');
    }

    return new Promise((resolve, reject) => {
        const child = ProcessManager.spawn(
            serverConfig.command,
            serverConfig.args || [],
            {
                env: serverConfig.env || {},
                shell: serverConfig.shell ?? true,
                windowsHide: serverConfig.windowsHide ?? true
            }
        );

        if (!child.stdout || !child.stderr || !child.stdin) {
            reject(new Error('子进程的标准输入输出流不可用'));
            return;
        }

        let output = '';
        let errorOutput = '';

        child.stdout.on('data', (data) => {
            const chunk = data.toString();
            output += chunk;
        });

        child.stderr.on('data', (data) => {
            const chunk = data.toString();
            errorOutput += chunk;
        });

        child.on('error', (error) => {
            reject(error);
        });

        child.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(errorOutput || `进程退出码: ${code}`));
                return;
            }

            try {
                const response = JSON.parse(output);
                resolve({
                    text: response.text || response.response || output,
                    model: response.model || request.model || 'default',
                    usage: response.usage
                });
            } catch {
                resolve({
                    text: output,
                    model: request.model || 'default'
                });
            }
        });

        if (!child.stdin) {
            reject(new Error('子进程的标准输入流不可用'));
            return;
        }

        try {
            const input = JSON.stringify(request) + '\n';
            child.stdin.write(input);
            child.stdin.end();
        } catch (error) {
            reject(new Error(`写入进程输入失败: ${error instanceof Error ? error.message : String(error)}`));
        }
    });
}

export function createStdioServer(serverConfig: StdioConfig) {
    let output = '';
    let errorOutput = '';
    let isReady = false;
    let currentResolve: ((value: ModelResponse) => void) | null = null;
    let currentReject: ((reason: any) => void) | null = null;
    let childProcess: ProcessHandle | null = null;

    const initializeProcess = () => {
        ProcessLogger.info(serverConfig.command, '开始初始化服务器...');
        
        try {
            const spawnedProcess = ProcessManager.spawn(
                serverConfig.command,
                serverConfig.args || [],
                {
                    env: { ...process.env, ...serverConfig.env },
                    shell: serverConfig.shell ?? true,
                    windowsHide: serverConfig.windowsHide ?? true,
                    stdio: ['pipe', 'pipe', 'pipe']
                }
            );

            if (!spawnedProcess || !isProcessHandle(spawnedProcess)) {
                throw new Error('无法创建有效的进程实例');
            }

            childProcess = spawnedProcess;
            const pid = childProcess.pid;
            ProcessLogger.info(serverConfig.command, `服务器已启动，PID: ${pid}`);
            setupEventHandlers(childProcess);
            
        } catch (error) {
            ProcessLogger.error(serverConfig.command, '初始化失败', error);
            throw error;
        }
    };

    const setupEventHandlers = (child: ProcessHandle): void => {
        child.stdout.on('data', (data: Buffer) => {
            handleStdout(data);
        });
        
        child.stderr.on('data', (data: Buffer) => {
            handleStderr(data);
        });
        
        child.on('error', (error: Error) => {
            handleError(error);
        });
        
        child.on('close', (code: number) => {
            handleClose(code);
        });
    };

    const handleStdout = (data: Buffer) => {
        const chunk = data.toString();
        console.log(`[${serverConfig.command}] 输出:`, chunk.trim());
        
        try {
            const lines = (output + chunk).split('\n');
            output = lines.pop() || '';

            for (const line of lines) {
                if (!line.trim()) continue;
                
                const response = JSON.parse(line);
                console.log(`[${serverConfig.command}] 解析响应:`, response);
                
                if (response.type === 'heartbeat') {
                    console.log(`[${serverConfig.command}] 收到心跳`);
                    isReady = true;
                    continue;
                }

                if (response.text || response.response) {
                    if (currentResolve) {
                        currentResolve({
                            text: response.text || response.response,
                            model: response.model || serverConfig.model || 'default',
                            usage: response.usage
                        });
                        currentResolve = null;
                    }
                }
            }
        } catch (e) {
            console.warn(`[${serverConfig.command}] 解析响应失败:`, e);
        }
    };

    const handleStderr = (data: Buffer) => {
        const chunk = data.toString();
        console.error(`[${serverConfig.command}] 错误: ${chunk.trim()}`);
        errorOutput += chunk;
        
        if (currentReject) {
            currentReject(new Error(errorOutput));
            currentReject = null;
        }
    };

    const handleError = (error: Error) => {
        console.error(`[${serverConfig.command}] 进程错误:`, error);
        if (currentReject) {
            currentReject(error);
            currentReject = null;
        }
    };

    const handleClose = (code: number) => {
        console.warn(`[${serverConfig.command}] 进程已关闭，退出码: ${code}`);
        if (currentReject) {
            currentReject(new Error(`进程已关闭，退出码: ${code}`));
            currentReject = null;
        }
    };

    const sendRequest = (request: ModelRequest): Promise<ModelResponse> => {
        return new Promise((resolve, reject) => {
            if (!childProcess || !childProcess.stdin) {
                reject(new Error('子进程未启动或标准输入流不可用'));
                return;
            }

            currentResolve = resolve;
            currentReject = reject;

            const input = JSON.stringify(request) + '\n';
            childProcess.stdin.write(input, (error) => {
                if (error) {
                    reject(new Error(`写入进程输入失败: ${error.message}`));
                }
            });
        });
    };

    initializeProcess();

    return {
        sendRequest
    };
}