import { IsArray, IsNotEmpty, ValidateNested, IsString, IsNumber, IsOptional, IsEnum } from 'class-validator';
import { Type } from 'class-transformer';

export class SectionDataDto {
  @IsString()
  @IsNotEmpty()
  transcript: string; // Transcript text for this section

  @IsString()
  @IsNotEmpty()
  imagePath: string; // Path/URL to image file for this section
}

export enum CombineMediasLayout {
  DEFAULT = 'default',
  VERTICAL_POSTER = 'vertical_poster',
}

export enum BottomHeadlineAppear {
  START = 'start',
  LAST = 'last',
}

export class CombineMediasDto {
  @IsString()
  @IsNotEmpty()
  audioPath: string; // Full video audio (all sections combined)

  @IsArray()
  @IsNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => SectionDataDto)
  sections: SectionDataDto[]; // Array of sections with transcript and image

  @IsOptional()
  @IsString()
  outputFormat?: string; // mp4, webm, etc. Default: mp4

  @IsOptional()
  @IsNumber()
  width?: number; // Output video width. Default: 1920

  @IsOptional()
  @IsNumber()
  height?: number; // Output video height. Default: 1080

  @IsOptional()
  @IsString()
  returnUrl?: string; // If "yes" or "true", return public URL instead of streaming file

  @IsOptional()
  useSubtitle?: string | boolean; // If "yes", "true", or true, generate regular SRT subtitles

  @IsOptional()
  useSocialMediaSubtitle?: string | boolean; // If "yes", "true", or true, generate social media-style ASS subtitles

  @IsOptional()
  asyncMode?: string | boolean; // If "yes", "true", or true, return job ID immediately and process in background

  @IsOptional()
  @IsEnum(CombineMediasLayout)
  layout?: CombineMediasLayout; // Layout mode: default or vertical_poster

  @IsOptional()
  @IsString()
  topHeadlineText?: string; // Top headline text (used when layout=vertical_poster)

  @IsOptional()
  @IsString()
  bottomHeadlineText?: string; // Bottom headline / CTA text (layout=vertical_poster)

  @IsOptional()
  @IsNumber()
  verticalGap?: number; // Gap between image and headlines (layout=vertical_poster)

  @IsOptional()
  @IsString()
  imageAspect?: string; // '3:4' or '1:1' hint for vertical_poster image ratio

  @IsOptional()
  @IsString()
  inputRatio?: string; // '3:4' or '1:1' - actual aspect ratio of input images/videos for positioning calculations

  @IsOptional()
  @IsEnum(BottomHeadlineAppear)
  bottomHeadlineAppear?: BottomHeadlineAppear; // When to show bottom headline: 'start' (from beginning) or 'last' (only last section)
}




