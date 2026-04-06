import { forwardRef, Inject, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { VideoRequestService } from './video-request.service';
import { VIDEO_GENERATION_JOB, VIDEO_GENERATION_QUEUE } from './video-request.queue';
import { ScriptToVideoService, VideoPipelineCancelledError } from '../video/script-to-video.service';
import { AutomationService } from '../automation/automation.service';

@Processor(VIDEO_GENERATION_QUEUE)
export class VideoGenerationProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoGenerationProcessor.name);

  constructor(
    private readonly videoRequestService: VideoRequestService,
    @Inject(forwardRef(() => AutomationService))
    private readonly automationService: AutomationService,
    private readonly scriptToVideoService: ScriptToVideoService,
  ) {
    super();
  }

  async process(
    job: Job<{ requestId: string; resume?: boolean; automationRunId?: string }>,
  ) {
    if (job.name !== VIDEO_GENERATION_JOB) return;
    const requestId = job.data?.requestId;
    if (!requestId) return;

    const resume = job.data?.resume === true;
    const automationRunId = job.data?.automationRunId;
    this.logger.log(`Processing video request job ${requestId}${resume ? ' (resume)' : ''}`);
    const before = await this.videoRequestService.getEntityById(requestId);
    if (before.status === 'cancelled') {
      this.logger.warn(`Skip cancelled request ${requestId}`);
      await this.automationService.onRunFailed(automationRunId, 'Cancelled');
      return;
    }
    await this.videoRequestService.markProcessing(requestId);
    await this.automationService.onRunProcessing(automationRunId);

    try {
      const request = await this.videoRequestService.getEntityById(requestId);
      if (request.status === 'cancelled') {
        this.logger.warn(`Abort cancelled request ${requestId}`);
        await this.automationService.onRunFailed(automationRunId, 'Cancelled');
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
        await this.automationService.onRunFailed(automationRunId, 'Cancelled');
        return;
      }
      await this.videoRequestService.markCompleted(requestId, output.resultUrl, output.debugMetaUrl);
      const afterComplete = await this.videoRequestService.getEntityById(requestId);
      if (
        automationRunId &&
        afterComplete.youtubeUploadMode === 'direct' &&
        afterComplete.connectionId
      ) {
        await this.automationService.onRunUploading(automationRunId);
      }
      await this.videoRequestService.finalizeYoutubeAfterRender(requestId, output.resultUrl);
      await this.automationService.onRunFinishedSuccess(automationRunId, requestId);
      this.logger.log(`Video request job completed ${requestId}`);
    } catch (err: any) {
      if (err instanceof VideoPipelineCancelledError) {
        this.logger.warn(`Video pipeline aborted (stop/cancel) ${requestId}`);
        await this.automationService.onRunFailed(automationRunId, 'Cancelled');
        return;
      }
      const message = err?.message || 'Video pipeline failed';
      this.logger.error(`Video request job failed ${requestId}: ${message}`);
      const latest = await this.videoRequestService.getEntityById(requestId);
      if (latest.status === 'cancelled') {
        this.logger.warn(`Request ${requestId} cancelled during processing`);
        await this.automationService.onRunFailed(automationRunId, 'Cancelled');
        return;
      }
      await this.videoRequestService.markFailed(requestId, message);
      await this.automationService.onRunFailed(automationRunId, message);
    }
  }
}

