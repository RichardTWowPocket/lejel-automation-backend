import { IsString, IsNotEmpty, IsOptional, IsNumber } from 'class-validator';

export class BurnSubtitlesDto {
  @IsString()
  @IsNotEmpty()
  videoUrl: string; // URL to the video file

  @IsString()
  @IsNotEmpty()
  subtitleContent: string; // SRT format subtitle content

  @IsOptional()
  @IsNumber()
  width?: number; // Output video width. Default: auto-detect from video

  @IsOptional()
  @IsNumber()
  height?: number; // Output video height. Default: auto-detect from video

  @IsOptional()
  @IsString()
  returnUrl?: string; // If "yes" or "true", return public URL instead of streaming file
}












