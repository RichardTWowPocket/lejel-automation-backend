import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Queue } from 'bullmq';
import * as fs from 'fs';
import * as path from 'path';
import { VideoRequest, VideoRequestStatus } from '../entities/video-request.entity';
import { LlmService, SupportedLlmModel } from '../llm/llm.service';
import { YouTubeService } from '../oauth/youtube.service';
import { CreateVideoRequestDto } from './dto/create-video-request.dto';
import { UpdateVideoRequestDto } from './dto/update-video-request.dto';
import { VIDEO_GENERATION_JOB, VIDEO_GENERATION_QUEUE } from './video-request.queue';
import { RequestFsService } from '../video/request-fs.service';

@Injectable()
export class VideoRequestService {
  constructor(
    @InjectRepository(VideoRequest)
    private readonly videoRequestRepository: Repository<VideoRequest>,
    private readonly configService: ConfigService,
    private readonly llmService: LlmService,
    private readonly youTubeService: YouTubeService,
    private readonly requestFsService: RequestFsService,
    @InjectQueue(VIDEO_GENERATION_QUEUE)
    private readonly videoGenerationQueue: Queue,
  ) {}

  private listFilesSafe(dirPath: string): string[] {
    try {
      if (!fs.existsSync(dirPath)) return [];
      return fs
        .readdirSync(dirPath)
        .filter((name) => fs.statSync(path.join(dirPath, name)).isFile())
        .sort();
    } catch {
      return [];
    }
  }

  private readJsonSafe<T = unknown>(filePath: string): T | null {
    try {
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
    } catch {
      return null;
    }
  }

  private toResponse(vr: VideoRequest) {
    return {
      id: vr.id,
      fullScript: vr.fullScript,
      segmentedScripts: vr.segmentedScripts,
      llmModel: vr.llmModel || undefined,
      status: vr.status,
      createdAt: vr.createdAt,
      updatedAt: vr.updatedAt,
      submittedAt: vr.submittedAt,
      completedAt: vr.completedAt,
      resultUrl: vr.resultUrl,
      errorMessage: vr.errorMessage,
      connectionId: vr.connectionId || undefined,
      youtubeUploadMode: vr.youtubeUploadMode,
      contentType: vr.contentType || undefined,
      profileId: vr.profileId || undefined,
      imageModel: vr.imageModel || undefined,
      videoModel: vr.videoModel || undefined,
      topHeadlineText: vr.topHeadlineText || undefined,
      bottomHeadlineText: vr.bottomHeadlineText || undefined,
      finalUrl: vr.finalUrl || undefined,
      debugMetaUrl: vr.debugMetaUrl || undefined,
      youtubeUrl: vr.youtubeUrl || undefined,
      youtubeVideoId: vr.youtubeVideoId || undefined,
      youtubeApprovalRejectedAt: vr.youtubeApprovalRejectedAt || undefined,
      user: vr.user ? { id: vr.user.id, name: vr.user.name, email: vr.user.email } : undefined,
      createdBy: vr.user ? { id: vr.user.id, name: vr.user.name, email: vr.user.email } : undefined,
    };
  }

  async create(userId: string, dto: CreateVideoRequestDto): Promise<VideoRequest> {
    const model = (dto.model || 'gpt-5-4') as SupportedLlmModel;
    const segmentedScripts =
      dto.segmentedScripts && dto.segmentedScripts.length > 0
        ? dto.segmentedScripts
        : await this.llmService.segmentScript(dto.fullScript, model);

    if (!segmentedScripts || segmentedScripts.length === 0) {
      throw new BadRequestException('Failed to generate script segments');
    }

    const youtubeUploadMode = dto.youtubeUploadMode || 'none';
    if (youtubeUploadMode !== 'none' && !dto.connectionId) {
      throw new BadRequestException(
        'connectionId is required when youtubeUploadMode is pending_approval or direct',
      );
    }

    const request = this.videoRequestRepository.create({
      userId,
      fullScript: dto.fullScript,
      segmentedScripts,
      llmModel: model,
      contentType: dto.contentType || null,
      profileId: dto.profileId || null,
      imageModel: dto.imageModel || null,
      videoModel: dto.videoModel || null,
      topHeadlineText: dto.topHeadlineText?.trim() ? dto.topHeadlineText.trim() : null,
      bottomHeadlineText: dto.bottomHeadlineText?.trim() ? dto.bottomHeadlineText.trim() : null,
      status: 'pending',
      submittedAt: new Date(),
      youtubeUploadMode,
      connectionId: dto.connectionId || null,
      youtubeTitle: dto.youtubeTitle || null,
      youtubeDescription: dto.youtubeDescription || null,
      youtubeTags: dto.youtubeTags || null,
      youtubePrivacyStatus: dto.youtubePrivacyStatus || 'private',
    });
    const saved = await this.videoRequestRepository.save(request);
    await this.enqueueGenerationJob(saved.id);
    return saved;
  }

