import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { ApiKeyOrJwtGuard } from '../auth/api-key-or-jwt.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateProfileDto } from './dto/create-profile.dto';
import { RenderProfilePreviewDto } from './dto/render-profile-preview.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ProfilePreviewService } from './profile-preview.service';
import { ProfileService } from './profile.service';

@Controller('api/profiles')
export class ProfileController {
  constructor(
    private readonly profileService: ProfileService,
    private readonly profilePreviewService: ProfilePreviewService,
  ) {}

  @Get()
  @UseGuards(ApiKeyOrJwtGuard)
  async listProfiles() {
    return this.profileService.listProfiles();
  }

  @Get(':id')
  @UseGuards(ApiKeyOrJwtGuard)
  async getProfile(@Param('id') id: string) {
    return this.profileService.getProfile(id);
  }

  @Post()
  @UseGuards(JwtAuthGuard, AdminGuard)
  async createProfile(@Body() dto: CreateProfileDto) {
    return this.profileService.createProfile(dto);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async updateProfile(@Param('id') id: string, @Body() dto: UpdateProfileDto) {
    return this.profileService.updateProfile(id, dto);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async deleteProfile(@Param('id') id: string) {
    return this.profileService.deleteProfile(id);
  }

  @Post('preview/render')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async renderProfilePreview(@Body() dto: RenderProfilePreviewDto) {
    const imageDataUrl = await this.profilePreviewService.renderPreview(dto);
    return { imageDataUrl };
  }
}
