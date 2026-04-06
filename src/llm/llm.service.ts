import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export type PlannedSegment = {
  text: string;
  mediaType: 'image' | 'video';
};

export const SUPPORTED_LLM_MODELS = [
  'gpt-5-4',
  'gpt-5-2',
  'claude-sonnet-4-6',
  'gemini-3-flash',
  'gemini-3-pro',
  'gemini-3.1-pro',
  'gemini-2.5-flash',
] as const;
export type SupportedLlmModel = (typeof SUPPORTED_LLM_MODELS)[number];

export type GeneratedYoutubeMetadata = {
  title: string;
  description: string;
  tags: string[];
};

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private readonly apiKey: string;
  private readonly baseUrl = 'https://api.kie.ai';

  constructor(private readonly configService: ConfigService) {
    this.apiKey = this.configService.get<string>('KIE_AI_API_KEY', '');
    if (!this.apiKey) {
      this.logger.warn('KIE_AI_API_KEY is not set. LLM calls will fallback.');
    }
  }

  private fallbackSegment(fullScript: string): string[] {
    const segments = fullScript
      .split(/\n+|(?<=[.!?])\s+/)
      .map((segment) => segment.trim())
      .filter(Boolean);
    return segments.length > 0 ? segments : [fullScript.trim()].filter(Boolean);
  }

  private buildPrompt(script: string, segmentationInstructions?: string | null): string {
    const lines = [
      'Split the following script into speaking segments for TTS-driven video generation.',
      'Use semantic and pacing boundaries (ideas, beats, natural pauses). Do NOT split only on every sentence boundary if that yields awkward cuts.',
      'Rules:',
      '- each segment is one coherent spoken unit (often 1-2 short sentences, or a tight list clause)',
      '- aim for roughly 6-14 seconds of speech per segment when read aloud',
      '- preserve original language, wording, and order; do not summarize or add commentary',
      '- output must be a JSON array of strings only, no markdown fences',
      '',
      'Return ONLY a valid JSON array of strings, for example: ["segment one text", "segment two text"]',
    ];
    const custom = segmentationInstructions?.trim();
    if (custom) {
      lines.push(
        '',
        'Additional segmentation instructions (follow these together with the rules above; still output ONLY the JSON array, no markdown):',
        custom,
      );
    }
    lines.push('', script);
    return lines.join('\n');
  }

  private parseSegmentsFromLlmOutput(outputText: string): string[] | null {
    const stripped = outputText.replace(/```json\s*|```/gi, '').trim();
    const tryParse = (raw: string): string[] | null => {
      try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return null;
        const segments = parsed
          .map((s) => (typeof s === 'string' ? s.trim() : ''))
          .filter(Boolean);
        return segments.length > 0 ? segments : null;
      } catch {
        return null;
      }
    };
    const direct = tryParse(stripped);
    if (direct) return direct;
    const bracket = stripped.match(/\[[\s\S]*\]/);
    if (bracket) return tryParse(bracket[0]);
    return null;
  }

  /** Normalize OpenAI-style message.content (string or part array). */
  private flattenMessageContent(content: unknown): string {
    if (typeof content === 'string') return content.trim();
    if (!Array.isArray(content)) return '';
    return content
      .map((c: any) => {
        if (typeof c === 'string') return c;
        return c?.text ?? c?.content ?? '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  /** Kie /codex/v1/responses and similar “output steps” shapes. */
  private extractFromCodexOutput(data: any): string {
    const output = data?.output;
    if (typeof output === 'string') return output.trim();
    if (!Array.isArray(output)) return '';

    const lines: string[] = [];
    for (const item of output) {
      const parts = item?.content;
      if (typeof parts === 'string') {
        lines.push(parts);
        continue;
      }
      if (!Array.isArray(parts)) continue;
      for (const block of parts) {
        const t =
          block?.text ??
          block?.output_text ??
          (typeof block === 'string' ? block : '');
        const type = block?.type;
        if (typeof t === 'string' && t.trim()) {
          if (!type || type === 'output_text' || type === 'text' || type === 'input_text') {
            lines.push(t.trim());
          }
        }
      }
    }
    return lines.join('\n').trim();
  }

  /**
   * Kie.ai response JSON varies by route. Try several shapes so we do not return '' when the API succeeded.
   * Many routes wrap the provider body in `{ code, msg, data }`.
   */
  private extractTextFromResponse(model: SupportedLlmModel, data: any): string {
    if (!data || typeof data !== 'object') return '';

    if (typeof data.code === 'number' && data.code !== 0) {
      this.logger.warn(
        `Kie API business error code=${data.code} msg=${String(data.msg ?? '').slice(0, 300)}`,
      );
      return '';
    }

    const inner = data?.data;
    const payloads =
      inner && typeof inner === 'object' && inner !== data ? [data, inner] : [data];

    for (const payload of payloads) {
      const t = this.extractTextFromOnePayload(model, payload);
      if (t) return t;
    }

    this.logger.debug(
      `[extractTextFromResponse] empty for model=${model} topKeys=${Object.keys(data).join(',')}`,
    );
    return '';
  }

  private extractTextFromOnePayload(model: SupportedLlmModel, data: any): string {
    if (!data || typeof data !== 'object') return '';

    // OpenAI-compatible chat.completions (many Gemini/GPT routes on Kie)
    const choiceMsg = data?.choices?.[0]?.message;
    const fromChoice = this.flattenMessageContent(choiceMsg?.content);
    if (fromChoice) return fromChoice;
    const delta = this.flattenMessageContent(data?.choices?.[0]?.delta?.content);
    if (delta) return delta;

    // Top-level string helpers some gateways use
    if (typeof data?.text === 'string' && data.text.trim()) return data.text.trim();
    if (typeof data?.result === 'string' && data.result.trim()) return data.result.trim();
    if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();

    // Anthropic-style
    if (Array.isArray(data?.content)) {
      const t = data.content
        .map((c: any) => (typeof c?.text === 'string' ? c.text : typeof c === 'string' ? c : ''))
        .filter(Boolean)
        .join('\n')
        .trim();
      if (t) return t;
    }

    // Gemini generateContent
    const parts = data?.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) {
      const t = parts
        .map((p: any) => p?.text ?? '')
        .join('\n')
        .trim();
      if (t) return t;
    }

    // GPT-5.4 / codex “responses” shape (and similar)
    if (model === 'gpt-5-4' || data?.output !== undefined) {
      const fromCodex = this.extractFromCodexOutput(data);
      if (fromCodex) return fromCodex;
    }

    return '';
  }

  private async callKieModel(
    model: SupportedLlmModel,
    prompt: string,
  ): Promise<string> {
    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };

    let data: any;
    if (model === 'gpt-5-4') {
      const res = await axios.post(
        `${this.baseUrl}/codex/v1/responses`,
        {
          model: 'gpt-5-4',
          stream: false,
          reasoning: { effort: 'low' },
          input: [
            {
              role: 'user',
              content: [{ type: 'input_text', text: prompt }],
            },
          ],
        },
        { headers, timeout: 90000 },
      );
      data = res.data;
    } else if (model === 'gpt-5-2') {
      const res = await axios.post(
        `${this.baseUrl}/gpt-5-2/v1/chat/completions`,
        {
          messages: [
            {
              role: 'user',
              content: [{ type: 'text', text: prompt }],
            },
          ],
          reasoning_effort: 'high',
        },
        { headers, timeout: 90000 },
      );
      data = res.data;
    } else if (model === 'claude-sonnet-4-6') {
      const res = await axios.post(
        `${this.baseUrl}/claude/v1/messages`,
        {
          model: 'claude-sonnet-4-6',
          stream: false,
          messages: [{ role: 'user', content: prompt }],
        },
        { headers, timeout: 90000 },
      );
      data = res.data;
    } else if (
      model === 'gemini-3-pro' ||
      model === 'gemini-3.1-pro' ||
      model === 'gemini-2.5-flash'
    ) {
      const res = await axios.post(
        `${this.baseUrl}/${model}/v1/chat/completions`,
        {
          stream: false,
          messages: [
            {
              role: 'user',
              content: [{ type: 'text', text: prompt }],
            },
          ],
        },
        { headers, timeout: 90000 },
      );
      data = res.data;
    } else {
      const res = await axios.post(
        `${this.baseUrl}/gemini/v1/models/gemini-3-flash-v1betamodels:streamGenerateContent`,
        {
          stream: false,
          contents: [
            {
              role: 'user',
              parts: [{ text: prompt }],
            },
          ],
          generationConfig: {
            thinkingConfig: {
              includeThoughts: false,
              thinkingLevel: 'low',
            },
          },
        },
        { headers, timeout: 90000 },
      );
      data = res.data;
    }

    const text = this.extractTextFromResponse(model, data);
    if (!text && data && typeof data === 'object') {
      const keys = Object.keys(data).join(', ');
      const errMsg =
        typeof (data as any).msg === 'string' ? String((data as any).msg).slice(0, 200) : '';
      this.logger.warn(
        `Kie LLM (${model}) HTTP OK but no extractable assistant text. topLevelKeys=[${keys}]${errMsg ? ` msg=${errMsg}` : ''}`,
      );
    }
    return text;
  }

  /**
   * @param useLocalFallback when true (default), sentence-split if Kie.ai fails or key missing.
   * When false, returns [] so callers can surface an error (e.g. Generate Script in UI).
   */
  async segmentScript(
    fullScript: string,
    model: SupportedLlmModel = 'gpt-5-4',
    options?: { useLocalFallback?: boolean; segmentationInstructions?: string | null },
  ): Promise<string[]> {
    const useLocalFallback = options?.useLocalFallback !== false;
    const script = fullScript?.trim();
    if (!script) return [];

    if (!this.apiKey) {
      if (useLocalFallback) return this.fallbackSegment(script);
      this.logger.warn('KIE_AI_API_KEY missing; strict segmentation returned empty.');
      return [];
    }

    try {
      const outputText = await this.callKieModel(
        model,
        this.buildPrompt(script, options?.segmentationInstructions),
      );

      if (!outputText) {
        this.logger.warn('Kie LLM returned empty output.');
        if (useLocalFallback) return this.fallbackSegment(script);
        return [];
      }

      const segments = this.parseSegmentsFromLlmOutput(outputText);
      if (segments?.length) return segments;

      this.logger.warn('Kie LLM output could not be parsed as JSON string array.');
      if (useLocalFallback) return this.fallbackSegment(script);
      return [];
    } catch (error: any) {
      this.logger.warn(`Kie LLM segmentation failed: ${error?.message}`);
      if (useLocalFallback) return this.fallbackSegment(script);
      return [];
    }
  }

  async segmentScriptWithMediaPlan(
    fullScript: string,
    contentType: 'video' | 'photo' | 'mixed' = 'mixed',
    model: SupportedLlmModel = 'gpt-5-4',
  ): Promise<PlannedSegment[]> {
    const baseSegments = await this.segmentScript(fullScript, model);
    const planned: PlannedSegment[] = baseSegments.map((text, index) => ({
      text,
      mediaType:
        contentType === 'video'
          ? 'video'
          : contentType === 'photo'
            ? 'image'
            : index % 2 === 0
              ? 'video'
              : 'image',
    }));

    this.logger.warn(
      `Using fallback LLM segment planner for ${planned.length} segments (${contentType})`,
    );
    return planned;
  }

  async deriveHeadline(script: string) {
    const firstLine = script
      .split(/\n+|(?<=[.!?])\s+/)
      .map((part) => part.trim())
      .find(Boolean);
    return firstLine || 'Generated headline';
  }

  private extractSingleLinePrompt(outputText: string): string {
    const stripped = String(outputText || '')
      .replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, ''))
      .trim();
    // take first non-empty line; many models still return multi-line
    const first = stripped
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)[0];
    const candidate = (first || stripped).trim();
    return candidate.replace(/^"+|"+$/g, '').trim();
  }

  async generateImagePrompt(
    scriptSegment: string,
    model: SupportedLlmModel = 'gpt-5-4',
  ): Promise<string> {
    const seg = (scriptSegment || '').trim();
    if (!seg) throw new Error('scriptSegment is required');
    if (!this.apiKey) throw new Error('KIE_AI_API_KEY missing; cannot generate image prompt');

    const prompt = [
      'You are a prompt writer for a text-to-image model.',
      'Task: write ONE concise image generation prompt based on the script segment below.',
      'Constraints:',
      '- cinematic, realistic, professional look',
      '- no visible text/captions/letters/numbers/logos/watermarks/subtitles/UI',
      '- describe subject, setting, lighting, composition, camera framing',
      '- output ONLY the final prompt text (no explanations, no JSON, no quotes)',
      '',
      'Script segment:',
      `"${seg}"`,
    ].join('\n');

    const out = await this.callKieModel(model, prompt);
    const single = this.extractSingleLinePrompt(out);
    if (!single) throw new Error('LLM returned empty image prompt');
    return single;
  }

  async generateVideoPrompt(
    scriptSegment: string,
    model: SupportedLlmModel = 'gpt-5-4',
  ): Promise<string> {
    const seg = (scriptSegment || '').trim();
    if (!seg) throw new Error('scriptSegment is required');
    if (!this.apiKey) throw new Error('KIE_AI_API_KEY missing; cannot generate video prompt');

    const prompt = [
      'You are a prompt writer for a text-to-video model.',
      'Task: write ONE concise video generation prompt based on the script segment below.',
      'Constraints:',
      '- cinematic, realistic motion, professional look',
      '- no visible text/captions/letters/numbers/logos/watermarks/subtitles/UI',
      '- describe action, setting, camera movement, lighting, mood',
      '- output ONLY the final prompt text (no explanations, no JSON, no quotes)',
      '',
      'Script segment:',
      `"${seg}"`,
    ].join('\n');

    const out = await this.callKieModel(model, prompt);
    const single = this.extractSingleLinePrompt(out);
    if (!single) throw new Error('LLM returned empty video prompt');
    return single;
  }

  private parseYoutubeMetadataJson(outputText: string): GeneratedYoutubeMetadata | null {
    const stripped = outputText.replace(/```json\s*|```/gi, '').trim();
    const tryParse = (raw: string): GeneratedYoutubeMetadata | null => {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object') return null;
        const o = parsed as Record<string, unknown>;
        const title = typeof o.title === 'string' ? o.title.trim() : '';
        const description = typeof o.description === 'string' ? o.description.trim() : '';
        const tagsRaw = o.tags;
        const tags: string[] = [];
        if (Array.isArray(tagsRaw)) {
          for (const t of tagsRaw) {
            if (typeof t === 'string' && t.trim()) tags.push(t.trim());
          }
        }
        if (!title) return null;
        return { title, description, tags };
      } catch {
        return null;
      }
    };
    const direct = tryParse(stripped);
    if (direct) return direct;
    const brace = stripped.match(/\{[\s\S]*\}/);
    if (brace) return tryParse(brace[0]);
    return null;
  }

  private clampYoutubeMetadata(meta: GeneratedYoutubeMetadata): GeneratedYoutubeMetadata {
    return {
      title: meta.title.replace(/\s+/g, ' ').trim().slice(0, 100),
      description: meta.description.trim().slice(0, 4800),
      tags: meta.tags.slice(0, 15).map((t) => t.replace(/^#+/, '').trim().slice(0, 48)),
    };
  }

  /**
   * Single LLM call: title, description, tags for YouTube. Returns null on failure (caller should fallback).
   */
  async generateYoutubeMetadata(params: {
    fullScript: string;
    webhookTitle: string | null;
    titleInstructions: string;
    descriptionInstructions: string;
    tagsInstructions: string;
    model: SupportedLlmModel;
  }): Promise<GeneratedYoutubeMetadata | null> {
    const script = params.fullScript?.trim();
    if (!script) return null;
    if (!this.apiKey) {
      this.logger.warn('KIE_AI_API_KEY missing; cannot generate YouTube metadata');
      return null;
    }

    const header = [
      'You produce metadata for a YouTube upload (e.g. Shorts). Reply with ONLY valid JSON, no markdown fences.',
      'Schema: {"title":"string","description":"string","tags":["string",...]}',
      'Hard limits:',
      '- title: max 100 characters, single line, no hashtags, engaging and accurate.',
      '- description: max 4800 characters; summarize what the video is about; plain text.',
      '- tags: 5-12 short tags (words or short phrases), no # character.',
      '- Use the same language as the script unless the instructions below say otherwise.',
    ].join('\n');

    const ctx = params.webhookTitle
      ? `Headline from the publisher (context, optional to use): "${params.webhookTitle}"\n\n`
      : '';

    const userBlock = [
      '--- Title instructions ---',
      params.titleInstructions.trim() ||
        'Write a clear, clickable YouTube title for this video.',
      '',
      '--- Description instructions ---',
      params.descriptionInstructions.trim() ||
        'Write a viewer-friendly description summarizing the video.',
      '',
      '--- Tags instructions ---',
      params.tagsInstructions.trim() ||
        'Suggest relevant YouTube search tags.',
      '',
      '--- Video script (full) ---',
      script,
    ].join('\n');

    const prompt = `${header}\n\n${ctx}${userBlock}`;

    try {
      const outputText = await this.callKieModel(params.model, prompt);
      if (!outputText) return null;
      const parsed = this.parseYoutubeMetadataJson(outputText);
      if (!parsed) {
        this.logger.warn('YouTube metadata LLM output could not be parsed as JSON');
        return null;
      }
      return this.clampYoutubeMetadata(parsed);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`YouTube metadata LLM failed: ${msg}`);
      return null;
    }
  }
}
