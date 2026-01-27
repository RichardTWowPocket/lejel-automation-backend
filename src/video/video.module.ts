import { Module } from '@nestjs/common';
import { VideoController } from './video.controller';
import { VideoProcessingService } from './video-processing.service';
import { JobQueueService } from './job-queue.service';
import { TranscriptionModule } from '../transcription/transcription.module';
import { AssemblyAIModule } from '../assemblyai/assemblyai.module';

@Module({
  imports: [TranscriptionModule, AssemblyAIModule],
  controllers: [VideoController],
  providers: [VideoProcessingService, JobQueueService],
  exports: [VideoProcessingService, JobQueueService],
})
export class VideoModule { }
