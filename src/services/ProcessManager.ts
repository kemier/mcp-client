import { ChildProcess, SpawnOptions } from 'child_process';
import { Readable, Writable } from 'stream';
import { ProcessHandle } from '../types/ProcessTypes.js';
import * as fs from 'fs';
import * as path from 'path';
import { ProcessLogger } from '../utils/ProcessUtils.js';
import { spawn } from 'child_process';

export class ProcessManagerClass {
    spawn(
        command: string, 
        args?: string[], 
        options?: { env?: NodeJS.ProcessEnv; shell?: boolean; windowsHide?: boolean; stdio?: any[] }
    ): ProcessHandle {
        ProcessLogger.debug('ProcessManager', '启动进程', { command, args, options });
        return spawn(command, args || [], options) as unknown as ProcessHandle;
    }

    async killProcess(pid: number): Promise<void> {
        try {
            process.kill(pid);
            ProcessLogger.info('ProcessManager', `终止进程 ${pid}`);
        } catch (error) {
            ProcessLogger.error('ProcessManager', `终止进程 ${pid} 失败`, error);
            throw error;
        }
    }
}

export const ProcessManager = new ProcessManagerClass();