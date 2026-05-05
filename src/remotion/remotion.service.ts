import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios from 'axios';
import type { SupportedLlmModel } from '../llm/llm.service';
import { RemotionTemplate } from '../entities/remotion-template.entity';
import { R2Service } from '../media/r2.service';
import { SaveTemplateDto } from './dto/save-template.dto';
import { RenderTemplateDto } from './dto/render-template.dto';
import { RemotionUserAssetDto } from './dto/remotion-user-asset.dto';
import { BEST_PRACTICES_GUIDE, FEW_SHOT_EXAMPLES } from './remotion-best-practices';
import { loadMegaSystemPrompt } from './mega-prompt.template';
import {
  CompositionPromptBuilder,
  CompositionPromptInput,
} from './composition-prompt.builder';
import {
  validateTsx,
  hasCriticalErrors,
  formatValidationErrors,
  MAX_VALIDATION_RETRIES,
} from './remotion-validator';

export type RenderSourceOptions = {
  source: string;
  durationInFrames?: number;
  fps?: number;
  width?: number;
  height?: number;
  outputFile?: string;
  inputProps?: Record<string, unknown>;
};

export type RenderSourceResult = {
  outputPath: string;
  outputUrl: string;
  mode: 'dynamic';
};

const TSX_SYSTEM_PROMPT_BASE = `You output ONE Remotion composition as raw TSX only (no markdown, no prose).

FIRST LINE (mandatory — without it the build fails): import what you use from "remotion", e.g.
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from "remotion";
Add spring, Easing, Sequence, Series, staticFile, Img, OffthreadVideo, getInputProps to that import only if used.

Export: default export function with root <AbsoluteFill> filling the composition (background motion graphic).

Style: inline style and/or Tailwind className; CSS and small inline SVG only. CJK text must set fontFamily to include 'Noto Sans CJK KR', 'Noto Sans KR', 'NanumGothic', sans-serif.

ANIMATION PATTERNS:
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width, height } = useVideoConfig();
  const opacity = interpolate(frame, [0, 30], [0, 1], { extrapolateRight: 'clamp' });
  const scale  = spring({ frame, fps, from: 0, to: 1, config: { damping: 12, stiffness: 100 } });

CANVAS:
- The user message includes the exact pixel width × height. Layout using useVideoConfig().width and useVideoConfig().height (do not hard-code 1080×1920 unless that is the stated size).
- The root element should always be <AbsoluteFill> filling the frame.

LENGTH (critical — truncated TSX breaks the bundler with "Expected > but found end of file"):
- Keep the WHOLE file under ~220 lines. No huge repetitive SVG paths, no long copy-pasted shape arrays.
- Prefer a few styled divs + one small inline SVG or simple gradients. Reuse variables for repeated values.
- You MUST fully close every JSX tag and end the file with the closing brace of the default export function.

Hard limits (truncated / unclosed JSX breaks the build): stay under ~220 lines; few divs + one small SVG or gradients; close every tag; end with a complete default export. No giant path arrays or copy-pasted shapes.

Loop-friendly motion; skip fake headline copy unless the user asks for text.

${BEST_PRACTICES_GUIDE}`;

const TSX_IMPORT_RULES_NO_ASSETS = `Imports: only from "remotion". No React import, no other packages, no URLs or files (no http(s) strings, no staticFile paths to user files).`;

const TSX_IMPORT_RULES_WITH_USER_ASSETS = `Imports: only from "remotion". No React import, no other packages.
When USER_ASSETS are listed in the user message:
- Import getInputProps from "remotion". Import Img for image kinds; import OffthreadVideo for video kinds.
- Define a TypeScript type for getInputProps whose keys EXACTLY match the userAssetN keys listed (e.g. userAsset0?: string; userAsset1?: string).
- At the start of your default export function body: const inputProps = getInputProps<YourType>();
- Use <Img src={inputProps.userAssetN} style={{...}} /> for image assets only when that key may exist; use objectFit where helpful.
- Use <OffthreadVideo src={inputProps.userAssetN} ... /> for video assets (pass appropriate style / sizing).
- NEVER embed literal http(s) URLs in the TSX source; only read URLs from inputProps fields (values are supplied at render time).`;

