import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GoogleClient } from '../entities/google-client.entity';
import { OAuthCredential } from '../entities/oauth-credential.entity';
import { AuthModule } from '../auth/auth.module';
import { OAuthController } from './oauth.controller';
import { OAuthService } from './oauth.service';
import { GoogleClientService } from './google-client.service';
import { EncryptionService } from './encryption.service';
import { YouTubeService } from './youtube.service';

@Module({
  imports: [TypeOrmModule.forFeature([GoogleClient, OAuthCredential]), AuthModule],
  controllers: [OAuthController],
  providers: [OAuthService, GoogleClientService, EncryptionService, YouTubeService],
  exports: [OAuthService, YouTubeService, GoogleClientService],
})
export class OAuthModule {}
