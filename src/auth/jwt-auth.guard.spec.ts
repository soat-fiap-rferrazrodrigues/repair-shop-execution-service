import { createHmac } from 'node:crypto';
import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';

const SECRET = 'test-secret';

const sign = (
  claims: Record<string, unknown>,
  { secret = SECRET, alg = 'HS256' } = {},
) => {
  const h = Buffer.from(JSON.stringify({ alg, typ: 'JWT' })).toString(
    'base64url',
  );
  const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const s = createHmac('sha256', secret)
    .update(`${h}.${p}`)
    .digest('base64url');
  return `${h}.${p}.${s}`;
};

const ctx = (authorization?: unknown) => {
  const req: { headers: Record<string, unknown>; user?: unknown } = {
    headers: { authorization },
  };
  return {
    req,
    context: {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext,
  };
};

describe('JwtAuthGuard', () => {
  const reflector = { getAllAndOverride: jest.fn() };
  const now = 1_700_000_000_000;
  const guard = new JwtAuthGuard(
    reflector as unknown as Reflector,
    SECRET,
    () => now,
  );

  beforeEach(() => reflector.getAllAndOverride.mockReset());

  const withRoles = (roles?: string[]) =>
    reflector.getAllAndOverride.mockImplementation((key: string) =>
      key === 'roles' ? roles : false,
    );

  it('enforces @Roles', () => {
    withRoles(['admin']);
    const admin = ctx(`Bearer ${sign({ role: 'admin' })}`).context;
    const client = ctx(`Bearer ${sign({ role: 'client' })}`).context;
    expect(guard.canActivate(admin)).toBe(true);
    expect(() => guard.canActivate(client)).toThrow(ForbiddenException);
  });

  it('empty @Roles allows any authenticated user', () => {
    withRoles([]);
    expect(guard.canActivate(ctx(`Bearer ${sign({})}`).context)).toBe(true);
  });

  it('allows @Public routes without token', () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    expect(guard.canActivate(ctx().context)).toBe(true);
  });

  it('accepts a valid token and exposes claims', () => {
    const { req, context } = ctx(
      `Bearer ${sign({ sub: 'u1', role: 'admin', exp: now / 1000 + 60 })}`,
    );
    expect(guard.canActivate(context)).toBe(true);
    expect(req.user).toMatchObject({ sub: 'u1', role: 'admin' });
  });

  it('accepts tokens without exp', () => {
    expect(guard.verify(sign({ sub: 'u1' }))).toEqual({ sub: 'u1' });
  });

  it.each([undefined, 'Basic abc', 42])('rejects header %p', (h) => {
    expect(() => guard.canActivate(ctx(h).context)).toThrow(
      UnauthorizedException,
    );
  });

  it.each([
    ['malformed', 'a.b'],
    ['bad json', 'x.y.z'],
    ['wrong secret', sign({ sub: 'u' }, { secret: 'other' })],
    ['alg none', sign({ sub: 'u' }, { alg: 'none' })],
    ['expired', sign({ sub: 'u', exp: now / 1000 - 1 })],
    ['short signature', `${sign({ sub: 'u' }).slice(0, -3)}`],
  ])('rejects %s token', (_name, token) => {
    expect(() => guard.verify(token)).toThrow(UnauthorizedException);
  });

  it('fails closed without secret', () => {
    const open = new JwtAuthGuard(reflector as unknown as Reflector, '');
    expect(() => open.verify(sign({}))).toThrow('auth not configured');
  });

  it('defaults secret and clock from env', () => {
    process.env.JWT_SECRET = SECRET;
    const g = new JwtAuthGuard(reflector as unknown as Reflector);
    expect(g.verify(sign({ exp: Date.now() / 1000 + 60 }))).toBeDefined();
    delete process.env.JWT_SECRET;
  });
});
