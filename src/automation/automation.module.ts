import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AutomationChannel } from '../entities/automation-channel.entity';
import { AutomationRun } from '../entities/automation-run.entity';
import { OAuthCredential } from '../entities/oauth-credential.entity';
import { User } from '../entities/user.entity';
import { LlmModule } from '../llm/llm.module';
import { ProfileModule } from '../profile/profile.module';
import { VideoRequestModule } from '../video-request/video-request.module';
import { AutomationService } from './automation.service';
import { AutomationAdminController } from './automation-admin.controller';
import { AutomationRunsController } from './automation-runs.controller';
import { AutomationWebhookController } from './automation-webhook.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AutomationChannel,
      AutomationRun,
      OAuthCredential,
      User,
    ]),
    LlmModule,
    ProfileModule,
    forwardRef(() => VideoRequestModule),
  ],
  controllers: [AutomationAdminController, AutomationRunsController, AutomationWebhookController],
  providers: [AutomationService],
  exports: [AutomationService],
})
export class AutomationModule {}
