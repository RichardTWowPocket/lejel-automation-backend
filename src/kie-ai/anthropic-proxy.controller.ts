import { Controller, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { KieAiService } from './kie-ai.service';

/**
 * Exposes POST /v1/messages for Anthropic-compatible clients; forwards to Kie Claude API.
 */
@Controller()
export class AnthropicProxyController {
  constructor(private readonly kieAiService: KieAiService) {}

  @Post('v1/messages')
  async messages(@Req() req: Request, @Res({ passthrough: false }) res: Response): Promise<void> {
    await this.kieAiService.proxyAnthropicMessages(req, res);
  }
}
