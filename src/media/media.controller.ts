import { BadRequestException, Body, Controller, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { User } from '../auth/user.decorator';
import { R2Service } from './r2.service';
import { PresignR2UploadDto } from './dto/presign-r2-upload.dto';
import { CompleteR2UploadDto } from './dto/complete-r2-upload.dto';

@Controller('api/media/r2')
export class MediaController {
  constructor(private readonly r2: R2Service) {}

  @Post('presign-upload')
  @UseGuards(JwtAuthGuard)
  async presignUpload(@User() user: { id: string }, @Body() dto: PresignR2UploadDto) {
    this.r2.assertEnabled();
    try {
      if (dto.scope === 'remotion') {
        return await this.r2.presignPutRemotionAsset(user.id, dto.contentType);
      }
      return await this.r2.presignPut(user.id, dto.contentType);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new BadRequestException(msg);
    }
  }

  @Post('complete')
  @UseGuards(JwtAuthGuard)
  async complete(@User() user: { id: string }, @Body() dto: CompleteR2UploadDto) {
    this.r2.assertEnabled();
    try {
      return await this.r2.verifyUploadedObject(user.id, dto.objectKey.trim());
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new BadRequestException(msg);
    }
  }
}
