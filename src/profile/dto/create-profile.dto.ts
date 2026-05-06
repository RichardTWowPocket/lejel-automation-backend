import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

const PROFILE_ID_RE = /^[a-zA-Z0-9_-]+$/;
const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const RATIOS = ['1:1', '3:4', '4:3', '9:16', '16:9'];
const RESOLUTIONS = ['720p', '1080p'];

export class DimensionConfigDto {
  @IsIn(RATIOS)
  ratio: string;

  @IsIn(RESOLUTIONS)
  resolution: string;
}

export class ContentConfigDto extends DimensionConfigDto {
  @IsNumber()
  @Min(-5000)
  @Max(5000)
  xOffset: number;

  @IsNumber()
  @Min(-5000)
  @Max(5000)
  yOffset: number;
}

export class TextStyleConfigDto {
  @IsBoolean()
  enabled: boolean;

  @IsString()
  @IsNotEmpty()
  font: string;

  @IsNumber()
  @Min(1)
  @Max(999)
  fontSize: number;

  @IsString()
  @Matches(HEX_COLOR_RE, { message: 'fontColor must be hex (#RRGGBB)' })
  fontColor: string;

  @IsString()
  @Matches(HEX_COLOR_RE, { message: 'highlightColor must be hex (#RRGGBB)' })
  highlightColor: string;

  @IsString()
  @Matches(HEX_COLOR_RE, { message: 'outlineColor must be hex (#RRGGBB)' })
  outlineColor: string;

  @IsNumber()
  @Min(0)
  @Max(50)
  outlineWidth: number;

  @IsBoolean()
  background: boolean;

  @IsString()
  @Matches(HEX_COLOR_RE, { message: 'backColor must be hex (#RRGGBB)' })
  backColor: string;

  @IsInt()
  @Min(1)
  @Max(9)
  alignment: number;

  @IsNumber()
  yOffset: number;

  @IsNumber()
  xOffset: number;

  @IsBoolean()
  bold: boolean;

  @IsBoolean()
  italic: boolean;
}

export class SubtitleConfigDto extends TextStyleConfigDto {
  @IsBoolean()
  socialMediaStyle: boolean;
}

export class HeadlineConfigDto {
  @ValidateNested()
  @Type(() => TextStyleConfigDto)
  top: TextStyleConfigDto;

  @ValidateNested()
  @Type(() => TextStyleConfigDto)
  bottom: TextStyleConfigDto;
}

export class ProfileSampleTextsDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  topHeadline?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  bottomHeadline?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  subtitle?: string;
}

export class VideoGenerationConfigDto {
  @IsIn(['slideshow', 'motion_graphic'])
  contentType: 'slideshow' | 'motion_graphic';

  @IsIn([
    'gpt-5-4',
    'gpt-5-2',
    'claude-sonnet-4-6',
    'gemini-3-flash',
    'gemini-3-pro',
    'gemini-3.1-pro',
    'gemini-2.5-flash',
  ])
  llmModel: string;

  @IsOptional()
  @IsIn([
    'z-image',
    'nano-banana-pro',
    'google/nano-banana',
    'flux-2/pro-text-to-image',
    'flux-2/flex-text-to-image',
    'grok-imagine/text-to-image',
    'gpt-image/1.5-text-to-image',
  ])
  imageModel?: string;

  @IsOptional()
  @IsIn([
    'kling-v1.6',
    'kling-v2.1-master',
    'kling-v2.1',
    'bytedance/v1-lite-text-to-video',
    'wan/2-6-text-to-video',
    'grok-imagine/image-to-video',
  ])
  videoModel?: string;
}

export class YoutubeProfileConfigDto {
  @IsIn(['none', 'direct', 'pending_approval'])
  uploadMode: 'none' | 'direct' | 'pending_approval';

  @IsOptional()
  @IsString()
  connectionId?: string;

  @IsOptional()
  @IsIn(['public', 'private', 'unlisted'])
  privacyStatus?: 'public' | 'private' | 'unlisted';
}

export class CreateProfileDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(128)
  @Matches(PROFILE_ID_RE, {
    message: 'profileId must contain only letters, numbers, underscores, and hyphens',
  })
  profileId: string;

  @IsString()
  @IsNotEmpty()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @ValidateNested()
  @Type(() => DimensionConfigDto)
  canvas: DimensionConfigDto;

  @ValidateNested()
  @Type(() => ContentConfigDto)
  content: ContentConfigDto;

  @ValidateNested()
  @Type(() => SubtitleConfigDto)
  subtitle: SubtitleConfigDto;

  @ValidateNested()
  @Type(() => HeadlineConfigDto)
  headline: HeadlineConfigDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ProfileSampleTextsDto)
  sampleTexts?: ProfileSampleTextsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => VideoGenerationConfigDto)
  generation?: VideoGenerationConfigDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => YoutubeProfileConfigDto)
  youtube?: YoutubeProfileConfigDto;
}
