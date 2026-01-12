import { IsArray, IsNotEmpty, ValidateNested, IsString, IsNumber, IsOptional, IsEnum } from 'class-validator';
import { Type } from 'class-transformer';

export enum MediaType {
  IMAGE = 'image',
  VIDEO = 'video',
}

export class SectionMediaDto {
  @IsString()
  @IsNotEmpty()
  mediaPath: string; // Path to image/video file

  @IsEnum(MediaType)
  mediaType: MediaType;

  @IsOptional()
  @IsNumber()
  startTime?: number; // Start time in seconds from combined audio (required if no audioPath)

  @IsOptional()
  @IsNumber()
  endTime?: number; // End time in seconds from combined audio (required if no audioPath)

  @IsOptional()
  @IsString()
  mediaUrl?: string; // Optional: URL to download media

  @IsOptional()
  @IsString()
  audioPath?: string; // Optional: Path to audio file for this section (if provided, startTime/endTime not needed)

  @IsOptional()
  @IsString()
  transcript?: string; // Optional: Transcript text for this section (generates subtitles)
}

export class CombineMediaDto {
  @IsOptional()
  @IsString()
  audioPath?: string; // Path to combined audio file (optional if all sections have audioPath)

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SectionMediaDto)
  sections: SectionMediaDto[];

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
  useSubtitle?: string | boolean; // If "yes", "true", or true, generate and add subtitles to video

  @IsOptional()
  useSocialMediaSubtitle?: string | boolean; // If "yes", "true", or true, generate social media-style subtitles (3-6 words with highlighted current word)

  @IsOptional()
  asyncMode?: string | boolean; // If "yes", "true", or true, return job ID immediately and process in background
}

