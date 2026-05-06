import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { CreateProfileDto } from './dto/create-profile.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import {
  ContentConfig,
  DimensionConfig,
  ProfileSampleTexts,
  VideoProfile,
  VideoGenerationConfig,
  YoutubeProfileConfig,
} from '../video/types/profile-config.interface';
import { RATIOS, RESOLUTIONS, Ratio, Resolution } from './profile-dimensions';

export function profileIdToFilename(profileId: string): string {
  return `${profileId}.json`;
}

@Injectable()
export class ProfileService {
  private readonly logger = new Logger(ProfileService.name);
  private readonly protectedFromDelete = new Set(['default_longform']);

  getProfilesDir(): string {
    return path.join(process.cwd(), 'profiles');
  }

  private ensureProfilesDir(): void {
    const dir = this.getProfilesDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      this.logger.log(`Created profiles directory: ${dir}`);
    }
  }

  private resolveProfilePath(profileId: string): string {
    const safe = profileId.trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(safe)) {
      throw new BadRequestException(
        'Invalid profileId: use only letters, numbers, underscores, and hyphens',
      );
    }
    return path.join(this.getProfilesDir(), profileIdToFilename(safe));
  }

  // DTOs are validated at runtime; this narrows them to the stricter profile type.
  private toDimensionConfig(input: { ratio: string; resolution: string }): DimensionConfig {
    if (!RATIOS.includes(input.ratio as Ratio)) {
      throw new BadRequestException(`Invalid ratio: ${input.ratio}`);
    }
    if (!RESOLUTIONS.includes(input.resolution as Resolution)) {
      throw new BadRequestException(`Invalid resolution: ${input.resolution}`);
    }
    return {
      ratio: input.ratio as Ratio,
      resolution: input.resolution as Resolution,
    };
  }

  private toContentConfig(input: {
    ratio: string;
    resolution: string;
    xOffset: number;
    yOffset: number;
  }): ContentConfig {
    const base = this.toDimensionConfig(input);
    return {
      ...base,
      xOffset: input.xOffset,
      yOffset: input.yOffset,
    };
  }

  private normalizeSampleTexts(
    raw?: { topHeadline?: string; bottomHeadline?: string; subtitle?: string } | null,
  ): ProfileSampleTexts | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const trimCap = (s: unknown, max: number): string | undefined => {
      if (typeof s !== 'string') return undefined;
      const t = s.trim();
      if (!t) return undefined;
      return t.length > max ? t.slice(0, max) : t;
    };
    const out: ProfileSampleTexts = {};
    const top = trimCap(raw.topHeadline, 500);
    const bottom = trimCap(raw.bottomHeadline, 500);
    const sub = trimCap(raw.subtitle, 2000);
    if (top) out.topHeadline = top;
    if (bottom) out.bottomHeadline = bottom;
    if (sub) out.subtitle = sub;
    return Object.keys(out).length ? out : undefined;
  }

  private normalizeGenerationConfig(
    raw?: { contentType: string; llmModel: string; imageModel?: string; videoModel?: string } | null,
  ): VideoGenerationConfig | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const c = raw as Record<string, unknown>;
    if (typeof c.contentType !== 'string' || typeof c.llmModel !== 'string') return undefined;
    if (!['slideshow', 'motion_graphic'].includes(c.contentType)) return undefined;
    return {
      contentType: c.contentType as 'slideshow' | 'motion_graphic',
      llmModel: String(c.llmModel),
      ...(typeof c.imageModel === 'string' && c.imageModel.trim()
        ? { imageModel: c.imageModel.trim() }
        : {}),
      ...(typeof c.videoModel === 'string' && c.videoModel.trim()
        ? { videoModel: c.videoModel.trim() }
        : {}),
    };
  }

  private normalizeYoutubeConfig(
    raw?: { uploadMode: string; connectionId?: string; privacyStatus?: string } | null,
  ): YoutubeProfileConfig | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const c = raw as Record<string, unknown>;
    if (typeof c.uploadMode !== 'string') return undefined;
    if (!['none', 'direct', 'pending_approval'].includes(c.uploadMode)) return undefined;
    return {
      uploadMode: c.uploadMode as 'none' | 'direct' | 'pending_approval',
      ...(typeof c.connectionId === 'string' && c.connectionId.trim()
        ? { connectionId: c.connectionId.trim() }
        : {}),
      ...(typeof c.privacyStatus === 'string' &&
        ['public', 'private', 'unlisted'].includes(c.privacyStatus)
        ? { privacyStatus: c.privacyStatus as 'public' | 'private' | 'unlisted' }
        : {}),
    };
  }

  private normalizeProfile(profile: VideoProfile): VideoProfile {
    const n = (v: unknown) => Number(v) || 0;
    return {
      ...profile,
      content: {
        ...profile.content,
        xOffset: n(profile.content?.xOffset),
        yOffset: n(profile.content?.yOffset),
      },
      subtitle: {
        ...profile.subtitle,
        xOffset: n(profile.subtitle?.xOffset),
        yOffset: n(profile.subtitle?.yOffset),
      },
      headline: {
        top: {
          ...profile.headline.top,
          xOffset: n(profile.headline.top?.xOffset),
          yOffset: n(profile.headline.top?.yOffset),
        },
        bottom: {
          ...profile.headline.bottom,
          xOffset: n(profile.headline.bottom?.xOffset),
          yOffset: n(profile.headline.bottom?.yOffset),
        },
      },
      sampleTexts: this.normalizeSampleTexts(profile.sampleTexts),
      generation: this.normalizeGenerationConfig(profile.generation as any),
      youtube: this.normalizeYoutubeConfig(profile.youtube as any),
    };
  }

  async listProfiles(): Promise<VideoProfile[]> {
    const dir = this.getProfilesDir();
    if (!fs.existsSync(dir)) return [];

    const entries = await fs.promises.readdir(dir);
    const jsonFiles = entries.filter((f) => f.endsWith('.json')).sort();
    const out: VideoProfile[] = [];

    for (const file of jsonFiles) {
      const full = path.join(dir, file);
      const raw = await fs.promises.readFile(full, 'utf-8');
      try {
        const data = JSON.parse(raw);
        if (!data.profileId || typeof data.profileId !== 'string') continue;
        out.push(this.normalizeProfile(data as VideoProfile));
      } catch (e: any) {
        this.logger.error(`Invalid JSON in ${full}: ${e?.message}`);
      }
    }
    return out;
  }

  async getProfile(profileId: string): Promise<VideoProfile> {
    const profilePath = this.resolveProfilePath(profileId);
    if (!fs.existsSync(profilePath)) {
      throw new NotFoundException(`Profile not found: ${profileId}`);
    }
    const raw = await fs.promises.readFile(profilePath, 'utf-8');
    try {
      return this.normalizeProfile(JSON.parse(raw) as VideoProfile);
    } catch {
      throw new BadRequestException(`Profile file is not valid JSON: ${profileId}`);
    }
  }

  async createProfile(dto: CreateProfileDto): Promise<VideoProfile> {
    this.ensureProfilesDir();
    const profilePath = this.resolveProfilePath(dto.profileId);
    if (fs.existsSync(profilePath)) {
      throw new ConflictException(`Profile already exists: ${dto.profileId}. Use PATCH to update.`);
    }

    const doc: VideoProfile = {
      profileId: dto.profileId,
      name: dto.name,
      description: dto.description ?? '',
      canvas: this.toDimensionConfig(dto.canvas),
      content: this.toContentConfig(dto.content),
      subtitle: dto.subtitle,
      headline: dto.headline,
      sampleTexts: this.normalizeSampleTexts(dto.sampleTexts),
      generation: dto.generation ? {
        contentType: dto.generation.contentType,
        llmModel: dto.generation.llmModel,
        ...(dto.generation.imageModel ? { imageModel: dto.generation.imageModel } : {}),
        ...(dto.generation.videoModel ? { videoModel: dto.generation.videoModel } : {}),
      } : undefined,
      youtube: dto.youtube ? {
        uploadMode: dto.youtube.uploadMode,
        ...(dto.youtube.connectionId ? { connectionId: dto.youtube.connectionId } : {}),
        ...(dto.youtube.privacyStatus ? { privacyStatus: dto.youtube.privacyStatus } : {}),
      } : undefined,
    };

    await fs.promises.writeFile(profilePath, `${JSON.stringify(doc, null, 2)}\n`, 'utf-8');
    this.logger.log(`Created profile: ${dto.profileId}`);
    return doc;
  }

  async updateProfile(profileId: string, dto: UpdateProfileDto): Promise<VideoProfile> {
    const existing = await this.getProfile(profileId);

    if (dto.name !== undefined) existing.name = dto.name;
    if (dto.description !== undefined) existing.description = dto.description;

    if (dto.canvas) {
      existing.canvas = this.toDimensionConfig({
        ratio: dto.canvas.ratio ?? existing.canvas.ratio,
        resolution: dto.canvas.resolution ?? existing.canvas.resolution,
      });
    }
    if (dto.content) {
      existing.content = this.toContentConfig({
        ratio: dto.content.ratio ?? existing.content.ratio,
        resolution: dto.content.resolution ?? existing.content.resolution,
        xOffset: dto.content.xOffset ?? existing.content.xOffset ?? 0,
        yOffset: dto.content.yOffset ?? existing.content.yOffset ?? 0,
      });
    }
    if (dto.subtitle) {
      existing.subtitle = { ...existing.subtitle, ...dto.subtitle };
    }
    if (dto.headline) {
      if (dto.headline.top) {
        existing.headline.top = { ...existing.headline.top, ...dto.headline.top };
      }
      if (dto.headline.bottom) {
        existing.headline.bottom = { ...existing.headline.bottom, ...dto.headline.bottom };
      }
    }
    if (dto.sampleTexts !== undefined) {
      existing.sampleTexts = this.normalizeSampleTexts(dto.sampleTexts);
    }
    if (dto.generation !== undefined) {
      if (dto.generation === null) {
        existing.generation = undefined;
      } else {
        const gen = dto.generation as any;
        existing.generation = {
          contentType: gen.contentType ?? existing.generation?.contentType,
          llmModel: gen.llmModel ?? existing.generation?.llmModel,
          ...(gen.imageModel !== undefined
            ? { imageModel: gen.imageModel || undefined }
            : { imageModel: existing.generation?.imageModel }),
          ...(gen.videoModel !== undefined
            ? { videoModel: gen.videoModel || undefined }
            : { videoModel: existing.generation?.videoModel }),
        } as VideoGenerationConfig;
      }
    }
    if (dto.youtube !== undefined) {
      if (dto.youtube === null) {
        existing.youtube = undefined;
      } else {
        const yt = dto.youtube as any;
        existing.youtube = {
          uploadMode: yt.uploadMode ?? existing.youtube?.uploadMode,
          ...(yt.connectionId !== undefined
            ? { connectionId: yt.connectionId || undefined }
            : { connectionId: existing.youtube?.connectionId }),
          ...(yt.privacyStatus !== undefined
            ? { privacyStatus: yt.privacyStatus || undefined }
            : { privacyStatus: existing.youtube?.privacyStatus }),
        } as YoutubeProfileConfig;
      }
    }

    const profilePath = this.resolveProfilePath(profileId);
    await fs.promises.writeFile(profilePath, `${JSON.stringify(existing, null, 2)}\n`, 'utf-8');
    this.logger.log(`Updated profile: ${profileId}`);
    return existing;
  }

  async deleteProfile(profileId: string): Promise<{ deleted: boolean; profileId: string }> {
    if (this.protectedFromDelete.has(profileId)) {
      throw new ForbiddenException(`Cannot delete built-in profile "${profileId}".`);
    }
    const profilePath = this.resolveProfilePath(profileId);
    if (!fs.existsSync(profilePath)) {
      throw new NotFoundException(`Profile not found: ${profileId}`);
    }
    await fs.promises.unlink(profilePath);
    this.logger.log(`Deleted profile: ${profileId}`);
    return { deleted: true, profileId };
  }
}
