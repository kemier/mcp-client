export interface ModelConfig {
    name: string;
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    stopTokens?: string[];
}

export interface ModelResponse {
    text: string;
    model: string;
    usage?: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    };
}

export interface ModelRequest {
    text: string;
    model?: string;
    options?: {
        temperature?: number;
        maxTokens?: number;
        topP?: number;
        stopTokens?: string[];
    };
}

export interface ServerConfig {
    type: 'stdio';
    command: string;
    args?: string[];
    shell?: boolean;
    windowsHide?: boolean;
    env?: Record<string, string>;
    heartbeatEnabled?: boolean;
}