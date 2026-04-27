import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { RemotionTemplate } from '../entities/remotion-template.entity';
import { RemotionService } from './remotion.service';
import { RemotionController } from './remotion.controller';

@Module({
  imports: [ConfigModule, AuthModule, TypeOrmModule.forFeature([RemotionTemplate])],
  controllers: [RemotionController],
  providers: [RemotionService],
  exports: [RemotionService],
})
export class RemotionModule {}
