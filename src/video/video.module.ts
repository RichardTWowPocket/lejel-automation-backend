import { Module } from '@nestjs/common';
import { VideoController } from './video.controller';
import { VideoProcessingService } from './video-processing.service';
import { JobQueueService } from './job-queue.service';
import { UploadMediaService } from './upload-media.service';
import { TranscriptionModule } from '../transcription/transcription.module';
import { AssemblyAIModule } from '../assemblyai/assemblyai.module';
import { AuthModule } from '../auth/auth.module';
import { BullModule } from '@nestjs/bullmq';
import { VideoProcessor } from './video.processor';

@Module({
  imports: [
    AuthModule,
    TranscriptionModule,
    AssemblyAIModule,
    BullModule.registerQueue({
      name: 'video-rendering',
    }),
  ],
  controllers: [VideoController],
  providers: [VideoProcessingService, JobQueueService, VideoProcessor, UploadMediaService],
  exports: [VideoProcessingService, JobQueueService],
})
export class VideoModule {}
