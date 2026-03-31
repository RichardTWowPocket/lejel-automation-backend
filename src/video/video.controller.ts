import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiKeyOrJwtGuard } from '../auth/api-key-or-jwt.guard';
import { CombineMediaProfileDto } from './dto/combine-media-profile.dto';
import { ScriptToVideoService } from './script-to-video.service';

@Controller('api/video')
@UseGuards(ApiKeyOrJwtGuard)
export class VideoController {
  constructor(
    private readonly scriptToVideoService: ScriptToVideoService,
  ) {}

  @Get('health')
  health() {
    return {
      status: 'ok',
      mode: 'fallback',
    };
  }

  @Post('combine-media-profile')
  async combineMediaProfile(@Body() dto: CombineMediaProfileDto) {
    return this.scriptToVideoService.runFullPipelineWithSegments(
      dto.sections.map((section) => section.transcript).join(' '),
      dto.sections.map((section) => section.transcript),
      'fallback-voice',
      { config: { profileId: dto.profile || 'default' } },
      dto.outputFormat || 'mp4',
    );
  }
}
