import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const apiKey = this.configService.get<string>('API_KEY');

    // If no API key is configured, allow all requests (for development)
    if (!apiKey) {
      return true;
    }

    // Get API key from header (X-API-Key or Authorization)
    const providedApiKey =
      request.headers['x-api-key'] ||
      request.headers['x-apikey'] ||
      request.headers['authorization']?.replace('Bearer ', '') ||
      request.headers['authorization']?.replace('ApiKey ', '');

    if (!providedApiKey) {
      throw new UnauthorizedException(
        'API key is required. Please provide it in X-API-Key header or Authorization header.',
      );
    }

    if (providedApiKey !== apiKey) {
      throw new UnauthorizedException('Invalid API key');
    }

    return true;
  }
}



