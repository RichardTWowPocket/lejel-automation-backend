import { Type } from 'class-transformer';
import { IsOptional, IsString, ValidateNested } from 'class-validator';
import {
  ContentConfigDto,
  DimensionConfigDto,
  HeadlineConfigDto,
  SubtitleConfigDto,
} from './create-profile.dto';

export class RenderProfilePreviewDto {
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
  @IsString()
  topHeadlineText?: string;

  @IsOptional()
  @IsString()
  subtitleText?: string;

  @IsOptional()
  @IsString()
  bottomHeadlineText?: string;
}
