import { IsString, IsOptional, IsIn } from 'class-validator';

export class CallbackDto {
  @IsString()
  @IsIn(['pending', 'processing', 'completed', 'failed'])
  status: string;

  @IsOptional()
  @IsString()
  resultUrl?: string;

  @IsOptional()
  @IsString()
  errorMessage?: string;
}
