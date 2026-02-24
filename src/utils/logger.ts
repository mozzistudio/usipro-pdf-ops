import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});

/** Create a child logger scoped to a specific OF number */
export function ofLogger(ofNumber: string) {
  return logger.child({ of: ofNumber });
}
