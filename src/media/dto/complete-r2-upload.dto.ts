import { IsString, MinLength } from 'class-validator';

export class CompleteR2UploadDto {
  @IsString()
  @MinLength(8)
  objectKey!: string;
}
