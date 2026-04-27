import { IsString, MinLength, MaxLength } from 'class-validator';

export class ExtractNewsDto {
  @IsString()
  @MinLength(8)
  @MaxLength(2048)
  url!: string;
}
