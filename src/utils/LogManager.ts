import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export class LogManager {
    private static logDir: string;
    private static processLogFile: string;
    private static chatLogFile: string;
    private static initialized = false;

    static initialize(extensionPath: string) {
        if (this.initialized) {
            return;
        }

        try {
            // 在扩展目录下创建日志目录
            this.logDir = path.join(extensionPath, 'logs');
            this.processLogFile = path.join(this.logDir, 'process.log');
            this.chatLogFile = path.join(this.logDir, 'chat.log');

            this.ensureLogDir();
            
            // 写入初始日志条目
            this.info('LogManager', '日志系统初始化完成', {
                logDir: this.logDir,
                processLog: this.processLogFile,
                chatLog: this.chatLogFile
            });

            this.initialized = true;
        } catch (error) {
            console.error('初始化日志目录失败:', error);
            throw error;
        }
    }

    private static ensureLogDir() {
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }
    }

    private static writeToFile(file: string, entry: string) {
        try {
            // 使用 UTF-8 with BOM 写入文件
            if (!fs.existsSync(file)) {
                fs.writeFileSync(file, '\ufeff', { encoding: 'utf8' });
            }
            fs.appendFileSync(file, entry + '\n', { encoding: 'utf8' });
        } catch (error) {
            console.error(`写入日志失败 (${file}):`, error);
            // 如果写入失败，尝试重新创建目录
            this.ensureLogDir();
            // 重试写入
            if (!fs.existsSync(file)) {
                fs.writeFileSync(file, '\ufeff', { encoding: 'utf8' });
            }
            fs.appendFileSync(file, entry + '\n', { encoding: 'utf8' });
        }
    }

    private static formatLogEntry(level: string, source: string, message: string, data?: any): string {
        const timestamp = new Date().toISOString();
        
        // 对于复杂对象使用多行格式
        if (data && typeof data === 'object') {
            return `${timestamp} [${level}] [${source}] ${message}\n${JSON.stringify(data, null, 2)}`;
        }
        
        // 对于简单消息使用单行格式
        return `${timestamp} [${level}] [${source}] ${message}`;
    }

    static info(source: string, message: string, data?: any) {
        if (!this.initialized) {
            console.warn('日志系统未初始化');
            return;
        }
        const entry = this.formatLogEntry('INFO', source, message, data);
        console.log(entry);
        this.writeToFile(this.processLogFile, entry);
    }

    static error(source: string, message: string, error?: any) {
        if (!this.initialized) {
            console.warn('日志系统未初始化');
            return;
        }
        const entry = this.formatLogEntry('ERROR', source, message, error);
        console.error(entry);
        this.writeToFile(this.processLogFile, entry);
    }

    static debug(source: string, message: string, data?: any) {
        if (!this.initialized) {
            return;
        }
        if (process.env.NODE_ENV !== 'production') {
            const entry = this.formatLogEntry('DEBUG', source, message, data);
            console.debug(entry);
            this.writeToFile(this.processLogFile, entry);
        }
    }

    static warn(source: string, message: string, data?: any) {
        if (!this.initialized) {
            console.warn('日志系统未初始化');
            return;
        }
        const entry = this.formatLogEntry('WARN', source, message, data);
        console.warn(entry);
        this.writeToFile(this.processLogFile, entry);
    }

    static isInitialized(): boolean {
        return this.initialized;
    }

    static ensureInitialized() {
        if (!this.initialized) {
            throw new Error('日志系统未初始化');
        }
    }
}