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

  @IsNumber()
  @IsNotEmpty()
  startTime: number; // Start time in seconds from combined audio

  @IsNumber()
  @IsNotEmpty()
  endTime: number; // End time in seconds from combined audio

  @IsOptional()
  @IsString()
  mediaUrl?: string; // Optional: URL to download media
}

export class CombineMediaDto {
  @IsString()
  @IsNotEmpty()
  audioPath: string; // Path to combined audio file

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

