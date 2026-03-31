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
}
