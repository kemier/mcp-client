import { ServerStatus } from '../models/Types';

/**
 * Interface for a server
 */
export interface IServer {
  /**
   * Start the server
   * @returns A promise that resolves when the server is started
   */
  start(): Promise<void>;

  /**
   * Stop the server
   * @returns A promise that resolves when the server is stopped
   */
  stop(): Promise<void>;

  /**
   * Send a message to the server
   * @param message The message to send
   * @returns A promise that resolves with the server's response
   */
  sendMessage(message: string): Promise<string>;

  /**
   * Get the status of the server
   * @returns The status of the server
   */
  getStatus(): ServerStatus;

  /**
   * Get process information for the server
   * @returns The process information or null if no process is running
   */
  getProcessInfo(): { pid: number } | null;

  /**
   * Get whether the server is ready to receive messages
   * @returns A boolean indicating whether the server is ready
   */
  isReady(): boolean;
} 