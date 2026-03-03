import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

export enum JobStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export interface JobData {
  id: string;
  status: JobStatus;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  result?: {
    url?: string;
    filePath?: string;
    error?: string;
  };
  progress?: {
    current: number;
    total: number;
    message?: string;
  };
}

@Injectable()
export class JobQueueService {
  private readonly logger = new Logger(JobQueueService.name);
  private jobStates: Map<string, JobData> = new Map();
  private readonly MAX_JOBS = 1000;

  constructor(
    @InjectQueue('video-rendering') private readonly videoQueue: Queue,
  ) {
    setInterval(() => this.cleanupOldJobs(), 3600000);
  }

  /**
   * Add a rendering job to the queue
   */
  async addRenderingJob(type: 'combine-media' | 'combine-medias', payload: any, requestId?: string): Promise<string> {
    const jobId = `job_${Date.now()}_${Math.round(Math.random() * 1e9)}`;
    const jobData: JobData = {
      id: jobId,
      status: JobStatus.PENDING,
      createdAt: new Date(),
    };

    this.jobStates.set(jobId, jobData);

    // Add to BullMQ with the generated jobId as the job identity
    await this.videoQueue.add(
      'render',
      { type, payload, requestId },
      { jobId, removeOnComplete: false, removeOnFail: false },
    );

    this.logger.log(`Added rendering job to queue: ${jobId}`);
    return jobId;
  }

  /**
   * Helper for original createJob (deprecated but kept for compatibility)
   */
  createJob(): string {
    const jobId = `job_${Date.now()}_${Math.round(Math.random() * 1e9)}`;
    this.jobStates.set(jobId, { id: jobId, status: JobStatus.PENDING, createdAt: new Date() });
    return jobId;
  }

  async getJob(jobId: string): Promise<JobData | undefined> {
    // Check in-memory state first
    let state = this.jobStates.get(jobId);

    // Sync with BullMQ if found
    const bullJob = await this.videoQueue.getJob(jobId);
    if (bullJob) {
      if (!state) {
        state = { id: jobId, status: JobStatus.PENDING, createdAt: new Date(bullJob.timestamp) };
        this.jobStates.set(jobId, state);
      }

      const bullStatus = await bullJob.getState();
      if (bullStatus === 'completed') {
        state.status = JobStatus.COMPLETED;
        state.completedAt = state.completedAt || new Date(bullJob.finishedOn || Date.now());
        if (bullJob.returnvalue?.filePath) state.result = { ...state.result, filePath: bullJob.returnvalue.filePath };
      } else if (bullStatus === 'failed') {
        state.status = JobStatus.FAILED;
        state.result = { ...state.result, error: bullJob.failedReason };
      } else if (bullStatus === 'active') {
        state.status = JobStatus.PROCESSING;
        state.startedAt = state.startedAt || new Date(bullJob.processedOn || Date.now());
      }
    }

    return state;
  }

  updateJobStatus(jobId: string, status: JobStatus): void {
    const job = this.jobStates.get(jobId);
    if (job) {
      job.status = status;
      if (status === JobStatus.PROCESSING && !job.startedAt) job.startedAt = new Date();
      if (status === JobStatus.COMPLETED || status === JobStatus.FAILED) job.completedAt = new Date();
    }
  }

  updateJobProgress(jobId: string, current: number, total: number, message?: string): void {
    const job = this.jobStates.get(jobId);
    if (job) job.progress = { current, total, message };
  }

  setJobResult(jobId: string, url?: string, filePath?: string): void {
    const job = this.jobStates.get(jobId);
    if (job) {
      job.result = { url, filePath };
      job.status = JobStatus.COMPLETED;
      job.completedAt = new Date();
    }
  }

  setJobError(jobId: string, error: string): void {
    const job = this.jobStates.get(jobId);
    if (job) {
      job.result = { error };
      job.status = JobStatus.FAILED;
      job.completedAt = new Date();
    }
  }

  private cleanupOldJobs(): void {
    const now = Date.now();
    const maxAge = 86400000;
    for (const [id, job] of this.jobStates.entries()) {
      if (job.completedAt && (now - job.completedAt.getTime() > maxAge)) {
        this.jobStates.delete(id);
      }
    }
  }
  /**
   * Get all job states (for debugging)
   */
  getAllJobs(): JobData[] {
    return Array.from(this.jobStates.values());
  }
}




