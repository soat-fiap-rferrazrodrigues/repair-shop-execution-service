import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ConsoleLogger } from '@nestjs/common';

/**
 * Per-async-context correlation id. For saga messages it is the orderId
 * (`correlation_id` attribute, ADR-005), so one Datadog query shows the whole
 * order across os-service, billing-service and execution-service.
 */
const storage = new AsyncLocalStorage<string>();

export const withCorrelation = <T>(id: string, fn: () => T): T =>
  storage.run(id, fn);

export const currentCorrelationId = (): string | undefined =>
  storage.getStore();

/** Express middleware: honours/echoes `x-request-id` (API Gateway, os-service). */
export const correlationMiddleware = (
  req: { headers: Record<string, unknown> },
  res: { setHeader(name: string, value: string): void },
  next: () => void,
): void => {
  const incoming = req.headers['x-request-id'];
  const id =
    typeof incoming === 'string' && incoming.length > 0
      ? incoming
      : randomUUID();
  res.setHeader('x-request-id', id);
  withCorrelation(id, next);
};

// Falls back to ids already present in log text (orderId=..., correlation_id=...).
const INLINE_ID = /(?:orderId|correlation_id)=([0-9a-f-]{36})/i;

/** One JSON object per line (Datadog parses it natively). */
export class JsonLogger extends ConsoleLogger {
  constructor(
    private readonly service = process.env.DD_SERVICE ?? 'unknown-service',
    private readonly env = process.env.DD_ENV ??
      process.env.NODE_ENV ??
      'local',
  ) {
    super();
  }

  log(message: unknown, context?: string): void {
    this.emit('info', message, context);
  }

  error(message: unknown, stack?: string, context?: string): void {
    this.emit('error', message, context, stack);
  }

  warn(message: unknown, context?: string): void {
    this.emit('warn', message, context);
  }

  debug(message: unknown, context?: string): void {
    this.emit('debug', message, context);
  }

  verbose(message: unknown, context?: string): void {
    this.emit('trace', message, context);
  }

  private emit(
    level: string,
    message: unknown,
    context?: string,
    stack?: string,
  ): void {
    const text = JsonLogger.stringify(message);
    const correlationId =
      currentCorrelationId() ?? INLINE_ID.exec(text)?.[1] ?? undefined;
    const record = {
      timestamp: new Date().toISOString(),
      level,
      service: this.service,
      env: this.env,
      message: text,
      ...(context ? { context } : {}),
      ...(correlationId ? { correlation_id: correlationId } : {}),
      ...(stack ? { stack } : {}),
    };
    const stream = level === 'error' ? process.stderr : process.stdout;
    stream.write(`${JSON.stringify(record)}\n`);
  }

  static stringify(message: unknown): string {
    if (typeof message === 'string') return message;
    if (message instanceof Error) return message.message;
    try {
      return JSON.stringify(message);
    } catch {
      return String(message);
    }
  }
}
