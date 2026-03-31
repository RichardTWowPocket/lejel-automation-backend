import { Module } from '@nestjs/common';
import { KieAiService } from './kie-ai.service';

@Module({
  providers: [KieAiService],
  exports: [KieAiService],
})
export class KieAiModule {}
