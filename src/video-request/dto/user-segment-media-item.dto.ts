import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';

export class UserSegmentMediaItemDto {
  /** When set, this segment uses this asset (manual). When omitted, server assigns using `assetLabel` + LLM. */
  @IsOptional()
  @IsInt()
  @Min(0)
  segmentIndex?: number;

  @IsString()
  @MinLength(3)
  @MaxLength(400)
  assetLabel!: string;

  @IsString()
  @MinLength(8)
  objectKey!: string;

  @IsIn(['image', 'video'])
  mediaKind!: 'image' | 'video';
}
