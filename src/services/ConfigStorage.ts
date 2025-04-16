import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ServerConfig } from '../models/Types';
import { logInfo, logError, logWarning } from '../utils/logger';

/**
 * Class to handle configuration storage for the extension
 */
export class ConfigStorage {
    private static _instance: ConfigStorage;
    private storagePath: string;
    private configFile: string;
    private servers: Map<string, ServerConfig> = new Map();
    private initialized: boolean = false;
    private context: vscode.ExtensionContext;

    private constructor(context: vscode.ExtensionContext) {
        this.storagePath = context.globalStoragePath;
        this.configFile = path.join(this.storagePath, 'servers.json');
        this.context = context;
        
        // Ensure storage directory exists
        if (!fs.existsSync(this.storagePath)) {
            fs.mkdirSync(this.storagePath, { recursive: true });
            logInfo(`[ConfigStorage] Created storage directory: ${this.storagePath}`);
        }
        
        this.loadConfigurations();
    }

    /**
     * Gets the singleton instance of ConfigStorage
     * @param context The extension context
     * @returns The ConfigStorage instance
     */
    public static getInstance(context: vscode.ExtensionContext): ConfigStorage {
        if (!ConfigStorage._instance) {
            ConfigStorage._instance = new ConfigStorage(context);
        }
        return ConfigStorage._instance;
    }

    /**
     * Load server configurations from the storage file
     */
    private loadConfigurations(): void {
        try {
            if (fs.existsSync(this.configFile)) {
                const data = fs.readFileSync(this.configFile, 'utf8');
                const configs = JSON.parse(data);
                
                for (const [name, config] of Object.entries(configs)) {
                    this.servers.set(name, config as ServerConfig);
                }
                
                logInfo(`[ConfigStorage] Loaded ${this.servers.size} server configurations from ${this.configFile}`);
            } else {
                logInfo(`[ConfigStorage] No configuration file found at ${this.configFile}`);
            }
            this.initialized = true;
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            logError(`[ConfigStorage] Failed to load configurations: ${errorMsg}`);
            // Initialize with empty config on error
            this.servers = new Map();
            this.initialized = true;
        }
    }

    /**
     * Save the current configurations to the storage file
     */
    private saveConfigurations(): void {
        try {
            const configs: Record<string, ServerConfig> = {};
            
            this.servers.forEach((config, name) => {
                configs[name] = config;
            });
            
            fs.writeFileSync(this.configFile, JSON.stringify(configs, null, 2), 'utf8');
            logInfo(`[ConfigStorage] Saved ${this.servers.size} server configurations to ${this.configFile}`);
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            logError(`[ConfigStorage] Failed to save configurations: ${errorMsg}`);
        }
    }

    /**
     * Add or update a server configuration
     */
    public async addServer(serverName: string, config: ServerConfig): Promise<void> {
        logInfo(`[ConfigStorage] Adding server: ${serverName}`);
        const servers = this.getAllServers();
        servers[serverName] = config;
        await this.updateServers(servers);
    }

    /**
     * Remove a server configuration
     */
    public async removeServer(serverName: string): Promise<void> {
        logInfo(`[ConfigStorage] Removing server: ${serverName}`);
        const servers = this.getAllServers();
        if (servers[serverName]) {
            delete servers[serverName];
            await this.updateServers(servers);
            logInfo(`[ConfigStorage] Server ${serverName} removed from config.`);
        } else {
            logWarning(`[ConfigStorage] Attempted to remove non-existent server: ${serverName}`);
        }
    }

    /**
     * Get a server configuration by name
     */
    public getServer(name: string): ServerConfig | undefined {
        return this.servers.get(name);
    }

    /**
     * Get all server configurations
     */
    public getAllServers(): Record<string, ServerConfig> {
        const servers = this.context.globalState.get<Record<string, ServerConfig>>('servers', {});
        return servers;
    }

    /**
     * Get a list of all server names
     */
    public getServerNames(): string[] {
        return Array.from(this.servers.keys());
    }

    /**
     * Check if the configuration store has been initialized
     */
    public isInitialized(): boolean {
        return this.initialized;
    }

    private async updateServers(servers: Record<string, ServerConfig>): Promise<void> {
        this.context.globalState.update('servers', servers);
        this.servers = new Map(Object.entries(servers));
        this.saveConfigurations();
    }
} 