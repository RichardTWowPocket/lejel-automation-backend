import {
  IsString,
  IsArray,
  IsOptional,
  IsIn,
  IsUUID,
  IsBoolean,
  MinLength,
  MaxLength,
} from 'class-validator';

const LLM_MODELS = [
  'gpt-5-4',
  'gpt-5-2',
  'claude-sonnet-4-6',
  'gemini-3-flash',
  'gemini-3-pro',
  'gemini-3.1-pro',
  'gemini-2.5-flash',
] as const;

const IMAGE_MODELS = [
  'z-image',
  'nano-banana-pro',
  'google/nano-banana',
  'flux-2/pro-text-to-image',
  'flux-2/flex-text-to-image',
  'grok-imagine/text-to-image',
  'gpt-image/1.5-text-to-image',
] as const;

const VIDEO_MODELS = [
  'kling-v1.6',
  'kling-v2.1-master',
  'kling-v2.1',
  'bytedance/v1-lite-text-to-video',
  'wan/2-6-text-to-video',
  'grok-imagine/image-to-video',
] as const;

export class UpdateAutomationChannelDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsUUID()
  connectionId?: string;

  @IsOptional()
  @IsUUID()
  ownerUserId?: string;

  @IsOptional()
  @IsString()
  profileId?: string;

  @IsOptional()
  @IsIn(['all_image', 'all_video', 'mixed'])
  contentType?: 'all_image' | 'all_video' | 'mixed';

  @IsOptional()
  @IsIn([...IMAGE_MODELS])
  imageModel?: (typeof IMAGE_MODELS)[number];

  @IsOptional()
  @IsIn([...VIDEO_MODELS])
  videoModel?: (typeof VIDEO_MODELS)[number];

  @IsOptional()
  @IsIn([...LLM_MODELS])
  llmModel?: (typeof LLM_MODELS)[number];

  @IsOptional()
  @IsString()
  scriptSegmentationPrompt?: string | null;

  @IsOptional()
  @IsBoolean()
  articleToScriptEnabled?: boolean;

  @IsOptional()
  @IsString()
  articleToScriptPrompt?: string | null;

  @IsOptional()
  @IsIn(['public', 'private', 'unlisted'])
  youtubePrivacyStatus?: 'public' | 'private' | 'unlisted';

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  youtubeTags?: string[];

  @IsOptional()
  @IsString()
  youtubeDescriptionTemplate?: string | null;

  @IsOptional()
  @IsIn(['static', 'llm'])
  youtubeMetadataMode?: 'static' | 'llm';

  @IsOptional()
  @IsString()
  youtubeTitlePrompt?: string | null;

  @IsOptional()
  @IsString()
  youtubeDescriptionPrompt?: string | null;

  @IsOptional()
  @IsString()
  youtubeTagsPrompt?: string | null;

  @IsOptional()
  @IsString()
  youtubeMetadataPrompt?: string | null;

  @IsOptional()
  @IsBoolean()
  automationTopHeadlineEnabled?: boolean;

  @IsOptional()
  @IsString()
  automationTopHeadlinePrompt?: string | null;

  @IsOptional()
  @IsBoolean()
  automationBottomHeadlineEnabled?: boolean;

  @IsOptional()
  @IsString()
  automationBottomHeadlinePrompt?: string | null;

  @IsOptional()
  @IsString()
  youtubeDescriptionCta?: string | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  youtubeTagPrefixes?: string[] | null;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
