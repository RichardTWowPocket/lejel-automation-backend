import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Headers,
} from '@nestjs/common';
import { VideoRequestService } from './video-request.service';
import { AdminGuard } from '../auth/admin.guard';
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
      llmModel: request.llmModel || undefined,
      status: request.status,
      createdAt: request.createdAt,
      submittedAt: request.submittedAt,
      connectionId: request.connectionId || undefined,
      contentType: request.contentType || undefined,
      profileId: request.profileId || undefined,
      imageModel: request.imageModel || undefined,
      videoModel: request.videoModel || undefined,
    };
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  async list(
    @ReqUser() user: { id: string; role?: 'user' | 'admin' },
    @Query('status') status?: VideoRequestStatus,
  ) {
    return this.videoRequestService.findAllByUser(user.id, status, {
      isAdmin: user.role === 'admin',
    });
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  async getOne(
    @ReqUser() user: { id: string; role?: 'user' | 'admin' },
    @Param('id') id: string,
  ) {
    return this.videoRequestService.findOne(id, user.id, {
      isAdmin: user.role === 'admin',
    });
  }

  @Get(':id/detail')
  @UseGuards(JwtAuthGuard)
  async getOneDetail(
    @ReqUser() user: { id: string; role?: 'user' | 'admin' },
    @Param('id') id: string,
  ) {
    return this.videoRequestService.findDetail(id, user.id, {
      isAdmin: user.role === 'admin',
    });
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

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  async remove(
    @ReqUser() user: { id: string; role?: 'user' | 'admin' },
    @Param('id') id: string,
  ) {
    return this.videoRequestService.remove(id, user.id, {
      isAdmin: user.role === 'admin',
    });
  }

  @Post(':id/stop')
  @UseGuards(JwtAuthGuard)
  async stop(
    @ReqUser() user: { id: string; role?: 'user' | 'admin' },
    @Param('id') id: string,
  ) {
    return this.videoRequestService.stopRequest(id, user.id, {
      isAdmin: user.role === 'admin',
    });
  }

  @Post(':id/retry')
  @UseGuards(JwtAuthGuard)
  async retry(
    @ReqUser() user: { id: string; role?: 'user' | 'admin' },
    @Param('id') id: string,
  ) {
    return this.videoRequestService.retryFailed(id, user.id, {
      isAdmin: user.role === 'admin',
    });
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

  @Get('admin/pending-youtube')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async getPendingYoutubeApprovals() {
    return this.videoRequestService.findPendingYoutubeApprovals();
  }

  @Post(':id/admin/approve-youtube')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async approveYoutubeUpload(
    @Param('id') id: string,
    @ReqUser() user: { id: string },
  ) {
    return this.videoRequestService.approveYoutubeUpload(id, user.id);
  }

  @Post(':id/admin/reject-youtube')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async rejectYoutubeUpload(
    @Param('id') id: string,
    @ReqUser() user: { id: string },
  ) {
    return this.videoRequestService.rejectYoutubeUpload(id, user.id);
  }
}
