import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LlmModule } from '../llm/llm.module';
import { ElevenLabsModule } from '../elevenlabs/elevenlabs.module';
import { KieAiModule } from '../kie-ai/kie-ai.module';
import { AssemblyAIModule } from '../assemblyai/assemblyai.module';
import { ProfileModule } from '../profile/profile.module';
import { UploadMediaService } from './upload-media.service';
import { ScriptToVideoService } from './script-to-video.service';
import { VideoController } from './video.controller';
import { VideoProcessingService } from './video-processing.service';
import { RequestFsService } from './request-fs.service';

@Module({
  imports: [
    AuthModule,
    LlmModule,
    ElevenLabsModule,
    KieAiModule,
    AssemblyAIModule,
    ProfileModule,
  ],
  controllers: [VideoController],
  providers: [
    UploadMediaService,
    ScriptToVideoService,
    VideoProcessingService,
    RequestFsService,
  ],
  exports: [
    UploadMediaService,
    ScriptToVideoService,
    VideoProcessingService,
    RequestFsService,
  ],
})
export class VideoModule {}
