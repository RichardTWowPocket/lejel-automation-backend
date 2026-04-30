/**
 * Composition Prompt Builder
 *
 * Builds the user prompt for motion graphic TSX generation from
 * VideoRequest data, segments, and Whisper transcript.
 */

export type SceneDirection = {
  segmentIndex: number;
  script: string;
  startFrame: number;
  durationInFrames: number;
  voiceEndFrame: number;
  visualDirection: string;
  keyNumbers?: string[];
  keyWords?: string[];
};

export type CompositionPromptInput = {
  requestId: string;
  canvasWidth: number;
  canvasHeight: number;
  fps: number;
  audioDurationSec: number;
  language: string;
  segments: SceneDirection[];
  whisperWords: Array<{ word: string; start: number; end: number }>;
  fullScript: string;
};

export class CompositionPromptBuilder {
  /**
   * Build the complete user prompt for Kie.ai.
   */
  static build(input: CompositionPromptInput): string {
    const lines: string[] = [];

    // Project metadata
    lines.push('# Motion Graphic Composition Request');
    lines.push('');
    lines.push(`Project ID: ${input.requestId}`);
    lines.push(`Canvas: ${input.canvasWidth}x${input.canvasHeight}, ${input.fps}fps`);
    lines.push(`Audio Duration: ${input.audioDurationSec.toFixed(3)}s (${Math.ceil(input.audioDurationSec * input.fps)} frames)`);
    lines.push(`Language: ${input.language}`);
    lines.push('');

    // Global style
    lines.push('## Global Style');
    lines.push('- Dark theme with radial gradient background');
    lines.push('- All visuals built from pure SVG/CSS/divs (NO external images)');
    lines.push('- CJK font stack for Korean/Chinese/Japanese text');
    lines.push('');

    // Full script
    lines.push('## Full Script');
    lines.push(input.fullScript);
    lines.push('');

    // Segments with frame timings
    lines.push('## Scene Definitions (with exact frame timings)');
    lines.push('');

    for (const scene of input.segments) {
      lines.push(`### Scene ${scene.segmentIndex}`);
      lines.push(`- Frames: ${scene.startFrame} to ${scene.startFrame + scene.durationInFrames} (duration: ${scene.durationInFrames} frames)`);
      lines.push(`- Voice ends at frame: ${scene.voiceEndFrame}`);
      lines.push(`- Script: "${scene.script}"`);
      lines.push(`- Visual Direction: ${scene.visualDirection}`);
      if (scene.keyNumbers?.length) {
        lines.push(`- Key Numbers: ${scene.keyNumbers.join(', ')}`);
      }
      if (scene.keyWords?.length) {
        lines.push(`- Key Words: ${scene.keyWords.join(', ')}`);
      }
      lines.push('');
    }

    // Whisper words for captions
    lines.push('## Whisper Word Timings (for karaoke captions)');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(input.whisperWords, null, 2));
    lines.push('```');
    lines.push('');

    // Output instructions
    lines.push('## Output Requirements');
    lines.push('');
    lines.push('Generate ONE complete Composition.tsx file with:');
    lines.push('1. `import { AbsoluteFill, Audio, Sequence, staticFile, interpolate, spring, useCurrentFrame, useVideoConfig, Easing } from "remotion"`;');
    lines.push('2. `const fontStack = "\'Noto Sans KR\', \'Apple SD Gothic Neo\', sans-serif"`;');
    lines.push('3. `WHISPER_WORDS` array with the exact word timings above');
    lines.push('4. `SEGMENTS` array with frame data');
    lines.push('5. One visual component per scene (Scene0Visual, Scene1Visual, etc.)');
    lines.push('6. `SegmentMotion` wrapper with enter/exit spring animation');
    lines.push('7. `WhisperSocialCaptions` with word-by-word karaoke highlighting');
    lines.push('8. `export default function Composition()` with <AbsoluteFill> root, <Audio>, <Sequence> map, and captions overlay');
    lines.push('');
    lines.push('The audio file is at `staticFile("audio.mp3")`.');
    lines.push('');

    return lines.join('\n');
  }

  /**
   * Generate visual direction hint for a segment based on its content.
   * This is a lightweight heuristic; the LLM will ultimately decide the visual.
   */
  static generateVisualDirection(script: string): string {
    const lower = script.toLowerCase();
    const numbers = script.match(/\d+%?|\d+\.\d+%?/g) || [];

    // Heuristic patterns
    if (/(growth|increase|surge|rise|up|more than|higher)/i.test(lower)) {
      return `Growth/surge visualization. ${numbers.length > 0 ? `Show comparison: ${numbers.join(' vs ')}.` : 'Use upward arrows or expanding elements.'}`;
    }
    if (/(decline|drop|fall|down|decrease|lower|less)/i.test(lower)) {
      return `Decline/drop visualization. ${numbers.length > 0 ? `Show drop: ${numbers.join(' → ')}.` : 'Use downward arrows or shrinking elements.'}`;
    }
    if (/(compare|vs|versus|while|whereas|difference)/i.test(lower)) {
      return `Comparison visualization. ${numbers.length > 0 ? `Compare ${numbers.join(' vs ')}.` : 'Side-by-side or before/after split.'}`;
    }
    if (/(percent|%|share|market|proportion|ratio)/i.test(lower) && numbers.length > 0) {
      return `Data visualization. ${numbers.length > 1 ? `Bar/pie chart comparing ${numbers.join(', ')}.` : `Highlight statistic: ${numbers[0]}.`}`;
    }
    if (/(network|ecosystem|chain|supply|connection|link)/i.test(lower)) {
      return 'Network/ecosystem diagram. Hub node connected to satellites with animated lines.';
    }
    if (/(warning|crisis|risk|danger|problem|threat)/i.test(lower)) {
      return 'Alert visualization. Pulsing red elements, warning indicators, or shock reveal.';
    }
    if (/(solution|policy|incentive|benefit|support|help)/i.test(lower)) {
      return 'Highlight card visualization. Glowing card or badge with key policy text.';
    }
    if (/(subscribe|follow|cta|call to action|join|click)/i.test(lower)) {
      return 'CTA/outro visualization. Bold centered text with button-like pill element.';
    }
    if (/(intro|beginning|start|first|hello|welcome)/i.test(lower)) {
      return 'Title reveal visualization. Large text entrance with supporting elements.';
    }

    // Default
    return `Key concept visualization. Extract the main idea from "${script.slice(0, 60)}..." and represent it with animated text + abstract shapes.`;
  }

  /**
   * Extract key numbers from script text.
   */
  static extractKeyNumbers(script: string): string[] {
    const matches = script.match(/\d+%?|\d+\.\d+%?/g);
    return matches ? [...new Set(matches)] : [];
  }
}
