import { IsOptional, IsString } from 'class-validator';

export class TranscribeAudioDto {
  @IsOptional()
  @IsString()
  language?: string;

  @IsOptional()
  @IsString()
  format?: 'json' | 'text' | 'srt' | 'verbose_json' | 'vtt';
}





