import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { VideoRequest } from '../entities/video-request.entity';
import { ElevenLabsService } from '../elevenlabs/elevenlabs.service';
import { AssemblyAIService } from '../assemblyai/assemblyai.service';
import { ProfileService } from '../profile/profile.service';
import { LlmService, SupportedLlmModel } from '../llm/llm.service';
import { KieAiService, KieMarketImageModel } from '../kie-ai/kie-ai.service';
import { RequestFsService } from './request-fs.service';
import { TextStyleConfig, VideoProfile } from './types/profile-config.interface';
import { resolveDimensions, Ratio, Resolution } from '../profile/profile-dimensions';
import {
  assertGptImage15TextToImageRatio,
  assertGrokImagineTextToImageRatio,
  validateKieMarketImageModelForProfile,
  validateKieMarketVideoModelForProfile,
} from './kie-model-profile-validation';
import {
  headlineHasHighlightTags,
  stripHeadlineHighlightTags,
  writeHeadlineHighlightAssFile,
} from './headline-highlight-ass';

/** Thrown when the user stops the request; worker exits without marking completed/failed. */
export class VideoPipelineCancelledError extends Error {
  readonly code = 'PIPELINE_CANCELLED';

  constructor() {
    super('Video pipeline cancelled');
    this.name = 'VideoPipelineCancelledError';
  }
}

@Injectable()
export class ScriptToVideoService {
  private readonly logger = new Logger(ScriptToVideoService.name);
  private readonly allowedVideoDurations = [5, 6, 10];

  constructor(
    private readonly elevenLabsService: ElevenLabsService,
    private readonly assemblyAiService: AssemblyAIService,
    private readonly profileService: ProfileService,
    private readonly llmService: LlmService,
    private readonly kieAiService: KieAiService,
    private readonly requestFsService: RequestFsService,
  ) {}

  private async pipelineAbortIfNeeded(abortCheck?: () => Promise<boolean>): Promise<void> {
    if (!abortCheck) return;
    if (await abortCheck()) {
      throw new VideoPipelineCancelledError();
    }
  }

  /**
   * ElevenLabs (and long single-shot TTS) often drifts quieter over time. Normalize dynamics and
   * peak-limit so artifact MP3 and the muxed AAC track stay consistently intelligible.
   * Optional: NARRATION_AUDIO_GAIN_DB (e.g. 1.5) for extra dB after normalization.
   */
  private async normalizeNarrationMp3(sourcePath: string, destPath: string): Promise<void> {
    const gainRaw = process.env.NARRATION_AUDIO_GAIN_DB?.trim();
    const gainDb = gainRaw !== undefined && gainRaw !== '' ? Number(gainRaw) : 0;
    const afParts = [
      // Level drift over long TTS. `b=1` enables alt boundary mode so EOF does not ramp gain down
      // (default dynaudnorm treats the last frames as a "boundary" and often sounds like a ~few-second fade-out).
      'dynaudnorm=g=31:f=200:p=0.95:m=15:b=1',
    ];
    if (Number.isFinite(gainDb) && gainDb !== 0) {
      afParts.push(`volume=${gainDb}dB`);
    }
    afParts.push('alimiter=limit=0.98:attack=2:release=50');

    await this.runFfmpeg([
      '-i',
      sourcePath,
      '-af',
      afParts.join(','),
      '-c:a',
      'libmp3lame',
      '-q:a',
      '2',
      '-y',
      destPath,
    ]);
  }

