import { Injectable, Logger } from '@nestjs/common';

export enum JobStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export interface Job {
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
  private jobs: Map<string, Job> = new Map();
  private readonly MAX_JOBS = 1000; // Prevent memory leaks
  private readonly CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour

  constructor() {
    // Cleanup old completed/failed jobs periodically
    setInterval(() => this.cleanupOldJobs(), this.CLEANUP_INTERVAL);
  }

  /**
   * Create a new job and return its ID
   */
  createJob(): string {
    const jobId = `job_${Date.now()}_${Math.round(Math.random() * 1e9)}`;
    const job: Job = {
      id: jobId,
      status: JobStatus.PENDING,
      createdAt: new Date(),
    };

    this.jobs.set(jobId, job);
    this.logger.log(`Created job: ${jobId}`);

    // Cleanup if we have too many jobs
    if (this.jobs.size > this.MAX_JOBS) {
      this.cleanupOldJobs();
    }

    return jobId;
  }

  /**
   * Get job by ID
   */
  getJob(jobId: string): Job | undefined {
    return this.jobs.get(jobId);
  }

  /**
   * Update job status
   */
  updateJobStatus(jobId: string, status: JobStatus): void {
    const job = this.jobs.get(jobId);
    if (!job) {
      this.logger.warn(`Job not found: ${jobId}`);
      return;
    }

    job.status = status;
    
    if (status === JobStatus.PROCESSING && !job.startedAt) {
      job.startedAt = new Date();
    }
    
    if (status === JobStatus.COMPLETED || status === JobStatus.FAILED) {
      job.completedAt = new Date();
    }

    this.logger.log(`Job ${jobId} status updated to: ${status}`);
  }

  /**
   * Update job progress
   */
  updateJobProgress(jobId: string, current: number, total: number, message?: string): void {
    const job = this.jobs.get(jobId);
    if (!job) {
      this.logger.warn(`Job not found: ${jobId}`);
      return;
    }

    job.progress = { current, total, message };
    this.logger.debug(`Job ${jobId} progress: ${current}/${total} - ${message || ''}`);
  }

  /**
   * Set job result (success)
   */
  setJobResult(jobId: string, url?: string, filePath?: string): void {
    const job = this.jobs.get(jobId);
    if (!job) {
      this.logger.warn(`Job not found: ${jobId}`);
      return;
    }

    job.result = { url, filePath };
    job.status = JobStatus.COMPLETED;
    job.completedAt = new Date();

    this.logger.log(`Job ${jobId} completed with result: ${url || filePath}`);
  }

  /**
   * Set job error
   */
  setJobError(jobId: string, error: string): void {
    const job = this.jobs.get(jobId);
    if (!job) {
      this.logger.warn(`Job not found: ${jobId}`);
      return;
    }

    job.result = { error };
    job.status = JobStatus.FAILED;
    job.completedAt = new Date();

    this.logger.error(`Job ${jobId} failed: ${error}`);
  }

  /**
   * Cleanup old completed/failed jobs (older than 24 hours)
   */
  private cleanupOldJobs(): void {
    const now = new Date();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours

    let cleaned = 0;
    for (const [jobId, job] of this.jobs.entries()) {
      if (
        (job.status === JobStatus.COMPLETED || job.status === JobStatus.FAILED) &&
        job.completedAt &&
        now.getTime() - job.completedAt.getTime() > maxAge
      ) {
        this.jobs.delete(jobId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.logger.log(`Cleaned up ${cleaned} old jobs`);
    }
  }

  /**
   * Get all jobs (for debugging)
   */
  getAllJobs(): Job[] {
    return Array.from(this.jobs.values());
  }
}




