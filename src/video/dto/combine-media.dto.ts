import { IsArray, IsNotEmpty, ValidateNested, IsString, IsNumber, IsOptional, IsEnum } from 'class-validator';
import { Type } from 'class-transformer';

export enum MediaType {
  IMAGE = 'image',
  VIDEO = 'video',
}

export class SectionMediaDto {
  @IsString()
  @IsNotEmpty()
  audioPath: string; // Path to audio file or base64/data URL

  @IsString()
  @IsNotEmpty()
  mediaPath: string; // Path to image/video file

  @IsEnum(MediaType)
  mediaType: MediaType;

  @IsNumber()
  @IsNotEmpty()
  startTime: number; // Start time in seconds from transcription

  @IsNumber()
  @IsNotEmpty()
  endTime: number; // End time in seconds from transcription

  @IsOptional()
  @IsString()
  audioUrl?: string; // Optional: URL to download audio

  @IsOptional()
  @IsString()
  mediaUrl?: string; // Optional: URL to download media
}

export class CombineMediaDto {
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
}