  /** Queue video pipeline; optional automationRunId for run log updates in the processor. */
  async enqueueGenerationJob(
    requestId: string,
    options?: { resume?: boolean; automationRunId?: string },
  ): Promise<void> {
    await this.videoGenerationQueue.add(
      VIDEO_GENERATION_JOB,
      {
        requestId,
        resume: options?.resume === true,
        automationRunId: options?.automationRunId,
      },
      {
        attempts: 2,
        removeOnComplete: 1000,
        removeOnFail: 1000,
      },
    );
  }

  /**
   * Re-queue a failed request. Pipeline runs with resume=true: reuse existing MP3 + transcript when present,
   * skip segment-N.mp4 files that already exist, regenerate the rest.
   */
  async retryFailed(id: string, userId: string, options?: { isAdmin?: boolean }) {
    const request = await this.videoRequestRepository.findOne({
      where: { id },
      relations: ['user'],
    });
    if (!request) {
      throw new NotFoundException('Video request not found');
    }
    const isAdmin = options?.isAdmin === true;
    if (!isAdmin && request.userId !== userId) {
      throw new ForbiddenException('Not allowed to access this request');
    }
    if (request.status !== 'failed') {
      throw new BadRequestException('Only failed requests can be retried');
    }

    await this.videoRequestRepository.update(id, {
      status: 'pending',
      errorMessage: null,
      completedAt: null,
    });

    await this.enqueueGenerationJob(id, { resume: true });

    const updated = await this.getEntityById(id);
    return this.toResponse(updated);
  }

  async getEntityById(id: string): Promise<VideoRequest> {
    const request = await this.videoRequestRepository.findOne({ where: { id } });
    if (!request) throw new NotFoundException('Video request not found');
    return request;
  }

  async markProcessing(id: string): Promise<void> {
    await this.videoRequestRepository.update(id, {
      status: 'processing',
      errorMessage: null,
    });
  }

  async markCompleted(id: string, finalUrl?: string, debugMetaUrl?: string): Promise<void> {
    await this.videoRequestRepository.update(id, {
      status: 'completed',
      completedAt: new Date(),
      resultUrl: finalUrl || null,
      finalUrl: finalUrl || null,
      debugMetaUrl: debugMetaUrl || null,
      errorMessage: null,
    });
  }

