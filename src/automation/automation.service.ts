import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
  BadRequestException,
  forwardRef,
  Inject,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { randomBytes, randomUUID } from 'crypto';
import { AutomationChannel } from '../entities/automation-channel.entity';
import { AutomationRun } from '../entities/automation-run.entity';
import { OAuthCredential } from '../entities/oauth-credential.entity';
import { User } from '../entities/user.entity';
import { LlmService, SupportedLlmModel } from '../llm/llm.service';
import { VideoRequestService } from '../video-request/video-request.service';
import { CreateAutomationChannelDto } from './dto/create-automation-channel.dto';
import { UpdateAutomationChannelDto } from './dto/update-automation-channel.dto';
import { AutomationWebhookDto } from './dto/automation-webhook.dto';

@Injectable()
export class AutomationService {
  constructor(
    @InjectRepository(AutomationChannel)
    private readonly channelRepo: Repository<AutomationChannel>,
    @InjectRepository(AutomationRun)
    private readonly runRepo: Repository<AutomationRun>,
    @InjectRepository(OAuthCredential)
    private readonly oauthRepo: Repository<OAuthCredential>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly llmService: LlmService,
    private readonly config: ConfigService,
    @Inject(forwardRef(() => VideoRequestService))
    private readonly videoRequestService: VideoRequestService,
  ) {}

  private webhookUrlFor(slug: string): string {
    const base = this.config.get<string>('BASE_URL') || 'http://localhost:3000';
    return `${base.replace(/\/$/, '')}/api/automation/webhook/${slug}`;
  }

  private toChannelRow(ch: AutomationChannel) {
    return {
      id: ch.id,
      name: ch.name,
      webhookSlug: ch.webhookSlug,
      webhookSecretPrefix: ch.webhookSecretPrefix || undefined,
      webhookUrl: this.webhookUrlFor(ch.webhookSlug),
      connectionId: ch.connectionId,
      ownerUserId: ch.ownerUserId,
      profileId: ch.profileId ?? undefined,
      contentType: ch.contentType ?? undefined,
      imageModel: ch.imageModel ?? undefined,
      videoModel: ch.videoModel ?? undefined,
      llmModel: ch.llmModel ?? undefined,
      scriptSegmentationPrompt: ch.scriptSegmentationPrompt ?? undefined,
      youtubePrivacyStatus: ch.youtubePrivacyStatus,
      youtubeTags: ch.youtubeTags ?? undefined,
      youtubeDescriptionTemplate: ch.youtubeDescriptionTemplate ?? undefined,
      youtubeMetadataMode: ch.youtubeMetadataMode ?? 'static',
      youtubeTitlePrompt: ch.youtubeTitlePrompt ?? undefined,
      youtubeDescriptionPrompt: ch.youtubeDescriptionPrompt ?? undefined,
      youtubeTagsPrompt: ch.youtubeTagsPrompt ?? undefined,
      youtubeDescriptionCta: ch.youtubeDescriptionCta ?? undefined,
      youtubeTagPrefixes: ch.youtubeTagPrefixes ?? undefined,
      enabled: ch.enabled,
      createdAt: ch.createdAt,
      updatedAt: ch.updatedAt,
    };
  }