const TSX_REVISE_EXTRA = `You are REVISING existing Remotion TSX. Output ONE complete replacement file (same constraints as above).
Preserve getInputProps / Img / OffthreadVideo usage when the current code uses them, unless the revision explicitly asks to remove them.
Do not add non-remotion imports. Do not introduce hard-coded http(s) URLs.`;

function buildTsxSystemPrompt(opts: { userAssetKeysListed: boolean; revision: boolean }): string {
  const parts = [TSX_SYSTEM_PROMPT_BASE, ''];
  if (opts.revision) {
    parts.push(TSX_REVISE_EXTRA, '');
  }
  parts.push(
    opts.userAssetKeysListed ? TSX_IMPORT_RULES_WITH_USER_ASSETS : TSX_IMPORT_RULES_NO_ASSETS,
    '',
    '--- REFERENCE TSX EXAMPLES (model your output after these) ---',
    FEW_SHOT_EXAMPLES,
  );
  return parts.join('\n');
}

const MAX_EXISTING_TSX_CHARS = 100_000;

@Injectable()
export class RemotionService {
  private readonly logger = new Logger(RemotionService.name);
  private readonly renderServerUrl: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly r2Service: R2Service,
    @InjectRepository(RemotionTemplate)
    private readonly templateRepo: Repository<RemotionTemplate>,
  ) {
    this.renderServerUrl = this.configService.get<string>(
      'REMOTION_RENDER_URL',
      'http://localhost:8080',
    );
  }

  // ─── TSX Generation ────────────────────────────────────────────────────────

  /**
   * Resolves user-owned R2 keys to presigned GET URLs for Remotion inputProps and builds the USER_ASSETS LLM block (keys + labels only).
   */
  async buildRemotionUserAssetContext(
    userId: string,
    assets: RemotionUserAssetDto[] | undefined,
  ): Promise<{ inputProps: Record<string, string>; userAssetsMessageBlock: string }> {
    if (!assets?.length) {
      return { inputProps: {}, userAssetsMessageBlock: '' };
    }
    if (!this.r2Service.isEnabled()) {
      throw new BadRequestException('User assets require R2 to be configured on the server');
    }
    const inputProps: Record<string, string> = {};
    const lines: string[] = [
      '--- USER_ASSETS (prop keys for getInputProps — use these exact keys; do not rename) ---',
    ];
    for (let i = 0; i < assets.length; i += 1) {
      const a = assets[i];
      const key = `userAsset${i}`;
      const trimmedKey = a.objectKey.trim();
      try {
        this.r2Service.assertRemotionAssetKeyOwnedByUser(trimmedKey, userId);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new BadRequestException(msg);
      }
      const url = await this.r2Service.presignGetUrl(userId, trimmedKey);
      inputProps[key] = url;
      lines.push(`${key}: kind=${a.kind} label=${JSON.stringify(a.label.trim())}`);
    }
    return { inputProps, userAssetsMessageBlock: lines.join('\n') };
  }

  async generateTsx(
    prompt: string,
    model: SupportedLlmModel = 'claude-sonnet-4-6',
    canvas?: { width: number; height: number },
    options?: { userAssetsMessageBlock?: string },
  ): Promise<string> {
    const userAssetKeysListed = !!options?.userAssetsMessageBlock?.trim();
    const canvasBlock =
      canvas &&
      `\n--- OUTPUT CANVAS (match exactly) ---\nPixel composition: ${canvas.width} × ${canvas.height}.\nDesign for this aspect and resolution; use useVideoConfig() for width/height in layout.\n`;
    const basePrompt = [
      buildTsxSystemPrompt({ userAssetKeysListed, revision: false }),
      '',
      '--- USER REQUEST ---',
      prompt.trim(),
      canvasBlock ?? '',
      options?.userAssetsMessageBlock ? `\n${options.userAssetsMessageBlock}\n` : '',
    ].join('\n');

    let lastTsx = '';
    for (let attempt = 0; attempt <= MAX_VALIDATION_RETRIES; attempt++) {
      const raw = attempt === 0
        ? await this.callLlmForTsxImpl(model, basePrompt)
        : await this.callLlmForTsxImpl(model, basePrompt + '\n\n--- PREVIOUS ISSUES (fix these) ---\n' + lastTsx);

      const tsx = this.extractTsx(raw);
      if (!tsx) {
        this.logger.warn(
          `[RemotionService] generateTsx attempt ${attempt + 1}: extractTsx returned empty. ` +
          `Raw text length=${raw.length}, preview=${raw.slice(0, 200).replace(/\n/g, '\\n')}`,
        );
        if (attempt < MAX_VALIDATION_RETRIES) {
          lastTsx = 'LLM returned empty or unparseable response. Output ONLY valid TSX code with export default.';
          continue;
        }
        this.logger.warn(`generateTsx failed after ${MAX_VALIDATION_RETRIES + 1} attempts (empty TSX)`);
        throw new InternalServerErrorException(
          'LLM returned an empty or unparseable TSX response after multiple attempts. Try rephrasing.',
        );
      }

      const fixed = this.ensureRemotionImports(tsx);
      const errors = validateTsx(fixed);

      if (!hasCriticalErrors(errors)) {
        if (errors.length > 0) {
          this.logger.warn(`generateTsx produced warnings: ${formatValidationErrors(errors)}`);
        }
        return fixed;
      }

      if (attempt < MAX_VALIDATION_RETRIES) {
        lastTsx = formatValidationErrors(errors) + '\n\nFix ALL errors and output the complete corrected TSX.';
        this.logger.warn(`generateTsx attempt ${attempt + 1} failed validation, retrying...`);
      } else {
        this.logger.warn(`generateTsx failed after ${MAX_VALIDATION_RETRIES + 1} attempts: ${formatValidationErrors(errors)}`);
        throw new InternalServerErrorException(
          `TSX validation failed after ${MAX_VALIDATION_RETRIES + 1} attempts: ${formatValidationErrors(errors)}`,
        );
      }
    }

    throw new InternalServerErrorException('Unexpected error in generateTsx retry loop.');
  }

  async reviseTsx(
    existingTsx: string,
    revisionPrompt: string,
    model: SupportedLlmModel = 'claude-sonnet-4-6',
    canvas?: { width: number; height: number },
  ): Promise<string> {
    const trimmed = existingTsx?.trim() ?? '';
    if (!trimmed) {
      throw new BadRequestException('existingTsx is required');
    }
    if (trimmed.length > MAX_EXISTING_TSX_CHARS) {
      throw new BadRequestException(`TSX exceeds ${MAX_EXISTING_TSX_CHARS} characters`);
    }
    const usesInputProps =
      /\bgetInputProps\b/.test(trimmed) ||
      /\buserAsset\d+\b/.test(trimmed) ||
      /\binputProps\b/.test(trimmed);
    const canvasBlock =
      canvas &&
      `\n--- OUTPUT CANVAS (match exactly) ---\nPixel composition: ${canvas.width} × ${canvas.height}.\n`;
    const basePrompt = [
      buildTsxSystemPrompt({ userAssetKeysListed: usesInputProps, revision: true }),
      '',
      '--- REVISION REQUEST ---',
      revisionPrompt.trim(),
      canvasBlock ?? '',
      '',
      '--- CURRENT TSX ---',
      trimmed,
    ].join('\n');

    let lastTsx = '';
    for (let attempt = 0; attempt <= MAX_VALIDATION_RETRIES; attempt++) {
      const raw = attempt === 0
        ? await this.callLlmForTsxImpl(model, basePrompt)
        : await this.callLlmForTsxImpl(model, basePrompt + '\n\n--- PREVIOUS ISSUES (fix these) ---\n' + lastTsx);

      const tsx = this.extractTsx(raw);
      if (!tsx) {
        if (attempt < MAX_VALIDATION_RETRIES) {
          lastTsx = 'LLM returned empty or unparseable response. Output ONLY valid TSX code with export default.';
          continue;
        }
        this.logger.warn(`reviseTsx failed after ${MAX_VALIDATION_RETRIES + 1} attempts (empty TSX)`);
        throw new InternalServerErrorException(
          'LLM returned an empty or unparseable TSX revision after multiple attempts.',
        );
      }

      const fixed = this.ensureRemotionImports(tsx);
      const errors = validateTsx(fixed);

      if (!hasCriticalErrors(errors)) {
        if (errors.length > 0) {
          this.logger.warn(`reviseTsx produced warnings: ${formatValidationErrors(errors)}`);
        }
        return fixed;
      }

      if (attempt < MAX_VALIDATION_RETRIES) {
        lastTsx = formatValidationErrors(errors) + '\n\nFix ALL errors and output the complete corrected TSX.';
        this.logger.warn(`reviseTsx attempt ${attempt + 1} failed validation, retrying...`);
      } else {
        this.logger.warn(`reviseTsx failed after ${MAX_VALIDATION_RETRIES + 1} attempts: ${formatValidationErrors(errors)}`);
        throw new InternalServerErrorException(
          `TSX revision failed after ${MAX_VALIDATION_RETRIES + 1} attempts: ${formatValidationErrors(errors)}`,
        );
      }
    }

    throw new InternalServerErrorException('Unexpected error in reviseTsx retry loop.');
  }

  // ─── Motion Graphic Composition Generation ─────────────────────────────────

  /**
   * Generate a full Remotion composition TSX for a scripted motion graphic video.
   * Uses the mega prompt + composition prompt builder to produce a unified
   * Composition.tsx with scenes, captions, and audio synced to Whisper timings.
   */
  async generateComposition(
    input: CompositionPromptInput,
    model: SupportedLlmModel = 'claude-sonnet-4-6',
  ): Promise<string> {
    const userPrompt = CompositionPromptBuilder.build(input);

    const fullPrompt = [
      loadMegaSystemPrompt(),
      '',
      '--- USER REQUEST ---',
      userPrompt,
    ].join('\n');

    let lastTsx = '';
    for (let attempt = 0; attempt <= MAX_VALIDATION_RETRIES; attempt++) {
      const raw = attempt === 0
        ? await this.callLlmForTsxImpl(model, fullPrompt)
        : await this.callLlmForTsxImpl(model, fullPrompt + '\n\n--- PREVIOUS ISSUES (fix these) ---\n' + lastTsx);

      const tsx = this.extractTsx(raw);
      if (!tsx) {
        this.logger.warn(
          `[RemotionService] generateComposition attempt ${attempt + 1}: extractTsx returned empty. ` +
          `Raw text length=${raw.length}, preview=${raw.slice(0, 200).replace(/\n/g, '\\n')}`,
        );
        if (attempt < MAX_VALIDATION_RETRIES) {
          lastTsx = 'LLM returned empty or unparseable response. Output ONLY valid TSX code with export default.';
          continue;
        }
        this.logger.warn(`generateComposition failed after ${MAX_VALIDATION_RETRIES + 1} attempts (empty TSX)`);
        throw new InternalServerErrorException(
          'LLM returned an empty or unparseable TSX response after multiple attempts. Try rephrasing.',
        );
      }

      const fixed = this.ensureRemotionImports(tsx);
      const errors = validateTsx(fixed);

      if (!hasCriticalErrors(errors)) {
        if (errors.length > 0) {
          this.logger.warn(`generateComposition produced warnings: ${formatValidationErrors(errors)}`);
        }
        return fixed;
      }

      if (attempt < MAX_VALIDATION_RETRIES) {
        lastTsx = formatValidationErrors(errors) + '\n\nFix ALL errors and output the complete corrected TSX.';
        this.logger.warn(`generateComposition attempt ${attempt + 1} failed validation, retrying...`);
      } else {
        this.logger.warn(`generateComposition failed after ${MAX_VALIDATION_RETRIES + 1} attempts: ${formatValidationErrors(errors)}`);
        throw new InternalServerErrorException(
          `Composition TSX validation failed after ${MAX_VALIDATION_RETRIES + 1} attempts: ${formatValidationErrors(errors)}`,
        );
      }
    }

    throw new InternalServerErrorException('Unexpected error in generateComposition retry loop.');
  }

  /**
    * LLMs often omit imports; without them esbuild fails (undefined hooks/components).
    * If the file has no `from "remotion"` import, prepend a standard one.
    */
  private ensureRemotionImports(tsx: string): string {
    const t = tsx.trimStart();
    if (/from\s+['"]remotion['"]/.test(t)) {
      return tsx;
    }
    return (
      `import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring, Easing, Sequence, Series, staticFile } from "remotion";\n\n` +
      tsx.trimStart()
    );
  }

  /** Strip markdown fences and extract the TSX source code. */
  private extractTsx(raw: string): string {
    let cleaned = raw.trim();
    // Strip ```tsx ... ``` or ``` ... ```
    cleaned = cleaned.replace(/^```(?:tsx|typescript|ts|jsx|js)?\s*/i, '').replace(/\s*```$/, '');
    cleaned = cleaned.trim();
    // Must have a default export to be useful
    if (!cleaned.includes('export default')) {
      // Attempt to find TSX within a larger response
      const match = cleaned.match(/import[\s\S]*export default[\s\S]*/);
      if (match) return match[0].trim();
      return '';
    }
    return cleaned;
  }

  /**
   * Calls Kie.ai with the given model and prompt, returning raw text output.
   * We re-implement the HTTP call here rather than depending on private LlmService methods.
   */
  async callLlmForTsx(model: SupportedLlmModel, prompt: string): Promise<string> {
    return this.callLlmForTsxImpl(model, prompt);
  }

  /**
   * Public alias for the agent service to call the LLM with arbitrary prompts.
   */
  async callLlmForAgent(model: SupportedLlmModel, prompt: string): Promise<string> {
    return this.callLlmForTsxImpl(model, prompt);
  }

  private async callLlmForTsxImpl(model: SupportedLlmModel, prompt: string): Promise<string> {
    const apiKey = this.configService.get<string>('KIE_AI_API_KEY', '');
    if (!apiKey) {
      throw new InternalServerErrorException('KIE_AI_API_KEY is not configured.');
    }

    const headers = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };
    const baseUrl = 'https://api.kie.ai';

    try {
      if (model === 'claude-sonnet-4-6') {
        const res = await axios.post(
          `${baseUrl}/claude/v1/messages`,
          {
            model: 'claude-sonnet-4-6',
            stream: false,
            max_tokens: 16384,
            messages: [{ role: 'user', content: prompt }],
          },
          { headers, timeout: 300000 },
        );
        return this.extractTextFromKieResponse(res.data, model);
      }

      if (model === 'gpt-5-4') {
        const res = await axios.post(
          `${baseUrl}/codex/v1/responses`,
          {
            model: 'gpt-5-4',
            stream: false,
            reasoning: { effort: 'low' },
            input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
          },
          { headers, timeout: 300000 },
        );
        return this.extractTextFromKieResponse(res.data, model);
      }

      // GPT-5-2 via OpenAI-compatible endpoint
      if (model === 'gpt-5-2') {
        const res = await axios.post(
          `${baseUrl}/gpt-5-2/v1/chat/completions`,
          {
            messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
            reasoning_effort: 'high',
          },
          { headers, timeout: 300000 },
        );
        return this.extractTextFromKieResponse(res.data, model);
      }

      // Gemini variants via OpenAI-compatible endpoint
      const geminiModels = [
        'gemini-3-flash',
        'gemini-3-pro',
        'gemini-3.1-pro',
        'gemini-2.5-flash',
      ];
      if (!geminiModels.includes(model)) {
        throw new BadRequestException(`Unsupported model: ${model}`);
      }
      const res = await axios.post(
        `${baseUrl}/${model}/v1/chat/completions`,
        {
          model,
          messages: [{ role: 'user', content: prompt }],
          stream: false,
          max_tokens: 8192,
        },
        { headers, timeout: 300000 },
      );
      const extracted = this.extractTextFromKieResponse(res.data, model);
      if (!extracted) {
        this.logger.warn(
          `[RemotionService] extractTextFromKieResponse returned empty for model=${model}. ` +
          `Raw response keys: ${Object.keys(res.data || {}).join(', ')}`,
        );
      }
      return extracted;
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        const rawMsg = JSON.stringify(err.response?.data ?? err.message).slice(0, 600);
        const clean = this.cleanLlmError(rawMsg, model);
        throw new InternalServerErrorException(clean);
      }
      throw err;
    }
  }

  private cleanLlmError(raw: string, model: string): string {
    const modelName = model;

    if (/maintenance/i.test(raw) || /under maintenance/i.test(raw)) {
      return `The AI model "${modelName}" is currently down for maintenance on Kie.ai. Please try again later or switch to a different model (e.g. gpt-5-4 or gemini-3-flash) in the settings.`;
    }

    if (/rate limit|too many requests|429/i.test(raw)) {
      return `Rate limit hit for model "${modelName}". Wait a moment and try again, or switch to a less busy model.`;
    }

    if (/timeout|timed out|ETIMEDOUT/i.test(raw)) {
      return `The request to model "${modelName}" timed out. The server may be overloaded. Try again or pick a different model.`;
    }

    if (/insufficient_quota|quota|credit/i.test(raw)) {
      return `Your Kie.ai account may be out of credits for model "${modelName}". Check your credit balance and try a different model.`;
    }

    if (/unauthorized|403|invalid.*api/i.test(raw)) {
      return `Kie.ai authentication failed for model "${modelName}". The API key may be invalid or expired.`;
    }

    // Generic fallback
    const truncated = raw.replace(/[{}"]/g, '').slice(0, 300);
    return `The AI model "${modelName}" returned an error: ${truncated}. Try again or switch to a different model.`;
  }

  private extractTextFromKieResponse(data: unknown, model: string): string {
    if (!data || typeof data !== 'object') return '';
    const d = data as Record<string, unknown>;

    // Claude: content[0].text
    if (Array.isArray(d.content)) {
      const first = d.content[0] as Record<string, unknown>;
      if (typeof first?.text === 'string') return first.text;
    }
    // OpenAI chat: choices[0].message.content
    if (Array.isArray(d.choices)) {
      const choice = d.choices[0] as Record<string, unknown>;
      const message = choice?.message as Record<string, unknown> | undefined;
      if (typeof message?.content === 'string') return message.content;
    }
    // GPT-5-4 codex: output[*].content[*].text
    if (Array.isArray(d.output)) {
      for (const item of d.output as Record<string, unknown>[]) {
        if (Array.isArray(item.content)) {
          for (const c of item.content as Record<string, unknown>[]) {
            if (typeof c.text === 'string' && c.text.trim()) return c.text;
          }
        }
      }
    }
    // Gemini: candidates[0].content.parts[0].text
    if (Array.isArray(d.candidates)) {
      const cand = d.candidates[0] as Record<string, unknown>;
      const content = cand?.content as Record<string, unknown> | undefined;
      if (Array.isArray(content?.parts)) {
        const part = (content.parts as Record<string, unknown>[])[0];
        if (typeof part?.text === 'string') return part.text;
      }
    }

    this.logger.warn(`Could not extract text from Kie response for model=${model}`);
    return '';
  }

  // ─── Render server calls ───────────────────────────────────────────────────

  async renderSource(opts: RenderSourceOptions): Promise<RenderSourceResult> {
    const renderKey = this.configService.get<string>('REMOTION_RENDER_API_KEY', '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (renderKey) headers['X-Render-Key'] = renderKey;

    const source = this.ensureRemotionImports(opts.source);

    const body: Record<string, unknown> = {
      source,
      durationInFrames: opts.durationInFrames ?? 210,
      fps: opts.fps ?? 30,
      width: opts.width ?? 1080,
      height: opts.height ?? 1920,
    };
    if (opts.outputFile) body.outputFile = opts.outputFile;
    if (opts.inputProps) body.inputProps = opts.inputProps;

    try {
      const res = await axios.post<{ ok: boolean; outputPath: string; mode: string }>(
        `${this.renderServerUrl}/render-source`,
        body,
        { headers, timeout: 300000 }, // 5 min timeout for render
      );

      if (!res.data.ok) {
        throw new InternalServerErrorException(`Render server error: ${JSON.stringify(res.data)}`);
      }

      const fileName = res.data.outputPath.split('/').pop() ?? 'render.mp4';
      const baseUrl = this.configService.get<string>('BASE_URL', 'http://localhost:3001');
      // Must match RemotionController @Controller('api/remotion') + @Get('files/:filename')
      const outputUrl = `${baseUrl.replace(/\/$/, '')}/api/remotion/files/${fileName}`;

      return {
        outputPath: res.data.outputPath,
        outputUrl,
        mode: 'dynamic',
      };
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        const msg = JSON.stringify(err.response?.data ?? err.message).slice(0, 800);
        throw new InternalServerErrorException(`Remotion render server error: ${msg}`);
      }
      throw err;
    }
  }

  /** Proxy a rendered MP4 file from the Remotion render server. */
  async getFileStream(filename: string): Promise<NodeJS.ReadableStream> {
    const renderKey = this.configService.get<string>('REMOTION_RENDER_API_KEY', '');
    const headers: Record<string, string> = {};
    if (renderKey) headers['X-Render-Key'] = renderKey;

    const res = await axios.get(`${this.renderServerUrl}/files/${filename}`, {
      headers,
      responseType: 'stream',
      timeout: 60000,
    });
    return res.data as NodeJS.ReadableStream;
  }

  // ─── Template CRUD ─────────────────────────────────────────────────────────

  async saveTemplate(userId: string, dto: SaveTemplateDto): Promise<RemotionTemplate> {
    const refs = dto.remotionAssetRefs?.length
      ? dto.remotionAssetRefs.map((r) => ({
          objectKey: r.objectKey.trim(),
          label: r.label.trim(),
          kind: r.kind,
        }))
      : null;
    if (refs?.length) {
      for (const r of refs) {
        try {
          this.r2Service.assertRemotionAssetKeyOwnedByUser(r.objectKey, userId);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          throw new BadRequestException(msg);
        }
      }
    }
    const tpl = this.templateRepo.create({
      userId,
      name: dto.name,
      description: dto.description ?? null,
      tsxSource: dto.tsxSource,
      generationPrompt: dto.generationPrompt ?? null,
      durationInFrames: dto.durationInFrames ?? 210,
      fps: dto.fps ?? 30,
      width: dto.width ?? 1080,
      height: dto.height ?? 1920,
      defaultInputProps: dto.defaultInputProps ?? null,
      remotionAssetRefs: refs,
    });
    return this.templateRepo.save(tpl);
  }

  async listTemplates(userId: string): Promise<RemotionTemplate[]> {
    return this.templateRepo.find({
      where: { userId },
      order: { updatedAt: 'DESC' },
      select: [
        'id',
        'name',
        'description',
        'generationPrompt',
        'durationInFrames',
        'fps',
        'width',
        'height',
        'defaultInputProps',
        'remotionAssetRefs',
        'lastOutputUrl',
        'createdAt',
        'updatedAt',
      ],
    });
  }

  async getTemplate(userId: string, id: string): Promise<RemotionTemplate> {
    const tpl = await this.templateRepo.findOne({ where: { id, userId } });
    if (!tpl) throw new NotFoundException(`Template ${id} not found.`);
    return tpl;
  }

  async deleteTemplate(userId: string, id: string): Promise<void> {
    const tpl = await this.getTemplate(userId, id);
    await this.templateRepo.remove(tpl);
  }

  async renderTemplate(
    userId: string,
    id: string,
    dto: RenderTemplateDto,
  ): Promise<RenderSourceResult> {
    const tpl = await this.getTemplate(userId, id);

    const fromRefs: Record<string, string> = {};
    if (tpl.remotionAssetRefs?.length) {
      if (!this.r2Service.isEnabled()) {
        throw new BadRequestException('Template uses motion assets but R2 is not configured');
      }
      for (let i = 0; i < tpl.remotionAssetRefs.length; i += 1) {
        const ref = tpl.remotionAssetRefs[i];
        try {
          this.r2Service.assertRemotionAssetKeyOwnedByUser(ref.objectKey.trim(), userId);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          throw new BadRequestException(msg);
        }
        fromRefs[`userAsset${i}`] = await this.r2Service.presignGetUrl(
          userId,
          ref.objectKey.trim(),
        );
      }
    }

    const inputProps = {
      ...(tpl.defaultInputProps ?? {}),
      ...fromRefs,
      ...(dto.inputProps ?? {}),
    };

    const result = await this.renderSource({
      source: tpl.tsxSource,
      durationInFrames: dto.durationInFrames ?? tpl.durationInFrames,
      fps: dto.fps ?? tpl.fps,
      width: dto.width ?? tpl.width,
      height: dto.height ?? tpl.height,
      outputFile: dto.outputFile,
      inputProps: Object.keys(inputProps).length > 0 ? inputProps : undefined,
    });

    // Persist the last output URL on the template
    await this.templateRepo.update(id, { lastOutputUrl: result.outputUrl });

    return result;
  }
}
