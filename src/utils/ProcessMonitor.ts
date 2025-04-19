import { EventEmitter } from 'events';
import { ManagedProcess } from './ProcessTypes.js';
import { ProcessLogger } from './ProcessUtils.js';

export class ProcessMonitor {
    private startTime: number;
    private lastHealthCheck: number;
    private healthCheckCount: number = 0;

    constructor(
        private readonly command: string,
        private readonly process: ManagedProcess
    ) {
        this.startTime = Date.now();
        this.lastHealthCheck = Date.now();
        this.logProcessStart();
    }

    private logProcessStart() {
        ProcessLogger.info(this.command, '进程启动', {
            pid: this.process.pid,
            startTime: new Date(this.startTime).toISOString(),
            env: process.env.NODE_ENV
        });
    }

    public recordHealthCheck(success: boolean) {
        this.healthCheckCount++;
        this.lastHealthCheck = Date.now();
        
        ProcessLogger.debug(this.command, '健康检查', {
            success,
            count: this.healthCheckCount,
            uptime: this.getUptime()
        });
    }

    public getStatus() {
        return {
            pid: this.process.pid,
            uptime: this.getUptime(),
            healthChecks: this.healthCheckCount,
            lastHealthCheck: new Date(this.lastHealthCheck).toISOString(),
            killed: this.process.killed
        };
    }

    private getUptime(): number {
        return Math.floor((Date.now() - this.startTime) / 1000);
    }
}