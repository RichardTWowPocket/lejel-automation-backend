import { IsOptional, IsString, IsBoolean } from 'class-validator';
import { Transform } from 'class-transformer';

export class TranscribeAudioDto {
  @IsOptional()
  @IsString()
  language?: string;

  @IsOptional()
  @IsString()
  format?: 'json' | 'text' | 'srt' | 'verbose_json' | 'vtt';

  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true' || value === true || value === 'yes' || value === '1') {
      return true;
    }
    if (value === 'false' || value === false || value === 'no' || value === '0') {
      return false;
    }
    return value;
  })
  @IsBoolean()
  useWhisperTimestamp?: boolean;
}





