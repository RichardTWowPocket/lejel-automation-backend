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
  VideoProfile,
} from '../video/types/profile-config.interface';
import {
  RATIOS,
  RESOLUTIONS,
  Ratio,
  Resolution,
} from './profile-dimensions';

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
  private toDimensionConfig(input: {
    ratio: string;
    resolution: string;
  }): DimensionConfig {
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

  private normalizeProfile(profile: VideoProfile): VideoProfile {
    return {
      ...profile,
      content: {
        ...profile.content,
        xOffset: profile.content?.xOffset ?? 0,
        yOffset: profile.content?.yOffset ?? 0,
      },
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
      throw new ConflictException(
        `Profile already exists: ${dto.profileId}. Use PATCH to update.`,
      );
    }

    const doc: VideoProfile = {
      profileId: dto.profileId,
      name: dto.name,
      description: dto.description ?? '',
      canvas: this.toDimensionConfig(dto.canvas),
      content: this.toContentConfig(dto.content),
      subtitle: dto.subtitle,
      headline: dto.headline,
    };

    await fs.promises.writeFile(
      profilePath,
      `${JSON.stringify(doc, null, 2)}\n`,
      'utf-8',
    );
    this.logger.log(`Created profile: ${dto.profileId}`);
    return doc;
  }

  async updateProfile(
    profileId: string,
    dto: UpdateProfileDto,
  ): Promise<VideoProfile> {
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

    const profilePath = this.resolveProfilePath(profileId);
    await fs.promises.writeFile(
      profilePath,
      `${JSON.stringify(existing, null, 2)}\n`,
      'utf-8',
    );
    this.logger.log(`Updated profile: ${profileId}`);
    return existing;
  }

  async deleteProfile(profileId: string): Promise<{ deleted: boolean; profileId: string }> {
    if (this.protectedFromDelete.has(profileId)) {
      throw new ForbiddenException(
        `Cannot delete built-in profile "${profileId}".`,
      );
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
