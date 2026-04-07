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
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ProfileSampleTextsDto } from './create-profile.dto';

const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const RATIOS = ['1:1', '3:4', '4:3', '9:16', '16:9'];
const RESOLUTIONS = ['720p', '1080p'];

class DimensionConfigUpdateDto {
  @IsOptional()
  @IsIn(RATIOS)
  ratio?: string;

  @IsOptional()
  @IsIn(RESOLUTIONS)
  resolution?: string;
}

class ContentConfigUpdateDto extends DimensionConfigUpdateDto {
  @IsOptional()
  @IsNumber()
  @Min(-5000)
  @Max(5000)
  xOffset?: number;

  @IsOptional()
  @IsNumber()
  @Min(-5000)
  @Max(5000)
  yOffset?: number;
}

class TextStyleConfigUpdateDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  font?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(999)
  fontSize?: number;

  @IsOptional()
  @IsString()
  @Matches(HEX_COLOR_RE, { message: 'fontColor must be hex (#RRGGBB)' })
  fontColor?: string;

  @IsOptional()
  @IsString()
  @Matches(HEX_COLOR_RE, { message: 'highlightColor must be hex (#RRGGBB)' })
  highlightColor?: string;

  @IsOptional()
  @IsString()
  @Matches(HEX_COLOR_RE, { message: 'outlineColor must be hex (#RRGGBB)' })
  outlineColor?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(50)
  outlineWidth?: number;

  @IsOptional()
  @IsBoolean()
  background?: boolean;

  @IsOptional()
  @IsString()
  @Matches(HEX_COLOR_RE, { message: 'backColor must be hex (#RRGGBB)' })
  backColor?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(9)
  alignment?: number;

  @IsOptional()
  @IsNumber()
  yOffset?: number;

  @IsOptional()
  @IsNumber()
  xOffset?: number;

  @IsOptional()
  @IsBoolean()
  bold?: boolean;

  @IsOptional()
  @IsBoolean()
  italic?: boolean;
}

class SubtitleConfigUpdateDto extends TextStyleConfigUpdateDto {
  @IsOptional()
  @IsBoolean()
  socialMediaStyle?: boolean;
}

class HeadlineConfigUpdateDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => TextStyleConfigUpdateDto)
  top?: TextStyleConfigUpdateDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => TextStyleConfigUpdateDto)
  bottom?: TextStyleConfigUpdateDto;
}

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => DimensionConfigUpdateDto)
  canvas?: DimensionConfigUpdateDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ContentConfigUpdateDto)
  content?: ContentConfigUpdateDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => SubtitleConfigUpdateDto)
  subtitle?: SubtitleConfigUpdateDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => HeadlineConfigUpdateDto)
  headline?: HeadlineConfigUpdateDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ProfileSampleTextsDto)
  sampleTexts?: ProfileSampleTextsDto;
}
