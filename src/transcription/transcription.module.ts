import { Module } from '@nestjs/common';
import { TranscriptionController } from './transcription.controller';
import { TranscriptionService } from './transcription.service';
import { ContainerManagerService } from './container-manager.service';

@Module({
  controllers: [TranscriptionController],
  providers: [TranscriptionService, ContainerManagerService],
})
export class TranscriptionModule {}



