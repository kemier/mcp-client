import { ProcessHandle, ProcessInputStream } from '../types/ProcessTypes.js';
import { isProcessHandle, ProcessLogger } from '../utils/ProcessUtils.js';
import { ProcessMonitor } from '../utils/ProcessMonitor.js';
import { ChildProcess } from 'child_process';
import { Readable, Writable } from 'stream';
import * as vscode from 'vscode';

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
    pid?: number; // Optional: process ID
    models?: string[]; // Optional: available models
    capabilities?: CapabilityManifest;
}

/**
 * General server configuration structure (used for storage and setup)
 */
export interface ServerConfig {
    type: 'stdio' | 'sse';
    command: string;
    args?: string[];
    shell?: boolean;
    windowsHide?: boolean;
    heartbeatEnabled?: boolean;
    env?: Record<string, string>;
    url?: string;
    autoApprove?: boolean;
}

// Keep StdioConfig specific interface if needed, though ServerConfig might suffice
export interface StdioConfig extends ServerConfig {
    type: 'stdio';
}

/**
 * Represents a request to a model
 */
export interface ModelRequest {
    prompt: string;
    model: string;
    id?: string;
}

/**
 * Represents a response from a model
 */
export interface ModelResponse {
    text: string;
    id?: string;
}

export interface ChatMessage {
    role: string;
    text: string;
}

/**
 * Represents a specific server capability
 */
export interface ServerCapability {
    name: string;
    type: 'model' | 'context' | 'feature';
    description?: string;
    parameters?: Record<string, any>;
    confidence?: number; // 0-100% confidence in this capability
}

/**
 * Represents a complete capability manifest
 */
export interface CapabilityManifest {
    models: string[];
    capabilities: CapabilityItem[];
    contextTypes: string[];
    discoveredAt: number;
}

export interface CapabilityItem {
    name: string;
    description?: string;
    inputSchema?: Record<string, any> | { type: 'object', properties: Record<string, any>, required?: string[] };
}

// Look for IServerStatusListener or similar interfaces