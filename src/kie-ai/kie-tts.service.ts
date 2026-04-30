import { Injectable, Logger, BadRequestException, InternalServerErrorException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

const KIE_BASE_URL = 'https://api.kie.ai';
const KIE_TTS_MODEL = 'elevenlabs/text-to-speech-multilingual-v2';
const KIE_POLL_INTERVAL_MS = 3000;
const KIE_MAX_POLL_ATTEMPTS = 120; // ~6 minutes max

interface KieTtsCreateResponse {
  code: number;
  msg: string;
  data: { taskId: string };
}

interface KieTtsRecordResponse {
  code: number;
  msg: string;
  data: {
    taskId: string;
    model: string;
    state: 'waiting' | 'queuing' | 'generating' | 'success' | 'fail';
    param?: string;
    resultJson?: string;
    failCode?: string;
    failMsg?: string;
  } | null;
}

interface KieTtsResult {
  resultUrls?: string[];
}

@Injectable()
export class KieTtsService {
  private readonly logger = new Logger(KieTtsService.name);

  constructor(private readonly configService: ConfigService) {}

  private getApiKey(): string {
    const key = this.configService.get<string>('KIE_AI_API_KEY');
    if (!key?.trim()) {
      throw new BadRequestException('KIE_AI_API_KEY is not configured');
    }
    return key.trim();
  }

  /**
   * Generate speech using Kie.ai's ElevenLabs TTS Multilingual V2.
   * Returns path to the downloaded MP3 file.
   */
  async generateSpeech(
    text: string,
    options?: {
      voice?: string;
      stability?: number;
      similarityBoost?: number;
      style?: number;
      speed?: number;
    },
  ): Promise<string> {
    const apiKey = this.getApiKey();
    const fullText = (text || '').trim();
    if (!fullText) {
      throw new BadRequestException('Text cannot be empty');
    }

    // 1. Create task
    const taskId = await this.createTask(apiKey, fullText, options);
    this.logger.log(`[KieTtsService] Task created: ${taskId}`);

    // 2. Poll until complete
    const resultUrl = await this.pollUntilComplete(apiKey, taskId);
    this.logger.log(`[KieTtsService] Result URL ready: ${resultUrl}`);

    // 3. Download MP3
    const outputPath = await this.downloadMp3(resultUrl);
    this.logger.log(`[KieTtsService] Downloaded to ${outputPath}`);

    return outputPath;
  }

  private async createTask(
    apiKey: string,
    text: string,
    options?: {
      voice?: string;
      stability?: number;
      similarityBoost?: number;
      style?: number;
      speed?: number;
    },
  ): Promise<string> {
    const payload = {
      model: KIE_TTS_MODEL,
      input: {
        text,
        voice: options?.voice || 'Rachel',
        stability: options?.stability ?? 0.5,
        similarity_boost: options?.similarityBoost ?? 0.75,
        style: options?.style ?? 0,
        speed: options?.speed ?? 1,
        timestamps: false,
        previous_text: '',
        next_text: '',
        language_code: '',
        nsfw_checker: true,
      },
    };

    try {
      const res = await axios.post<KieTtsCreateResponse>(
        `${KIE_BASE_URL}/api/v1/jobs/createTask`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        },
      );

      if (res.data.code !== 200 || !res.data.data?.taskId) {
        throw new BadRequestException(
          `Kie TTS create task failed: ${res.data.msg || 'unknown error'}`,
        );
      }

      return res.data.data.taskId;
    } catch (err: any) {
      if (axios.isAxiosError(err)) {
        const msg = JSON.stringify(err.response?.data ?? err.message).slice(0, 400);
        throw new BadRequestException(`Kie TTS create task error: ${msg}`);
      }
      throw err;
    }
  }

  private async pollUntilComplete(apiKey: string, taskId: string): Promise<string> {
    for (let attempt = 0; attempt < KIE_MAX_POLL_ATTEMPTS; attempt++) {
      await this.delay(KIE_POLL_INTERVAL_MS);

      const res = await axios.get<KieTtsRecordResponse>(
        `${KIE_BASE_URL}/api/v1/jobs/recordInfo`,
        {
          params: { taskId },
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
          timeout: 15000,
        },
      );

      const data = res.data.data;
      if (!data) {
        this.logger.warn(`[KieTtsService] Poll ${attempt + 1}: no data`);
        continue;
      }

      const state = data.state;
      this.logger.debug(`[KieTtsService] Poll ${attempt + 1}: state=${state}`);

      if (state === 'success') {
        if (!data.resultJson) {
          throw new InternalServerErrorException('Kie TTS success but no resultJson');
        }
        let result: KieTtsResult;
        try {
          result = JSON.parse(data.resultJson) as KieTtsResult;
        } catch {
          throw new InternalServerErrorException('Kie TTS resultJson is invalid JSON');
        }
        const url = result.resultUrls?.[0];
        if (!url) {
          throw new InternalServerErrorException('Kie TTS success but no resultUrls');
        }
        return url;
      }

      if (state === 'fail') {
        throw new BadRequestException(
          `Kie TTS failed: ${data.failMsg || data.failCode || 'unknown'}`,
        );
      }

      // waiting / queuing / generating — keep polling
    }

    throw new ServiceUnavailableException(
      `Kie TTS polling timed out after ${KIE_MAX_POLL_ATTEMPTS} attempts`,
    );
  }

  private async downloadMp3(url: string): Promise<string> {
    const tempDir = path.join(process.cwd(), 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const outputPath = path.join(tempDir, `kie_tts_${Date.now()}.mp3`);

    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 60000,
    });

    fs.writeFileSync(outputPath, Buffer.from(response.data as ArrayBuffer));
    return outputPath;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
