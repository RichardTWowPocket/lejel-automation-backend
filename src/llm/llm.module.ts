import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { LlmController } from './llm.controller';
import { LlmService } from './llm.service';

@Module({
  imports: [ConfigModule, AuthModule],
  controllers: [LlmController],
  providers: [LlmService],
  exports: [LlmService],
})
export class LlmModule {}
