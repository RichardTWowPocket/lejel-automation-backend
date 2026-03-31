import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProfileController } from './profile.controller';
import { ProfilePreviewService } from './profile-preview.service';
import { ProfileService } from './profile.service';

@Module({
  imports: [AuthModule],
  controllers: [ProfileController],
  providers: [ProfileService, ProfilePreviewService],
  exports: [ProfileService],
})
export class ProfileModule {}
