import { Readable, Writable } from 'stream';

// 基本进程流类型
export interface BaseStream {
    on(event: string, listener: (...args: any[]) => void): this;
}

// 进程标准输出流
export interface ProcessOutputStream extends BaseStream {
    on(event: 'data', listener: (chunk: Buffer) => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: 'end', listener: () => void): this;
    on(event: 'close', listener: () => void): this;
}

// 进程标准输入流
export interface ProcessInputStream extends BaseStream {
    write(chunk: any, callback?: (error?: Error | null) => void): boolean;
    write(chunk: any, encoding: BufferEncoding, callback?: (error?: Error | null) => void): boolean;
    end(): void;
    end(callback: () => void): void;
}

// 进程句柄定义
export interface ProcessHandle {
    pid: number;
    killed: boolean;
    stdout: ProcessOutputStream & Readable;
    stderr: ProcessOutputStream & Readable;
    stdin: ProcessInputStream & Writable;
    on(event: 'error', listener: (err: Error) => void): void;
    on(event: 'close', listener: (code: number) => void): void;
    kill(): void;
}