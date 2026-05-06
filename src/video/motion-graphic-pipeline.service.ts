import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { VideoRequest } from '../entities/video-request.entity';
import { RemotionService } from '../remotion/remotion.service';
import { CompositionAssembler } from '../remotion/composition-assembler.service';
import {
  CompositionPromptBuilder,
  CompositionPromptInput,
  SceneDirection,
} from '../remotion/composition-prompt.builder';
import { RequestFsService } from './request-fs.service';
import { R2Service } from '../media/r2.service';

@Injectable()
export class MotionGraphicPipelineService {
  private readonly logger = new Logger(MotionGraphicPipelineService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly remotionService: RemotionService,
    private readonly compositionAssembler: CompositionAssembler,
    private readonly requestFsService: RequestFsService,
    private readonly r2Service: R2Service,
  ) {}

  /**
   * Run the motion graphic pipeline for a VideoRequest.
   *
   * Steps:
   * 1. Build frame timings from Whisper transcript
   * 2. Build composition prompt
   * 3. Generate TSX via Kie.ai (mega prompt)
   * 4. Render TSX via Remotion render server
   * 5. Return final MP4 path/URL
   */
  async runPipeline(
    request: VideoRequest,
    audioPath: string,
    whisperWords: Array<{ word: string; start: number; end: number }>,
    totalDurationSec: number,
  ): Promise<{ resultUrl: string; tsxSource: string }> {
    const requestId = request.id;

    // Use motionConfig from request, fall back to profile or hardcoded defaults
    const fps = request.motionConfig?.fps || 30;
    const canvasWidth = request.motionConfig?.width || 1080;
    const canvasHeight = request.motionConfig?.height || 1920;
    const visualStylePrompt = request.motionConfig?.visualStylePrompt || undefined;

    this.logger.log(
      `Motion graphic pipeline: ${canvasWidth}x${canvasHeight} @ ${fps}fps${visualStylePrompt ? `, style: ${visualStylePrompt}` : ''}`,
    );

    const profileId = request.profileId || 'default_longform';

    // Build audio public URL
    const baseUrl = this.configService.get<string>('BASE_URL', 'http://localhost:3000');
    const audioPublicUrl = `${baseUrl.replace(/\/$/, '')}/requests/${requestId}/audio/${path.basename(audioPath)}`;

    // Build segment frame timings
    const totalFrames = Math.ceil(totalDurationSec * fps);
    const segments = this.buildSegmentTimings(
      request.segmentedScripts,
      whisperWords,
      totalFrames,
      fps,
    );

    // Build scene directions
    const sceneDirections: SceneDirection[] = segments.map((seg, idx) => ({
      segmentIndex: idx,
      script: seg.script,
      startFrame: seg.startFrame,
      durationInFrames: seg.durationInFrames,
      voiceEndFrame: seg.voiceEndFrame,
      visualDirection: [
        CompositionPromptBuilder.generateVisualDirection(seg.script),
        visualStylePrompt ? `[Style guide: ${visualStylePrompt}]` : '',
      ]
        .filter(Boolean)
        .join(' '),
      keyNumbers: CompositionPromptBuilder.extractKeyNumbers(seg.script),
    }));

    // Build composition prompt
    const promptInput: CompositionPromptInput = {
      requestId,
      canvasWidth,
      canvasHeight,
      fps,
      audioDurationSec: totalDurationSec,
      language: this.detectLanguage(request.fullScript),
      segments: sceneDirections,
      whisperWords,
      fullScript: request.fullScript,
    };

    this.logger.log(`Generating motion graphic composition for request ${requestId} with ${segments.length} scenes`);

    // Generate TSX via template-based assembler
    const model = (request.llmModel as any) || 'claude-sonnet-4-6';
    const assembled = await this.compositionAssembler.assemble(promptInput, model);
    const tsxSource = assembled.tsxSource;

    // Write TSX to disk for debugging
    const metaDir = path.join(this.requestFsService.getRequestDir(requestId), 'meta');
    fs.mkdirSync(metaDir, { recursive: true });
    fs.writeFileSync(path.join(metaDir, 'composition.tsx'), tsxSource, 'utf-8');

    this.logger.log(`Composition TSX generated (${tsxSource.length} chars), rendering...`);

    // Render via Remotion render server
    const renderResult = await this.remotionService.renderSource({
      source: tsxSource,
      durationInFrames: totalFrames,
      fps,
      width: canvasWidth,
      height: canvasHeight,
      inputProps: {
        audioUrl: audioPublicUrl,
      },
    });

    this.logger.log(`Motion graphic rendered: ${renderResult.outputUrl}`);

    return {
      resultUrl: renderResult.outputUrl,
      tsxSource,
    };
  }

