import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { ApiKeyGuard } from './api-key.guard';

/**
 * Allows request if either API key (X-API-Key or Authorization: ApiKey/Bearer with API key)
 * or JWT (Authorization: Bearer <jwt>) is valid.
 * Use for endpoints that dashboard calls with JWT while server-side can use API key.
 */
@Injectable()
export class ApiKeyOrJwtGuard implements CanActivate {
  constructor(
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
    private readonly authService: AuthService,
    private readonly apiKeyGuard: ApiKeyGuard,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    // 1) Try API key first (treat as admin for RBAC)
    try {
      if (await this.apiKeyGuard.canActivate(context)) {
        request.user = { role: 'admin' as const };
        return true;
      }
    } catch {
      // API key missing or invalid, try JWT
    }

    // 2) Try JWT (Authorization: Bearer <token>)
    const authHeader = request.headers['authorization'];
    const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!bearer) {
      throw new UnauthorizedException(
        'API key or JWT required. Provide X-API-Key header or Authorization: Bearer <token>.',
      );
    }

    const apiKey = this.configService.get<string>('API_KEY');
    if (apiKey && bearer === apiKey) {
      return true;
    }

    try {
      const payload = this.jwtService.verify(bearer, {
        secret: this.configService.get<string>('JWT_SECRET') || 'dev-secret-change-in-production',
      });
      const user = await this.authService.findById(payload.sub);
      if (!user) {
        throw new UnauthorizedException();
      }
      request.user = user;
      return true;
    } catch {
      throw new UnauthorizedException(
        'API key or JWT required. Provide X-API-Key header or Authorization: Bearer <token>.',
      );
    }
  }
}
