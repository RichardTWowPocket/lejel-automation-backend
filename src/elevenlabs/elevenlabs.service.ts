import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const ELEVENLABS_TTS_URL = 'https://api.elevenlabs.io/v1/text-to-speech';

/** eleven_multilingual_v2 allows ~10k chars; stay under to leave API headroom. */
const MAX_TTS_CHARS_PER_REQUEST = 7500;

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

  /** Split on sentence / paragraph boundaries so chunks stay under the API limit. */
  private splitTextForTts(text: string): string[] {
    const t = text.trim();
    if (!t) return [];
    if (t.length <= MAX_TTS_CHARS_PER_REQUEST) return [t];

    const out: string[] = [];
    let start = 0;
    while (start < t.length) {
      let end = Math.min(start + MAX_TTS_CHARS_PER_REQUEST, t.length);
      if (end < t.length) {
        const slice = t.slice(start, end);
        let bestBreak = -1;
        const candidates = ['\n\n', '\n', '. ', '。', '! ', '? ', '；', '; '];
        for (const br of candidates) {
          const idx = slice.lastIndexOf(br);
          if (idx > MAX_TTS_CHARS_PER_REQUEST * 0.35) {
            const endPos = idx + br.length;
            if (endPos > bestBreak) bestBreak = endPos;
          }
        }
        if (bestBreak > 0) end = start + bestBreak;
      }
      const piece = t.slice(start, end).trim();
      if (piece) out.push(piece);
      start = end;
    }
    return out;
  }

  private async concatMp3WithFfmpeg(inputPaths: string[], outputPath: string): Promise<void> {
    const listPath = path.join(path.dirname(outputPath), `elevenlabs-concat-${Date.now()}.txt`);
    const esc = (p: string) => p.replace(/\\/g, '/').replace(/'/g, "'\\''");
    fs.writeFileSync(listPath, inputPaths.map((p) => `file '${esc(p)}'`).join('\n'), 'utf-8');

    await new Promise<void>((resolve, reject) => {
      const ff = spawn('ffmpeg', [
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listPath,
        '-c',
        'copy',
        '-y',
        outputPath,
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      ff.stderr?.on('data', (c) => {
        stderr += String(c);
      });
      ff.on('error', reject);
      ff.on('exit', (code) => {
        try {
          fs.unlinkSync(listPath);
        } catch {
          /* ok */
        }
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg mp3 concat failed (${code}): ${stderr.slice(-800)}`));
      });
    });
  }

  private async synthesizeOneChunk(
    text: string,
    apiKey: string,
    effectiveVoiceId: string,
    partLabel: string,
  ): Promise<Buffer> {
    const response = await axios.post(
      `${ELEVENLABS_TTS_URL}/${effectiveVoiceId}`,
      {
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0,
          use_speaker_boost: true,
        },
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': apiKey,
          Accept: 'audio/mpeg',
        },
        responseType: 'arraybuffer',
        timeout: 240000,
      },
    );
    const buffer = Buffer.from(response.data as ArrayBuffer);
    this.logger.log(`[ElevenLabsService] ${partLabel}: ${buffer.length} bytes, ${text.length} chars`);
    return buffer;
  }

  /**
   * Generate speech from full text and save to a temp file. Returns path to the audio file.
   * Long text is split into multiple API calls (limit per request) and concatenated.
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

    const chunks = this.splitTextForTts(text);
    this.logger.log(
      `[ElevenLabsService] TTS ${chunks.length} chunk(s), total ${text.length} chars (limit ${MAX_TTS_CHARS_PER_REQUEST}/req)`,
    );

    const tempPartPaths: string[] = [];

    try {
      for (let i = 0; i < chunks.length; i += 1) {
        const partPath = path.join(tempDir, `elevenlabs_part_${Date.now()}_${i}.mp3`);
        const buf = await this.synthesizeOneChunk(
          chunks[i],
          apiKey,
          effectiveVoiceId,
          `Part ${i + 1}/${chunks.length}`,
        );
        fs.writeFileSync(partPath, buf);
        tempPartPaths.push(partPath);
      }

      const outputPath = path.join(tempDir, `script_to_video_audio_${Date.now()}.mp3`);

      if (tempPartPaths.length === 1) {
        fs.renameSync(tempPartPaths[0], outputPath);
      } else {
        await this.concatMp3WithFfmpeg(tempPartPaths, outputPath);
      }

      this.logger.log(`[ElevenLabsService] Generated speech saved to ${outputPath}`);
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
    } finally {
      for (const p of tempPartPaths) {
        try {
          if (fs.existsSync(p)) fs.unlinkSync(p);
        } catch {
          /* best-effort */
        }
      }
    }
  }
}
