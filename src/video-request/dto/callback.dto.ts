import { IsString, IsOptional, IsIn, IsArray } from 'class-validator';
import { Transform } from 'class-transformer';

function parseTags(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.every((x) => typeof x === 'string') ? (value as string[]) : undefined;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) && parsed.every((x) => typeof x === 'string') ? (parsed as string[]) : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export class CallbackDto {
  @IsString()
  @IsIn(['pending', 'processing', 'completed', 'failed'])
  status: string;

  @IsOptional()
  @IsString()
  resultUrl?: string;

  @IsOptional()
  @IsString()
  errorMessage?: string;

  /** From automation: title for YouTube upload (overrides request value when provided) */
  @IsOptional()
  @IsString()
  youtubeTitle?: string;

  /** From automation: description for YouTube upload */
  @IsOptional()
  @IsString()
  youtubeDescription?: string;

  /** From automation: tags for YouTube upload (array or JSON string like "[\"a\",\"b\"]") */
  @IsOptional()
  @Transform(({ value }) => parseTags(value))
  @IsArray()
  @IsString({ each: true })
  youtubeTags?: string[];

  /** From automation: public | private | unlisted */
  @IsOptional()
  @IsString()
  @IsIn(['public', 'private', 'unlisted'])
  youtubePrivacyStatus?: string;
}
