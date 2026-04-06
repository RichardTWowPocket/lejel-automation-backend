import {
  IsString,
  IsArray,
  ArrayMinSize,
  IsOptional,
  IsIn,
} from 'class-validator';

export class CreateVideoRequestDto {
  @IsString()
  fullScript: string;

  @IsArray()
  @IsOptional()
  @ArrayMinSize(1, { message: 'At least one segment is required' })
  @IsString({ each: true })
  segmentedScripts?: string[];

  /** LLM model used to segment script */
  @IsOptional()
  @IsIn([
    'gpt-5-4',
    'gpt-5-2',
    'claude-sonnet-4-6',
    'gemini-3-flash',
    'gemini-3-pro',
    'gemini-3.1-pro',
    'gemini-2.5-flash',
  ])
  model?:
    | 'gpt-5-4'
    | 'gpt-5-2'
    | 'claude-sonnet-4-6'
    | 'gemini-3-flash'
    | 'gemini-3-pro'
    | 'gemini-3.1-pro'
    | 'gemini-2.5-flash';

  /** none = generate only; pending_approval = upload after admin approves; direct = upload on completion */
  @IsOptional()
  @IsIn(['none', 'pending_approval', 'direct'])
  youtubeUploadMode?: 'none' | 'pending_approval' | 'direct';

  /** OAuth connection ID - required when youtubeUploadMode is pending_approval or direct */
  @IsOptional()
  @IsString()
  connectionId?: string;

  /** YouTube metadata (used when connectionId is set; defaults: title from fullScript snippet, empty description/tags, private) */
  @IsOptional()
  @IsString()
  youtubeTitle?: string;

  @IsOptional()
  @IsString()
  youtubeDescription?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  youtubeTags?: string[];

  @IsOptional()
  @IsIn(['public', 'private', 'unlisted'])
  youtubePrivacyStatus?: 'public' | 'private' | 'unlisted';

  /** Kie Market image model for segment stills (see kie-ai.service). */
  @IsOptional()
  @IsIn([
    'z-image',
    'nano-banana-pro',
    'google/nano-banana',
    'flux-2/pro-text-to-image',
    'flux-2/flex-text-to-image',
    'grok-imagine/text-to-image',
    'gpt-image/1.5-text-to-image',
  ])
  imageModel?: string;

  @IsOptional()
  @IsIn([
    // Kling (current placeholder implementation)
    'kling-v1.6',
    'kling-v2.1-master',
    'kling-v2.1',
    // Kie Market (implemented via createMarketVideoTask)
    'bytedance/v1-lite-text-to-video',
    'wan/2-6-text-to-video',
    'grok-imagine/image-to-video',
  ])
  videoModel?: string;

  @IsOptional()
  @IsIn(['all_image', 'all_video', 'mixed'])
  contentType?: 'all_image' | 'all_video' | 'mixed';

  @IsOptional()
  @IsString()
  profileId?: string;

  /** When profile top headline is enabled, optional override (empty = auto from script in pipeline) */
  @IsOptional()
  @IsString()
  topHeadlineText?: string;

  /** When profile bottom headline is enabled, optional override (empty = profile display name in pipeline) */
  @IsOptional()
  @IsString()
  bottomHeadlineText?: string;
}
