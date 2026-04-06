import { Body, Controller, Post, UseGuards, BadRequestException } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { LlmService, SupportedLlmModel } from './llm.service';
import { SegmentScriptDto } from './dto/segment-script.dto';

@Controller('api/llm')
export class LlmController {
  constructor(private readonly llmService: LlmService) {}

  @Post('segment-script')
  @UseGuards(JwtAuthGuard)
  async segmentScript(@Body() dto: SegmentScriptDto) {
    const model = (dto.model || 'gpt-5-4') as SupportedLlmModel;
    const segments = await this.llmService.segmentScript(dto.fullScript, model, {
      useLocalFallback: false,
    });
    if (!segments.length) {
      throw new BadRequestException(
        'LLM segmentation failed or returned no segments. Check KIE_AI_API_KEY, model availability, and try again.',
      );
    }
    return { segments };
  }
}
