export const LogConfig = {
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    prefix: 'MCP',
    timestamp: true
};