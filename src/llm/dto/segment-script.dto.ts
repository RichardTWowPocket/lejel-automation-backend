import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** `manual`: user script is already narration — segment only. `article_import`: Crawl4AI markdown — rewrite for VO then segment. */
export type SegmentScriptSource = 'manual' | 'article_import';

export class SegmentScriptDto {
  @IsString()
  @MinLength(1, { message: 'fullScript is required' })
  fullScript: string;

  @IsOptional()
  @IsIn(['manual', 'article_import'])
  scriptSource?: SegmentScriptSource;

  /** Headline from extract (optional); passed into article→voiceover step when scriptSource is article_import. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  articleTitle?: string;

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
}
