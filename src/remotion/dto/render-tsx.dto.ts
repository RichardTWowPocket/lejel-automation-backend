import { IsObject, IsOptional, IsString, IsNotEmpty, IsInt, Min, Max } from 'class-validator';

export class RenderTsxDto {
  @IsString()
  @IsNotEmpty()
  tsxSource: string;

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

  /** Merged into Remotion root props (e.g. userAsset0 URLs from generate-tsx response). */
  @IsOptional()
  @IsObject()
  inputProps?: Record<string, unknown>;
}
