import {
  Body,
  Controller,
  Headers,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { AutomationService } from './automation.service';
import { AutomationWebhookDto } from './dto/automation-webhook.dto';

@Controller('api/automation/webhook')
export class AutomationWebhookController {
  constructor(private readonly automationService: AutomationService) {}

  @Post(':slug')
  async handle(
    @Param('slug') slug: string,
    @Body() body: AutomationWebhookDto,
    @Headers('x-webhook-secret') headerSecret?: string,
    @Headers('authorization') authorization?: string,
  ) {
    let secret = typeof headerSecret === 'string' ? headerSecret.trim() : '';
    if (!secret && authorization?.startsWith('Bearer ')) {
      secret = authorization.slice(7).trim();
    }
    if (!secret) {
      throw new UnauthorizedException('Missing webhook secret');
    }
    return this.automationService.ingestWebhook(slug, secret, body);
  }
}
