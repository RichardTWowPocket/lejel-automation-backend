export class UploadMediaResponseDto {
  filePath: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  mediaType: 'image' | 'video' | 'audio';
  publicUrl: string; // Public URL to access the media file
}