  /**
   * Build segment frame timings from Whisper word data.
   * Each segment starts where the previous one ends (contiguous).
   * voiceEndFrame is the last spoken word's end time in that segment.
   */
  private buildSegmentTimings(
    segmentedScripts: string[],
    whisperWords: Array<{ word: string; start: number; end: number }>,
    totalFrames: number,
    fps: number,
  ): Array<{
    script: string;
    startFrame: number;
    durationInFrames: number;
    voiceEndFrame: number;
  }> {
    if (!whisperWords.length || !segmentedScripts.length) {
      // Fallback: even distribution
      const perSegment = Math.floor(totalFrames / Math.max(1, segmentedScripts.length));
      return segmentedScripts.map((script, i) => ({
        script,
        startFrame: i * perSegment,
        durationInFrames: perSegment,
        voiceEndFrame: (i + 1) * perSegment,
      }));
    }

    // Map segment text to word ranges
    const segmentTimings: Array<{
      script: string;
      startFrame: number;
      durationInFrames: number;
      voiceEndFrame: number;
    }> = [];

    let wordCursor = 0;
    const normalizedWords = whisperWords.map((w) => ({
      ...w,
      normalized: w.word.toLowerCase().replace(/[^\w]/g, ''),
    }));

    for (let segIdx = 0; segIdx < segmentedScripts.length; segIdx++) {
      const script = segmentedScripts[segIdx];
      const scriptWords = script
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .split(/\s+/)
        .filter(Boolean);

      let segStartWordIdx = wordCursor;
      let segEndWordIdx = wordCursor;

      // Try to match script words to whisper words
      let matched = 0;
      for (let w = wordCursor; w < normalizedWords.length && matched < scriptWords.length; w++) {
        // Simple sliding window match
        const window = normalizedWords.slice(w, w + scriptWords.length);
        const windowNorm = window.map((x) => x.normalized);
        if (this.arraysMatch(windowNorm, scriptWords)) {
          segStartWordIdx = w;
          segEndWordIdx = w + scriptWords.length - 1;
          matched = scriptWords.length;
          wordCursor = w + scriptWords.length;
          break;
        }
      }

      if (matched === 0) {
        // Fallback: evenly distribute remaining words
        const remaining = normalizedWords.length - wordCursor;
        const perSeg = Math.ceil(remaining / (segmentedScripts.length - segIdx));
        segStartWordIdx = wordCursor;
        segEndWordIdx = Math.min(wordCursor + perSeg - 1, normalizedWords.length - 1);
        wordCursor = segEndWordIdx + 1;
      }

      const startSec = normalizedWords[segStartWordIdx]?.start ?? 0;
      const voiceEndSec = normalizedWords[segEndWordIdx]?.end ?? startSec + 3;

      // Next segment start (or total duration for last segment)
      const nextStartSec =
        segIdx < segmentedScripts.length - 1
          ? (normalizedWords[segEndWordIdx + 1]?.start ?? voiceEndSec + 0.5)
          : totalFrames / fps;

      const startFrame = Math.floor(startSec * fps);
      const endFrame = Math.floor(nextStartSec * fps);
      const voiceEndFrame = Math.ceil(voiceEndSec * fps);

      segmentTimings.push({
        script,
        startFrame,
        durationInFrames: Math.max(1, endFrame - startFrame),
        voiceEndFrame,
      });
    }

    return segmentTimings;
  }

  private arraysMatch(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  private detectLanguage(script: string): string {
    // Simple heuristic
    if (/[\uAC00-\uD7AF]/.test(script)) return 'ko';
    if (/[\u4E00-\u9FFF]/.test(script)) return 'zh';
    if (/[\u3040-\u309F\u30A0-\u30FF]/.test(script)) return 'ja';
    return 'en';
  }
}
