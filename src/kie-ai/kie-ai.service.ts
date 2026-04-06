import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

const KIE_BASE_URL = 'https://api.kie.ai';

export interface KieCreditResponse {
  code: number;
  msg: string;
  data: number;
}

export interface KieCreateTaskResponse {
  code: number;
  msg: string;
  data: { taskId: string };
}

export interface KieTaskDetailsResponse {
  code: number;
  msg: string;
  data: {
    taskId: string;
    model: string;
    state: 'waiting' | 'queuing' | 'generating' | 'success' | 'fail';
    param?: string;
    resultJson?: string;
    failCode?: string;
    failMsg?: string;
    progress?: number;
  } | null;
}

/** Kie Market image models (POST /api/v1/jobs/createTask). */
export type KieMarketImageModel =
  | 'z-image'
  | 'nano-banana-pro'
  | 'google/nano-banana'
  | 'flux-2/pro-text-to-image'
  | 'flux-2/flex-text-to-image'
  | 'grok-imagine/text-to-image'
  | 'gpt-image/1.5-text-to-image';

/** Kie Market video models (POST /api/v1/jobs/createTask). */
export type KieMarketVideoModel =
  | 'bytedance/v1-lite-text-to-video'
  | 'wan/2-6-text-to-video'
  | 'grok-imagine/image-to-video';

export type KieZImageAspectRatio = '1:1' | '4:3' | '3:4' | '16:9' | '9:16';

export type KieFluxAspectRatio =
  | '1:1'
  | '4:3'
  | '3:4'
  | '16:9'
  | '9:16'
  | '3:2'
  | '2:3';

export type KieNanoBananaProAspectRatio =
  | '1:1'
  | '2:3'
  | '3:2'
  | '3:4'
  | '4:3'
  | '4:5'
  | '5:4'
  | '9:16'
  | '16:9'
  | '21:9'
  | 'auto';

export type KieGoogleNanoBananaImageSize =
  | '1:1'
  | '9:16'
  | '16:9'
  | '3:4'
  | '4:3'
  | '3:2'
  | '2:3'
  | '5:4'
  | '4:5'
  | '21:9'
  | 'auto';

export type KieGrokImagineAspectRatio =
  | '1:1'
  | '16:9'
  | '9:16'
  | '2:3'
  | '3:2';

export type KieGptImageAspectRatio = '1:1' | '2:3' | '3:2';

export type CreateKieImageTaskParams =
  | {
      model: 'z-image';
      prompt: string;
      aspect_ratio: KieZImageAspectRatio;
      nsfw_checker?: boolean;
      callBackUrl?: string;
    }
  | {
      model: 'nano-banana-pro';
      prompt: string;
      aspect_ratio: KieNanoBananaProAspectRatio;
      resolution?: '1K' | '2K' | '4K';
      output_format?: 'png' | 'jpg';
      image_input?: string[];
      callBackUrl?: string;
    }
  | {
      model: 'google/nano-banana';
      prompt: string;
      image_size: KieGoogleNanoBananaImageSize;
      output_format?: 'png' | 'jpeg';
      callBackUrl?: string;
    }
  | {
      model: 'flux-2/pro-text-to-image' | 'flux-2/flex-text-to-image';
      prompt: string;
      aspect_ratio: KieFluxAspectRatio;
      resolution?: '1K' | '2K';
      nsfw_checker?: boolean;
      callBackUrl?: string;
    }
  | {
      model: 'grok-imagine/text-to-image';
      prompt: string;
      aspect_ratio: KieGrokImagineAspectRatio;
      callBackUrl?: string;
    }
  | {
      model: 'gpt-image/1.5-text-to-image';
      prompt: string;
      aspect_ratio: KieGptImageAspectRatio;
      quality?: 'medium' | 'high';
      callBackUrl?: string;
    };

export type KieBytedanceTextToVideoDuration = '5' | '10' | '15';
export type KieBytedanceTextToVideoResolution = '720p' | '1080p';

export type KieWanTextToVideoDuration = '5' | '10' | '15';
export type KieWanTextToVideoResolution = '720p' | '1080p';

export type KieGrokImageToVideoMode = 'fun' | 'normal' | 'spicy';
export type KieGrokImageToVideoResolution = '480p' | '720p';

