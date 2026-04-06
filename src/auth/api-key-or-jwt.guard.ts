import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';

/**
 * Allows request if:
 * - (dev) API_KEY env is unset → allow anyone (same as ApiKeyGuard)
 * - X-API-Key or x-apikey matches API_KEY → admin
 * - Authorization: Bearer <value> equals API_KEY → admin
 * - Authorization: Bearer <jwt> verifies with JWT_SECRET → user
 *
 * Important: we validate X-API-Key first, then JWT. We do **not** treat Bearer tokens as API keys
 * until we've tried JWT verification when the bearer looks like a JWT (three segments), so dashboard
 * JWTs are not rejected as "invalid API key" without a proper fallback.
 */
@Injectable()
export class ApiKeyOrJwtGuard implements CanActivate {
  constructor(
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
    private readonly authService: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const configApiKey = this.configService.get<string>('API_KEY')?.trim() || '';
    const jwtSecret =
      this.configService.get<string>('JWT_SECRET') || 'dev-secret-change-in-production';

    // Match ApiKeyGuard: no API key configured → allow (development)
    if (!configApiKey) {
      request.user = request.user ?? { role: 'admin' as const };
      return true;
    }

    const xApiKeyRaw = request.headers['x-api-key'] || request.headers['x-apikey'];
    const xApiKey = Array.isArray(xApiKeyRaw)
      ? String(xApiKeyRaw[0] ?? '').trim()
      : typeof xApiKeyRaw === 'string'
        ? xApiKeyRaw.trim()
        : '';
    if (xApiKey && xApiKey === configApiKey) {
      request.user = { role: 'admin' as const };
      return true;
    }

    const authHeader =
      typeof request.headers['authorization'] === 'string' ? request.headers['authorization'] : '';
    const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    const bearer = bearerMatch?.[1]?.trim() ?? '';

    if (!bearer) {
      throw new UnauthorizedException(
        'Authentication required. Sign in to the dashboard (session cookie / Bearer token) or send the X-API-Key header. This message is from the Lejel API, not YouTube.',
      );
    }

    if (bearer === configApiKey) {
      request.user = { role: 'admin' as const };
      return true;
    }

    const looksLikeJwt = bearer.split('.').length === 3;
    if (looksLikeJwt) {
      try {
        const payload = this.jwtService.verify(bearer, { secret: jwtSecret }) as { sub?: string };
        const sub = typeof payload?.sub === 'string' ? payload.sub : undefined;
        if (!sub) {
          throw new UnauthorizedException(
            'Invalid token. Sign in again. (Lejel API — JWT payload missing subject.)',
          );
        }
        const user = await this.authService.findById(sub);
        if (!user) {
          throw new UnauthorizedException(
            'Invalid token. User no longer exists. Sign in again. (Lejel API)',
          );
        }
        request.user = user;
        return true;
      } catch (e) {
        if (e instanceof UnauthorizedException) throw e;
        throw new UnauthorizedException(
          'Invalid or expired session. Sign in again. (Lejel API — JWT verification failed, not YouTube.)',
        );
      }
    }

    throw new UnauthorizedException(
      'Invalid API key or token. Use X-API-Key, or sign in and use a valid Bearer JWT. (Lejel API)',
    );
  }
}
