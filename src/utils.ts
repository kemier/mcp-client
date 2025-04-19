import * as vscode from 'vscode';
import { ServerConfig, CapabilityManifest } from './models/Types.js';
import { ConfigStorage } from './services/ConfigStorage.js';

/**
 * Generates a random nonce for CSP
 */
export function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

/**
 * Formats a date as a timestamp string
 * @param date The date to format (defaults to now)
 * @returns A formatted timestamp string
 */
export function formatTimestamp(date = new Date()): string {
    return date.toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
}

/**
 * Throttles function calls
 * @param fn The function to throttle
 * @param delay Delay in milliseconds
 * @returns A throttled function
 */
export function throttle(fn: Function, delay: number): (...args: any[]) => void {
    let lastCall = 0;
    return function(...args: any[]) {
        const now = Date.now();
        if (now - lastCall >= delay) {
            lastCall = now;
            return fn(...args);
        }
    };
}

export function determineAppropriateServers(text: string, availableServers: Record<string, ServerConfig>): string[] {
    const serverIds = Object.keys(availableServers);
    if (serverIds.length === 0) {
        return [];
    }
    
    // Check for explicit server selection command
    const serverCommandMatch = text.match(/^\/server:([a-zA-Z0-9_-]+)\s/);
    if (serverCommandMatch && serverIds.includes(serverCommandMatch[1])) {
        return [serverCommandMatch[1]];
    }
    
    // Get all server capabilities
    const configStorage = ConfigStorage.getInstance();
    const serverCapabilities: Record<string, CapabilityManifest | undefined> = {};
    
    serverIds.forEach(id => {
        serverCapabilities[id] = configStorage.getServerCapabilities(id);
    });
    
    // Analyze the message to determine required capabilities
    const requiredCapabilities: string[] = [];
    
    // Simple content analysis (can be extended with more sophisticated detection)
    if (text.includes('```') || /```[a-z]+\n/.test(text)) {
        requiredCapabilities.push('code-understanding');
    }
    
    if (text.includes('summarize') || text.includes('summary')) {
        requiredCapabilities.push('summarization');
    }
    
    if (text.match(/\b(sql|table|database|query)\b/i)) {
        requiredCapabilities.push('data-analysis');
    }
    
    // Score each server based on capability match
    const serverScores: Record<string, number> = {};
    
    serverIds.forEach(id => {
        const manifest = serverCapabilities[id];
        if (!manifest) {
            serverScores[id] = 0;
            return;
        }
        
        let score = 1; // Base score
        
        // Check for capability matches
        requiredCapabilities.forEach(reqCap => {
            const hasCapability = manifest.capabilities.some(
                cap => cap.name.toLowerCase() === reqCap.toLowerCase()
            );
            if (hasCapability) {
                score += 2;
            }
        });
        
        // Bonus for recently discovered capabilities (fresher information)
        const ageInHours = (Date.now() - manifest.discoveredAt) / (1000 * 60 * 60);
        if (ageInHours < 24) {
            score += 0.5;
        }
        
        serverScores[id] = score;
    });
    
    // Sort servers by score
    const rankedServers = serverIds
        .sort((a, b) => serverScores[b] - serverScores[a]);
    
    // If we have requirements but no good matches, use all servers
    if (requiredCapabilities.length > 0 && rankedServers.length > 0 && serverScores[rankedServers[0]] <= 1) {
        return serverIds;
    }
    
    // Return the best server, or all if no clear winner
    return rankedServers.length > 0 ? [rankedServers[0]] : serverIds;
} 