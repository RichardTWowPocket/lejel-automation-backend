import { Module } from '@nestjs/common';
import { VideoController } from './video.controller';
import { VideoProcessingService } from './video-processing.service';

@Module({
  controllers: [VideoController],
  providers: [VideoProcessingService],
  exports: [VideoProcessingService],
})
export class VideoModule {}

