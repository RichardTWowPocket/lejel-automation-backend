import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ExtractNewsDto } from './dto/extract-news.dto';
import { Crawl4AiService } from './crawl4ai.service';

@Controller('api/news')
export class NewsController {
  constructor(private readonly crawl4ai: Crawl4AiService) {}

  @Post('extract')
  @UseGuards(JwtAuthGuard)
  async extract(@Body() dto: ExtractNewsDto) {
    return this.crawl4ai.extractArticle(dto.url);
  }
}
