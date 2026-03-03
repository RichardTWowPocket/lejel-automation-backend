import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios from 'axios';
import { VideoRequest, VideoRequestStatus } from '../entities/video-request.entity';
import { CreateVideoRequestDto } from './dto/create-video-request.dto';
import { UpdateVideoRequestDto } from './dto/update-video-request.dto';

@Injectable()
export class VideoRequestService {
  constructor(
    @InjectRepository(VideoRequest)
    private readonly videoRequestRepository: Repository<VideoRequest>,
    private readonly configService: ConfigService,
  ) {}

  async create(userId: string, dto: CreateVideoRequestDto): Promise<VideoRequest> {
    const request = this.videoRequestRepository.create({
      userId,
      fullScript: dto.fullScript,
      segmentedScripts: dto.segmentedScripts,
      status: 'pending',
      submittedAt: new Date(),
      connectionId: dto.connectionId || null,
    });
    const saved = await this.videoRequestRepository.save(request);

    const baseUrl = this.configService.get<string>('BASE_URL', 'http://localhost:3000');
    const callbackUrl = `${baseUrl}/api/video-requests/${saved.id}/callback`;
    const webhookUrl = this.configService.get<string>('N8N_WEBHOOK_URL');

    if (webhookUrl) {
      try {
        await axios.post(
          webhookUrl,
          {
            requestId: saved.id,
            fullScript: saved.fullScript,
            segmentedScripts: saved.segmentedScripts,
            callbackUrl,
            connectionId: saved.connectionId || undefined,
            uploadToYoutube: !!saved.connectionId,
            uploadApiUrl: saved.connectionId ? `${baseUrl.replace(/\/$/, '')}/api/oauth/youtube/upload` : undefined,
          },
          { timeout: 10000 },
        );
      } catch (err: any) {
        await this.videoRequestRepository.update(saved.id, {
          status: 'failed',
          errorMessage: err.message || 'Failed to trigger n8n webhook',
          completedAt: new Date(),
        });
        throw new BadRequestException(
          'Video request created but failed to trigger pipeline: ' + (err.message || 'unknown'),
        );
      }
    }

    return saved;
  }

  async findAllByUser(userId: string, status?: VideoRequestStatus) {
    const qb = this.videoRequestRepository
      .createQueryBuilder('vr')
      .leftJoinAndSelect('vr.user', 'user')
      .where('vr.userId = :userId', { userId })
      .orderBy('vr.createdAt', 'DESC');

    if (status) {
      qb.andWhere('vr.status = :status', { status });
    }

    const list = await qb.getMany();
    return list.map((vr) => ({
      id: vr.id,
      fullScript: vr.fullScript,
      segmentedScripts: vr.segmentedScripts,
      status: vr.status,
      createdAt: vr.createdAt,
      updatedAt: vr.updatedAt,
      submittedAt: vr.submittedAt,
      completedAt: vr.completedAt,
      resultUrl: vr.resultUrl,
      errorMessage: vr.errorMessage,
      connectionId: vr.connectionId || undefined,
      user: vr.user ? { id: vr.user.id, name: vr.user.name, email: vr.user.email } : undefined,
    }));
  }

  async findOne(id: string, userId: string) {
    const request = await this.videoRequestRepository.findOne({
      where: { id },
      relations: ['user'],
    });
    if (!request) {
      throw new NotFoundException('Video request not found');
    }
    if (request.userId !== userId) {
      throw new ForbiddenException('Not allowed to access this request');
    }
    return {
      id: request.id,
      fullScript: request.fullScript,
      segmentedScripts: request.segmentedScripts,
      status: request.status,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
      submittedAt: request.submittedAt,
      completedAt: request.completedAt,
      resultUrl: request.resultUrl,
      errorMessage: request.errorMessage,
      connectionId: request.connectionId || undefined,
      user: request.user
        ? { id: request.user.id, name: request.user.name, email: request.user.email }
        : undefined,
    };
  }

  async update(id: string, userId: string, dto: UpdateVideoRequestDto) {
    const request = await this.videoRequestRepository.findOne({ where: { id } });
    if (!request) {
      throw new NotFoundException('Video request not found');
    }
    if (request.userId !== userId) {
      throw new ForbiddenException('Not allowed to update this request');
    }
    if (request.status !== 'draft') {
      throw new BadRequestException('Only draft requests can be updated');
    }
    if (dto.fullScript !== undefined) request.fullScript = dto.fullScript;
    if (dto.segmentedScripts !== undefined) request.segmentedScripts = dto.segmentedScripts;
    await this.videoRequestRepository.save(request);
    return request;
  }

  async handleCallback(
    id: string,
    secret: string,
    status: string,
    resultUrl?: string,
    errorMessage?: string,
  ) {
    const expectedSecret = this.configService.get<string>('CALLBACK_SECRET');
    if (!expectedSecret || secret !== expectedSecret) {
      throw new ForbiddenException('Invalid callback secret');
    }

    const request = await this.videoRequestRepository.findOne({ where: { id } });
    if (!request) {
      throw new NotFoundException('Video request not found');
    }

    const update: Partial<VideoRequest> = { status: status as VideoRequestStatus };
    if (status === 'completed' || status === 'failed') {
      update.completedAt = new Date();
      if (resultUrl) update.resultUrl = resultUrl;
      if (errorMessage) update.errorMessage = errorMessage;
    }

    await this.videoRequestRepository.update(id, update);
    return { ok: true };
  }
}
