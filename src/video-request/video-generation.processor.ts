import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { VideoRequestService } from './video-request.service';
import { VIDEO_GENERATION_JOB, VIDEO_GENERATION_QUEUE } from './video-request.queue';
import { ScriptToVideoService } from '../video/script-to-video.service';

@Processor(VIDEO_GENERATION_QUEUE)
export class VideoGenerationProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoGenerationProcessor.name);

  constructor(
    private readonly videoRequestService: VideoRequestService,
    private readonly scriptToVideoService: ScriptToVideoService,
  ) {
    super();
  }

  async process(job: Job<{ requestId: string }>) {
    if (job.name !== VIDEO_GENERATION_JOB) return;
    const requestId = job.data?.requestId;
    if (!requestId) return;

    this.logger.log(`Processing video request job ${requestId}`);
    await this.videoRequestService.markProcessing(requestId);

    try {
      const request = await this.videoRequestService.getEntityById(requestId);
      const output = await this.scriptToVideoService.runRequestPipeline(request);
      await this.videoRequestService.markCompleted(requestId, output.resultUrl, output.debugMetaUrl);
      this.logger.log(`Video request job completed ${requestId}`);
    } catch (err: any) {
      const message = err?.message || 'Video pipeline failed';
      this.logger.error(`Video request job failed ${requestId}: ${message}`);
      await this.videoRequestService.markFailed(requestId, message);
    }
  }
}

