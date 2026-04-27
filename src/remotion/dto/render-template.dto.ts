import { IsOptional, IsObject, IsString, IsInt, Min, Max } from 'class-validator';

export class RenderTemplateDto {
  /** Override inputProps for this render (merged with template's defaultInputProps). */
  @IsOptional()
  @IsObject()
  inputProps?: Record<string, unknown>;

  /** Custom output file name (must end in .mp4). */
  @IsOptional()
  @IsString()
  outputFile?: string;

  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(3600)
  durationInFrames?: number;

  @IsOptional()
  @IsInt()
  @Min(24)
  @Max(60)
  fps?: number;

  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(4096)
  width?: number;

  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(4096)
  height?: number;
}
