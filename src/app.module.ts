import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HealthModule } from './health/health.module';
import { TranscriptionModule } from './transcription/transcription.module';
import { VideoModule } from './video/video.module';
import { AuthModule } from './auth/auth.module';
import { VideoRequestModule } from './video-request/video-request.module';
import { BullModule } from '@nestjs/bullmq';
import { User } from './entities/user.entity';
import { VideoRequest } from './entities/video-request.entity';
import { OAuthCredential } from './entities/oauth-credential.entity';
import { OAuthModule } from './oauth/oauth.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => {
        const databaseUrl =
          config.get<string>('DATABASE_URL') ||
          (config.get('POSTGRES_HOST')
            ? `postgresql://${config.get('POSTGRES_USER', 'lejel')}:${config.get('POSTGRES_PASSWORD', 'lejel_password')}@${config.get('POSTGRES_HOST')}:${config.get('POSTGRES_PORT', '5432')}/${config.get('POSTGRES_DB', 'lejel')}`
            : null);
        if (!databaseUrl) {
          throw new Error(
            'Database config required: set DATABASE_URL or POSTGRES_HOST (and optionally POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB, POSTGRES_PORT)',
          );
        }
        return {
          type: 'postgres',
          url: databaseUrl,
          entities: [User, VideoRequest, OAuthCredential],
          synchronize: true,
        };
      },
      inject: [ConfigService],
    }),
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
      },
    }),
    AuthModule,
    OAuthModule,
    VideoRequestModule,
    HealthModule,
    TranscriptionModule,
    VideoModule,
  ],
})
export class AppModule { }





