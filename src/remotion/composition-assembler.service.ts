import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { RemotionService } from './remotion.service';
import { validateTsx, formatValidationErrors } from './remotion-validator';
import type { CompositionPromptInput } from './composition-prompt.builder';
import type { SupportedLlmModel } from '../llm/llm.service';

interface AssembledComposition {
  tsxSource: string;
  sceneCount: number;
}

@Injectable()
export class CompositionAssembler {
  private readonly logger = new Logger(CompositionAssembler.name);
  private readonly maxSceneRetries = 3;

  constructor(private readonly remotionService: RemotionService) {}

  /**
   * Orchestrate template-based composition generation:
   * 1. Build data arrays (WHISPER_WORDS, SEGMENTS)
   * 2. Generate each scene visual in parallel (small focused prompts)
   * 3. Validate each scene component
   * 4. Assemble into pre-validated skeleton
   * 5. Final validation of assembled file
   */
  async assemble(
    input: CompositionPromptInput,
    model: SupportedLlmModel,
  ): Promise<AssembledComposition> {
    this.logger.log(
      `[CompositionAssembler] Assembling composition for request ${input.requestId} with ${input.segments.length} scenes`,
    );

    const totalFrames = Math.ceil(input.audioDurationSec * input.fps);

    // Step 1: Build data arrays
    const dataArraysTsx = this.buildDataArrays(input, totalFrames);

    // Step 2: Generate scene components in parallel
    const sceneGenerationTasks = input.segments.map((seg, idx) =>
      this.generateSceneComponent(seg, idx, model, input.canvasWidth, input.canvasHeight, input.fps),
    );
    const sceneResults = await Promise.all(sceneGenerationTasks);

    // Step 3: Build scene Sequence JSX
    const sceneSequenceTsx = input.segments
      .map((seg, idx) => {
        const compName = `Scene${idx}Visual`;
        return `      <Sequence key={${idx}} from={${seg.startFrame}} durationInFrames={${seg.durationInFrames}} layout="none">
        <SegmentMotion startFrame={${seg.startFrame}} voiceEndFrame={${seg.voiceEndFrame}} durationInFrames={${seg.durationInFrames}}>
          <${compName} />
        </SegmentMotion>
      </Sequence>`;
      })
      .join('\n');

    // Step 4: Assemble final TSX
    const assembled = this.assembleFinalTsx(
      dataArraysTsx,
      sceneResults.join('\n\n'),
      sceneSequenceTsx,
      totalFrames,
    );

    // Step 5: Final validation
    const errors = validateTsx(assembled);
    if (errors.length > 0) {
      this.logger.warn(
        `[CompositionAssembler] Final validation warnings: ${formatValidationErrors(errors)}`,
      );
    }

    this.logger.log(
      `[CompositionAssembler] Assembled composition (${assembled.length} chars) for request ${input.requestId}`,
    );

    return { tsxSource: assembled, sceneCount: input.segments.length };
  }

  private buildDataArrays(input: CompositionPromptInput, totalFrames: number): string {
    const wordsArray = input.whisperWords
      .map((w) => `  { word: ${JSON.stringify(w.word)}, start: ${w.start}, end: ${w.end} }`)
      .join(',\n');

    const segmentsArray = input.segments
      .map(
        (seg) =>
          `  { segmentIndex: ${seg.segmentIndex}, startFrame: ${seg.startFrame}, durationInFrames: ${seg.durationInFrames}, voiceEndFrame: ${seg.voiceEndFrame} }`,
      )
      .join(',\n');

    return [
      `const FONT_STACK = "'Noto Sans KR', 'Apple SD Gothic Neo', sans-serif";`,
      ``,
      `const TOTAL_FRAMES = ${totalFrames};`,
      ``,
      `const WHISPER_WORDS = [`,
      wordsArray,
      `] as const;`,
      ``,
      `const SEGMENTS = [`,
      segmentsArray,
      `] as const;`,
    ].join('\n');
  }