export type CreateKieVideoTaskParams =
  | {
      model: 'bytedance/v1-lite-text-to-video';
      prompt: string;
      callBackUrl?: string;
      progressCallBackUrl?: string;
      aspect_ratio?: string;
      resolution?: KieBytedanceTextToVideoResolution;
      duration?: KieBytedanceTextToVideoDuration;
      camera_fixed?: boolean;
      seed?: number;
      enable_safety_checker?: boolean;
      nsfw_checker?: boolean;
    }
  | {
      model: 'wan/2-6-text-to-video';
      prompt: string;
      callBackUrl?: string;
      aspect_ratio?: string;
      duration?: KieWanTextToVideoDuration;
      resolution?: KieWanTextToVideoResolution;
      nsfw_checker?: boolean;
    }
  | {
      model: 'grok-imagine/image-to-video';
      callBackUrl?: string;
      input: {
        /** Provide external image URLs (max 7). Do not use with task_id. */
        image_urls?: string[];
        /** Use taskId from grok-imagine/text-to-image. Do not use with image_urls. */
        task_id?: string;
        /** 0-based index (0-5) when using task_id. */
        index?: number;
        /** Motion prompt. Optional per docs. */
        prompt?: string;
        mode?: KieGrokImageToVideoMode;
        /** 6-30 seconds. */
        duration?: string;
        resolution?: KieGrokImageToVideoResolution;
        /**
         * Only applies to multi-image mode per docs; keep optional.
         * (Single-image uses image dimensions.)
         */
        aspect_ratio?: '2:3' | '3:2' | '1:1' | '16:9' | '9:16';
      };
    };

