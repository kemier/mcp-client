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