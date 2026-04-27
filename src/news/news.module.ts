import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { NewsController } from './news.controller';
import { Crawl4AiService } from './crawl4ai.service';

@Module({
  imports: [ConfigModule, AuthModule],
  controllers: [NewsController],
  providers: [Crawl4AiService],
  exports: [Crawl4AiService],
})
export class NewsModule {}
