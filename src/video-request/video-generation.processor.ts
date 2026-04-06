import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { VideoRequestService } from './video-request.service';
import { VIDEO_GENERATION_JOB, VIDEO_GENERATION_QUEUE } from './video-request.queue';
import { ScriptToVideoService, VideoPipelineCancelledError } from '../video/script-to-video.service';

@Processor(VIDEO_GENERATION_QUEUE)
export class VideoGenerationProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoGenerationProcessor.name);

  constructor(
    private readonly videoRequestService: VideoRequestService,
    private readonly scriptToVideoService: ScriptToVideoService,
  ) {
    super();
  }

  async process(job: Job<{ requestId: string; resume?: boolean }>) {
    if (job.name !== VIDEO_GENERATION_JOB) return;
    const requestId = job.data?.requestId;
    if (!requestId) return;

    const resume = job.data?.resume === true;
    this.logger.log(`Processing video request job ${requestId}${resume ? ' (resume)' : ''}`);
    const before = await this.videoRequestService.getEntityById(requestId);
    if (before.status === 'cancelled') {
      this.logger.warn(`Skip cancelled request ${requestId}`);
      return;
    }
    await this.videoRequestService.markProcessing(requestId);

    try {
      const request = await this.videoRequestService.getEntityById(requestId);
      if (request.status === 'cancelled') {
        this.logger.warn(`Abort cancelled request ${requestId}`);
        return;
      }
      const output = await this.scriptToVideoService.runRequestPipeline(request, {
        resume,
        abortCheck: async () => {
          const e = await this.videoRequestService.getEntityById(requestId);
          return e.status === 'cancelled';
        },
      });
      const latest = await this.videoRequestService.getEntityById(requestId);
      if (latest.status === 'cancelled') {
        this.logger.warn(`Request ${requestId} was cancelled before completion mark`);
        return;
      }
      await this.videoRequestService.markCompleted(requestId, output.resultUrl, output.debugMetaUrl);
      await this.videoRequestService.finalizeYoutubeAfterRender(requestId, output.resultUrl);
      this.logger.log(`Video request job completed ${requestId}`);
    } catch (err: any) {
      if (err instanceof VideoPipelineCancelledError) {
        this.logger.warn(`Video pipeline aborted (stop/cancel) ${requestId}`);
        return;
      }
      const message = err?.message || 'Video pipeline failed';
      this.logger.error(`Video request job failed ${requestId}: ${message}`);
      const latest = await this.videoRequestService.getEntityById(requestId);
      if (latest.status === 'cancelled') {
        this.logger.warn(`Request ${requestId} cancelled during processing`);
        return;
      }
      await this.videoRequestService.markFailed(requestId, message);
    }
  }
}

