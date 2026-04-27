import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';

export class RemotionUserAssetDto {
  @IsString()
  @MinLength(8)
  objectKey!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(200)
  label!: string;

  @IsIn(['image', 'video'])
  kind!: 'image' | 'video';
}
