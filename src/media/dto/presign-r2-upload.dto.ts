import { IsIn, IsOptional, IsString } from 'class-validator';

const ALLOWED = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/quicktime',
] as const;

export class PresignR2UploadDto {
  @IsString()
  @IsIn([...ALLOWED])
  contentType!: (typeof ALLOWED)[number];

  /** `remotion` → keys under `users/{id}/remotion-assets/` for motion graphics. Default: segment media uploads. */
  @IsOptional()
  @IsIn(['uploads', 'remotion'])
  scope?: 'uploads' | 'remotion';
}
