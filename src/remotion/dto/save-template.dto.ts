import { Type } from 'class-transformer';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsInt,
  Min,
  Max,
  IsObject,
  IsArray,
  ArrayMaxSize,
  ValidateNested,
} from 'class-validator';
import { RemotionUserAssetDto } from './remotion-user-asset.dto';

export class SaveTemplateDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsString()
  @IsNotEmpty()
  tsxSource: string;

  @IsOptional()
  @IsString()
  generationPrompt?: string;

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

  @IsOptional()
  @IsObject()
  defaultInputProps?: Record<string, unknown>;

  /** Persist R2 keys so template re-renders can presign fresh GET URLs (order = userAsset0..). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => RemotionUserAssetDto)
  remotionAssetRefs?: RemotionUserAssetDto[];
}
