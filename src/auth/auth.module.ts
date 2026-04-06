import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../entities/user.entity';
import { VideoRequest } from '../entities/video-request.entity';
import { AdminGuard } from './admin.guard';
import { ApiKeyGuard } from './api-key.guard';
import { ApiKeyOrJwtGuard } from './api-key-or-jwt.guard';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { JwtStrategy } from './jwt.strategy';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, VideoRequest]),
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET') || 'dev-secret-change-in-production',
        signOptions: { expiresIn: '7d' },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, JwtAuthGuard, ApiKeyGuard, ApiKeyOrJwtGuard, AdminGuard],
  exports: [AuthService, JwtModule, JwtAuthGuard, ApiKeyGuard, ApiKeyOrJwtGuard, AdminGuard],
})
export class AuthModule {}
