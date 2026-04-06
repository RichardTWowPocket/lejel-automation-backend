import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { KieAiController } from './kie-ai.controller';
import { KieAiService } from './kie-ai.service';

@Module({
  imports: [AuthModule],
  controllers: [KieAiController],
  providers: [KieAiService],
  exports: [KieAiService],
})
export class KieAiModule {}