  private toRunRow(r: AutomationRun) {
    return {
      id: r.id,
      channelId: r.channelId,
      videoRequestId: r.videoRequestId,
      status: r.status,
      inputTitle: r.inputTitle,
      inputBody: r.inputBody,
      youtubeUrl: r.youtubeUrl,
      errorMessage: r.errorMessage,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  private async assertValidConnection(connectionId: string): Promise<void> {
    const c = await this.oauthRepo.findOne({ where: { id: connectionId } });
    if (!c) {
      throw new BadRequestException('Invalid connectionId');
    }
  }

  private async assertValidOwner(userId: string): Promise<void> {
    const u = await this.userRepo.findOne({ where: { id: userId } });
    if (!u) {
      throw new BadRequestException('Invalid ownerUserId');
    }
  }

  private generatePlainSecret(): string {
    return randomBytes(32).toString('hex');
  }

  private secretPrefix(plain: string): string {
    return plain.slice(0, 6);
  }

  /** Prefix tags first, then others; dedupe case-insensitively; cap count for YouTube. */
  private mergeYoutubeTagLists(prefixes: string[] | null | undefined, tags: string[]): string[] {
    const p = (prefixes ?? []).map((t) => t.trim()).filter(Boolean);
    const seen = new Set(p.map((t) => t.toLowerCase()));
    const out = [...p];
    for (const t of tags) {
      const n = t.trim();
      if (!n) continue;
      const k = n.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(n);
      if (out.length >= 25) break;
    }
    return out;
  }

  private appendDescriptionCta(body: string, cta: string | null | undefined): string {
    const b = (body ?? '').trimEnd();
    const c = cta?.trim();
    if (!c) return b;
    return b ? `${b}\n\n${c}` : c;
  }

  private buildStaticYoutubeDescription(
    template: string | null | undefined,
    textBody: string,
  ): string {
    const descTemplate = template?.trim() || '';
    if (descTemplate) {
      return `${descTemplate}\n\n${textBody.slice(0, 4000)}`;
    }
    return textBody.slice(0, 5000);
  }

  async listChannels(): Promise<ReturnType<AutomationService['toChannelRow']>[]> {
    const list = await this.channelRepo.find({ order: { createdAt: 'DESC' } });
    return list.map((c) => this.toChannelRow(c));
  }

  async getChannel(id: string): Promise<ReturnType<AutomationService['toChannelRow']>> {
    const ch = await this.channelRepo.findOne({ where: { id } });
    if (!ch) throw new NotFoundException('Automation channel not found');
    return this.toChannelRow(ch);
  }

  async createChannel(
    dto: CreateAutomationChannelDto,
  ): Promise<{
    channel: ReturnType<AutomationService['toChannelRow']>;
    webhookSecret: string;
  }> {
    await this.assertValidConnection(dto.connectionId);
    await this.assertValidOwner(dto.ownerUserId);

    const plainSecret = this.generatePlainSecret();
    const hash = await bcrypt.hash(plainSecret, 10);
    const slug = randomUUID();

    const ch = this.channelRepo.create({
      name: dto.name.trim(),
      webhookSlug: slug,
      webhookSecretHash: hash,
      webhookSecretPrefix: this.secretPrefix(plainSecret),
      connectionId: dto.connectionId,
      ownerUserId: dto.ownerUserId,
      profileId: dto.profileId?.trim() || null,
      contentType: dto.contentType || null,
      imageModel: dto.imageModel || null,
      videoModel: dto.videoModel || null,
      llmModel: dto.llmModel || null,
      scriptSegmentationPrompt: dto.scriptSegmentationPrompt?.trim() || null,
      youtubePrivacyStatus: dto.youtubePrivacyStatus || 'private',
      youtubeTags: dto.youtubeTags?.length ? dto.youtubeTags : null,
      youtubeDescriptionTemplate: dto.youtubeDescriptionTemplate?.trim() || null,
      youtubeMetadataMode: dto.youtubeMetadataMode === 'llm' ? 'llm' : 'static',
      youtubeTitlePrompt: dto.youtubeTitlePrompt?.trim() || null,
      youtubeDescriptionPrompt: dto.youtubeDescriptionPrompt?.trim() || null,
      youtubeTagsPrompt: dto.youtubeTagsPrompt?.trim() || null,
      youtubeDescriptionCta: dto.youtubeDescriptionCta?.trim() || null,
      youtubeTagPrefixes: dto.youtubeTagPrefixes?.length ? dto.youtubeTagPrefixes.map((t) => t.trim()).filter(Boolean) : null,
      enabled: dto.enabled !== false,
    });
    const saved = await this.channelRepo.save(ch);
    return {
      channel: this.toChannelRow(saved),
      webhookSecret: plainSecret,
    };
  }

  async updateChannel(
    id: string,
    dto: UpdateAutomationChannelDto,
  ): Promise<ReturnType<AutomationService['toChannelRow']>> {
    const ch = await this.channelRepo.findOne({ where: { id } });
    if (!ch) throw new NotFoundException('Automation channel not found');

    if (dto.connectionId !== undefined) {
      await this.assertValidConnection(dto.connectionId);
      ch.connectionId = dto.connectionId;
    }
    if (dto.ownerUserId !== undefined) {
      await this.assertValidOwner(dto.ownerUserId);
      ch.ownerUserId = dto.ownerUserId;
    }
    if (dto.name !== undefined) ch.name = dto.name.trim();
    if (dto.profileId !== undefined) ch.profileId = dto.profileId?.trim() || null;
    if (dto.contentType !== undefined) ch.contentType = dto.contentType || null;
    if (dto.imageModel !== undefined) ch.imageModel = dto.imageModel || null;
    if (dto.videoModel !== undefined) ch.videoModel = dto.videoModel || null;
    if (dto.llmModel !== undefined) ch.llmModel = dto.llmModel || null;
    if (dto.scriptSegmentationPrompt !== undefined) {
      ch.scriptSegmentationPrompt =
        dto.scriptSegmentationPrompt === null
          ? null
          : dto.scriptSegmentationPrompt.trim() || null;
    }
    if (dto.youtubePrivacyStatus !== undefined) {
      ch.youtubePrivacyStatus = dto.youtubePrivacyStatus;
    }
    if (dto.youtubeTags !== undefined) {
      ch.youtubeTags = dto.youtubeTags?.length ? dto.youtubeTags : null;
    }
    if (dto.youtubeDescriptionTemplate !== undefined) {
      ch.youtubeDescriptionTemplate =
        dto.youtubeDescriptionTemplate === null
          ? null
          : dto.youtubeDescriptionTemplate.trim() || null;
    }
    if (dto.youtubeMetadataMode !== undefined) {
      ch.youtubeMetadataMode = dto.youtubeMetadataMode;
    }
    if (dto.youtubeTitlePrompt !== undefined) {
      ch.youtubeTitlePrompt =
        dto.youtubeTitlePrompt === null ? null : dto.youtubeTitlePrompt.trim() || null;
    }
    if (dto.youtubeDescriptionPrompt !== undefined) {
      ch.youtubeDescriptionPrompt =
        dto.youtubeDescriptionPrompt === null
          ? null
          : dto.youtubeDescriptionPrompt.trim() || null;
    }
    if (dto.youtubeTagsPrompt !== undefined) {
      ch.youtubeTagsPrompt =
        dto.youtubeTagsPrompt === null ? null : dto.youtubeTagsPrompt.trim() || null;
    }
    if (dto.youtubeDescriptionCta !== undefined) {
      ch.youtubeDescriptionCta =
        dto.youtubeDescriptionCta === null ? null : dto.youtubeDescriptionCta.trim() || null;
    }
    if (dto.youtubeTagPrefixes !== undefined) {
      ch.youtubeTagPrefixes =
        dto.youtubeTagPrefixes === null
          ? null
          : dto.youtubeTagPrefixes.map((t) => t.trim()).filter(Boolean);
    }
    if (dto.enabled !== undefined) ch.enabled = dto.enabled;

    const saved = await this.channelRepo.save(ch);
    return this.toChannelRow(saved);
  }

  async softDeleteChannel(id: string): Promise<void> {
    const ch = await this.channelRepo.findOne({ where: { id } });
    if (!ch) throw new NotFoundException('Automation channel not found');
    ch.enabled = false;
    await this.channelRepo.save(ch);
  }

  async regenerateWebhookSecret(
    id: string,
  ): Promise<{ channel: ReturnType<AutomationService['toChannelRow']>; webhookSecret: string }> {
    const ch = await this.channelRepo.findOne({ where: { id } });
    if (!ch) throw new NotFoundException('Automation channel not found');
    const plainSecret = this.generatePlainSecret();
    ch.webhookSecretHash = await bcrypt.hash(plainSecret, 10);
    ch.webhookSecretPrefix = this.secretPrefix(plainSecret);
    const saved = await this.channelRepo.save(ch);
    return { channel: this.toChannelRow(saved), webhookSecret: plainSecret };
  }

  async listRuns(
    channelId: string,
    page = 1,
    limit = 20,
  ): Promise<{ items: ReturnType<AutomationService['toRunRow']>[]; total: number }> {
    const ch = await this.channelRepo.findOne({ where: { id: channelId } });
    if (!ch) throw new NotFoundException('Automation channel not found');

    const take = Math.min(Math.max(limit, 1), 100);
    const skip = Math.max(page - 1, 0) * take;

    const [items, total] = await this.runRepo.findAndCount({
      where: { channelId },
      order: { createdAt: 'DESC' },
      take,
      skip,
    });
    return { items: items.map((r) => this.toRunRow(r)), total };
  }

  async getRun(runId: string): Promise<ReturnType<AutomationService['toRunRow']>> {
    const r = await this.runRepo.findOne({ where: { id: runId } });
    if (!r) throw new NotFoundException('Automation run not found');
    return this.toRunRow(r);
  }

  async ingestWebhook(
    slug: string,
    secret: string,
    body: AutomationWebhookDto,
  ): Promise<{ ok: true; runId: string; videoRequestId: string }> {
    const channel = await this.channelRepo.findOne({
      where: { webhookSlug: slug, enabled: true },
    });
    if (!channel) {
      throw new UnauthorizedException('Invalid webhook');
    }
    const secretOk = await bcrypt.compare(secret, channel.webhookSecretHash);
    if (!secretOk) {
      throw new UnauthorizedException('Invalid webhook secret');
    }

    const textBody = (body.content ?? body.body ?? '').trim();
    if (!textBody) {
      throw new BadRequestException('content or body is required');
    }
    const title = (body.title ?? '').trim() || null;

    const run = this.runRepo.create({
      channelId: channel.id,
      status: 'received',
      inputTitle: title,
      inputBody: textBody,
      videoRequestId: null,
      youtubeUrl: null,
      errorMessage: null,
    });
    const savedRun = await this.runRepo.save(run);
    await this.runRepo.update(savedRun.id, { status: 'segmenting' });

    try {
      const fullScript = title ? `${title}\n\n${textBody}` : textBody;
      const model = (channel.llmModel || 'gpt-5-4') as SupportedLlmModel;
      const segmentedScripts = await this.llmService.segmentScript(fullScript, model, {
        segmentationInstructions: channel.scriptSegmentationPrompt,
      });
      if (!segmentedScripts?.length) {
        throw new BadRequestException('Failed to generate script segments');
      }

      const metadataMode = channel.youtubeMetadataMode === 'llm' ? 'llm' : 'static';
      let youtubeTitle: string;
      let descriptionBeforeCta: string;
      let tagTail: string[];

      if (metadataMode === 'llm') {
        const meta = await this.llmService.generateYoutubeMetadata({
          fullScript,
          webhookTitle: title,
          titleInstructions: channel.youtubeTitlePrompt || '',
          descriptionInstructions: channel.youtubeDescriptionPrompt || '',
          tagsInstructions: channel.youtubeTagsPrompt || '',
          model,
        });
        if (meta) {
          youtubeTitle = meta.title;
          descriptionBeforeCta = meta.description;
          tagTail = meta.tags;
        } else {
          youtubeTitle = title || fullScript.slice(0, 90);
          descriptionBeforeCta = this.buildStaticYoutubeDescription(
            channel.youtubeDescriptionTemplate,
            textBody,
          );
          tagTail = channel.youtubeTags ?? [];
        }
      } else {
        youtubeTitle = title || fullScript.slice(0, 90);
        descriptionBeforeCta = this.buildStaticYoutubeDescription(
          channel.youtubeDescriptionTemplate,
          textBody,
        );
        tagTail = channel.youtubeTags ?? [];
      }

      const youtubeDescription = this.appendDescriptionCta(
        descriptionBeforeCta,
        channel.youtubeDescriptionCta,
      ).slice(0, 5000);

      const youtubeTags = this.mergeYoutubeTagLists(channel.youtubeTagPrefixes, tagTail);

      const videoRequest = await this.videoRequestService.create(
        channel.ownerUserId,
        {
          fullScript,
          segmentedScripts,
          model,
          youtubeUploadMode: 'direct',
          connectionId: channel.connectionId,
          youtubeTitle,
          youtubeDescription,
          youtubeTags: youtubeTags.length ? youtubeTags : undefined,
          youtubePrivacyStatus: channel.youtubePrivacyStatus || 'private',
          contentType: channel.contentType as 'all_image' | 'all_video' | 'mixed' | undefined,
          profileId: channel.profileId || undefined,
          imageModel: channel.imageModel || undefined,
          videoModel: channel.videoModel || undefined,
        },
        { automationRunId: savedRun.id },
      );

      await this.runRepo.update(savedRun.id, {
        videoRequestId: videoRequest.id,
        status: 'queued',
      });

      return {
        ok: true,
        runId: savedRun.id,
        videoRequestId: videoRequest.id,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.runRepo.update(savedRun.id, {
        status: 'failed',
        errorMessage: msg,
      });
      throw err;
    }
  }

  /** Bull worker: video pipeline started. */
  async onRunProcessing(automationRunId?: string): Promise<void> {
    if (!automationRunId) return;
    await this.runRepo.update(automationRunId, { status: 'processing' });
  }

  /** Bull worker: about to upload to YouTube (direct mode with connection). */
  async onRunUploading(automationRunId?: string): Promise<void> {
    if (!automationRunId) return;
    await this.runRepo.update(automationRunId, { status: 'uploading' });
  }

  /** Bull worker: render + YouTube finalize finished (read VideoRequest for URLs / errors). */
  async onRunFinishedSuccess(automationRunId?: string, requestId?: string): Promise<void> {
    if (!automationRunId || !requestId) return;
    const vr = await this.videoRequestService.getEntityById(requestId);
    const err = vr.youtubeErrorMessage?.trim() || null;
    await this.runRepo.update(automationRunId, {
      status: 'completed',
      youtubeUrl: vr.youtubeUrl || null,
      errorMessage: err,
    });
  }

  async onRunFailed(automationRunId?: string, message?: string): Promise<void> {
    if (!automationRunId) return;
    await this.runRepo.update(automationRunId, {
      status: 'failed',
      errorMessage: message || 'Unknown error',
    });
  }
}
