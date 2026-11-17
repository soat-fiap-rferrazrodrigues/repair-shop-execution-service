import {
  JsonLogger,
  correlationMiddleware,
  currentCorrelationId,
  withCorrelation,
} from './json.logger';

const ID = '11111111-2222-3333-4444-555555555555';

describe('JsonLogger', () => {
  let out: jest.SpyInstance;
  let err: jest.SpyInstance;
  const logger = new JsonLogger('svc', 'test');

  const last = (spy: jest.SpyInstance): Record<string, unknown> => {
    const calls = spy.mock.calls as [string][];
    return JSON.parse(calls[calls.length - 1][0]) as Record<string, unknown>;
  };

  beforeEach(() => {
    out = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    err = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['log', 'info'],
    ['warn', 'warn'],
    ['debug', 'debug'],
    ['verbose', 'trace'],
  ] as const)('%s → stdout level %s', (method, level) => {
    logger[method]('hi', 'Ctx');
    expect(last(out)).toMatchObject({
      level,
      message: 'hi',
      context: 'Ctx',
      service: 'svc',
      env: 'test',
    });
    expect(last(out)).not.toHaveProperty('correlation_id');
  });

  it('error → stderr with stack and async-context correlation id', () => {
    withCorrelation('req-1', () => logger.error(new Error('boom'), 'st'));
    expect(last(err)).toMatchObject({
      level: 'error',
      message: 'boom',
      stack: 'st',
      correlation_id: 'req-1',
    });
  });

  it('extracts orderId from message text when no context is active', () => {
    logger.log(`saga orderId=${ID}`);
    expect(last(out).correlation_id).toBe(ID);
    logger.log(`failed correlation_id=${ID}`);
    expect(last(out).correlation_id).toBe(ID);
  });

  it('stringifies objects and circular values', () => {
    logger.log({ a: 1 });
    expect(last(out).message).toBe('{"a":1}');
    const c: Record<string, unknown> = {};
    c.self = c;
    logger.log(c);
    expect(last(out).message).toBe('[object Object]');
  });

  it('uses env defaults', () => {
    process.env.DD_SERVICE = 'from-env';
    new JsonLogger().log('x');
    expect(last(out).service).toBe('from-env');
    delete process.env.DD_SERVICE;
    new JsonLogger().log('x');
    expect(last(out).service).toBe('unknown-service');
  });
});

describe('correlationMiddleware', () => {
  const run = (headers: Record<string, unknown>) => {
    const setHeader = jest.fn();
    let seen: string | undefined;
    correlationMiddleware({ headers }, { setHeader }, () => {
      seen = currentCorrelationId();
    });
    return { setHeader, seen };
  };

  it('reuses x-request-id inside the async context', () => {
    const { setHeader, seen } = run({ 'x-request-id': 'abc' });
    expect(seen).toBe('abc');
    expect(setHeader).toHaveBeenCalledWith('x-request-id', 'abc');
  });

  it.each([[{}], [{ 'x-request-id': '' }], [{ 'x-request-id': ['a'] }]])(
    'generates uuid for %j',
    (headers) => {
      expect(run(headers).seen).toMatch(/^[0-9a-f-]{36}$/);
    },
  );

  it('context does not leak outside', () => {
    run({ 'x-request-id': 'abc' });
    expect(currentCorrelationId()).toBeUndefined();
  });
});
