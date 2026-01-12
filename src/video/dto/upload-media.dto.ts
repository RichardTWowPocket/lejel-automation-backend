import { IsOptional, IsString } from 'class-validator';

export class UploadMediaRequestDto {
  @IsOptional()
  @IsString()
  url?: string; // Optional URL to download media from

  @IsOptional()
  @IsString()
  format?: string; // Optional format to convert to (e.g., 'mp3', 'mp4', 'wav', 'ogg', etc.)
}

export class UploadMediaResponseDto {
  filePath: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  mediaType: 'image' | 'video' | 'audio';
  publicUrl: string; // Public URL to access the media file
}

