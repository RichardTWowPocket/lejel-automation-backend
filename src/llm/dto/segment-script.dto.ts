import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';

export class SegmentScriptDto {
  @IsString()
  @MinLength(1, { message: 'fullScript is required' })
  fullScript: string;

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