function makeSvgDataUrl(label: string, prompt: string): string {
  const safePrompt = prompt
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="576" viewBox="0 0 1024 576">
  <rect width="1024" height="576" fill="#18181b"/>
  <text x="512" y="110" text-anchor="middle" fill="#f59e0b" font-family="Arial, sans-serif" font-size="32">${label}</text>
  <foreignObject x="110" y="170" width="804" height="250">
    <div xmlns="http://www.w3.org/1999/xhtml" style="font-family:Arial,sans-serif;color:#fff;font-size:24px;line-height:1.5;text-align:center;">
      ${safePrompt}
    </div>
  </foreignObject>
</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

@Injectable()
export class KieAiService {
  private readonly logger = new Logger(KieAiService.name);
  private readonly apiKey: string;

  constructor(private readonly configService: ConfigService) {
    this.apiKey = this.configService.get<string>('KIE_AI_API_KEY', '');
    if (!this.apiKey) {
      this.logger.warn('KIE_AI_API_KEY is not set — Kie AI calls will fail');
    }
  }

  async getCredits(): Promise<KieCreditResponse> {
    if (!this.apiKey?.trim()) {
      throw new ServiceUnavailableException('KIE_AI_API_KEY is not configured');
    }
    try {
      const { data } = await axios.get<KieCreditResponse>(
        `${KIE_BASE_URL}/api/v1/chat/credit`,
        { headers: { Authorization: `Bearer ${this.apiKey}` } },
      );
      return data;
    } catch (err: unknown) {
      const ax = err as { response?: { data?: { msg?: string } }; message?: string };
      const msg =
        ax?.response?.data?.msg || ax?.message || 'Failed to fetch Kie.ai credits';
      this.logger.warn(`Kie credit check failed: ${msg}`);
      throw new ServiceUnavailableException(msg);
    }
  }

  async createVideoTask(prompt: string, _bucket?: string, _options?: Record<string, unknown>) {
    // Backward compat: keep this method, but prefer createMarketVideoTask().
    // If any existing code calls createVideoTask(prompt), we return a stub.
    const taskId = `fallback-video-${Date.now()}`;
    this.logger.warn(`Using fallback Kie video task stub for task ${taskId}`);
    this.logger.debug(prompt);
    return taskId;
  }

  async createMarketVideoTask(params: CreateKieVideoTaskParams): Promise<string> {
    // Use the same unified createTask endpoint for all video models.
    if (params.model === 'bytedance/v1-lite-text-to-video') {
      const prompt = params.prompt.trim();
      if (!prompt) throw new Error('Kie video prompt is required');
      const slicedPrompt = prompt.slice(0, 10000);
      if (!params.aspect_ratio) {
        throw new Error(`Kie model 'bytedance/v1-lite-text-to-video' requires aspect_ratio`);
      }
      return this.postCreateTask({
        model: params.model,
        callBackUrl: params.callBackUrl,
        input: {
          prompt: slicedPrompt,
          aspect_ratio: params.aspect_ratio,
          resolution: params.resolution ?? '720p',
          duration: params.duration ?? '5',
          camera_fixed: params.camera_fixed ?? false,
          seed: params.seed ?? -1,
          enable_safety_checker: params.enable_safety_checker ?? true,
          nsfw_checker: params.nsfw_checker ?? false,
        },
      });
    }

    // wan/2-6-text-to-video
    if (params.model === 'wan/2-6-text-to-video') {
      const prompt = params.prompt.trim();
      if (!prompt) throw new Error('Kie video prompt is required');
      const slicedPrompt = prompt.slice(0, 10000);
      return this.postCreateTask({
        model: params.model,
        callBackUrl: params.callBackUrl,
        input: {
          prompt: slicedPrompt,
          duration: params.duration ?? '5',
          resolution: params.resolution ?? '1080p',
          nsfw_checker: params.nsfw_checker ?? false,
        },
      });
    }

    if (params.model === 'grok-imagine/image-to-video') {
      const input = params.input || {};
      const hasUrls = Array.isArray(input.image_urls) && input.image_urls.length > 0;
      const hasTask = typeof input.task_id === 'string' && input.task_id.trim().length > 0;
      if (hasUrls && hasTask) {
        throw new Error(`Kie model 'grok-imagine/image-to-video': provide either image_urls or task_id, not both`);
      }
      if (!hasUrls && !hasTask) {
        throw new Error(`Kie model 'grok-imagine/image-to-video' requires image_urls or task_id`);
      }
      return this.postCreateTask({
        model: params.model,
        callBackUrl: params.callBackUrl,
        input: {
          ...(hasUrls ? { image_urls: input.image_urls } : {}),
          ...(hasTask ? { task_id: input.task_id, index: input.index ?? 0 } : {}),
          ...(typeof input.prompt === 'string' && input.prompt.trim()
            ? { prompt: input.prompt.trim().slice(0, 5000) }
            : {}),
          mode: input.mode ?? 'normal',
          ...(input.duration ? { duration: input.duration } : {}),
          ...(input.resolution ? { resolution: input.resolution } : {}),
          ...(input.aspect_ratio ? { aspect_ratio: input.aspect_ratio } : {}),
        },
      });
    }

    throw new Error(`Unsupported Kie video model: ${(params as any).model}`);
  }

  /**
   * Poll task until completion and extract first `resultUrls[0]` from task `resultJson`.
   * Caller can download the URL to a local file.
   */
  async getFirstTaskResultUrl(taskId: string): Promise<string> {
    const details = await this.pollTaskUntilComplete(taskId);
    if (details?.data?.state === 'fail') {
      throw new Error(
        `Kie task failed: ${(details?.data?.failMsg as string) || details?.data?.failCode || 'unknown'}`,
      );
    }
    const resultJson = details?.data?.resultJson ? JSON.parse(details.data.resultJson) : null;

    const url: string | undefined =
      resultJson?.resultUrls?.[0] ||
      resultJson?.resultUrl ||
      resultJson?.url;

    if (!url) {
      throw new Error('Kie task success but no result url found in resultJson');
    }

    return url;
  }

  private async postCreateTask(body: Record<string, unknown>): Promise<string> {
    if (!this.apiKey?.trim()) {
      throw new ServiceUnavailableException('KIE_AI_API_KEY is not configured');
    }
    const { data } = await axios.post<KieCreateTaskResponse>(
      `${KIE_BASE_URL}/api/v1/jobs/createTask`,
      body,
      { headers: { Authorization: `Bearer ${this.apiKey}` } },
    );
    if (data?.code !== 200 || !data?.data?.taskId) {
      throw new Error(data?.msg || `Kie createTask failed (code=${data?.code ?? '?'})`);
    }
    return data.data.taskId;
  }

  /**
   * Unified Kie Market image generation task (text-to-image + stills).
   * @see https://docs.kie.ai — model-specific `input` fields per OpenAPI.
   */
  async createImageTask(params: CreateKieImageTaskParams): Promise<string> {
    if (params.model === 'z-image') {
      const prompt = params.prompt.trim().slice(0, 1000);
      return this.postCreateTask({
        model: 'z-image',
        callBackUrl: params.callBackUrl,
        input: {
          prompt,
          aspect_ratio: params.aspect_ratio,
          nsfw_checker: params.nsfw_checker ?? true,
        },
      });
    }
    if (params.model === 'nano-banana-pro') {
      const prompt = params.prompt.trim().slice(0, 10000);
      return this.postCreateTask({
        model: 'nano-banana-pro',
        callBackUrl: params.callBackUrl,
        input: {
          prompt,
          aspect_ratio: params.aspect_ratio,
          resolution: params.resolution ?? '1K',
          output_format: params.output_format ?? 'png',
          ...(params.image_input?.length ? { image_input: params.image_input } : {}),
        },
      });
    }
    if (params.model === 'flux-2/pro-text-to-image' || params.model === 'flux-2/flex-text-to-image') {
      const prompt = params.prompt.trim().slice(0, 5000);
      return this.postCreateTask({
        model: params.model,
        callBackUrl: params.callBackUrl,
        input: {
          prompt,
          aspect_ratio: params.aspect_ratio,
          resolution: params.resolution ?? '1K',
          nsfw_checker: params.nsfw_checker ?? true,
        },
      });
    }
    if (params.model === 'grok-imagine/text-to-image') {
      const prompt = params.prompt.trim().slice(0, 5000);
      return this.postCreateTask({
        model: params.model,
        callBackUrl: params.callBackUrl,
        input: {
          prompt,
          aspect_ratio: params.aspect_ratio,
        },
      });
    }
    if (params.model === 'gpt-image/1.5-text-to-image') {
      const prompt = params.prompt.trim().slice(0, 5000);
      return this.postCreateTask({
        model: params.model,
        callBackUrl: params.callBackUrl,
        input: {
          prompt,
          aspect_ratio: params.aspect_ratio,
          quality: params.quality ?? 'medium',
        },
      });
    }
    if (params.model === 'google/nano-banana') {
      const prompt = params.prompt.trim().slice(0, 5000);
      return this.postCreateTask({
        model: 'google/nano-banana',
        callBackUrl: params.callBackUrl,
        input: {
          prompt,
          image_size: params.image_size,
          output_format: params.output_format ?? 'png',
        },
      });
    }

    throw new Error(`Unsupported Kie image model: ${(params as any).model}`);
  }

  /** @deprecated Prefer createImageTask({ model: 'z-image', ... }) */
  async createZImageTask(input: {
    prompt: string;
    aspect_ratio: KieZImageAspectRatio;
    nsfw_checker?: boolean;
    callBackUrl?: string;
  }): Promise<string> {
    return this.createImageTask({
      model: 'z-image',
      prompt: input.prompt,
      aspect_ratio: input.aspect_ratio,
      nsfw_checker: input.nsfw_checker,
      callBackUrl: input.callBackUrl,
    });
  }

  async getTaskDetails(taskId: string): Promise<KieTaskDetailsResponse> {
    const { data } = await axios.get<KieTaskDetailsResponse>(
      `${KIE_BASE_URL}/api/v1/jobs/recordInfo`,
      {
        params: { taskId },
        headers: { Authorization: `Bearer ${this.apiKey}` },
      },
    );
    return data;
  }

  async pollTaskUntilComplete(
    taskId: string,
    intervalMs = 4000,
    maxAttempts = 60,
  ): Promise<KieTaskDetailsResponse> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const res = await this.getTaskDetails(taskId);
      const state = res?.data?.state;
      this.logger.debug(`[pollTask] ${taskId} state=${state} attempt=${attempt}/${maxAttempts}`);
      if (state === 'success' || state === 'fail') return res;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`Kie.ai task ${taskId} timed out after ${maxAttempts} attempts`);
  }

  async generateImage(prompt: string, _options?: Record<string, unknown>) {
    this.logger.warn('Using fallback Kie image output');
    return makeSvgDataUrl('Fallback Image Output', prompt);
  }
}
