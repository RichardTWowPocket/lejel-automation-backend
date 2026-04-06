import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { VideoRequest } from '../entities/video-request.entity';
import { AuthModule } from '../auth/auth.module';
import { LlmModule } from '../llm/llm.module';
import { OAuthModule } from '../oauth/oauth.module';
import { VideoModule } from '../video/video.module';
import { VideoRequestController } from './video-request.controller';
import { VideoRequestService } from './video-request.service';
import { VideoGenerationProcessor } from './video-generation.processor';
import { VIDEO_GENERATION_QUEUE } from './video-request.queue';
import { AutomationModule } from '../automation/automation.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([VideoRequest]),
    BullModule.registerQueue({ name: VIDEO_GENERATION_QUEUE }),
    AuthModule,
    OAuthModule,
    LlmModule,
    VideoModule,
    forwardRef(() => AutomationModule),
  ],
  controllers: [VideoRequestController],
  providers: [VideoRequestService, VideoGenerationProcessor],
  exports: [VideoRequestService],
})
export class VideoRequestModule {}
