import { ProcessHandle } from '../types/ProcessTypes';
import { Readable, Writable } from 'stream';
import { LogManager } from './LogManager';

export function isProcessHandle(proc: any): proc is ProcessHandle {
    if (!proc) {
        console.debug('[ProcessUtils] 进程实例为空');
        return false;
    }

    const checks = {
        hasPid: typeof proc.pid === 'number',
        hasKilled: typeof proc.killed === 'boolean',
        hasStdout: proc.stdout instanceof Readable,
        hasStderr: proc.stderr instanceof Readable,
        hasStdin: proc.stdin instanceof Writable,
        hasWrite: typeof proc.stdin?.write === 'function',
        hasEnd: typeof proc.stdin?.end === 'function',
        hasOn: typeof proc.on === 'function',
        hasKill: typeof proc.kill === 'function'
    };

    const valid = Object.values(checks).every(Boolean);
    
    if (!valid) {
        console.debug('[ProcessUtils] 进程实例检查结果:', checks);
    }

    return valid;
}

export const ProcessLogger = {
    info: (command: string, message: string, ...args: any[]) => {
        LogManager.info(command, message, args.length ? args : undefined);
    },

    error: (command: string, message: string, error?: any) => {
        LogManager.error(command, message, error);
    },

    debug: (command: string, message: string, ...args: any[]) => {
        if (process.env.NODE_ENV !== 'production') {
            LogManager.debug(command, message, args.length ? args : undefined);
        }
    }
};