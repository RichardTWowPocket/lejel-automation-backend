import { Injectable, Logger } from '@nestjs/common';
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
    const { data } = await axios.get<KieCreditResponse>(
      `${KIE_BASE_URL}/api/v1/chat/credit`,
      { headers: { Authorization: `Bearer ${this.apiKey}` } },
    );
    return data;
  }

  async createVideoTask(prompt: string, _bucket?: string, _options?: Record<string, unknown>) {
    const taskId = `fallback-video-${Date.now()}`;
    this.logger.warn(`Using fallback Kie video task stub for task ${taskId}`);
    this.logger.debug(prompt);
    return taskId;
  }

  async createZImageTask(input: {
    prompt: string;
    aspect_ratio: '1:1' | '4:3' | '3:4' | '16:9' | '9:16';
    nsfw_checker?: boolean;
    callBackUrl?: string;
  }): Promise<string> {
    const { data } = await axios.post<KieCreateTaskResponse>(
      `${KIE_BASE_URL}/api/v1/jobs/createTask`,
      {
        model: 'z-image',
        callBackUrl: input.callBackUrl,
        input: {
          prompt: input.prompt,
          aspect_ratio: input.aspect_ratio,
          nsfw_checker: input.nsfw_checker ?? true,
        },
      },
      { headers: { Authorization: `Bearer ${this.apiKey}` } },
    );
    return data?.data?.taskId;
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
