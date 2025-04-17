import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ServerConfig, CapabilityManifest, ServerCapability } from '../models/Types';
import { LogManager } from '../utils/LogManager';



/**
 * Class to handle configuration storage for the extension
 */
export class ConfigStorage {
    private static _instance: ConfigStorage;
    private storagePath: string;
    private globalConfigPath: string;
    private projectConfigPath: string | undefined;
    private configFile: string;
    private servers: Map<string, ServerConfig> = new Map();
    private initialized: boolean = false;
    private context: vscode.ExtensionContext;
    private capabilityCache: Map<string, CapabilityManifest> = new Map();

    private constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.storagePath = context.globalStoragePath;
        this.configFile = path.join(this.storagePath, 'servers.json');
        
        // Set up Cursor-compatible config paths
        this.globalConfigPath = path.join(os.homedir(), '.cursor', 'mcp.json');
        
        // Try to get project config path from workspace folder
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            this.projectConfigPath = path.join(
                vscode.workspace.workspaceFolders[0].uri.fsPath, 
                '.cursor', 
                'mcp.json'
            );
        }
        
        // Ensure storage directory exists
        if (!fs.existsSync(this.storagePath)) {
            fs.mkdirSync(this.storagePath, { recursive: true });
            LogManager.info('ConfigStorage', `Created storage directory: ${this.storagePath}`);
        }
        
        this.loadConfigurations();
        this.loadCapabilitiesFromStorage();
    }

    /**
     * Gets the singleton instance of ConfigStorage
     * @param context The extension context (required on first call)
     * @returns The ConfigStorage instance
     */
    public static getInstance(context?: vscode.ExtensionContext): ConfigStorage {
        if (!ConfigStorage._instance) {
            if (!context) {
                throw new Error('ConfigStorage must be initialized with a context on first call');
            }
            ConfigStorage._instance = new ConfigStorage(context);
        }
        return ConfigStorage._instance;
    }

    /**
     * Load server configurations from cursor-compatible config files
     */
    private loadConfigurations(): void {
        try {
            // Load from our extension storage
            if (fs.existsSync(this.configFile)) {
                const data = fs.readFileSync(this.configFile, 'utf8');
                const configs = JSON.parse(data);
                
                for (const [name, config] of Object.entries(configs)) {
                    this.servers.set(name, config as ServerConfig);
                }
                
                LogManager.info('ConfigStorage', `Loaded ${this.servers.size} server configurations from ${this.configFile}`);
            }
            
            // Load from global cursor config
            if (fs.existsSync(this.globalConfigPath)) {
                try {
                    const data = fs.readFileSync(this.globalConfigPath, 'utf8');
                    const config = JSON.parse(data);
                    
                    if (config.mcpServers) {
                        for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
                            const transformedConfig = this.transformCursorConfig(name, serverConfig);
                            this.servers.set(name, transformedConfig);
                        }
                        LogManager.info('ConfigStorage', `Loaded server configurations from Cursor global config`);
                    }
                } catch (error) {
                    LogManager.warn('ConfigStorage', `Failed to parse Cursor global config: ${error}`);
                }
            }
            
            // Load from project cursor config (overrides globals)
            if (this.projectConfigPath && fs.existsSync(this.projectConfigPath)) {
                try {
                    const data = fs.readFileSync(this.projectConfigPath, 'utf8');
                    const config = JSON.parse(data);
                    
                    if (config.mcpServers) {
                        for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
                            const transformedConfig = this.transformCursorConfig(name, serverConfig);
                            this.servers.set(name, transformedConfig);
                        }
                        LogManager.info('ConfigStorage', `Loaded server configurations from Cursor project config`);
                    }
                } catch (error) {
                    LogManager.warn('ConfigStorage', `Failed to parse Cursor project config: ${error}`);
                }
            }
            
            this.initialized = true;
        } catch (error) {
            LogManager.error('ConfigStorage', `Failed to load configurations: ${error}`);
            // Initialize with empty config on error
            this.servers = new Map();
            this.initialized = true;
        }
    }
    
    /**
     * Transform Cursor config format to our ServerConfig format
     */
    private transformCursorConfig(name: string, cursorConfig: any): ServerConfig {
        return {
            type: cursorConfig.url ? 'sse' : 'stdio',
            command: cursorConfig.command,
            args: cursorConfig.args || [],
            shell: cursorConfig.shell !== undefined ? cursorConfig.shell : true,
            windowsHide: cursorConfig.windowsHide !== undefined ? cursorConfig.windowsHide : true,
            heartbeatEnabled: cursorConfig.heartbeatEnabled || false,
            env: cursorConfig.env || {},
            url: cursorConfig.url,
            autoApprove: cursorConfig.autoApprove || false
        };
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
            LogManager.info('ConfigStorage', `Saved ${this.servers.size} server configurations to ${this.configFile}`);
        } catch (error) {
            LogManager.error('ConfigStorage', `Failed to save configurations: ${error}`);
        }
    }

    /**
     * Add or update a server configuration
     */
    public async addServer(serverName: string, config: ServerConfig): Promise<void> {
        LogManager.info('ConfigStorage', `Adding server: ${serverName}`);
        this.servers.set(serverName, config);
        this.saveConfigurations();
    }

    /**
     * Remove a server configuration
     */
    public async removeServer(serverName: string): Promise<boolean> {
        LogManager.info('ConfigStorage', `Removing server: ${serverName}`);
        const removed = this.servers.delete(serverName);
        if (removed) {
            this.saveConfigurations();
            await this.clearServerCapabilities(serverName);
            LogManager.info('ConfigStorage', `Server ${serverName} removed from config.`);
            return true;
        } else {
            LogManager.warn('ConfigStorage', `Attempted to remove non-existent server: ${serverName}`);
            return false;
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
        const result: Record<string, ServerConfig> = {};
        this.servers.forEach((config, name) => {
            result[name] = config;
        });
        return result;
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

    private loadCapabilitiesFromStorage(): void {
        const storedCapabilities = this.context.globalState.get<Record<string, CapabilityManifest>>('serverCapabilities', {});
        Object.entries(storedCapabilities).forEach(([serverId, manifest]) => {
            this.capabilityCache.set(serverId, manifest);
        });
        LogManager.debug('ConfigStorage', 'Capability cache loaded/initialized.', { cacheSize: this.capabilityCache.size });
    }
    
    public getServerCapabilities(serverId: string): CapabilityManifest | undefined {
        const cached = this.capabilityCache.get(serverId);
        LogManager.debug('ConfigStorage', `Returning cached capabilities for serverId: ${serverId}`, { found: !!cached });
        return cached;
    }
    
    public async storeServerCapabilities(serverId: string, capabilities: CapabilityManifest): Promise<void> {
        this.capabilityCache.set(serverId, capabilities);
        const storedCapabilities = this.context.globalState.get<Record<string, CapabilityManifest>>('serverCapabilities', {});
        storedCapabilities[serverId] = capabilities;
        await this.context.globalState.update('serverCapabilities', storedCapabilities);
        LogManager.debug('ConfigStorage', `Stored dynamic capabilities for serverId: ${serverId}`);
    }
    
    public async clearServerCapabilities(serverId: string): Promise<void> {
        this.capabilityCache.delete(serverId);
        const storedCapabilities = this.context.globalState.get<Record<string, CapabilityManifest>>('serverCapabilities', {});
        delete storedCapabilities[serverId];
        await this.context.globalState.update('serverCapabilities', storedCapabilities);
        LogManager.debug('ConfigStorage', `Cleared dynamic capabilities for serverId: ${serverId}`);
    }
    
    public getAllServerCapabilities(): Record<string, CapabilityManifest> {
        const result: Record<string, CapabilityManifest> = {};
        this.capabilityCache.forEach((manifest, serverId) => {
            result[serverId] = manifest;
        });
        return result;
    }

    public async saveServerConfig(serverName: string, config: ServerConfig): Promise<void> {
        this.servers.set(serverName, config);
        this.saveConfigurations();
        return Promise.resolve();
    }

    /**
     * Get capabilities for a server (alias for getServerCapabilities for compatibility)
     */
    public getCapabilities(serverId: string): CapabilityManifest | undefined {
        return this.getServerCapabilities(serverId);
    }
} 