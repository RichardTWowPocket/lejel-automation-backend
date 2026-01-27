import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import { AssemblyAIService } from '../assemblyai/assemblyai.service';

@Injectable()
export class TranscriptionService {
  private readonly logger = new Logger(TranscriptionService.name);

  constructor(
    private configService: ConfigService,
    private assemblyAIService: AssemblyAIService,
  ) {
    this.logger.log('[TranscriptionService] Initialized with AssemblyAI');
  }

  async transcribe(
    audioFilePath: string,
    language?: string,
    responseFormat: string = 'verbose_json',
    useWhisperTimestamp?: boolean,
  ): Promise<{ result: any; transcriptId: string }> {
    // Check if file exists
    if (!fs.existsSync(audioFilePath)) {
      throw new BadRequestException('Audio file not found');
    }

    // Use AssemblyAI for transcription
    this.logger.log(`[TranscriptionService] Using AssemblyAI for transcription (language: ${language || 'ko'})`);

    try {
      const { whisperFormat, transcriptId } = await this.assemblyAIService.transcribe(
        audioFilePath,
        language || 'ko', // Default to Korean
      );

      this.logger.log(`[TranscriptionService] AssemblyAI transcription completed successfully (transcript ID: ${transcriptId})`);
      return {
        result: whisperFormat,
        transcriptId: transcriptId,
      };
    } catch (error: any) {
      this.logger.error(`[TranscriptionService] AssemblyAI transcription failed: ${error.message}`);
      throw new BadRequestException(
        `Failed to transcribe audio with AssemblyAI: ${error.message}`,
      );
    }
  }
}
