import { IsString, IsNotEmpty, IsOptional, IsIn, IsInt, Min, Max } from 'class-validator';
import { SUPPORTED_LLM_MODELS } from '../../llm/llm.service';

export class ReviseRemotionDto {
  @IsString()
  @IsNotEmpty()
  existingTsx!: string;

  @IsString()
  @IsNotEmpty()
  revisionPrompt!: string;

  @IsOptional()
  @IsIn(SUPPORTED_LLM_MODELS)
  model?: (typeof SUPPORTED_LLM_MODELS)[number];

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
}