  private async generateSceneComponent(
    seg: CompositionPromptInput['segments'][number],
    sceneIndex: number,
    model: SupportedLlmModel,
    canvasWidth: number,
    canvasHeight: number,
    fps: number,
  ): Promise<string> {
    const prompt = this.buildScenePrompt(seg, sceneIndex, canvasWidth, canvasHeight, fps);
    let lastError = '';

    for (let attempt = 0; attempt <= this.maxSceneRetries; attempt++) {
      try {
        const raw =
          attempt === 0
            ? await this.remotionService.callLlmForTsx(model, prompt)
            : await this.remotionService.callLlmForTsx(
                model,
                prompt + '\n\n--- PREVIOUS ERRORS ---\nYour previous attempt had these errors:\n' + lastError,
              );

        const tsx = this.extractTsx(raw);
        if (!tsx) {
          lastError = 'Generated code was empty or missing export default. Output ONLY the Scene visual component code.';
          this.logger.warn(`Scene ${sceneIndex} attempt ${attempt + 1}: empty TSX`);
          continue;
        }

        // Wrap in function declaration for validation
        const wrapped = this.wrapSceneComponent(tsx, sceneIndex);
        const errors = validateTsx(wrapped);
        if (errors.length === 0) {
          return wrapped;
        }

        lastError = formatValidationErrors(errors);
        this.logger.warn(
          `Scene ${sceneIndex} attempt ${attempt + 1} validation failed: ${lastError}`,
        );
      } catch (err: any) {
        lastError = err.message || String(err);
        this.logger.warn(
          `Scene ${sceneIndex} attempt ${attempt + 1} threw: ${lastError}`,
        );
      }
    }

    this.logger.error(
      `Scene ${sceneIndex} failed after ${this.maxSceneRetries + 1} attempts. Falling back to placeholder.`,
    );

    // Fallback: return a minimal placeholder component
    return this.wrapSceneComponent(
      `export const Scene${sceneIndex}Visual = () => {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%' }}>
      <p style={{ fontFamily: FONT_STACK, fontSize: 48, color: '#38bdf8', textAlign: 'center' }}>
        ${seg.script.slice(0, 60).replace(/'/g, "\\'")}...
      </p>
    </div>
  );
};`,
      sceneIndex,
    );
  }

