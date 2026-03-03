import { IsString, IsArray, ArrayMinSize, IsOptional } from 'class-validator';

export class CreateVideoRequestDto {
  @IsString()
  fullScript: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'At least one segment is required' })
  @IsString({ each: true })
  segmentedScripts: string[];

  /** OAuth connection ID - when set, n8n will upload generated video to this YouTube channel */
  @IsOptional()
  @IsString()
  connectionId?: string;
}
