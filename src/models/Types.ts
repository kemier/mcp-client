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
    Stopping = 'stopping',
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

// Update ChatMessage to handle different roles and content types
export interface ChatMessage {
    role: 'user' | 'assistant' | 'tool' | 'bot'; // Use specific roles
    content?: string; // Primary content for user/assistant
    text?: string; // Keep for compatibility with 'bot' role messages in UI
    tool_calls?: any[]; // For assistant requesting tools
    tool_results?: any[]; // For tool results
}

/**
 * Represents metadata for a chat session (used in session list UI)
 */
export interface ChatSessionMetadata {
    id: string;
    title: string;
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

// --- JSON-RPC Notification Types (Server -> Client) --- 
// These need to be aligned with the server implementation!

export interface TextChunkNotificationParams {
    session_id?: string; // Optional based on protocol spec, but server seems to send it
    task_id: string;    // Required
    content: string;    // Use 'content' based on recent server logs
}

export interface FinalTextNotificationParams {
    session_id?: string;
    task_id: string;
    final_text: string; // Use 'final_text' based on recent server logs
}

export interface FunctionCallRequestNotificationParams {
    task_id: string;
    session_id: string;
    call_info: any; // Use 'any' for FunctionCallRequest structure for now
}

export interface StatusNotificationParams {
    task_id?: string; // Optional, might be global
    session_id?: string; // Optional
    status: string;
}

export interface ErrorNotificationParams {
    task_id?: string; // Optional
    session_id?: string; // Optional
    error_details: string;
}

export interface EndNotificationParams {
    task_id: string;
    session_id: string;
    error_occurred?: boolean;
}

// Look for IServerStatusListener or similar interfaces

// --- Add exports for other needed types --- 

// Represents a tool definition usable by the client/LLM
export interface SimpleTool {
  name: string;
  description: string;
  inputSchema: any;
}

// Represents a request from the LLM to call a specific tool (sent via SSE)
export interface FunctionCallRequest {
    tool_call_id: string; 
    tool_name: string;
    parameters: Record<string, any>;
}

// Represents the result of executing a tool call (sent back to server)
export interface ToolResult {
    tool_call_id: string; 
    tool_name: string;
    result?: any; 
    error?: string; 
}

// Represents the response from /create_session (assuming this is still needed, maybe via RPC now)
export interface SessionResponse {
    session_id: string;
}

// Interface for a chat session (used internally by client)
export interface ChatSession {
  id: string; 
  title: string; 
  history: ChatMessage[]; // Use exported ChatMessage
}