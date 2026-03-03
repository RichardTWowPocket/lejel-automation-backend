import { IsString, IsArray, ArrayMinSize, IsOptional } from 'class-validator';

export class UpdateVideoRequestDto {
  @IsOptional()
  @IsString()
  fullScript?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  segmentedScripts?: string[];
}
