import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OAuthCredential } from '../entities/oauth-credential.entity';
import { OAuthController } from './oauth.controller';
import { OAuthService } from './oauth.service';
import { EncryptionService } from './encryption.service';
import { YouTubeService } from './youtube.service';

@Module({
  imports: [TypeOrmModule.forFeature([OAuthCredential])],
  controllers: [OAuthController],
  providers: [OAuthService, EncryptionService, YouTubeService],
  exports: [OAuthService, YouTubeService],
})
export class OAuthModule {}
