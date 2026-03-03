import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { VideoProcessingService } from './video-processing.service';
import { JobQueueService, JobStatus } from './job-queue.service';

const MEDIA_DIR = path.join(process.cwd(), 'public', 'media');

@Processor('video-rendering', {
  concurrency: 2,
})
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    private readonly videoProcessingService: VideoProcessingService,
    private readonly jobQueueService: JobQueueService,
    private readonly config: ConfigService,
  ) {
    super();
  }

  async process(job: Job<any, any, string>): Promise<any> {
    const { id, data } = job;
    const { type, payload, requestId } = data;

    this.logger.log(`Processing job ${id} (Type: ${type})`);
    this.jobQueueService.updateJobStatus(id, JobStatus.PROCESSING);

    try {
      let resultPath: string;

      if (type === 'combine-media') {
        resultPath = await this.videoProcessingService.combineMedia(
          payload.audioPath,
          payload.sections,
          payload.outputFormat,
          payload.width,
          payload.height,
          payload.useSubtitle,
          payload.useSocialMediaSubtitle,
          requestId,
        );
      } else if (type === 'combine-medias') {
        resultPath = await this.videoProcessingService.combineMediasWithTranscripts(
          payload.audioPath,
          payload.sections,
          payload.outputFormat,
          requestId,
          payload.profileConfig,
          payload.topHeadlineText,
          payload.bottomHeadlineText,
          payload.bottomHeadlineAppear,
        );
      } else {
        throw new Error(`Unknown job type: ${type}`);
      }

      this.logger.log(`Job ${id} completed. Result: ${resultPath}`);
      return { filePath: resultPath };
    } catch (error) {
      this.logger.error(`Job ${id} failed: ${error.message}`, error.stack);
      throw error;
    }
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job) {
    const { id, returnvalue } = job;
    const filePath = returnvalue?.filePath;
    if (!filePath) {
      this.jobQueueService.setJobResult(id, undefined, undefined);
      return;
    }
    if (!fs.existsSync(filePath)) {
      this.jobQueueService.setJobResult(id, undefined, filePath);
      return;
    }
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    const fileName = `combined-${id}-${Date.now()}.mp4`;
    const destPath = path.join(MEDIA_DIR, fileName);
    try {
      fs.copyFileSync(filePath, destPath);
      try {
        fs.unlinkSync(filePath);
      } catch (_) {}
      const baseUrl = this.config.get<string>('BASE_URL', 'http://localhost:3000');
      const publicUrl = `${baseUrl.replace(/\/$/, '')}/media/${fileName}`;
      this.jobQueueService.setJobResult(id, publicUrl, destPath);
    } catch (err) {
      this.logger.warn(`Could not copy result to public/media: ${err}`);
      this.jobQueueService.setJobResult(id, undefined, filePath);
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error) {
    this.jobQueueService.setJobError(job.id, error.message);
  }
}
