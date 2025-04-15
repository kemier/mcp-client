import { ProcessHandle, ProcessInputStream } from '../types/ProcessTypes';
import { isProcessHandle, ProcessLogger } from '../utils/ProcessUtils';
import { ProcessMonitor } from '../utils/ProcessMonitor';
import { ChildProcess } from 'child_process';
import { Readable, Writable } from 'stream';

// 只保留必要的类型定义
export type ServerStatusType = 'connected' | 'disconnected';

export interface BaseServerConfig {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    shell?: boolean;
    windowsHide?: boolean;
    model?: string;
}

export interface StdioConfig extends BaseServerConfig {
    stdio?: ['pipe', 'pipe', 'pipe'];
}

export interface ServerStatusEvent {
    serverId: string;
    isReady: boolean;
    status: 'connected' | 'disconnected';
    pid?: number;
    error?: string;
    models?: string[];
}

export interface ModelRequest {
    text: string;
    model?: string;
    options?: Record<string, any>;
}

export interface ModelResponse {
    text: string;
    model: string;
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
    };
}

export interface ServerStatus {
    isReady: boolean;
    lastError?: string;
    lastUpdate?: number;
    lastActivityTime?: number;
    uptime?: number;
    pid?: number;
    models?: string[];
}

export interface ServerConfig {
    type: 'stdio';
    command: string;
    args?: string[];
    shell?: boolean;
    windowsHide?: boolean;
    env?: Record<string, string>;
}

export interface ChatMessage {
    role: string;
    text: string;
}

export interface ServerMessage {
    request: ModelRequest;
    response: ModelResponse;
}