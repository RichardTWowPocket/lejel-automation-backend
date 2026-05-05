import { IsOptional, IsString, IsIn } from 'class-validator';

export class RetryWithChangesDto {
  @IsOptional()
  @IsString()
  llmModel?: string;

  @IsOptional()
  @IsString()
  imageModel?: string;

  @IsOptional()
  @IsString()
  videoModel?: string;

  @IsOptional()
  @IsIn(['all_image', 'all_video', 'mixed', 'motion_graphic'])
  contentType?: 'all_image' | 'all_video' | 'mixed' | 'motion_graphic';
}
