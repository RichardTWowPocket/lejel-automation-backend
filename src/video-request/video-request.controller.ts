import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  Headers,
} from '@nestjs/common';
import { VideoRequestService } from './video-request.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { User as ReqUser } from '../auth/user.decorator';
import { CreateVideoRequestDto } from './dto/create-video-request.dto';
import { UpdateVideoRequestDto } from './dto/update-video-request.dto';
import { CallbackDto } from './dto/callback.dto';
import { VideoRequestStatus } from '../entities/video-request.entity';

@Controller('api/video-requests')
export class VideoRequestController {
  constructor(private readonly videoRequestService: VideoRequestService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  async create(
    @ReqUser() user: { id: string },
    @Body() dto: CreateVideoRequestDto,
  ) {
    const request = await this.videoRequestService.create(user.id, dto);
    return {
      id: request.id,
      fullScript: request.fullScript,
      segmentedScripts: request.segmentedScripts,
      status: request.status,
      createdAt: request.createdAt,
      submittedAt: request.submittedAt,
      connectionId: request.connectionId || undefined,
    };
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  async list(
    @ReqUser() user: { id: string },
    @Query('status') status?: VideoRequestStatus,
  ) {
    return this.videoRequestService.findAllByUser(user.id, status);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  async getOne(@ReqUser() user: { id: string }, @Param('id') id: string) {
    return this.videoRequestService.findOne(id, user.id);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  async update(
    @ReqUser() user: { id: string },
    @Param('id') id: string,
    @Body() dto: UpdateVideoRequestDto,
  ) {
    return this.videoRequestService.update(id, user.id, dto);
  }

  @Post(':id/callback')
  async callback(
    @Param('id') id: string,
    @Headers('x-callback-secret') secret: string,
    @Body() dto: CallbackDto,
  ) {
    return this.videoRequestService.handleCallback(
      id,
      secret || '',
      dto.status,
      dto.resultUrl,
      dto.errorMessage,
    );
  }
}
