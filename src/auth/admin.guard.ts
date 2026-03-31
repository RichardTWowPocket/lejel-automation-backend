import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';

/**
 * Restricts access to admin only. Requires request.user to be set (e.g. by JwtAuthGuard or ApiKeyOrJwtGuard)
 * with user.role === 'admin'. API key auth is treated as admin in ApiKeyOrJwtGuard.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request.user as { role?: string } | undefined;
    if (!user || user.role !== 'admin') {
      throw new ForbiddenException('Admin only');
    }
    return true;
  }
}
