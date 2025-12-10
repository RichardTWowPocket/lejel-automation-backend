export class UploadMediaResponseDto {
  filePath: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  mediaType: 'image' | 'video' | 'audio';
}

