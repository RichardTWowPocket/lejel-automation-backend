import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { RemotionAgentService } from './remotion-agent.service';
import { StartSessionDto, SendMessageDto } from './dto/agent-session.dto';

@Controller('api/remotion/agent')
export class RemotionAgentController {
  constructor(private readonly agentService: RemotionAgentService) {}

  @Post('start')
  @HttpCode(HttpStatus.CREATED)
  startSession(@Body() dto: StartSessionDto) {
    const session = this.agentService.createSession({
      canvas: dto.canvas,
      model: dto.model,
      fps: dto.fps,
      durationInFrames: dto.durationInFrames,
    });
    return {
      sessionId: session.id,
      canvas: session.canvas,
      model: session.model,
      fps: session.fps,
      durationInFrames: session.durationInFrames,
    };
  }

  @Post(':sessionId/message')
  @HttpCode(HttpStatus.ACCEPTED)
  async sendMessage(
    @Param('sessionId') sessionId: string,
    @Body() dto: SendMessageDto,
  ) {
    if (!dto.content?.trim()) {
      return { status: 'error', message: 'Message content is required' };
    }

    // Kick off async processing but don't wait
    this.agentService.processMessage(sessionId, dto.content.trim()).catch(() => {});

    return {
      sessionId,
      status: 'processing',
      message: 'Message received. Poll the session for updates.',
    };
  }

  @Get(':sessionId')
  getSession(@Param('sessionId') sessionId: string) {
    const session = this.agentService.getSession(sessionId);
    if (!session) {
      return { status: 'error', message: `Session ${sessionId} not found` };
    }

    return {
      sessionId: session.id,
      status: session.status,
      error: session.error,
      canvas: session.canvas,
      model: session.model,
      fps: session.fps,
      durationInFrames: session.durationInFrames,
      currentTsx: session.currentTsx,
      lastRenderUrl: session.lastRenderUrl,
      messages: session.messages,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }
}
