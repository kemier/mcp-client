import { ProcessHandle, ProcessInputStream } from '../types/ProcessTypes';
import { isProcessHandle, ProcessLogger } from '../utils/ProcessUtils';
import { ProcessMonitor } from '../utils/ProcessMonitor';
import { ChildProcess } from 'child_process';
import { Readable, Writable } from 'stream';

// Define ServerStatus enum
export enum ServerStatus {
    Disconnected = 'disconnected',
    Connecting = 'connecting',
    Connected = 'connected',
    Error = 'error'
}

// 只保留必要的类型定义
export interface BaseServerConfig {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    shell?: boolean;
    windowsHide?: boolean;
    model?: string;
}

/**
 * Represents the overall status of a managed server - emitted by McpServerManager
 */
export interface ServerStatusEvent {
    serverId: string;
    status: ServerStatus; // Use the enum type here
    error?: string;
    uptime?: number; // Optional: track server uptime
    lastUpdate?: number;
}

/**
 * General server configuration structure (used for storage and setup)
 */
export interface ServerConfig {
    type: 'stdio' | 'http' | string; // Allow custom types
    command: string;
    args: string[];
    shell?: boolean;
    windowsHide?: boolean;
    heartbeatEnabled?: boolean;
    env?: Record<string, string>;
}

// Keep StdioConfig specific interface if needed, though ServerConfig might suffice
export interface StdioConfig extends ServerConfig {
    type: 'stdio';
}

/**
 * Represents a request to a model
 */
export interface ModelRequest {
    model: string;
    prompt: string;
    params?: Record<string, any>;
    context?: any; // Context for multi-turn conversation, etc.
}

/**
 * Represents a response from a model
 */
export interface ModelResponse {
    text: string;
    model: string;
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
    };
    error?: string; // Optional error message
}

export interface ChatMessage {
    role: string;
    text: string;
}

// Look for IServerStatusListener or similar interfaces