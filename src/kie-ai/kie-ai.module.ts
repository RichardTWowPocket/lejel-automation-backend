import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AnthropicProxyController } from './anthropic-proxy.controller';
import { KieAiController } from './kie-ai.controller';
import { KieAiService } from './kie-ai.service';
import { KieTtsService } from './kie-tts.service';

@Module({
  imports: [AuthModule],
  controllers: [AnthropicProxyController, KieAiController],
  providers: [KieAiService, KieTtsService],
  exports: [KieAiService, KieTtsService],
})
export class KieAiModule {}
