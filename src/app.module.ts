import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthModule } from './health/health.module';
import { TranscriptionModule } from './transcription/transcription.module';
import { VideoModule } from './video/video.module';
import { AuthModule } from './auth/auth.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    AuthModule,
    HealthModule,
    TranscriptionModule,
    VideoModule,
  ],
})
export class AppModule {}





