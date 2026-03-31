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

  private buildPrompt(script: string): string {
    return [
      'Split the following script into speaking segments for TTS-driven video generation.',
      'Rules:',
      '- each segment should be around 1-2 sentences',
      '- each segment should be roughly 6-12 seconds in spoken duration',
      '- keep original language and meaning',
      '- do not add commentary',
      'Return ONLY valid JSON array of strings.',
      '',
      script,
    ].join('\n');
  }

  private extractTextFromResponse(model: SupportedLlmModel, data: any): string {
    if (model === 'gpt-5-4') {
      return (
        data?.output
          ?.flatMap((item: any) => item?.content ?? [])
          ?.filter((content: any) =>
            content?.type === 'output_text' || content?.type === 'text',
          )
          ?.map((content: any) => content?.text ?? '')
          ?.join('\n')
          ?.trim() ?? ''
      );
    }

    if (model === 'gpt-5-2') {
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content === 'string') return content.trim();
      if (Array.isArray(content)) {
        return content
          .map((c: any) => c?.text || '')
          .join('\n')
          .trim();
      }
      return '';
    }

    if (model === 'claude-sonnet-4-6') {
      const content = data?.content;
      if (!Array.isArray(content)) return '';
      return content
        .map((c: any) => c?.text || '')
        .join('\n')
        .trim();
    }

    if (
      model === 'gemini-3-pro' ||
      model === 'gemini-3.1-pro' ||
      model === 'gemini-2.5-flash'
    ) {
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content === 'string') return content.trim();
      if (Array.isArray(content)) {
        return content
          .map((p: any) => p?.text || '')
          .join('\n')
          .trim();
      }
      return '';
    }

    // gemini-3-flash
    return (
      data?.candidates?.[0]?.content?.parts
        ?.map((p: any) => p?.text || '')
        ?.join('\n')
        ?.trim() ?? ''
    );
  }

  private async callKieModel(
    model: SupportedLlmModel,
    prompt: string,
  ): Promise<string> {
    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };

    if (model === 'gpt-5-4') {
      const { data } = await axios.post(
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
      return this.extractTextFromResponse(model, data);
    }

    if (model === 'gpt-5-2') {
      const { data } = await axios.post(
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
      return this.extractTextFromResponse(model, data);
    }

    if (model === 'claude-sonnet-4-6') {
      const { data } = await axios.post(
        `${this.baseUrl}/claude/v1/messages`,
        {
          model: 'claude-sonnet-4-6',
          stream: false,
          messages: [{ role: 'user', content: prompt }],
        },
        { headers, timeout: 90000 },
      );
      return this.extractTextFromResponse(model, data);
    }

    if (
      model === 'gemini-3-pro' ||
      model === 'gemini-3.1-pro' ||
      model === 'gemini-2.5-flash'
    ) {
      const { data } = await axios.post(
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
      return this.extractTextFromResponse(model, data);
    }

    const { data } = await axios.post(
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
    return this.extractTextFromResponse(model, data);
  }

  async segmentScript(
    fullScript: string,
    model: SupportedLlmModel = 'gpt-5-4',
  ): Promise<string[]> {
    const script = fullScript?.trim();
    if (!script) return [];

    if (!this.apiKey) {
      return this.fallbackSegment(script);
    }

    try {
      const outputText = await this.callKieModel(model, this.buildPrompt(script));

      if (!outputText) {
        this.logger.warn('Kie LLM returned empty output. Using fallback segmenter.');
        return this.fallbackSegment(script);
      }

      const normalized = outputText.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(normalized);
      if (!Array.isArray(parsed)) {
        this.logger.warn('Kie LLM output is not an array. Using fallback segmenter.');
        return this.fallbackSegment(script);
      }

      const segments = parsed
        .map((s) => (typeof s === 'string' ? s.trim() : ''))
        .filter(Boolean);
      return segments.length > 0 ? segments : this.fallbackSegment(script);
    } catch (error: any) {
      this.logger.warn(`Kie LLM segmentation failed, using fallback: ${error?.message}`);
      return this.fallbackSegment(script);
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
}
