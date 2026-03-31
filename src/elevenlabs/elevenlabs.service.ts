import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

const ELEVENLABS_TTS_URL = 'https://api.elevenlabs.io/v1/text-to-speech';

@Injectable()
export class ElevenLabsService {
  private readonly logger = new Logger(ElevenLabsService.name);

  constructor(private readonly configService: ConfigService) {}

  private getApiKey(): string {
    const key = this.configService.get<string>('ELEVENLABS_API_KEY');
    if (!key?.trim()) {
      throw new BadRequestException('ELEVENLABS_API_KEY is not configured');
    }
    return key.trim();
  }

  /**
   * Generate speech from full text and save to a temp file. Returns path to the audio file.
   */
  async generateSpeech(fullText: string, voiceId: string): Promise<string> {
    const apiKey = this.getApiKey();
    const effectiveVoiceId = (voiceId || this.configService.get<string>('ELEVENLABS_VOICE_ID') || '').trim();
    if (!effectiveVoiceId) {
      throw new BadRequestException('voiceId is required or set ELEVENLABS_VOICE_ID');
    }

    const text = (fullText || '').trim();
    if (!text) {
      throw new BadRequestException('fullText cannot be empty');
    }

    const tempDir = path.join(process.cwd(), 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    const outputPath = path.join(tempDir, `script_to_video_audio_${Date.now()}.mp3`);

    try {
      const response = await axios.post(
        `${ELEVENLABS_TTS_URL}/${effectiveVoiceId}`,
        {
          text,
          model_id: 'eleven_multilingual_v2',
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'xi-api-key': apiKey,
            Accept: 'audio/mpeg',
          },
          responseType: 'arraybuffer',
          timeout: 120000,
        },
      );

      const buffer = Buffer.from(response.data as ArrayBuffer);
      fs.writeFileSync(outputPath, buffer);
      this.logger.log(`[ElevenLabsService] Generated speech saved to ${outputPath} (${buffer.length} bytes)`);
      return outputPath;
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      if (axios.isAxiosError(err)) {
        const status = err.response?.status;
        const data = err.response?.data;
        let msg = err.message;
        if (typeof data === 'object' && data?.detail?.message) {
          msg = data.detail.message;
        } else if (Buffer.isBuffer(data)) {
          msg = `HTTP ${status}`;
        }
        this.logger.error(`[ElevenLabsService] ElevenLabs TTS failed: ${msg}`);
        throw new BadRequestException(`ElevenLabs API error${status ? ` (${status})` : ''}: ${msg}`);
      }
      this.logger.error(`[ElevenLabsService] generateSpeech error: ${err.message}`, err.stack);
      throw new BadRequestException(`Generate speech failed: ${err.message}`);
    }
  }
}