  private async runFfmpeg(args: string[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      ff.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      ff.on('error', reject);
      ff.on('exit', (code) => {
        if (code === 0) return resolve();
        reject(new Error(`ffmpeg failed (${code}): ${stderr.slice(-1200)}`));
      });
    });
  }

  /** Container / stream duration in seconds (ffprobe format.duration). */
  private async probeMediaDurationSeconds(filePath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const pr = spawn(
        'ffprobe',
        [
          '-v',
          'error',
          '-show_entries',
          'format=duration',
          '-of',
          'default=noprint_wrappers=1:nokey=1',
          filePath,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let out = '';
      let err = '';
      pr.stdout.on('data', (chunk) => {
        out += String(chunk);
      });
      pr.stderr.on('data', (chunk) => {
        err += String(chunk);
      });
      pr.on('error', reject);
      pr.on('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`ffprobe failed (${code}): ${err.slice(-800)}`));
          return;
        }
        const sec = parseFloat(out.trim());
        resolve(Number.isFinite(sec) && sec > 0 ? sec : 0);
      });
    });
  }

  /**
   * Master output length: at least transcript end (last word) and at least probed file length,
   * so mux does not clip narration when STT ends before the MP3.
   * Optional NARRATION_MAX_TAIL_BEYOND_TRANSCRIPT_SEC: cap how far past transcript end we trust file duration
   * (mitigates bogus long containers).
   */
  private resolveMasterTimelineEndSec(transcriptEndSec: number, audioFileDurationSec: number): number {
    if (!(transcriptEndSec > 0)) {
      return Math.max(transcriptEndSec, audioFileDurationSec);
    }
    const capRaw = process.env.NARRATION_MAX_TAIL_BEYOND_TRANSCRIPT_SEC?.trim();
    const cap = capRaw !== undefined && capRaw !== '' ? Number(capRaw) : NaN;
    if (Number.isFinite(cap) && cap >= 0) {
      const audioClamped = Math.min(audioFileDurationSec, transcriptEndSec + cap);
      return Math.max(transcriptEndSec, audioClamped);
    }
    return Math.max(transcriptEndSec, audioFileDurationSec);
  }

  /** Newest non-trivial MP3 in the request audio folder (for failed-job resume). */
  private findLatestMp3InDir(dir: string): string | null {
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir).filter((f) => /\.mp3$/i.test(f));
    if (!files.length) return null;
    const ranked = files
      .map((name) => {
        const p = path.join(dir, name);
        try {
          const st = fs.statSync(p);
          return { p, mtime: st.mtimeMs, size: st.size };
        } catch {
          return null;
        }
      })
      .filter((x): x is { p: string; mtime: number; size: number } => x !== null && x.size > 256);
    if (!ranked.length) return null;
    ranked.sort((a, b) => b.mtime - a.mtime);
    return ranked[0].p;
  }

  private segmentMp4LooksValid(filePath: string): boolean {
    try {
      const st = fs.statSync(filePath);
      return st.isFile() && st.size > 512;
    } catch {
      return false;
    }
  }

  private loadTranscriptFromDisk(
    transcriptPath: string,
  ): { whisperFormat: unknown; transcriptId: string } | null {
    try {
      const raw = JSON.parse(fs.readFileSync(transcriptPath, 'utf-8')) as {
        whisperFormat?: unknown;
        transcriptId?: string;
      };
      if (raw?.whisperFormat) {
        return {
          whisperFormat: raw.whisperFormat,
          transcriptId: typeof raw.transcriptId === 'string' ? raw.transcriptId : 'from-disk',
        };
      }
    } catch {
      /* corrupt or missing */
    }
    return null;
  }

  private normalize(input: string): string {
    return (input || '')
      .toLowerCase()
      .replace(/[^a-z0-9\u00C0-\u024F\u0400-\u04FF\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private splitWords(input: string): string[] {
    const n = this.normalize(input);
    return n ? n.split(' ') : [];
  }

  private mapSegmentTimings(
    segments: string[],
    words: Array<{ word: string; start: number; end: number }>,
    totalDuration: number,
  ): Array<{ index: number; text: string; start: number; end: number; duration: number }> {
    if (!words.length) {
      const even = totalDuration > 0 ? totalDuration / Math.max(segments.length, 1) : 3;
      return segments.map((text, i) => ({
        index: i,
        text,
        start: i * even,
        end: (i + 1) * even,
        duration: even,
      }));
    }

    const segCharCounts = segments.map((s) => this.normalize(s).length || 1);
    const totalSegChars = segCharCounts.reduce((a, b) => a + b, 0);

    const wordCharCounts = words.map((w) => this.normalize(w.word).length || 1);
    const totalWordChars = wordCharCounts.reduce((a, b) => a + b, 0);

    const segCumChars: number[] = [];
    let cum = 0;
    for (const c of segCharCounts) {
      cum += c;
      segCumChars.push(cum);
    }

    const wordCumChars: number[] = [];
    let wCum = 0;
    for (const c of wordCharCounts) {
      wCum += c;
      wordCumChars.push(wCum);
    }

    const out: Array<{ index: number; text: string; start: number; end: number; duration: number }> = [];
    let wordCursor = 0;

    for (let i = 0; i < segments.length; i += 1) {
      const targetCum = (segCumChars[i] / totalSegChars) * totalWordChars;

      let endIdx = wordCursor;
      for (let j = wordCursor; j < words.length; j += 1) {
        endIdx = j;
        if (wordCumChars[j] >= targetCum) break;
      }
      if (i === segments.length - 1) endIdx = words.length - 1;

      const startWord = words[wordCursor];
      const endWord = words[endIdx];
      const start = startWord?.start ?? 0;
      const end = endWord?.end ?? start + 1;

      out.push({
        index: i,
        text: segments[i],
        start,
        end,
        duration: Math.max(0.2, end - start),
      });

      wordCursor = Math.min(endIdx + 1, words.length - 1);
    }

    return out;
  }

  private toSrtTime(seconds: number): string {
    const ms = Math.max(0, Math.round(seconds * 1000));
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const rem = ms % 1000;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(rem).padStart(3, '0')}`;
  }

  /** Match profile preview / ASS alignment grid (1–9). */
  private assAnchorX(alignment: number): 'left' | 'center' | 'right' {
    if ([1, 4, 7].includes(alignment)) return 'left';
    if ([3, 6, 9].includes(alignment)) return 'right';
    return 'center';
  }

  private assAnchorY(alignment: number): 'top' | 'middle' | 'bottom' {
    if ([7, 8, 9].includes(alignment)) return 'top';
    if ([4, 5, 6].includes(alignment)) return 'middle';
    return 'bottom';
  }

  /** ffmpeg drawtext x/y expressions; same geometry as profile-preview.service. */
  private headlineExprX(style: TextStyleConfig): string {
    const ax = this.assAnchorX(style.alignment ?? 2);
    const xOff = Number(style.xOffset) || 0;
    if (ax === 'left') return `20+${xOff}`;
    if (ax === 'right') return `w-text_w-20+${xOff}`;
    return `(w-text_w)/2+${xOff}`;
  }

  private headlineExprY(style: TextStyleConfig): string {
    const ay = this.assAnchorY(style.alignment ?? 2);
    const yOff = Number(style.yOffset) || 0;
    if (ay === 'top') return `20+${yOff}`;
    if (ay === 'middle') return `(h-text_h)/2+${yOff}`;
    return `h-text_h-20-${yOff}`;
  }

  /**
   * drawtext=text='…' lives inside a -vf filtergraph where `:` separates options.
   * Unescaped `:` (e.g. profile name "Default Long Form (16:9)") breaks parsing with errors like `near '9):font=`.
   */
  private escapeDrawtextQuotedText(s: string): string {
    return (s || '')
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/:/g, '\\:')
      .replace(/%/g, '%%');
  }

  /** ASS \\pos + \\an so xOffset/yOffset work (Style margins alone do not move centered subs horizontally). */
  private assSubtitlePosPrefix(style: TextStyleConfig, playResX: number, playResY: number): string {
    const a = style.alignment ?? 2;
    const ax = this.assAnchorX(a);
    const ay = this.assAnchorY(a);
    const xOff = Number(style.xOffset) || 0;
    const yOff = Number(style.yOffset) || 0;
    const m = 20;
    let x = playResX / 2;
    let y = playResY / 2;
    if (ay === 'top') {
      y = m + yOff;
      if (ax === 'left') x = m + xOff;
      else if (ax === 'right') x = playResX - m + xOff;
      else x = playResX / 2 + xOff;
    } else if (ay === 'middle') {
      if (ax === 'left') x = m + xOff;
      else if (ax === 'right') x = playResX - m + xOff;
      else x = playResX / 2 + xOff;
      y = playResY / 2 + yOff;
    } else {
      y = playResY - m - yOff;
      if (ax === 'left') x = m + xOff;
      else if (ax === 'right') x = playResX - m + xOff;
      else x = playResX / 2 + xOff;
    }
    return `{\\an${a}\\pos(${Math.round(x)},${Math.round(y)})}`;
  }

  /** For ASS \\k karaoke: Secondary = unspoken, Primary = highlighted (swap vs plain dialogue). */
  private textStyleToAss(style: TextStyleConfig, forKaraoke = false, styleName = 'Default'): string {
    const bgr = (hex: string) => {
      const clean = hex.replace('#', '');
      const r = clean.slice(0, 2);
      const g = clean.slice(2, 4);
      const b = clean.slice(4, 6);
      return `&H00${b}${g}${r}`;
    };
    const assAlignmentMap: Record<number, number> = {
      1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9,
    };
    const alignment = assAlignmentMap[style.alignment] ?? 2;
    const primary = forKaraoke ? style.highlightColor : style.fontColor;
    const secondary = forKaraoke ? style.fontColor : style.highlightColor;
    // Margins 0: social/social-style lines use explicit \\pos(...) so underline x/y offsets apply.
    return `Style: ${styleName},${style.font},${style.fontSize},${bgr(primary)},${bgr(secondary)},${bgr(style.backColor)},${bgr(style.outlineColor)},${style.bold ? -1 : 0},${style.italic ? -1 : 0},0,0,100,100,0,0,1,${Math.max(0, style.outlineWidth)},0,${alignment},0,0,0,1`;
  }

  private assPathForFilter(absPath: string): string {
    return absPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  }

  private createSrt(
    timings: Array<{ index: number; text: string; start: number; end: number }>,
  ): string {
    return timings
      .map((t, idx) => {
        // Ensure each cue is a single logical line (no embedded newlines).
        const cleanText = String(t.text || '')
          .replace(/\r?\n/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        return `${idx + 1}\n${this.toSrtTime(t.start)} --> ${this.toSrtTime(t.end)}\n${cleanText}\n`;
      })
      .join('\n');
  }

  private createAss(
    timings: Array<{ index: number; text: string; start: number; end: number }>,
    subtitleStyle: TextStyleConfig,
    playResX = 1920,
    playResY = 1080,
  ): string {
    const toAssTime = (seconds: number) => {
      const total = Math.max(0, seconds);
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      const s = Math.floor(total % 60);
      const cs = Math.floor((total - Math.floor(total)) * 100);
      return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
    };

    const posPrefix = this.assSubtitlePosPrefix(subtitleStyle, playResX, playResY);
    const lines = timings.map(
      (t) =>
        `Dialogue: 0,${toAssTime(t.start)},${toAssTime(t.end)},Default,,0,0,0,,${posPrefix}${this.assEscapeText(t.text)}`,
    );

    return [
      '[Script Info]',
      'ScriptType: v4.00+',
      `PlayResX: ${playResX}`,
      `PlayResY: ${playResY}`,
      '',
      '[V4+ Styles]',
      'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,BackColour,OutlineColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
      this.textStyleToAss(subtitleStyle, false),
      '',
      '[Events]',
      'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text',
      ...lines,
      '',
    ].join('\n');
  }

  private assEscapeText(input: string): string {
    return (input || '')
      .replace(/\\/g, '\\\\')
      .replace(/\{/g, '\\{')
      .replace(/\}/g, '\\}')
      .replace(/\n/g, ' ')
      .trim();
  }

  /** ASS escaping variant that keeps leading/trailing spaces for inline headline tags. */
  private assEscapeTextKeepSpacing(input: string): string {
    return (input || '')
      .replace(/\\/g, '\\\\')
      .replace(/\{/g, '\\{')
      .replace(/\}/g, '\\}')
      .replace(/\n/g, ' ');
  }

  private createSocialAssFromWords(
    words: Array<{ word: string; start: number; end: number }>,
    subtitleStyle: TextStyleConfig,
    playResX = 1920,
    playResY = 1080,
  ): string {
    const toAssTime = (seconds: number) => {
      const total = Math.max(0, seconds);
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      const s = Math.floor(total % 60);
      const cs = Math.floor((total - Math.floor(total)) * 100);
      return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
    };

    const chunks: Array<Array<{ word: string; start: number; end: number }>> = [];
    let current: Array<{ word: string; start: number; end: number }> = [];
    const MAX_WORDS = 3;
    const PAUSE_SPLIT_SEC = 0.55;

    const flush = () => {
      if (current.length) {
        chunks.push(current);
        current = [];
      }
    };

    for (let i = 0; i < words.length; i += 1) {
      const w = words[i];
      if (!w || !w.word) continue;
      const wordText = String(w.word).trim();
      if (!wordText) continue;

      const prev = current[current.length - 1];
      if (prev && w.start - prev.end > PAUSE_SPLIT_SEC) flush();

      current.push({ word: wordText, start: w.start, end: w.end });

      const endPunctuation = /[.!?。！？]$/.test(wordText);
      if (endPunctuation || current.length >= MAX_WORDS) flush();
    }
    flush();

    const posPrefix = this.assSubtitlePosPrefix(subtitleStyle, playResX, playResY);
    const lines = chunks.map((chunk) => {
      const start = chunk[0].start;
      const end = chunk[chunk.length - 1].end;
      const karaokeText = chunk
        .map((w) => {
          const cs = Math.max(1, Math.round((w.end - w.start) * 100));
          return `{\\k${cs}}${this.assEscapeText(w.word)}`;
        })
        .join(' ');
      return `Dialogue: 0,${toAssTime(start)},${toAssTime(end)},Default,,0,0,0,,${posPrefix}${karaokeText}`;
    });

    return [
      '[Script Info]',
      'ScriptType: v4.00+',
      `PlayResX: ${playResX}`,
      `PlayResY: ${playResY}`,
      '',
      '[V4+ Styles]',
      'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,BackColour,OutlineColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
      this.textStyleToAss(subtitleStyle, true),
      '',
      '[Events]',
      'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text',
      ...lines,
      '',
    ].join('\n');
  }

  private chooseVideoDurations(targetDuration: number): { chunks: number[]; extraFreeze: number } {
    const sorted = [...this.allowedVideoDurations].sort((a, b) => a - b);
    const max = sorted[sorted.length - 1];
    const chunks: number[] = [];

    let remaining = targetDuration;
    while (remaining > max) {
      chunks.push(max);
      remaining -= max;
    }
    if (remaining <= 0) return { chunks, extraFreeze: 0 };

    const ceil = sorted.find((d) => d >= remaining);
    if (ceil) {
      const extra = ceil - remaining;
      if (extra <= 0.3) {
        chunks.push(Math.max(...sorted.filter((d) => d <= remaining)));
        return { chunks, extraFreeze: extra };
      }
      chunks.push(ceil);
      return { chunks, extraFreeze: 0 };
    }

    chunks.push(max);
    return { chunks, extraFreeze: max - remaining };
  }

  /** Simpler prompt when the primary Z-Image task fails twice (fewer constraints, still on-topic). */
  private alternateZImagePrompt(segmentText: string): string {
    const t = (segmentText || '').trim().slice(0, 800);
    return `Photorealistic scene illustrating this narration, single subject or wide establishing shot, natural lighting, no text in image, no watermarks: ${t}`;
  }

  private buildImageGenerationPrompt(scriptSegment: string): string {
    return [
      'Create an image prompt illustrating the meaning and context of the following script segment.',
      'Focus on visual storytelling that represents the situation, emotion, or concept described in the text.',
      'Use cinematic, realistic, high-quality visual style suitable for professional video content.',
      'Do not include any visible text, captions, letters, numbers, logos, watermarks, signs, subtitles, or UI elements in the image.',
      'Make the visual metaphor clear and easy to understand globally.',
      'Output only the image generation prompt.',
      '',
      'Script segment:',
      `"${(scriptSegment || '').trim()}"`,
    ].join('\n');
  }

  private buildVideoGenerationPrompt(scriptSegment: string): string {
    return [
      'Create a cinematic video generation prompt that visually represents the meaning and context of the following script segment.',
      'Focus on actions, atmosphere, and visual storytelling that match the message of the text.',
      'Use realistic motion, cinematic lighting, professional tone, and global appeal.',
      'Do not include any visible text, captions, letters, numbers, logos, watermarks, signs, subtitles, or UI overlays in the video frames.',
      'Output only the video generation prompt.',
      '',
      'Script segment:',
      `"${(scriptSegment || '').trim()}"`,
    ].join('\n');
  }

  private readJsonSafe<T = unknown>(filePath: string): T | null {
    try {
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
    } catch {
      return null;
    }
  }

  private async ensureMediaPlanPrompts(
    mediaPlan: Array<{
      index: number;
      text: string;
      mediaType: 'image' | 'video';
      prompt: string;
      promptUsed: string | null;
      imageModel: string;
      videoModel: string;
    }>,
    request: VideoRequest,
    dirs: { meta: string },
    resume: boolean,
    abortCheck?: () => Promise<boolean>,
  ): Promise<void> {
    const planPath = path.join(dirs.meta, 'media-plan.json');
    if (resume) {
      const fromDisk = this.readJsonSafe<any[]>(planPath);
      if (Array.isArray(fromDisk) && fromDisk.length === mediaPlan.length) {
        let ok = true;
        for (let i = 0; i < fromDisk.length; i += 1) {
          if (typeof fromDisk[i]?.prompt !== 'string' || !fromDisk[i].prompt.trim()) ok = false;
        }
        if (ok) {
          for (let i = 0; i < mediaPlan.length; i += 1) {
            mediaPlan[i].prompt = String(fromDisk[i].prompt);
          }
          this.logger.log(`Resume: reusing media-plan.json prompts (${mediaPlan.length})`);
          return;
        }
      }
    }

    const model = ((request.llmModel || 'gpt-5-4') as SupportedLlmModel) || 'gpt-5-4';
    this.logger.log(`Generating media prompts via LLM (model=${model}) for ${mediaPlan.length} segments`);
    for (let i = 0; i < mediaPlan.length; i += 1) {
      await this.pipelineAbortIfNeeded(abortCheck);
      const seg = mediaPlan[i];
      if (seg.mediaType === 'image') {
        seg.prompt = await this.llmService.generateImagePrompt(seg.text, model);
      } else {
        seg.prompt = await this.llmService.generateVideoPrompt(seg.text, model);
      }
    }
    this.requestFsService.writeJson(planPath, mediaPlan);
  }

  /** Bytedance / Wan accept the same 720p|1080p labels as video profiles. */
  private kieMarketVideoResolutionFromProfile(contentResolution: Resolution): '720p' | '1080p' {
    return contentResolution === '1080p' ? '1080p' : '720p';
  }

  /** Grok image-to-video API allows only 480p | 720p. */
  private kieGrokImageToVideoResolution(contentResolution: Resolution): '480p' | '720p' {
    return contentResolution === '1080p' ? '720p' : '480p';
  }

  /** Flux-2 and Nano Banana Pro support 1K | 2K; align with profile content resolution. */
  private kieFluxOrNanoBananaImageResolution(contentResolution: Resolution): '1K' | '2K' {
    return contentResolution === '1080p' ? '2K' : '1K';
  }

  /** Map request `imageModel` to Kie Market model id (see kie-ai.service CreateKieImageTaskParams). */
  private normalizeKieImageModel(raw: string | null | undefined): KieMarketImageModel {
    const s = (raw || 'z-image').trim();
    if (s === 'nano-banana-pro') return 'nano-banana-pro';
    if (s === 'google/nano-banana' || s === 'nano-banana') return 'google/nano-banana';
    if (s === 'flux-2/pro-text-to-image') return 'flux-2/pro-text-to-image';
    if (s === 'flux-2/flex-text-to-image') return 'flux-2/flex-text-to-image';
    if (s === 'grok-imagine/text-to-image') return 'grok-imagine/text-to-image';
    if (s === 'gpt-image/1.5-text-to-image') return 'gpt-image/1.5-text-to-image';
    return 'z-image';
  }

  private async downloadKieImageToFile(
    outputPath: string,
    prompt: string,
    ratio: Ratio,
    contentResolution: Resolution,
    imageModel: string,
    segmentLabel: string,
  ): Promise<void> {
    const model = this.normalizeKieImageModel(imageModel);
    if (model === 'grok-imagine/text-to-image') {
      assertGrokImagineTextToImageRatio(ratio);
    } else if (model === 'gpt-image/1.5-text-to-image') {
      assertGptImage15TextToImageRatio(ratio);
    }
    const fluxNanoRes = this.kieFluxOrNanoBananaImageResolution(contentResolution);

    const taskId = await this.kieAiService.createImageTask(
      model === 'google/nano-banana'
        ? {
            model: 'google/nano-banana',
            prompt,
            image_size: ratio,
            output_format: 'png',
          }
        : model === 'nano-banana-pro'
          ? {
              model: 'nano-banana-pro',
              prompt,
              aspect_ratio: ratio,
              resolution: fluxNanoRes,
              output_format: 'png',
            }
          : model === 'flux-2/pro-text-to-image' || model === 'flux-2/flex-text-to-image'
            ? {
                model,
                prompt,
                aspect_ratio: ratio,
                resolution: fluxNanoRes,
                nsfw_checker: true,
              }
            : model === 'grok-imagine/text-to-image'
              ? {
                  model,
                  prompt,
                  aspect_ratio: ratio as '1:1' | '16:9' | '9:16',
                }
              : model === 'gpt-image/1.5-text-to-image'
                ? {
                    model,
                    prompt,
                    aspect_ratio: '1:1',
                    quality: 'medium',
                  }
                : {
                    model: 'z-image',
                    prompt,
                    aspect_ratio: ratio,
                    nsfw_checker: true,
                  },
    );
    this.logger.log(
      `${segmentLabel} Kie image (${model}) task ${taskId} (prompt chars=${prompt.length})`,
    );
    const details = await this.kieAiService.pollTaskUntilComplete(taskId);
    if (details?.data?.state === 'fail') {
      throw new Error(
        `Kie image (${model}) failed: ${details.data.failMsg || details.data.failCode || 'unknown'}`,
      );
    }
    const resultJson = details?.data?.resultJson ? JSON.parse(details.data.resultJson) : null;
    const url: string | undefined = resultJson?.resultUrls?.[0];
    if (!url) {
      throw new Error(`Kie image (${model}) success but no resultUrls in resultJson`);
    }
    const imageRes = await axios.get<ArrayBuffer>(url, { responseType: 'arraybuffer', timeout: 120000 });
    fs.writeFileSync(outputPath, Buffer.from(imageRes.data));
  }

  private async generateSegmentImageWithRetries(
    imgPath: string,
    primaryPrompt: string,
    segmentText: string,
    ratio: Ratio,
    contentResolution: Resolution,
    imageModel: string,
    segmentLabel: string,
    abortCheck?: () => Promise<boolean>,
  ): Promise<string> {
    const alternate = this.alternateZImagePrompt(segmentText);
    const attempts: { label: string; prompt: string }[] = [
      { label: 'primary', prompt: primaryPrompt },
      { label: 'retry_same', prompt: primaryPrompt },
      { label: 'alternate_prompt', prompt: alternate },
    ];
    let lastError: Error | null = null;
    for (let i = 0; i < attempts.length; i += 1) {
      await this.pipelineAbortIfNeeded(abortCheck);
      const { label, prompt } = attempts[i];
      try {
        this.logger.log(`${segmentLabel} image attempt ${i + 1}/${attempts.length} (${label})`);
        await this.downloadKieImageToFile(
          imgPath,
          prompt,
          ratio,
          contentResolution,
          imageModel,
          segmentLabel,
        );
        return prompt;
      } catch (err: any) {
        if (err instanceof VideoPipelineCancelledError) throw err;
        lastError = err instanceof Error ? err : new Error(String(err));
        this.logger.warn(`${segmentLabel} ${label} failed: ${lastError.message}`);
      }
    }
    throw lastError ?? new Error(`${segmentLabel} Kie image failed after ${attempts.length} attempts`);
  }

  private async createPlaceholderVideo(outputPath: string, label: string, duration: number, w = 1280, h = 720): Promise<void> {
    await this.runFfmpeg([
      '-f', 'lavfi',
      '-i', `color=c=0x0f172a:s=${w}x${h}:d=${Math.max(0.2, duration)}`,
      '-vf', `drawtext=text='${this.escapeDrawtextQuotedText(label)}':x=(w-text_w)/2:y=(h-text_h)/2:fontcolor=white:fontsize=28`,
      '-t', String(Math.max(0.2, duration)),
      '-r', '30',
      '-pix_fmt', 'yuv420p',
      '-y',
      outputPath,
    ]);
  }

  /**
   * Narration for TTS must match what we align segments to. If `fullScript` is empty or much shorter
   * than the joined segments (client bugs / stale state), ElevenLabs would only read the short string — e.g. ~18s audio.
   */
  private resolveNarrationTextForTts(request: VideoRequest): string {
    const full = (request.fullScript || '').trim();
    const fromSegments = (request.segmentedScripts || [])
      .map((s) => (s || '').trim())
      .filter(Boolean)
      .join(' ')
      .trim();

    if (!fromSegments) {
      return full;
    }
    if (!full) {
      this.logger.warn('fullScript is empty; TTS using joined segmentedScripts');
      return fromSegments;
    }
    if (fromSegments.length > full.length * 1.12) {
      this.logger.warn(
        `TTS: fullScript (${full.length} chars) is much shorter than joined segments (${fromSegments.length} chars); using segments for ElevenLabs`,
      );
      return fromSegments;
    }
    return full;
  }

  async runRequestPipeline(
    request: VideoRequest,
    options?: { resume?: boolean; abortCheck?: () => Promise<boolean> },
  ): Promise<{ resultUrl: string; debugMetaUrl?: string }> {
    const resume = options?.resume === true;
    const abortCheck = options?.abortCheck;
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    const dirs = this.requestFsService.ensureRequestDirs(request.id);
    const timestamp = this.requestFsService.timestamp();
    await this.pipelineAbortIfNeeded(abortCheck);

    let audioPath: string | undefined;
    let generatedNewAudio = false;

    if (resume) {
      const existingAudio = this.findLatestMp3InDir(dirs.audio);
      if (existingAudio) {
        audioPath = existingAudio;
        this.logger.log(`Resume: reusing narration audio ${audioPath}`);
      }
    }

    if (!audioPath) {
      const narrationText = this.resolveNarrationTextForTts(request);
      const voiceId = process.env.ELEVENLABS_VOICE_ID || '';
      const generatedAudio = await this.elevenLabsService.generateSpeech(narrationText, voiceId);
      const audioFilename = `audio-${timestamp}.mp3`;
      audioPath = path.join(dirs.audio, audioFilename);
      await this.normalizeNarrationMp3(generatedAudio, audioPath);
      generatedNewAudio = true;
      try {
        if (fs.existsSync(generatedAudio)) fs.unlinkSync(generatedAudio);
      } catch {
        /* temp cleanup best-effort */
      }
    }

    await this.pipelineAbortIfNeeded(abortCheck);

    const transcriptPath = path.join(dirs.transcript, 'transcript.json');
    let transcription: { whisperFormat: any; transcriptId: string };

    if (resume && !generatedNewAudio) {
      const fromDisk = this.loadTranscriptFromDisk(transcriptPath);
      if (fromDisk) {
        transcription = fromDisk as { whisperFormat: any; transcriptId: string };
        this.logger.log('Resume: reusing transcript.json');
      } else {
        transcription = await this.assemblyAiService.transcribe(audioPath, null);
        this.requestFsService.writeJson(transcriptPath, transcription);
      }
    } else {
      transcription = await this.assemblyAiService.transcribe(audioPath, null);
      this.requestFsService.writeJson(transcriptPath, transcription);
    }

    await this.pipelineAbortIfNeeded(abortCheck);

    const words: Array<{ word: string; start: number; end: number }> =
      transcription.whisperFormat?.segments?.[0]?.words || [];
    const totalDuration = words.length ? words[words.length - 1].end : 0;
    const narrationFileDurationSec = await this.probeMediaDurationSeconds(audioPath);
    const masterTimelineEndSec = this.resolveMasterTimelineEndSec(totalDuration, narrationFileDurationSec);
    if (Math.abs(masterTimelineEndSec - totalDuration) > 0.05 || narrationFileDurationSec > totalDuration + 0.05) {
      this.logger.log(
        `Master timeline: transcript end=${totalDuration.toFixed(3)}s, narration file=${narrationFileDurationSec.toFixed(3)}s -> mux/pad target=${masterTimelineEndSec.toFixed(3)}s`,
      );
    }
    const timings = this.mapSegmentTimings(request.segmentedScripts, words, totalDuration);
    const timingMetaPath = path.join(dirs.meta, 'segment-timing.json');
    this.requestFsService.writeJson(timingMetaPath, timings);

    const profileId = request.profileId || 'default_longform';
    const profile: VideoProfile = await this.profileService.getProfile(profileId);
    const canvasDim = resolveDimensions(profile.canvas.ratio as Ratio, profile.canvas.resolution as Resolution);
    const contentDim = resolveDimensions(profile.content.ratio as Ratio, profile.content.resolution as Resolution);
    const contentX = Math.round(
      (canvasDim.width - contentDim.width) / 2 + (Number(profile.content.xOffset) || 0),
    );
    const contentY = Math.round(
      (canvasDim.height - contentDim.height) / 2 + (Number(profile.content.yOffset) || 0),
    );
    const segmentContentVf = [
      `scale=${contentDim.width}:${contentDim.height}:force_original_aspect_ratio=decrease`,
      `pad=${contentDim.width}:${contentDim.height}:(ow-iw)/2:(oh-ih)/2`,
      `pad=${canvasDim.width}:${canvasDim.height}:${contentX}:${contentY}:color=black`,
      'format=yuv420p',
    ].join(',');
    this.logger.log(
      `Canvas: ${canvasDim.width}x${canvasDim.height}, Content: ${contentDim.width}x${contentDim.height} @ (${contentX},${contentY})`,
    );

    let subtitleFile: string | undefined;
    if (profile.subtitle.enabled) {
      if (profile.subtitle.socialMediaStyle) {
        subtitleFile = path.join(dirs.subtitles, 'subtitles.ass');
        fs.writeFileSync(
          subtitleFile,
          this.createSocialAssFromWords(words, profile.subtitle, canvasDim.width, canvasDim.height),
          'utf-8',
        );
      } else {
        subtitleFile = path.join(dirs.subtitles, 'subtitles.srt');
        fs.writeFileSync(subtitleFile, this.createSrt(timings), 'utf-8');
      }
    }

    for (let i = 0; i < timings.length; i += 1) {
      if (i < timings.length - 1) {
        timings[i].duration = Math.max(0.2, timings[i + 1].start - timings[i].start);
      } else {
        timings[i].duration = Math.max(0.2, totalDuration - timings[i].start);
      }
    }
    this.logger.log(`Segment durations (gap-aware): ${timings.map((t) => t.duration.toFixed(2)).join(', ')}`);

    const contentType = request.contentType || 'mixed';
    const mediaTypePerSegment: Array<'image' | 'video'> = [];
    if (contentType === 'all_image') {
      for (let i = 0; i < timings.length; i += 1) mediaTypePerSegment.push('image');
    } else if (contentType === 'all_video') {
      for (let i = 0; i < timings.length; i += 1) mediaTypePerSegment.push('video');
    } else {
      // fallback mixed strategy (can be replaced with stronger LLM policy)
      for (let i = 0; i < timings.length; i += 1) mediaTypePerSegment.push(i % 2 === 0 ? 'video' : 'image');
    }

    const mediaPlan = timings.map((t, idx) => ({
      ...t,
      mediaType: mediaTypePerSegment[idx],
      prompt:
        mediaTypePerSegment[idx] === 'image'
          ? this.buildImageGenerationPrompt(t.text)
          : this.buildVideoGenerationPrompt(t.text),
      // Updated during generation:
      // - for images: the prompt attempt that actually succeeded
      // - for video: null when we fall back to placeholder (Kie generation failed)
      promptUsed: null as string | null,
      imageModel: request.imageModel || 'z-image',
      videoModel: request.videoModel || 'kling-v2.1',
    }));
    this.requestFsService.writeJson(path.join(dirs.meta, 'media-plan.json'), mediaPlan);

    // Replace template prompts with actual LLM-generated prompts (persisted in media-plan.json).
    await this.ensureMediaPlanPrompts(mediaPlan as any, request, dirs as any, resume, abortCheck);

    await this.pipelineAbortIfNeeded(abortCheck);

    const kieProfileContent = {
      ratio: profile.content.ratio as Ratio,
      resolution: profile.content.resolution as Resolution,
    };

    const hasVideoSegments = mediaPlan.some((p) => p.mediaType === 'video');
    if (hasVideoSegments) {
      const selectedVideoModel = request.videoModel || 'kling-v2.1';
      validateKieMarketVideoModelForProfile(selectedVideoModel, kieProfileContent, request.imageModel);
    }

    const hasImageSegments = mediaPlan.some((p) => p.mediaType === 'image');
    if (hasImageSegments) {
      validateKieMarketImageModelForProfile(request.imageModel, kieProfileContent);
    }

    const segmentVideoPaths: string[] = [];
    for (let segIdx = 0; segIdx < mediaPlan.length; segIdx += 1) {
      await this.pipelineAbortIfNeeded(abortCheck);
      const seg = mediaPlan[segIdx];
      const segAssetPrefix = `segment${seg.index + 1}`;
      const segmentOut = path.join(dirs.segments, `segment-${seg.index + 1}.mp4`);

      if (resume && this.segmentMp4LooksValid(segmentOut)) {
        this.logger.log(`Resume: skip segment ${seg.index + 1} (keep ${path.basename(segmentOut)})`);
        segmentVideoPaths.push(segmentOut);
        continue;
      }

      if (seg.mediaType === 'image') {
        const imgPath = path.join(dirs.segments, `${segAssetPrefix}-image-${this.requestFsService.timestamp()}.png`);
        const usedPrompt = await this.generateSegmentImageWithRetries(
          imgPath,
          seg.prompt,
          seg.text,
          profile.content.ratio,
          profile.content.resolution as Resolution,
          seg.imageModel || 'z-image',
          `[Segment ${seg.index + 1}]`,
          abortCheck,
        );
        mediaPlan[segIdx].promptUsed = usedPrompt;

        await this.runFfmpeg([
          '-loop', '1',
          '-i', imgPath,
          '-t', String(Math.max(0.2, seg.duration)),
          '-r', '30',
          '-vf', segmentContentVf,
          '-pix_fmt', 'yuv420p',
          '-y',
          segmentOut,
        ]);
      } else {
        const policy = this.chooseVideoDurations(seg.duration);
        const generatedClips: string[] = [];

        const videoModel = seg.videoModel || 'kling-v2.1';
        let anyKieGenerated = false;

        for (let i = 0; i < policy.chunks.length; i += 1) {
          await this.pipelineAbortIfNeeded(abortCheck);
          const chunkDuration = policy.chunks[i];
          const chunkPath = path.join(
            dirs.segments,
            `${segAssetPrefix}-video-${i + 1}-${this.requestFsService.timestamp()}.mp4`,
          );
          let generated = false;
          try {
            const mapDuration = (d: number): '5' | '10' | '15' => {
              if (d <= 7.5) return '5';
              if (d <= 12.5) return '10';
              return '15';
            };

            if (videoModel === 'bytedance/v1-lite-text-to-video') {
              // bytedance supports the same aspect_ratio values we use in profiles (1:1, 4:3, 3:4, 16:9, 9:16).
              const bytedanceAspectRatio = profile.content.ratio as Ratio;
              const bytedanceResolution = this.kieMarketVideoResolutionFromProfile(
                profile.content.resolution as Resolution,
              );
              this.logger.log(
                `Kie bytedance: profile.content ratio=${profile.content.ratio} resolution=${profile.content.resolution} -> payload aspect_ratio=${bytedanceAspectRatio} resolution=${bytedanceResolution}`,
              );
              const taskId = await this.kieAiService.createMarketVideoTask({
                model: 'bytedance/v1-lite-text-to-video',
                prompt: seg.prompt,
                aspect_ratio: bytedanceAspectRatio,
                resolution: bytedanceResolution,
                duration: mapDuration(chunkDuration),
                camera_fixed: false,
                seed: -1,
                enable_safety_checker: true,
                nsfw_checker: false,
              });

              const url = await this.kieAiService.getFirstTaskResultUrl(taskId);
              const videoRes = await axios.get<ArrayBuffer>(url, {
                responseType: 'arraybuffer',
                timeout: 180000,
              });
              fs.writeFileSync(chunkPath, Buffer.from(videoRes.data));
              generated = true;
              anyKieGenerated = true;
            } else if (videoModel === 'grok-imagine/image-to-video') {
              // 1) Create a Grok still image task; 2) Animate it with image-to-video.
              // Note: Grok image-to-video requires either image_urls or task_id. We use task_id to avoid hosting images.
              await this.pipelineAbortIfNeeded(abortCheck);
              const stillPrompt = await this.llmService.generateImagePrompt(seg.text, request.llmModel as any);
              const stillTaskId = await this.kieAiService.createImageTask({
                model: 'grok-imagine/text-to-image',
                prompt: stillPrompt,
                aspect_ratio:
                  profile.content.ratio === '1:1'
                    ? '1:1'
                    : profile.content.ratio === '16:9'
                      ? '16:9'
                      : '9:16',
              });

              const dur = chunkDuration <= 6 ? '6' : String(Math.min(30, Math.round(chunkDuration)));
              const grokI2vRes = this.kieGrokImageToVideoResolution(
                profile.content.resolution as Resolution,
              );

              const taskId = await this.kieAiService.createMarketVideoTask({
                model: 'grok-imagine/image-to-video',
                input: {
                  task_id: stillTaskId,
                  index: 0,
                  prompt: seg.prompt,
                  mode: 'normal',
                  duration: dur,
                  resolution: grokI2vRes,
                },
              });

              const url = await this.kieAiService.getFirstTaskResultUrl(taskId);
              const videoRes = await axios.get<ArrayBuffer>(url, {
                responseType: 'arraybuffer',
                timeout: 180000,
              });
              fs.writeFileSync(chunkPath, Buffer.from(videoRes.data));
              generated = true;
              anyKieGenerated = true;
            } else if (videoModel === 'wan/2-6-text-to-video') {
              const wanResolution = this.kieMarketVideoResolutionFromProfile(
                profile.content.resolution as Resolution,
              );
              const taskId = await this.kieAiService.createMarketVideoTask({
                model: 'wan/2-6-text-to-video',
                prompt: seg.prompt,
                duration: mapDuration(chunkDuration),
                resolution: wanResolution,
                nsfw_checker: false,
              });

              const url = await this.kieAiService.getFirstTaskResultUrl(taskId);
              const videoRes = await axios.get<ArrayBuffer>(url, {
                responseType: 'arraybuffer',
                timeout: 180000,
              });
              fs.writeFileSync(chunkPath, Buffer.from(videoRes.data));
              generated = true;
              anyKieGenerated = true;
            }
          } catch (err: any) {
            if (err instanceof VideoPipelineCancelledError) throw err;
            this.logger.warn(
              `Kie video generation failed for segment ${seg.index + 1} chunk ${i + 1} (model=${videoModel}). Falling back to placeholder. err=${err?.message ?? String(err)}`,
            );
          }

          if (!generated) {
            await this.createPlaceholderVideo(
              chunkPath,
              `Segment ${seg.index + 1} video ${chunkDuration}s`,
              chunkDuration,
              canvasDim.width,
              canvasDim.height,
            );
          }

          generatedClips.push(chunkPath);
        }

        mediaPlan[segIdx].promptUsed = anyKieGenerated ? seg.prompt : null;

        const concatTxt = path.join(
          dirs.segments,
          `${segAssetPrefix}-concat-${this.requestFsService.timestamp()}.txt`,
        );
        fs.writeFileSync(concatTxt, generatedClips.map((p) => `file '${p}'`).join('\n'), 'utf-8');
        const mergedPath = path.join(
          dirs.segments,
          `${segAssetPrefix}-merged-${this.requestFsService.timestamp()}.mp4`,
        );
        await this.runFfmpeg([
          '-f', 'concat',
          '-safe', '0',
          '-i', concatTxt,
          '-c:v', 'libx264',
          '-pix_fmt', 'yuv420p',
          '-an',
          '-y',
          mergedPath,
        ]);

        const targetDuration = Math.max(0.2, seg.duration);
        await this.runFfmpeg([
          '-i', mergedPath,
          '-t', String(targetDuration),
          '-vf', segmentContentVf,
          '-pix_fmt', 'yuv420p',
          '-y',
          segmentOut,
        ]);
      }

      segmentVideoPaths.push(segmentOut);
    }

    // Persist promptUsed values for the segments so the frontend can display
    // the actual generation prompt (including which retry prompt succeeded).
    this.requestFsService.writeJson(path.join(dirs.meta, 'media-plan.json'), mediaPlan);

    await this.pipelineAbortIfNeeded(abortCheck);

    const concatList = path.join(dirs.segments, `concat-final-${timestamp}.txt`);
    fs.writeFileSync(concatList, segmentVideoPaths.map((p) => `file '${p}'`).join('\n'), 'utf-8');
    const assembledVideo = path.join(dirs.final, `assembled-${timestamp}.mp4`);
    await this.runFfmpeg([
      '-f', 'concat',
      '-safe', '0',
      '-i', concatList,
      '-y',
      assembledVideo,
    ]);

    const assembledDurationSec = await this.probeMediaDurationSeconds(assembledVideo);
    const padNeededSec = masterTimelineEndSec - assembledDurationSec;
    const MIN_PAD_SEC = 0.05;
    let videoForMux = assembledVideo;
    if (padNeededSec > MIN_PAD_SEC) {
      const stopDur = Number(padNeededSec.toFixed(3));
      const paddedVideo = path.join(dirs.final, `assembled-padded-${timestamp}.mp4`);
      this.logger.log(
        `Padding assembled video by ${stopDur}s (assembled=${assembledDurationSec.toFixed(3)}s, target=${masterTimelineEndSec.toFixed(3)}s)`,
      );
      await this.runFfmpeg([
        '-i',
        assembledVideo,
        '-vf',
        `tpad=stop_mode=clone:stop_duration=${stopDur}`,
        '-an',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '18',
        '-pix_fmt',
        'yuv420p',
        '-y',
        paddedVideo,
      ]);
      videoForMux = paddedVideo;
    }

    const mergedAv = path.join(dirs.final, `merged-av-${timestamp}.mp4`);
    await this.runFfmpeg([
      '-i',
      videoForMux,
      '-i',
      audioPath,
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-ar',
      '48000',
      '-t',
      String(masterTimelineEndSec),
      '-y',
      mergedAv,
    ]);

    await this.pipelineAbortIfNeeded(abortCheck);

    const topStored = request.topHeadlineText;
    const bottomStored = request.bottomHeadlineText;

    let topHeadlineText = typeof topStored === 'string' && topStored.trim() ? topStored.trim() : '';
    if (!topHeadlineText && profile.headline.top.enabled) {
      topHeadlineText = await this.llmService.deriveHeadline(request.fullScript);
    }

    let bottomHeadlineText = typeof bottomStored === 'string' && bottomStored.trim() ? bottomStored.trim() : '';
    if (!bottomHeadlineText && profile.headline.bottom.enabled) {
      bottomHeadlineText = (profile.name || '').trim();
    }

    const filters: string[] = [];
    if (subtitleFile) {
      if (subtitleFile.endsWith('.ass')) {
        filters.push(`ass='${subtitleFile.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`);
      } else {
        // Prevent libass wrapping that turns a single cue into multiple visual lines.
        // WrapStyle=0 disables auto-wrapping.
        filters.push(
          `subtitles='${subtitleFile
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "\\'")}':force_style='WrapStyle=0'`,
        );
      }
    }
    if (profile.headline.top.enabled && topHeadlineText) {
      if (headlineHasHighlightTags(topHeadlineText)) {
        const hlAss = path.join(dirs.subtitles, `headline-top-${timestamp}.ass`);
        writeHeadlineHighlightAssFile(
          profile.headline.top,
          topHeadlineText,
          canvasDim.width,
          canvasDim.height,
          hlAss,
        );
        filters.push(`ass='${this.assPathForFilter(hlAss)}'`);
      } else {
        const plainTop = stripHeadlineHighlightTags(topHeadlineText).trim();
        if (plainTop) {
          filters.push(
            `drawtext=text='${this.escapeDrawtextQuotedText(plainTop)}':font='${this.escapeDrawtextQuotedText(profile.headline.top.font)}':fontcolor=${profile.headline.top.fontColor}:fontsize=${profile.headline.top.fontSize}:x=${this.headlineExprX(profile.headline.top)}:y=${this.headlineExprY(profile.headline.top)}`,
          );
        }
      }
    }
    if (profile.headline.bottom.enabled && bottomHeadlineText) {
      if (headlineHasHighlightTags(bottomHeadlineText)) {
        const hlAss = path.join(dirs.subtitles, `headline-bottom-${timestamp}.ass`);
        writeHeadlineHighlightAssFile(
          profile.headline.bottom,
          bottomHeadlineText,
          canvasDim.width,
          canvasDim.height,
          hlAss,
        );
        filters.push(`ass='${this.assPathForFilter(hlAss)}'`);
      } else {
        const plainBot = stripHeadlineHighlightTags(bottomHeadlineText).trim();
        if (plainBot) {
          filters.push(
            `drawtext=text='${this.escapeDrawtextQuotedText(plainBot)}':font='${this.escapeDrawtextQuotedText(profile.headline.bottom.font)}':fontcolor=${profile.headline.bottom.fontColor}:fontsize=${profile.headline.bottom.fontSize}:x=${this.headlineExprX(profile.headline.bottom)}:y=${this.headlineExprY(profile.headline.bottom)}`,
          );
        }
      }
    }

    const finalOut = path.join(dirs.final, 'final-video.mp4');
    if (filters.length) {
      await this.runFfmpeg([
        '-i', mergedAv,
        '-vf', filters.join(','),
        '-c:a', 'copy',
        '-y',
        finalOut,
      ]);
    } else {
      fs.copyFileSync(mergedAv, finalOut);
    }

    const debugMetaPath = path.join(dirs.meta, 'pipeline-output.json');
    const debugMeta = {
      requestId: request.id,
      audio: path.relative(this.requestFsService.getRequestDir(request.id), audioPath),
      subtitle: subtitleFile ? path.relative(this.requestFsService.getRequestDir(request.id), subtitleFile) : null,
      segments: segmentVideoPaths.map((p) => path.relative(this.requestFsService.getRequestDir(request.id), p)),
      finalVideo: 'final/final-video.mp4',
      transcriptEndSec: totalDuration,
      narrationFileDurationSec,
      masterTimelineEndSec,
      assembledVideoDurationSec: assembledDurationSec,
    };
    this.requestFsService.writeJson(debugMetaPath, debugMeta);

    return {
      resultUrl: this.requestFsService.toPublicUrl(baseUrl, request.id, 'final/final-video.mp4'),
      debugMetaUrl: this.requestFsService.toPublicUrl(baseUrl, request.id, 'meta/pipeline-output.json'),
    };
  }

  async runFullPipelineWithSegments(
    fullScript: string,
    segmentedScripts: string[],
    _voiceId: string,
    _profile: { config: unknown },
    _outputFormat: string,
    requestId?: string,
  ) {
    return {
      ok: true,
      status: 'queued',
      requestId,
      segments: segmentedScripts.length,
      preview: fullScript.slice(0, 120),
    };
  }
}
