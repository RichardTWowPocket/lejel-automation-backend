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
import {
  VideoRequest,
  VideoRequestStatus,
  UserSegmentMediaItem,
} from '../entities/video-request.entity';
import {
  LlmService,
  SupportedLlmModel,
  type UserAssetForSegmentAssignment,
} from '../llm/llm.service';
import { YouTubeService } from '../oauth/youtube.service';
import { CreateVideoRequestDto } from './dto/create-video-request.dto';
import { UpdateVideoRequestDto } from './dto/update-video-request.dto';
import { RetryWithChangesDto } from './dto/retry-with-changes.dto';
import { VIDEO_GENERATION_JOB, VIDEO_GENERATION_QUEUE } from './video-request.queue';
import { RequestFsService } from '../video/request-fs.service';
import { R2Service } from '../media/r2.service';
import { UserSegmentMediaItemDto } from './dto/user-segment-media-item.dto';

@Injectable()
export class VideoRequestService {
  constructor(
    @InjectRepository(VideoRequest)
    private readonly videoRequestRepository: Repository<VideoRequest>,
    private readonly configService: ConfigService,
    private readonly llmService: LlmService,
    private readonly youTubeService: YouTubeService,
    private readonly requestFsService: RequestFsService,
    private readonly r2Service: R2Service,
    @InjectQueue(VIDEO_GENERATION_QUEUE)
    private readonly videoGenerationQueue: Queue,
  ) {}

  private async resolveUserSegmentMedia(
    userId: string,
    items: UserSegmentMediaItemDto[] | undefined,
    segmentedScripts: string[],
    model: SupportedLlmModel,
  ): Promise<UserSegmentMediaItem[] | null> {
    if (!items?.length) return null;
    if (!this.r2Service.isEnabled()) {
      throw new BadRequestException(
        'User segment media requires R2 to be configured on the server',
      );
    }

    type Draft = {
      objectKey: string;
      mediaKind: 'image' | 'video';
      assetLabel: string;
      segmentIndex?: number;
    };
    const drafts: Draft[] = [];
    for (const it of items) {
      const key = it.objectKey.trim();
      const label = it.assetLabel.trim();
      if (label.length < 3) {
        throw new BadRequestException(
          'Each user asset must include assetLabel (at least 3 characters) describing the image or clip',
        );
      }
      try {
        this.r2Service.assertKeyOwnedByUser(key, userId);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new BadRequestException(msg);
      }
      drafts.push({
        objectKey: key,
        mediaKind: it.mediaKind,
        assetLabel: label,
        ...(typeof it.segmentIndex === 'number' ? { segmentIndex: it.segmentIndex } : {}),
      });
    }

    const manual: UserSegmentMediaItem[] = [];
    const taken = new Set<number>();
    const autoInputs: UserAssetForSegmentAssignment[] = [];

    for (const d of drafts) {
      if (typeof d.segmentIndex === 'number') {
        const idx = d.segmentIndex;
        if (idx < 0 || idx >= segmentedScripts.length) {
          throw new BadRequestException(
            `userSegmentMedia.segmentIndex ${idx} is out of range (0..${segmentedScripts.length - 1})`,
          );
        }
        if (taken.has(idx)) {
          throw new BadRequestException(`Duplicate userSegmentMedia for segmentIndex ${idx}`);
        }
        taken.add(idx);
        manual.push({
          segmentIndex: idx,
          objectKey: d.objectKey,
          mediaKind: d.mediaKind,
          assetLabel: d.assetLabel,
        });
      } else {
        autoInputs.push({
          objectKey: d.objectKey,
          mediaKind: d.mediaKind,
          assetLabel: d.assetLabel,
        });
      }
    }

    const allowedForAuto = segmentedScripts.map((_, i) => i).filter((i) => !taken.has(i));
    let autoResolved: Array<{
      objectKey: string;
      segmentIndex: number;
      mediaKind: 'image' | 'video';
    }> = [];
    if (autoInputs.length > 0) {
      try {
        autoResolved = await this.llmService.assignUserMediaToScriptSegments(
          segmentedScripts,
          autoInputs,
          model,
          allowedForAuto,
        );
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new BadRequestException(`Could not auto-place user media: ${msg}`);
      }
    }

    const merged: UserSegmentMediaItem[] = [...manual];
    for (const a of autoResolved) {
      if (taken.has(a.segmentIndex)) {
        throw new BadRequestException('Auto-assigned segment conflicts with a manual assignment');
      }
      taken.add(a.segmentIndex);
      const src = autoInputs.find((x) => x.objectKey === a.objectKey);
      merged.push({
        segmentIndex: a.segmentIndex,
        objectKey: a.objectKey,
        mediaKind: a.mediaKind,
        assetLabel: src?.assetLabel,
      });
    }
    return merged.length ? merged : null;
  }

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

