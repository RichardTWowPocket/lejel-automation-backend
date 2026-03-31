import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { VideoRequest } from '../entities/video-request.entity';
import { ElevenLabsService } from '../elevenlabs/elevenlabs.service';
import { AssemblyAIService } from '../assemblyai/assemblyai.service';
import { ProfileService } from '../profile/profile.service';
import { LlmService } from '../llm/llm.service';
import { KieAiService } from '../kie-ai/kie-ai.service';
import { RequestFsService } from './request-fs.service';
import { TextStyleConfig, VideoProfile } from './types/profile-config.interface';
import { resolveDimensions, Ratio, Resolution } from '../profile/profile-dimensions';

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

  private textStyleToAss(style: TextStyleConfig): string {
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
    return `Style: Default,${style.font},${style.fontSize},${bgr(style.fontColor)},${bgr(style.highlightColor)},${bgr(style.backColor)},${bgr(style.outlineColor)},${style.bold ? -1 : 0},${style.italic ? -1 : 0},0,0,100,100,0,0,1,${Math.max(0, style.outlineWidth)},0,${alignment},20,20,${Math.max(0, style.yOffset)},1`;
  }

  private createSrt(
    timings: Array<{ index: number; text: string; start: number; end: number }>,
  ): string {
    return timings
      .map((t, idx) => `${idx + 1}\n${this.toSrtTime(t.start)} --> ${this.toSrtTime(t.end)}\n${t.text}\n`)
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

    const lines = timings.map((t) =>
      `Dialogue: 0,${toAssTime(t.start)},${toAssTime(t.end)},Default,,0,0,0,,${t.text.replace(/\n/g, ' ')}`,
    );

    return [
      '[Script Info]',
      'ScriptType: v4.00+',
      `PlayResX: ${playResX}`,
      `PlayResY: ${playResY}`,
      '',
      '[V4+ Styles]',
      'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,BackColour,OutlineColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
      this.textStyleToAss(subtitleStyle),
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

    const lines = chunks.map((chunk) => {
      const start = chunk[0].start;
      const end = chunk[chunk.length - 1].end;
      const karaokeText = chunk
        .map((w) => {
          const cs = Math.max(1, Math.round((w.end - w.start) * 100));
          return `{\\k${cs}}${this.assEscapeText(w.word)}`;
        })
        .join(' ');
      return `Dialogue: 0,${toAssTime(start)},${toAssTime(end)},Default,,0,0,0,,${karaokeText}`;
    });

    return [
      '[Script Info]',
      'ScriptType: v4.00+',
      `PlayResX: ${playResX}`,
      `PlayResY: ${playResY}`,
      '',
      '[V4+ Styles]',
      'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,BackColour,OutlineColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
      this.textStyleToAss(subtitleStyle),
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

  private async createPlaceholderImage(outputPath: string, label: string, w = 1280, h = 720): Promise<void> {
    await this.runFfmpeg([
      '-f', 'lavfi',
      '-i', `color=c=0x111111:s=${w}x${h}:d=1`,
      '-vf', `drawtext=text='${label.replace(/'/g, "\\'")}':x=(w-text_w)/2:y=(h-text_h)/2:fontcolor=white:fontsize=36`,
      '-frames:v', '1',
      '-y',
      outputPath,
    ]);
  }

  private async createPlaceholderVideo(outputPath: string, label: string, duration: number, w = 1280, h = 720): Promise<void> {
    await this.runFfmpeg([
      '-f', 'lavfi',
      '-i', `color=c=0x0f172a:s=${w}x${h}:d=${Math.max(0.2, duration)}`,
      '-vf', `drawtext=text='${label.replace(/'/g, "\\'")}':x=(w-text_w)/2:y=(h-text_h)/2:fontcolor=white:fontsize=28`,
      '-t', String(Math.max(0.2, duration)),
      '-r', '30',
      '-pix_fmt', 'yuv420p',
      '-y',
      outputPath,
    ]);
  }

  async runRequestPipeline(request: VideoRequest): Promise<{ resultUrl: string; debugMetaUrl?: string }> {
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    const dirs = this.requestFsService.ensureRequestDirs(request.id);
    const timestamp = this.requestFsService.timestamp();

    const voiceId = process.env.ELEVENLABS_VOICE_ID || '';
    const generatedAudio = await this.elevenLabsService.generateSpeech(request.fullScript, voiceId);
    const audioFilename = `audio-${timestamp}.mp3`;
    const audioPath = path.join(dirs.audio, audioFilename);
    fs.copyFileSync(generatedAudio, audioPath);

    const transcription = await this.assemblyAiService.transcribe(audioPath, null);
    const transcriptPath = path.join(dirs.transcript, 'transcript.json');
    this.requestFsService.writeJson(transcriptPath, transcription);

    const words: Array<{ word: string; start: number; end: number }> =
      transcription.whisperFormat?.segments?.[0]?.words || [];
    const totalDuration = words.length ? words[words.length - 1].end : 0;
    const timings = this.mapSegmentTimings(request.segmentedScripts, words, totalDuration);
    const timingMetaPath = path.join(dirs.meta, 'segment-timing.json');
    this.requestFsService.writeJson(timingMetaPath, timings);

    const profileId = request.profileId || 'default_longform';
    const profile: VideoProfile = await this.profileService.getProfile(profileId);
    const canvasDim = resolveDimensions(profile.canvas.ratio as Ratio, profile.canvas.resolution as Resolution);
    const contentDim = resolveDimensions(profile.content.ratio as Ratio, profile.content.resolution as Resolution);
    this.logger.log(`Canvas: ${canvasDim.width}x${canvasDim.height}, Content: ${contentDim.width}x${contentDim.height}`);

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
      prompt: `Create a ${mediaTypePerSegment[idx]} illustrating: ${t.text}`,
      imageModel: request.imageModel || 'z-image',
      videoModel: request.videoModel || 'kling-v2.1',
    }));
    this.requestFsService.writeJson(path.join(dirs.meta, 'media-plan.json'), mediaPlan);

    const segmentVideoPaths: string[] = [];
    for (const seg of mediaPlan) {
      const segAssetPrefix = `segment${seg.index + 1}`;
      const segmentOut = path.join(dirs.segments, `segment-${seg.index + 1}.mp4`);

      if (seg.mediaType === 'image') {
        const imgPath = path.join(dirs.segments, `${segAssetPrefix}-image-${this.requestFsService.timestamp()}.png`);
        try {
          const taskId = await this.kieAiService.createZImageTask({
            prompt: seg.prompt,
            aspect_ratio: profile.content.ratio,
          });
          this.logger.log(`[Segment ${seg.index + 1}] Z-Image task created: ${taskId}, polling...`);
          const details = await this.kieAiService.pollTaskUntilComplete(taskId);
          const resultJson = details?.data?.resultJson ? JSON.parse(details.data.resultJson) : null;
          const url: string | undefined = resultJson?.resultUrls?.[0];
          if (url) {
            this.logger.log(`[Segment ${seg.index + 1}] Downloading image from ${url}`);
            const imageRes = await axios.get<ArrayBuffer>(url, { responseType: 'arraybuffer', timeout: 60000 });
            fs.writeFileSync(imgPath, Buffer.from(imageRes.data));
          } else {
            this.logger.warn(`[Segment ${seg.index + 1}] No image URL in task result, using placeholder`);
            await this.createPlaceholderImage(imgPath, `Segment ${seg.index + 1} image`, canvasDim.width, canvasDim.height);
          }
        } catch (err) {
          this.logger.error(`[Segment ${seg.index + 1}] Image generation failed: ${err?.message || err}`);
          await this.createPlaceholderImage(imgPath, `Segment ${seg.index + 1} image`, canvasDim.width, canvasDim.height);
        }

        await this.runFfmpeg([
          '-loop', '1',
          '-i', imgPath,
          '-t', String(Math.max(0.2, seg.duration)),
          '-r', '30',
          '-vf', `scale=${canvasDim.width}:${canvasDim.height}:force_original_aspect_ratio=decrease,pad=${canvasDim.width}:${canvasDim.height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`,
          '-pix_fmt', 'yuv420p',
          '-y',
          segmentOut,
        ]);
      } else {
        const policy = this.chooseVideoDurations(seg.duration);
        const generatedClips: string[] = [];

        for (let i = 0; i < policy.chunks.length; i += 1) {
          const chunkDuration = policy.chunks[i];
          const chunkPath = path.join(
            dirs.segments,
            `${segAssetPrefix}-video-${i + 1}-${this.requestFsService.timestamp()}.mp4`,
          );
          await this.createPlaceholderVideo(
            chunkPath,
            `Segment ${seg.index + 1} video ${chunkDuration}s`,
            chunkDuration,
            canvasDim.width,
            canvasDim.height,
          );
          generatedClips.push(chunkPath);
        }

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
          '-c', 'copy',
          '-y',
          mergedPath,
        ]);

        const targetDuration = Math.max(0.2, seg.duration);
        await this.runFfmpeg([
          '-i', mergedPath,
          '-t', String(targetDuration),
          '-vf', `scale=${canvasDim.width}:${canvasDim.height}:force_original_aspect_ratio=decrease,pad=${canvasDim.width}:${canvasDim.height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`,
          '-pix_fmt', 'yuv420p',
          '-y',
          segmentOut,
        ]);
      }

      segmentVideoPaths.push(segmentOut);
    }

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

    const mergedAv = path.join(dirs.final, `merged-av-${timestamp}.mp4`);
    await this.runFfmpeg([
      '-i', assembledVideo,
      '-i', audioPath,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-shortest',
      '-y',
      mergedAv,
    ]);

    const topHeadlineText = await this.llmService.deriveHeadline(request.fullScript);
    const bottomHeadlineText = profile.name || '';

    const filters: string[] = [];
    if (subtitleFile) {
      if (subtitleFile.endsWith('.ass')) {
        filters.push(`ass='${subtitleFile.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`);
      } else {
        filters.push(`subtitles='${subtitleFile.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`);
      }
    }
    if (profile.headline.top.enabled) {
      filters.push(
        `drawtext=text='${topHeadlineText.replace(/'/g, "\\'")}':font='${profile.headline.top.font}':fontcolor=${profile.headline.top.fontColor}:fontsize=${profile.headline.top.fontSize}:x=(w-text_w)/2+${profile.headline.top.xOffset}:y=20+${profile.headline.top.yOffset}`,
      );
    }
    if (profile.headline.bottom.enabled && bottomHeadlineText) {
      filters.push(
        `drawtext=text='${bottomHeadlineText.replace(/'/g, "\\'")}':font='${profile.headline.bottom.font}':fontcolor=${profile.headline.bottom.fontColor}:fontsize=${profile.headline.bottom.fontSize}:x=(w-text_w)/2+${profile.headline.bottom.xOffset}:y=h-text_h-20-${profile.headline.bottom.yOffset}`,
      );
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
