import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

export const IS_PUBLIC = 'isPublic';
/** Skips JWT validation (health checks, signed provider webhooks). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const ROLES = 'roles';
/** Restricts a route/controller to the given `role` claims (os-service Role enum). */
export const Roles = (...roles: string[]) => SetMetadata(ROLES, roles);

export interface JwtClaims {
  sub?: string;
  role?: string;
  exp?: number;
  [key: string]: unknown;
}

const b64url = (buf: Buffer) => buf.toString('base64url');

/**
 * Verifies HS256 tokens issued by the os-service / auth lambda (ADR-001) with
 * the shared JWT_SECRET. Dependency-free on purpose: only HS256 is accepted,
 * which also blocks `alg: none` downgrade attacks. Fails closed when the
 * secret is not configured.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly secret: string | undefined = process.env.JWT_SECRET,
    private readonly now: () => number = () => Date.now(),
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx
      .switchToHttp()
      .getRequest<{ headers: Record<string, unknown>; user?: JwtClaims }>();
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('missing bearer token');
    }
    req.user = this.verify(header.slice(7));

    const roles = this.reflector.getAllAndOverride<string[] | undefined>(
      ROLES,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (roles?.length && !roles.includes(String(req.user.role))) {
      throw new ForbiddenException('insufficient role');
    }
    return true;
  }

  verify(token: string): JwtClaims {
    if (!this.secret) throw new UnauthorizedException('auth not configured');
    const parts = token.split('.');
    if (parts.length !== 3) throw new UnauthorizedException('malformed token');
    const [h, p, s] = parts;

    let header: { alg?: string };
    let claims: JwtClaims;
    try {
      header = JSON.parse(Buffer.from(h, 'base64url').toString()) as {
        alg?: string;
      };
      claims = JSON.parse(Buffer.from(p, 'base64url').toString()) as JwtClaims;
    } catch {
      throw new UnauthorizedException('malformed token');
    }
    if (header.alg !== 'HS256') throw new UnauthorizedException('bad alg');

    const expected = Buffer.from(
      b64url(createHmac('sha256', this.secret).update(`${h}.${p}`).digest()),
    );
    const given = Buffer.from(s);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new UnauthorizedException('invalid signature');
    }
    if (typeof claims.exp === 'number' && claims.exp * 1000 <= this.now()) {
      throw new UnauthorizedException('token expired');
    }
    return claims;
  }
}
