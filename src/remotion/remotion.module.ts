import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { RemotionTemplate } from '../entities/remotion-template.entity';
import { RemotionService } from './remotion.service';
import { RemotionController } from './remotion.controller';
import { RemotionAgentService } from './remotion-agent.service';
import { RemotionAgentController } from './remotion-agent.controller';

@Module({
  imports: [ConfigModule, AuthModule, TypeOrmModule.forFeature([RemotionTemplate])],
  controllers: [RemotionController, RemotionAgentController],
  providers: [RemotionService, RemotionAgentService],
  exports: [RemotionService, RemotionAgentService],
})
export class RemotionModule {}
