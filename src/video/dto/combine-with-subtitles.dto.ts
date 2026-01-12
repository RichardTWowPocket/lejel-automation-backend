import { IsArray, IsNotEmpty, ValidateNested, IsString, IsNumber, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

export class MediaResultDto {
  @IsString()
  @IsNotEmpty()
  index: string;

  @IsOptional()
  @IsString()
  imageUrl?: string; // Image URL (either imageUrl or videoUrl is required)

  @IsOptional()
  @IsString()
  videoUrl?: string; // Video URL (either imageUrl or videoUrl is required)

  @IsString()
  @IsNotEmpty()
  script: string; // Subtitle text to burn

  @IsString()
  @IsNotEmpty()
  audio: string; // Audio URL
}

export class CombineWithSubtitlesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MediaResultDto)
  results: MediaResultDto[];

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
}

