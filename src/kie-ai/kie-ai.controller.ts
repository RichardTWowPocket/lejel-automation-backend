import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { KieAiService } from './kie-ai.service';

@Controller('api/kie-ai')
export class KieAiController {
  constructor(private readonly kieAiService: KieAiService) {}

  /** Current Kie.ai chat/API credit balance (proxied from Kie; requires server KIE_AI_API_KEY). */
  @Get('credits')
  @UseGuards(JwtAuthGuard)
  async getCredits() {
    return this.kieAiService.getCredits();
  }
}