  /**
   * After a render finishes with resultUrl: pending_approval → status update; direct → upload to YouTube.
   * Idempotent if youtubeVideoId already set. Used by the Bull worker and external callback.
   */
  async finalizeYoutubeAfterRender(requestId: string, resultUrl: string): Promise<void> {
    if (!resultUrl?.trim()) return;
    const request = await this.videoRequestRepository.findOne({ where: { id: requestId } });
    if (!request?.connectionId) return;
    if (request.youtubeVideoId) return;

    if (request.youtubeUploadMode === 'pending_approval') {
      await this.videoRequestRepository.update(requestId, {
        status: 'pending_youtube_approval',
      });
      return;
    }

    if (request.youtubeUploadMode !== 'direct') return;

    try {
      const videoId = await this.youTubeService.uploadVideoFromUrl(
        resultUrl,
        {
          title:
            request.youtubeTitle ||
            request.fullScript.slice(0, 90) ||
            `Video request ${request.id}`,
          description: request.youtubeDescription || '',
          tags: request.youtubeTags || [],
          privacyStatus: request.youtubePrivacyStatus || 'private',
        },
        './temp',
        request.connectionId,
      );
      await this.videoRequestRepository.update(requestId, {
        youtubeVideoId: videoId,
        youtubeUrl: `https://www.youtube.com/watch?v=${videoId}`,
        youtubeErrorMessage: null,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.videoRequestRepository.update(requestId, {
        youtubeErrorMessage: msg,
      });
    }
  }

  async markFailed(id: string, message: string): Promise<void> {
    await this.videoRequestRepository.update(id, {
      status: 'failed',
      completedAt: new Date(),
      errorMessage: message,
    });
  }

  async markCancelled(id: string, message = 'Cancelled by user'): Promise<void> {
    await this.videoRequestRepository.update(id, {
      status: 'cancelled',
      completedAt: new Date(),
      errorMessage: message,
    });
  }

  async findAllByUser(
    userId: string,
    status?: VideoRequestStatus,
    options?: { isAdmin?: boolean },
  ) {
    const qb = this.videoRequestRepository
      .createQueryBuilder('vr')
      .leftJoinAndSelect('vr.user', 'user')
      .orderBy('vr.createdAt', 'DESC');

    if (!options?.isAdmin) {
      qb.where('vr.userId = :userId', { userId });
    }

    if (status) {
      qb.andWhere('vr.status = :status', { status });
    }

    const list = await qb.getMany();
    return list.map((vr) => this.toResponse(vr));
  }

  async findOne(id: string, userId: string, options?: { isAdmin?: boolean }) {
    const request = await this.videoRequestRepository.findOne({
      where: { id },
      relations: ['user'],
    });
    if (!request) {
      throw new NotFoundException('Video request not found');
    }
    const isAdmin = options?.isAdmin === true;
    if (!isAdmin && request.userId !== userId) {
      throw new ForbiddenException('Not allowed to access this request');
    }
    return this.toResponse(request);
  }

  async findDetail(id: string, userId: string, options?: { isAdmin?: boolean }) {
    const request = await this.videoRequestRepository.findOne({
      where: { id },
      relations: ['user'],
    });
    if (!request) {
      throw new NotFoundException('Video request not found');
    }
    const isAdmin = options?.isAdmin === true;
    if (!isAdmin && request.userId !== userId) {
      throw new ForbiddenException('Not allowed to access this request');
    }

    const baseUrl = this.configService.get<string>('BASE_URL') || 'http://localhost:3000';
    const rootDir = this.requestFsService.getRequestDir(id);
    const audioDir = path.join(rootDir, 'audio');
    const transcriptDir = path.join(rootDir, 'transcript');
    const subtitlesDir = path.join(rootDir, 'subtitles');
    const segmentsDir = path.join(rootDir, 'segments');
    const finalDir = path.join(rootDir, 'final');
    const metaDir = path.join(rootDir, 'meta');

    const audioFiles = this.listFilesSafe(audioDir);
    const transcriptFiles = this.listFilesSafe(transcriptDir);
    const subtitleFiles = this.listFilesSafe(subtitlesDir);
    const segmentFiles = this.listFilesSafe(segmentsDir);
    const finalFiles = this.listFilesSafe(finalDir);
    const metaFiles = this.listFilesSafe(metaDir);

    const segmentTiming = this.readJsonSafe<
      Array<{ index: number; text: string; start: number; end: number; duration: number }>
    >(path.join(metaDir, 'segment-timing.json')) || [];
    const mediaPlan = this.readJsonSafe<
      Array<{
        index: number;
        mediaType: 'image' | 'video';
        prompt?: string;
        promptUsed?: string | null;
        imageModel?: string;
        videoModel?: string;
      }>
    >(path.join(metaDir, 'media-plan.json')) || [];

    const toUrl = (subdir: string, filename: string) =>
      this.requestFsService.toPublicUrl(baseUrl, id, `${subdir}/${filename}`);

    const audioUrls = audioFiles.map((f) => toUrl('audio', f));
    const transcriptUrls = transcriptFiles.map((f) => toUrl('transcript', f));
    const subtitleUrls = subtitleFiles.map((f) => toUrl('subtitles', f));
    const finalUrls = finalFiles.map((f) => toUrl('final', f));
    const metaUrls = metaFiles.map((f) => toUrl('meta', f));
    const segmentVideoUrls = segmentFiles
      .filter((f) => /^segment-\d+\.mp4$/i.test(f))
      .map((f) => toUrl('segments', f));

    const segmentArtifacts = request.segmentedScripts.map((text, idx) => {
      const oneBased = idx + 1;
      const imageCandidates = segmentFiles
        .filter((f) => f.startsWith(`segment${oneBased}-image-`) && /\.(png|jpg|jpeg|webp)$/i.test(f))
        .sort();
      const videoCandidates = segmentFiles
        .filter((f) => f.startsWith(`segment${oneBased}-video-`) && f.endsWith('.mp4'))
        .sort();
      const mergedCandidates = segmentFiles
        .filter((f) => f.startsWith(`segment${oneBased}-merged-`) && f.endsWith('.mp4'))
        .sort();
      const finalSegment = `segment-${oneBased}.mp4`;

      const timing = segmentTiming.find((t) => t.index === idx);
      const plan = mediaPlan.find((m) => m.index === idx);

      return {
        index: idx,
        text,
        timing: timing || null,
        mediaType: plan?.mediaType || null,
        prompt: plan?.promptUsed || plan?.prompt || null,
        imageModel: plan?.imageModel || null,
        videoModel: plan?.videoModel || null,
        imageUrls: imageCandidates.map((f) => toUrl('segments', f)),
        generatedChunkVideoUrls: videoCandidates.map((f) => toUrl('segments', f)),
        mergedVideoUrls: mergedCandidates.map((f) => toUrl('segments', f)),
        finalSegmentUrl: segmentFiles.includes(finalSegment)
          ? toUrl('segments', finalSegment)
          : null,
      };
    });

    const hasAudio = audioFiles.length > 0;
    const hasTranscript = transcriptFiles.length > 0;
    const hasMediaPlan = mediaPlan.length > 0;
    const hasSegments = segmentVideoUrls.length > 0;
    const hasFinal = finalFiles.some((f) => f === 'final-video.mp4');

    const progressStages = [
      { key: 'audio', label: 'Audio generated', done: hasAudio },
      { key: 'transcript', label: 'Transcript generated', done: hasTranscript },
      { key: 'planning', label: 'Media plan generated', done: hasMediaPlan },
      { key: 'segments', label: 'Segment videos generated', done: hasSegments },
      { key: 'final', label: 'Final video generated', done: hasFinal || request.status === 'completed' },
    ];
    const doneCount = progressStages.filter((s) => s.done).length;
    const percent = Math.round((doneCount / progressStages.length) * 100);

    return {
      request: this.toResponse(request),
      progress: {
        status: request.status,
        percent,
        doneCount,
        totalCount: progressStages.length,
        stages: progressStages,
      },
      artifacts: {
        audioUrls,
        transcriptUrls,
        subtitleUrls,
        segmentVideoUrls,
        finalUrls,
        metaUrls,
      },
      segments: segmentArtifacts,
    };
  }

  async update(id: string, userId: string, dto: UpdateVideoRequestDto) {
    const request = await this.videoRequestRepository.findOne({ where: { id } });
    if (!request) {
      throw new NotFoundException('Video request not found');
    }
    if (request.userId !== userId) {
      throw new ForbiddenException('Not allowed to update this request');
    }
    if (request.status !== 'draft') {
      throw new BadRequestException('Only draft requests can be updated');
    }
    if (dto.fullScript !== undefined) request.fullScript = dto.fullScript;
    if (dto.segmentedScripts !== undefined) request.segmentedScripts = dto.segmentedScripts;
    await this.videoRequestRepository.save(request);
    return request;
  }

  async remove(id: string, userId: string, options?: { isAdmin?: boolean }) {
    const request = await this.videoRequestRepository.findOne({ where: { id } });
    if (!request) {
      throw new NotFoundException('Video request not found');
    }
    const isAdmin = options?.isAdmin === true;
    if (!isAdmin && request.userId !== userId) {
      throw new ForbiddenException('Not allowed to delete this request');
    }

    await this.videoRequestRepository.delete({ id });

    const requestDir = this.requestFsService.getRequestDir(id);
    try {
      if (fs.existsSync(requestDir)) {
        fs.rmSync(requestDir, { recursive: true, force: true });
      }
    } catch {
      // Deleting DB row is primary; artifact cleanup is best-effort.
    }

    return { deleted: true, id };
  }

  async stopRequest(id: string, userId: string, options?: { isAdmin?: boolean }) {
    const request = await this.videoRequestRepository.findOne({ where: { id } });
    if (!request) {
      throw new NotFoundException('Video request not found');
    }
    const isAdmin = options?.isAdmin === true;
    if (!isAdmin && request.userId !== userId) {
      throw new ForbiddenException('Not allowed to stop this request');
    }
    if (!['pending', 'processing'].includes(request.status)) {
      throw new BadRequestException('Only pending/processing requests can be stopped');
    }

    await this.markCancelled(id);

    // Best-effort: remove queued jobs for this request so it won't restart.
    try {
      const jobs = await this.videoGenerationQueue.getJobs([
        'waiting',
        'delayed',
        'prioritized',
        'paused',
      ]);
      for (const job of jobs) {
        if (job?.name !== VIDEO_GENERATION_JOB) continue;
        if (job.data?.requestId === id) {
          await job.remove();
        }
      }
    } catch {
      // ignore queue cleanup failure; status is already cancelled
    }

    const updated = await this.getEntityById(id);
    return this.toResponse(updated);
  }

  async handleCallback(
    id: string,
    secret: string,
    status: string,
    resultUrl?: string,
    errorMessage?: string,
  ) {
    const expectedSecret = this.configService.get<string>('CALLBACK_SECRET');
    if (!expectedSecret || secret !== expectedSecret) {
      throw new ForbiddenException('Invalid callback secret');
    }

    const request = await this.videoRequestRepository.findOne({ where: { id } });
    if (!request) {
      throw new NotFoundException('Video request not found');
    }

    const update: Partial<VideoRequest> = { status: status as VideoRequestStatus };
    if (status === 'completed' || status === 'failed') {
      update.completedAt = new Date();
      if (resultUrl) update.resultUrl = resultUrl;
      if (errorMessage) update.errorMessage = errorMessage;
    }

    await this.videoRequestRepository.update(id, update);

    if (status === 'completed' && resultUrl) {
      await this.finalizeYoutubeAfterRender(id, resultUrl);
    }

    return { ok: true };
  }

  async findPendingYoutubeApprovals() {
    const list = await this.videoRequestRepository.find({
      where: { status: 'pending_youtube_approval' },
      relations: ['user'],
      order: { createdAt: 'DESC' },
    });
    return list.map((vr) => this.toResponse(vr));
  }

  async approveYoutubeUpload(id: string, _adminUserId?: string) {
    const request = await this.videoRequestRepository.findOne({
      where: { id },
      relations: ['user'],
    });
    if (!request) {
      throw new NotFoundException('Video request not found');
    }
    if (request.status !== 'pending_youtube_approval') {
      throw new BadRequestException('Request is not waiting for YouTube approval');
    }
    if (!request.resultUrl || !request.connectionId) {
      throw new BadRequestException('Request is missing resultUrl or connectionId');
    }

    const videoId = await this.youTubeService.uploadVideoFromUrl(
      request.resultUrl,
      {
        title:
          request.youtubeTitle ||
          request.fullScript.slice(0, 90) ||
          `Video request ${request.id}`,
        description: request.youtubeDescription || '',
        tags: request.youtubeTags || [],
        privacyStatus: request.youtubePrivacyStatus || 'private',
      },
      './temp',
      request.connectionId,
    );

    request.status = 'completed';
    request.youtubeVideoId = videoId;
    request.youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
    request.youtubeErrorMessage = null;
    await this.videoRequestRepository.save(request);

    return {
      ok: true,
      youtubeVideoId: videoId,
      youtubeUrl: request.youtubeUrl,
    };
  }

  async rejectYoutubeUpload(id: string, adminUserId?: string) {
    const request = await this.videoRequestRepository.findOne({
      where: { id },
      relations: ['user'],
    });
    if (!request) {
      throw new NotFoundException('Video request not found');
    }
    if (request.status !== 'pending_youtube_approval') {
      throw new BadRequestException('Request is not waiting for YouTube approval');
    }

    request.status = 'completed';
    request.youtubeApprovalRejectedAt = new Date();
    request.youtubeApprovalRejectedBy = adminUserId || null;
    await this.videoRequestRepository.save(request);

    return { ok: true };
  }
}
