import { Type } from 'class-transformer';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsIn,
  IsInt,
  Min,
  Max,
  IsArray,
  ArrayMaxSize,
  ValidateNested,
} from 'class-validator';
import { SUPPORTED_LLM_MODELS, type SupportedLlmModel } from '../../llm/llm.service';
import { RemotionUserAssetDto } from './remotion-user-asset.dto';

export class GenerateRemotionDto {
  @IsString()
  @IsNotEmpty()
  prompt: string;

  @IsOptional()
  @IsIn(SUPPORTED_LLM_MODELS)
  model?: SupportedLlmModel;

  /** Duration in frames (default 210 = 7s @ 30fps for Shorts). */
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

  /** Width in pixels (default 1080 for Shorts). */
  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(4096)
  width?: number;

  /** Height in pixels (default 1920 for Shorts). */
  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(4096)
  height?: number;

  /** R2 object keys (user-owned); server resolves to presigned GET URLs for LLM + render inputProps. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => RemotionUserAssetDto)
  userAssets?: RemotionUserAssetDto[];
}
