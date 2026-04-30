import { IsOptional, IsIn, IsInt, Min, Max, IsObject, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { SUPPORTED_LLM_MODELS, type SupportedLlmModel } from '../../llm/llm.service';

class CanvasDto {
  @IsInt()
  @Min(16)
  @Max(4096)
  width: number;

  @IsInt()
  @Min(16)
  @Max(4096)
  height: number;
}

export class StartSessionDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => CanvasDto)
  canvas?: CanvasDto;

  @IsOptional()
  @IsIn(SUPPORTED_LLM_MODELS)
  model?: SupportedLlmModel;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(120)
  fps?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(7200)
  durationInFrames?: number;
}

export class SendMessageDto {
  @IsOptional()
  content?: string;
}
