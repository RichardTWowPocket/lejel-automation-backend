import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from '../auth/admin.guard';
import { AutomationService } from './automation.service';
import { CreateAutomationChannelDto } from './dto/create-automation-channel.dto';
import { UpdateAutomationChannelDto } from './dto/update-automation-channel.dto';

@Controller('api/automation/channels')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AutomationAdminController {
  constructor(private readonly automationService: AutomationService) {}

  @Get()
  list() {
    return this.automationService.listChannels();
  }

  @Post()
  create(@Body() dto: CreateAutomationChannelDto) {
    return this.automationService.createChannel(dto);
  }

  @Get(':id/runs')
  listRuns(
    @Param('id') id: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.automationService.listRuns(id, page, limit);
  }

  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.automationService.getChannel(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateAutomationChannelDto) {
    return this.automationService.updateChannel(id, dto);
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    await this.automationService.softDeleteChannel(id);
    return { ok: true };
  }

  @Post(':id/regenerate-secret')
  regenerateSecret(@Param('id') id: string) {
    return this.automationService.regenerateWebhookSecret(id);
  }
}
