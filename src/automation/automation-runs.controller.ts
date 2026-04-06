import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from '../auth/admin.guard';
import { AutomationService } from './automation.service';

@Controller('api/automation/runs')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AutomationRunsController {
  constructor(private readonly automationService: AutomationService) {}

  @Get(':runId')
  getOne(@Param('runId') runId: string) {
    return this.automationService.getRun(runId);
  }
}