  private async toResponse(vr: VideoRequest) {
    const effectiveBackend =
      vr.storageBackend === 'r2'
        ? 'r2'
        : (await this.r2Service.hasRequestArtifacts(vr.id))
          ? ('r2' as const)
          : ('local' as const);

    const resolveResultUrl = async (): Promise<string | undefined> => {
      if (!vr.resultUrl) return undefined;
      if (effectiveBackend === 'r2') {
        const r2Path = vr.resultUrl.startsWith('http')
          ? vr.resultUrl.replace(new RegExp(`.*/requests/${vr.id}/`), '')
          : vr.resultUrl;
        try {
          return await this.r2Service.presignGetRequestUrl(vr.id, r2Path);
        } catch {
          return this.requestFsService.toPublicUrl(
            this.configService.get<string>('BASE_URL') || 'http://localhost:3000',
            vr.id,
            r2Path,
          );
        }
      }
      return vr.resultUrl;
    };
    const resolveFinalUrl = async (): Promise<string | undefined> => {
      if (!vr.finalUrl) return undefined;
      if (effectiveBackend === 'r2') {
        const r2Path = vr.finalUrl.startsWith('http')
          ? vr.finalUrl.replace(new RegExp(`.*/requests/${vr.id}/`), '')
          : vr.finalUrl;
        try {
          return await this.r2Service.presignGetRequestUrl(vr.id, r2Path);
        } catch {
          return this.requestFsService.toPublicUrl(
            this.configService.get<string>('BASE_URL') || 'http://localhost:3000',
            vr.id,
            r2Path,
          );
        }
      }
      return vr.finalUrl;
    };
    const resolveMetaUrl = async (): Promise<string | undefined> => {
      if (!vr.debugMetaUrl) return undefined;
      if (effectiveBackend === 'r2') {
        const r2Path = vr.debugMetaUrl.startsWith('http')
          ? vr.debugMetaUrl.replace(new RegExp(`.*/requests/${vr.id}/`), '')
          : vr.debugMetaUrl;
        try {
          return await this.r2Service.presignGetRequestUrl(vr.id, r2Path);
        } catch {
          return this.requestFsService.toPublicUrl(
            this.configService.get<string>('BASE_URL') || 'http://localhost:3000',
            vr.id,
            r2Path,
          );
        }
      }
      return vr.debugMetaUrl;
    };

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
      resultUrl: await resolveResultUrl(),
      errorMessage: vr.errorMessage,
      connectionId: vr.connectionId || undefined,
      youtubeUploadMode: vr.youtubeUploadMode,
      contentType: vr.contentType || undefined,
      profileId: vr.profileId || undefined,
      imageModel: vr.imageModel || undefined,
      videoModel: vr.videoModel || undefined,
      userSegmentMedia: vr.userSegmentMedia?.length ? vr.userSegmentMedia : undefined,
      topHeadlineText: vr.topHeadlineText || undefined,
      bottomHeadlineText: vr.bottomHeadlineText || undefined,
      finalUrl: await resolveFinalUrl(),
      debugMetaUrl: await resolveMetaUrl(),
      youtubeUrl: vr.youtubeUrl || undefined,
      youtubeVideoId: vr.youtubeVideoId || undefined,
      youtubeApprovalRejectedAt: vr.youtubeApprovalRejectedAt || undefined,
      storageBackend: vr.storageBackend,
      user: vr.user ? { id: vr.user.id, name: vr.user.name, email: vr.user.email } : undefined,
      createdBy: vr.user ? { id: vr.user.id, name: vr.user.name, email: vr.user.email } : undefined,
    };
  }

  async create(
    userId: string,
    dto: CreateVideoRequestDto,
    queueOpts?: { automationRunId?: string },
  ): Promise<VideoRequest> {
    const model = (dto.model || 'gpt-5-4') as SupportedLlmModel;
    const segmentedScripts =
      dto.segmentedScripts && dto.segmentedScripts.length > 0
        ? dto.segmentedScripts
        : await this.llmService.segmentScript(dto.fullScript, model);

    if (!segmentedScripts || segmentedScripts.length === 0) {
      throw new BadRequestException('Failed to generate script segments');
    }

    const userSegmentMedia = await this.resolveUserSegmentMedia(
      userId,
      dto.userSegmentMedia,
      segmentedScripts,
      model,
    );

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
      userSegmentMedia,
    });
    const saved = await this.videoRequestRepository.save(request);
    await this.enqueueGenerationJob(saved.id, {
      automationRunId: queueOpts?.automationRunId,
    });
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

  /**
   * Retry a failed request with updated parameters (e.g. switch model).
   * Updates the request fields, clears error state, and re-queues with resume=true.
   */
  async retryWithChanges(
    id: string,
    userId: string,
    dto: RetryWithChangesDto,
    options?: { isAdmin?: boolean },
  ) {
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

    const update: Partial<VideoRequest> = {
      status: 'pending',
      errorMessage: null,
      completedAt: null,
    };
    if (dto.llmModel !== undefined) update.llmModel = dto.llmModel;
    if (dto.imageModel !== undefined) update.imageModel = dto.imageModel;
    if (dto.videoModel !== undefined) update.videoModel = dto.videoModel;
    if (dto.contentType !== undefined) update.contentType = dto.contentType;

    await this.videoRequestRepository.update(id, update);
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
    const isR2 = finalUrl?.startsWith('r2:');
    await this.videoRequestRepository.update(id, {
      status: 'completed',
      completedAt: new Date(),
      resultUrl: isR2 ? finalUrl!.replace(/^r2:/, '') : finalUrl || null,
      finalUrl: isR2 ? finalUrl!.replace(/^r2:/, '') : finalUrl || null,
      debugMetaUrl: isR2 ? debugMetaUrl?.replace(/^r2:/, '') : debugMetaUrl || null,
      storageBackend: isR2 ? 'r2' : 'local',
      errorMessage: null,
    });
  }

  /**
   * After a render finishes with resultUrl: pending_approval → status update; direct → upload to YouTube.
   * Idempotent if youtubeVideoId already set. Used by the Bull worker and external callback.
   */
  private async resolveStorageUrl(
    requestId: string,
    stored: string | null | undefined,
    backend: 'local' | 'r2',
  ): Promise<string> {
    if (!stored) return '';
    const clean = stored.startsWith('r2:') ? stored.replace(/^r2:/, '') : stored;
    if (backend === 'r2') {
      return this.r2Service.presignGetRequestUrl(requestId, clean);
    }
    return clean;
  }

  async finalizeYoutubeAfterRender(requestId: string, resultUrl: string): Promise<void> {
    if (!resultUrl?.trim()) return;
    const request = await this.videoRequestRepository.findOne({ where: { id: requestId } });
    if (!request?.connectionId) return;
    if (request.youtubeVideoId) return;

    const downloadableUrl = await this.resolveStorageUrl(
      requestId,
      resultUrl,
      request.storageBackend,
    );
    if (!downloadableUrl) return;

    if (request.youtubeUploadMode === 'pending_approval') {
      await this.videoRequestRepository.update(requestId, {
        status: 'pending_youtube_approval',
      });
      return;
    }

    if (request.youtubeUploadMode !== 'direct') return;

    try {
      const videoId = await this.youTubeService.uploadVideoFromUrl(
        downloadableUrl,
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
    return Promise.all(list.map((vr) => this.toResponse(vr)));
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

    const useR2 = await this.r2Service.hasRequestArtifacts(id);

    let audioFiles: string[];
    let transcriptFiles: string[];
    let subtitleFiles: string[];
    let segmentFiles: string[];
    let finalFiles: string[];
    let metaFiles: string[];

    if (useR2) {
      audioFiles = await this.r2Service.listRequestFiles(id, 'audio');
      transcriptFiles = await this.r2Service.listRequestFiles(id, 'transcript');
      subtitleFiles = await this.r2Service.listRequestFiles(id, 'subtitles');
      segmentFiles = await this.r2Service.listRequestFiles(id, 'segments');
      finalFiles = await this.r2Service.listRequestFiles(id, 'final');
      metaFiles = await this.r2Service.listRequestFiles(id, 'meta');
    } else {
      const audioDir = path.join(rootDir, 'audio');
      const transcriptDir = path.join(rootDir, 'transcript');
      const subtitlesDir = path.join(rootDir, 'subtitles');
      const segmentsDir = path.join(rootDir, 'segments');
      const finalDir = path.join(rootDir, 'final');
      const metaDir = path.join(rootDir, 'meta');

      audioFiles = this.listFilesSafe(audioDir);
      transcriptFiles = this.listFilesSafe(transcriptDir);
      subtitleFiles = this.listFilesSafe(subtitlesDir);
      segmentFiles = this.listFilesSafe(segmentsDir);
      finalFiles = this.listFilesSafe(finalDir);
      metaFiles = this.listFilesSafe(metaDir);
    }

    const metaJsonDir = useR2 ? '' : path.join(rootDir, 'meta');

    const segmentTiming = useR2
      ? (await this.r2Service.readRequestJson<
          Array<{ index: number; text: string; start: number; end: number; duration: number }>
        >(id, 'meta/segment-timing.json')) || []
      : this.readJsonSafe<
          Array<{ index: number; text: string; start: number; end: number; duration: number }>
        >(path.join(metaJsonDir, 'segment-timing.json')) || [];

    const mediaPlan = useR2
      ? (await this.r2Service.readRequestJson<
          Array<{
            index: number;
            mediaType: 'image' | 'video';
            prompt?: string;
            promptUsed?: string | null;
            imageModel?: string;
            videoModel?: string;
          }>
        >(id, 'meta/media-plan.json')) || []
      : this.readJsonSafe<
          Array<{
            index: number;
            mediaType: 'image' | 'video';
            prompt?: string;
            promptUsed?: string | null;
            imageModel?: string;
            videoModel?: string;
          }>
        >(path.join(metaJsonDir, 'media-plan.json')) || [];

    const resolveUrls = async (subdir: string, files: string[]): Promise<string[]> => {
      if (useR2) {
        return Promise.all(
          files.map((f) => this.r2Service.presignGetRequestUrl(id, `${subdir}/${f}`)),
        );
      }
      return files.map((f) => this.requestFsService.toPublicUrl(baseUrl, id, `${subdir}/${f}`));
    };

    const audioUrls = await resolveUrls('audio', audioFiles);
    const transcriptUrls = await resolveUrls('transcript', transcriptFiles);
    const subtitleUrls = await resolveUrls('subtitles', subtitleFiles);
    const finalUrls = await resolveUrls('final', finalFiles);
    const metaUrls = await resolveUrls('meta', metaFiles);
    const segmentVideoUrls = await resolveUrls(
      'segments',
      segmentFiles.filter((f) => /^segment-\d+\.mp4$/i.test(f)),
    );

    const segmentArtifacts = await Promise.all(
      request.segmentedScripts.map(async (text, idx) => {
        const oneBased = idx + 1;
        const imageCandidates = segmentFiles
          .filter(
            (f) => f.startsWith(`segment${oneBased}-image-`) && /\.(png|jpg|jpeg|webp)$/i.test(f),
          )
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

        const imageUrls = useR2
          ? await Promise.all(
              imageCandidates.map((f) => this.r2Service.presignGetRequestUrl(id, `segments/${f}`)),
            )
          : imageCandidates.map((f) =>
              this.requestFsService.toPublicUrl(baseUrl, id, `segments/${f}`),
            );
        const generatedChunkVideoUrls = useR2
          ? await Promise.all(
              videoCandidates.map((f) => this.r2Service.presignGetRequestUrl(id, `segments/${f}`)),
            )
          : videoCandidates.map((f) =>
              this.requestFsService.toPublicUrl(baseUrl, id, `segments/${f}`),
            );
        const mergedVideoUrls = useR2
          ? await Promise.all(
              mergedCandidates.map((f) => this.r2Service.presignGetRequestUrl(id, `segments/${f}`)),
            )
          : mergedCandidates.map((f) =>
              this.requestFsService.toPublicUrl(baseUrl, id, `segments/${f}`),
            );
        const finalSegmentUrlObj = segmentFiles.includes(finalSegment)
          ? useR2
            ? await this.r2Service.presignGetRequestUrl(id, `segments/${finalSegment}`)
            : this.requestFsService.toPublicUrl(baseUrl, id, `segments/${finalSegment}`)
          : null;

        return {
          index: idx,
          text,
          timing: timing || null,
          mediaType: plan?.mediaType || null,
          prompt: plan?.promptUsed || plan?.prompt || null,
          imageModel: plan?.imageModel || null,
          videoModel: plan?.videoModel || null,
          imageUrls,
          generatedChunkVideoUrls,
          mergedVideoUrls,
          finalSegmentUrl: finalSegmentUrlObj,
        };
      }),
    );

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
      {
        key: 'final',
        label: 'Final video generated',
        done: hasFinal || request.status === 'completed',
      },
    ];
    const doneCount = progressStages.filter((s) => s.done).length;
    const percent = Math.round((doneCount / progressStages.length) * 100);

    return {
      request: await this.toResponse(request),
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

    if (this.r2Service.isEnabled()) {
      try {
        await this.r2Service.deleteRequestDir(id);
      } catch {
        /* R2 cleanup best-effort */
      }
    }

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
    return Promise.all(list.map((vr) => this.toResponse(vr)));
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

    const downloadableUrl = await this.resolveStorageUrl(
      id,
      request.resultUrl,
      request.storageBackend,
    );

    const videoId = await this.youTubeService.uploadVideoFromUrl(
      downloadableUrl,
      {
        title:
          request.youtubeTitle || request.fullScript.slice(0, 90) || `Video request ${request.id}`,
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
