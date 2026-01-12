import { Module } from '@nestjs/common';
import { VideoController } from './video.controller';
import { VideoProcessingService } from './video-processing.service';
import { JobQueueService } from './job-queue.service';
import { TranscriptionModule } from '../transcription/transcription.module';

@Module({
  imports: [TranscriptionModule],
  controllers: [VideoController],
  providers: [VideoProcessingService, JobQueueService],
  exports: [VideoProcessingService, JobQueueService],
})
export class VideoModule {}

