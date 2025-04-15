import { Readable, Writable } from 'stream';

// 标准流类型定义
export type ManagedInputStream = Writable & {
    write(chunk: any, encoding?: string, callback?: (error?: Error | null) => void): boolean;
    end(callback?: () => void): void;
};

export type ManagedOutputStream = Readable;

// 受管理进程类型定义
export interface ManagedProcess {
    pid: number;
    killed: boolean;
    stdout: ManagedOutputStream;
    stderr: ManagedOutputStream;
    stdin: ManagedInputStream;
    on(event: string, listener: (...args: any[]) => void): void;
    kill(): void;
}