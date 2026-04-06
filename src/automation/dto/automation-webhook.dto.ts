import { IsOptional, IsString, MaxLength } from 'class-validator';

export class AutomationWebhookDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  title?: string;

  /** Primary article body (alias: `body`). */
  @IsOptional()
  @IsString()
  @MaxLength(200_000)
  content?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200_000)
  body?: string;
}
