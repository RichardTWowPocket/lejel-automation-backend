import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HealthModule } from './health/health.module';
import { TranscriptionModule } from './transcription/transcription.module';
import { VideoModule } from './video/video.module';
import { ProfileModule } from './profile/profile.module';
import { AuthModule } from './auth/auth.module';
import { VideoRequestModule } from './video-request/video-request.module';
import { BullModule } from '@nestjs/bullmq';
import { User } from './entities/user.entity';
import { VideoRequest } from './entities/video-request.entity';
import { GoogleClient } from './entities/google-client.entity';
import { OAuthCredential } from './entities/oauth-credential.entity';
import { AutomationChannel } from './entities/automation-channel.entity';
import { AutomationRun } from './entities/automation-run.entity';
import { OAuthModule } from './oauth/oauth.module';
import { AutomationModule } from './automation/automation.module';
import { LlmModule } from './llm/llm.module';
import { ElevenLabsModule } from './elevenlabs/elevenlabs.module';
import { KieAiModule } from './kie-ai/kie-ai.module';
import { FontsModule } from './fonts/fonts.module';

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
          entities: [
            User,
            VideoRequest,
            GoogleClient,
            OAuthCredential,
            AutomationChannel,
            AutomationRun,
          ],
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
    AutomationModule,
    HealthModule,
    TranscriptionModule,
    LlmModule,
    ElevenLabsModule,
    KieAiModule,
    VideoModule,
    ProfileModule,
    FontsModule,
  ],
})
export class AppModule { }





