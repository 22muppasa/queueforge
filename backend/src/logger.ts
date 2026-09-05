export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const weights: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(minimum: LogLevel, base: Record<string, unknown> = {}) {
  const write = (level: LogLevel, event: string, fields: Record<string, unknown> = {}) => {
    if (weights[level] < weights[minimum]) return;
    const record = { timestamp: new Date().toISOString(), level, event, ...base, ...fields };
    const line = JSON.stringify(record);
    if (level === 'error') console.error(line);
    else console.log(line);
  };
  return {
    debug: (event: string, fields?: Record<string, unknown>) => write('debug', event, fields),
    info: (event: string, fields?: Record<string, unknown>) => write('info', event, fields),
    warn: (event: string, fields?: Record<string, unknown>) => write('warn', event, fields),
    error: (event: string, fields?: Record<string, unknown>) => write('error', event, fields),
  };
}

export type Logger = ReturnType<typeof createLogger>;