  private buildScenePrompt(
    seg: CompositionPromptInput['segments'][number],
    sceneIndex: number,
    canvasWidth: number,
    canvasHeight: number,
    fps: number,
  ): string {
    const durationSec = (seg.durationInFrames / fps).toFixed(1);
    const voiceEndSec = (seg.voiceEndFrame / fps).toFixed(1);

    return [
      `You are writing a Remotion visual component for a motion graphic video scene.`,
      ``,
      `## RULES`,
      `1. ONLY import from "remotion" — do NOT import React or any other package.`,
      `2. All animations MUST use useCurrentFrame() + interpolate() or spring().`,
      `3. CSS @keyframes, CSS transitions, and Tailwind animate-* classes are FORBIDDEN.`,
      `4. Use this exact component signature: export const Scene${sceneIndex}Visual = () => { ... }`,
      `5. The root element inside the component should be <div style={{ width: '100%', height: '100%' }}>`,
      `6. Use FONT_STACK variable for fontFamily: FONT_STACK`,
      `7. NEVER embed literal http(s) URLs.`,
      `8. Inside the component, useCurrentFrame() starts at 0 and goes up to ${seg.durationInFrames - 1}.`,
      ``,
      `## ANIMATION PATTERNS`,
      `Enter animation (first 12 frames):`,
      `  const enter = spring({ frame: local, fps: ${fps}, config: { damping: 20, stiffness: 96 } });`,
      ``,
      `Exit animation (starts at voiceEndFrame ${seg.voiceEndFrame}):`,
      `  const voiceEndLocal = ${seg.voiceEndFrame};`,
      `  const exitStart = Math.min(Math.max(0, voiceEndLocal), Math.max(0, ${seg.durationInFrames} - 2));`,
      `  const exitLen = Math.min(24, Math.max(10, ${seg.durationInFrames} - exitStart));`,
      `  const exitProg = interpolate(local, [exitStart, exitStart + exitLen], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });`,
      ``,
      `## CANVAS`,
      `Size: ${canvasWidth} × ${canvasHeight}`,
      `Duration: ${seg.durationInFrames} frames (${durationSec}s)`,
      `Voice ends at frame: ${seg.voiceEndFrame} (${voiceEndSec}s)`,
      ``,
      `## STYLE`,
      `Background is handled by parent. Your scene should have NO background (transparent).`,
      `Dark theme: primary accent #38bdf8, highlight #fef08a, danger #dc2626, success #22c55e.`,
      `Muted text: #94a3b8. Card backgrounds: linear-gradient with #334155 to #1e293b.`,
      ``,
      `## SCRIPT FOR THIS SCENE`,
      seg.script,
      ``,
      `## VISUAL DIRECTION`,
      seg.visualDirection,
      ``,
      seg.keyNumbers?.length
        ? `Key numbers to animate: ${seg.keyNumbers.join(', ')}`
        : '',
      ``,
      `## OUTPUT`,
      `Write ONLY the React component code. No markdown, no explanations, no backticks.`,
      `The component MUST be named exactly Scene${sceneIndex}Visual.`,
      `Example:`,
      `export const Scene0Visual = () => {`,
      `  const frame = useCurrentFrame();`,
      `  const { fps } = useVideoConfig();`,
      `  const local = frame;`,
      `  // ... animations ...`,
      `  return (`,
      `    <div style={{ width: '100%', height: '100%' }}>`,
      `      {/* your visual content */}`,
      `    </div>`,
      `  );`,
      `};`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private extractTsx(raw: string): string {
    let cleaned = raw.trim();
    cleaned = cleaned
      .replace(/^```(?:tsx|typescript|ts|jsx|js)?\s*/i, '')
      .replace(/\s*```$/, '');
    cleaned = cleaned.trim();

    if (!cleaned.includes('export const Scene')) {
      const match = cleaned.match(/export const Scene\d+Visual[\s\S]*/);
      if (match) {
        cleaned = match[0].trim();
      } else {
        return '';
      }
    }

    // Trim trailing content after the component's closing }; to avoid stray code
    const closingIdx = cleaned.lastIndexOf('\n};');
    if (closingIdx !== -1) {
      const candidate = cleaned.substring(0, closingIdx + 3);
      // Only trim if the closing }; looks like it ends the component
      if (!cleaned.substring(closingIdx + 3).trim().startsWith('export')) {
        cleaned = candidate;
      }
    }

    return cleaned;
  }

  private wrapSceneComponent(tsx: string, sceneIndex: number): string {
    // Ensure the component is wrapped as a standalone function declaration
    const compName = `Scene${sceneIndex}Visual`;
    if (tsx.includes(`export const ${compName}`)) {
      return tsx;
    }
    // If raw is just the body, wrap it
    return `export const ${compName} = () => {\n${tsx}\n};`;
  }

  private assembleFinalTsx(
    dataArrays: string,
    sceneComponents: string,
    sceneSequence: string,
    totalFrames: number,
  ): string {
    const skeleton = this.loadSkeleton();
    return skeleton
      .replace('DATA_ARRAYS_PLACEHOLDER', dataArrays)
      .replace('SCENE_COMPONENTS_PLACEHOLDER', sceneComponents)
      .replace('SCENE_SEQUENCE_PLACEHOLDER', sceneSequence)
      .replace(/TOTAL_FRAMES/g, String(totalFrames));
  }

  private loadSkeleton(): string {
    const fs = require('fs');
    const path = require('path');
    const filePath = path.join(__dirname, 'composition-skeleton.template.txt');
    return fs.readFileSync(filePath, 'utf-8');
  }
}
