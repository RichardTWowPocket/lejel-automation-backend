import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { VideoRequest } from '../entities/video-request.entity';
import { RemotionService } from '../remotion/remotion.service';
import {
  CompositionPromptBuilder,
  CompositionPromptInput,
  SceneDirection,
} from '../remotion/composition-prompt.builder';
import { RequestFsService } from './request-fs.service';
import { R2Service } from '../media/r2.service';
import type { SupportedLlmModel } from '../llm/llm.service';

const AGENT_MODEL: SupportedLlmModel = 'claude-sonnet-4-6';
const MAX_RENDER_ATTEMPTS = 3;

@Injectable()
export class MotionGraphicPipelineService {
  private readonly logger = new Logger(MotionGraphicPipelineService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly remotionService: RemotionService,
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

    // ── Agent loop: generate → render → fix → render ──────────────
    const tsxSource = await this.generateCompositionAndRender(
      promptInput,
      audioPublicUrl,
      requestId,
      totalFrames,
      fps,
      canvasWidth,
      canvasHeight,
    );

    this.logger.log(`Motion graphic rendered successfully for request ${requestId}`);

    return {
      resultUrl: tsxSource, // The last iteration set this to the output URL
      tsxSource: fs.readFileSync(
        path.join(this.requestFsService.getRequestDir(requestId), 'meta', 'composition.tsx'),
        'utf-8',
      ),
    };
  }

  /**
   * Agent approach: generate full composition, render, feed render errors back to LLM, retry.
   * Up to MAX_RENDER_ATTEMPTS render attempts. Uses claude-sonnet-4-6 exclusively.
   */
  private async generateCompositionAndRender(
    promptInput: CompositionPromptInput,
    audioPublicUrl: string,
    requestId: string,
    totalFrames: number,
    fps: number,
    width: number,
    height: number,
  ): Promise<string> {
    const metaDir = path.join(this.requestFsService.getRequestDir(requestId), 'meta');
    fs.mkdirSync(metaDir, { recursive: true });

    // Step 1: Generate initial full composition (single mega-prompt call)
    this.logger.log('[MotionAgent] Generating initial composition...');
    let tsx = await this.remotionService.generateComposition(promptInput, AGENT_MODEL);
    fs.writeFileSync(path.join(metaDir, 'composition-v0.tsx'), tsx, 'utf-8');
    this.logger.log(`[MotionAgent] Initial composition: ${tsx.length} chars`);

    // Step 2: Render → fix → render loop
    for (let attempt = 0; attempt < MAX_RENDER_ATTEMPTS; attempt++) {
      try {
        this.logger.log(`[MotionAgent] Render attempt ${attempt + 1}/${MAX_RENDER_ATTEMPTS}...`);
        const result = await this.remotionService.renderSource({
          source: tsx,
          durationInFrames: totalFrames,
          fps,
          width,
          height,
          inputProps: { audioUrl: audioPublicUrl },
        });

        // Success! Save final TSX and return
        fs.writeFileSync(path.join(metaDir, 'composition.tsx'), tsx, 'utf-8');
        this.logger.log(`[MotionAgent] Render succeeded on attempt ${attempt + 1}`);
        return result.outputUrl;
      } catch (err: any) {
        const renderError = err.message || String(err);
        this.logger.warn(
          `[MotionAgent] Render attempt ${attempt + 1} failed: ${renderError.slice(0, 400)}`,
        );

        if (attempt >= MAX_RENDER_ATTEMPTS - 1) {
          throw new InternalServerErrorException(
            `Motion graphic render failed after ${MAX_RENDER_ATTEMPTS} attempts: ${renderError}`,
          );
        }

        // Feed the real render error back to the LLM for revision
        this.logger.log(`[MotionAgent] Asking LLM to fix render error...`);
        try {
          tsx = await this.reviseCompositionWithError(tsx, renderError, promptInput);
          fs.writeFileSync(
            path.join(metaDir, `composition-v${attempt + 1}.tsx`),
            tsx,
            'utf-8',
          );
          this.logger.log(`[MotionAgent] Revised composition: ${tsx.length} chars`);
        } catch (llmErr: any) {
          this.logger.error(`[MotionAgent] LLM revision failed: ${llmErr.message}`);
          throw new InternalServerErrorException(
            `LLM failed to revise TSX after render error: ${llmErr.message}`,
          );
        }
      }
    }

    throw new InternalServerErrorException('Unexpected end of render loop');
  }

  /**
   * Ask the LLM to fix a failed composition given the actual render error.
   */
  private async reviseCompositionWithError(
    currentTsx: string,
    renderError: string,
    _promptInput: CompositionPromptInput,
  ): Promise<string> {
    const revisionPrompt = [
      `The Remotion render server failed to compile this TSX. Fix ALL errors and output the complete corrected file.`,
      ``,
      `## RENDER ERROR`,
      renderError,
      ``,
      `## RULES`,
      `- Output ONLY the corrected TSX — no markdown, no explanations, no backticks.`,
      `- The file must have: import from "remotion", a default export function wrapped in <AbsoluteFill>.`,
      `- Use useCurrentFrame() + interpolate() or spring() for ALL animations — NO CSS @keyframes or Tailwind animate-* classes.`,
      `- Keep the file under 220 lines. Close every JSX tag.`,
      `- Fix the EXACT error shown above. Do not change the intended design unless necessary.`,
      ``,
      `## CURRENT TSX (with errors)`,
      currentTsx,
    ].join('\n');

    const raw = await this.remotionService.callLlmForTsx(AGENT_MODEL, revisionPrompt);
    const extracted = this.remotionService.extractTsx(raw);
    if (!extracted) {
      this.logger.warn(`[MotionAgent] extractTsx returned empty after revision`);
      const fallback = raw
        .replace(/^```(?:tsx|typescript|ts|jsx|js)?\s*/i, '')
        .replace(/\s*```$/, '')
        .trim();
      return fallback || currentTsx;
    }

    return this.remotionService.ensureRemotionImports(extracted);
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
