import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { VideoRequest } from '../entities/video-request.entity';
import { AuthModule } from '../auth/auth.module';
import { VideoRequestController } from './video-request.controller';
import { VideoRequestService } from './video-request.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([VideoRequest]),
    AuthModule,
  ],
  controllers: [VideoRequestController],
  providers: [VideoRequestService],
  exports: [VideoRequestService],
})
export class VideoRequestModule {}
