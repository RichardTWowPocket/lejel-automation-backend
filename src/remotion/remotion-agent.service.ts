import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { SupportedLlmModel } from '../llm/llm.service';
import { RemotionService } from './remotion.service';
import { buildAgentSystemPrompt } from './remotion-best-practices';
import { validateTsx, formatValidationErrors } from './remotion-validator';

// ─── Types ───────────────────────────────────────────────────────────────────────

export type AgentStatus = 'idle' | 'thinking' | 'generating' | 'validating' | 'rendering' | 'error';

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string;
  action?: 'think' | 'generate' | 'revise' | 'render' | 'error';
  tsxSource?: string;
  renderUrl?: string;
}

export interface AgentSession {
  id: string;
  messages: AgentMessage[];
  currentTsx: string | null;
  currentTsxLabel: string | null;
  lastRenderUrl: string | null;
  canvas: { width: number; height: number };
  fps: number;
  durationInFrames: number;
  model: SupportedLlmModel;
  status: AgentStatus;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateSessionOptions {
  canvas?: { width: number; height: number };
  model?: SupportedLlmModel;
  fps?: number;
  durationInFrames?: number;
}

interface LlmAction {
  action: 'think' | 'generate' | 'revise' | 'render';
  content: string;
}

// ─── Session Store ───────────────────────────────────────────────────────────────

const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

// ─── Service ─────────────────────────────────────────────────────────────────────

@Injectable()
export class RemotionAgentService {
  private readonly logger = new Logger(RemotionAgentService.name);
  private readonly sessions = new Map<string, AgentSession>();

  constructor(private readonly remotionService: RemotionService) {
    setInterval(() => this.cleanupStaleSessions(), CLEANUP_INTERVAL_MS);
  }

  // ─── Session Management ──────────────────────────────────────────────────────

  createSession(opts?: CreateSessionOptions): AgentSession {
    const session: AgentSession = {
      id: randomUUID(),
      messages: [],
      currentTsx: null,
      currentTsxLabel: null,
      lastRenderUrl: null,
      canvas: opts?.canvas ?? { width: 1080, height: 1920 },
      fps: opts?.fps ?? 30,
      durationInFrames: opts?.durationInFrames ?? 210,
      model: opts?.model ?? 'claude-sonnet-4-6',
      status: 'idle',
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.sessions.set(session.id, session);
    this.logger.log(`Created agent session ${session.id}`);
    return session;
  }

  getSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  getSessionOrThrow(sessionId: string): AgentSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new NotFoundException(`Agent session ${sessionId} not found`);
    }
    return session;
  }

  // ─── Message Processing ──────────────────────────────────────────────────────

  async processMessage(sessionId: string, userContent: string): Promise<AgentSession> {
    const session = this.getSessionOrThrow(sessionId);

    if (session.status !== 'idle') {
      throw new BadRequestException('Session is busy processing. Wait for it to become idle.');
    }

    // Add user message
    session.messages.push({ role: 'user', content: userContent });
    session.status = 'thinking';
    session.error = null;
    this.touch(session);

    try {
      await this.runAgentLoop(session);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Agent session ${sessionId} error: ${msg}`);
      session.status = 'error';
      session.error = msg;

      const isMaintenance = /maintenance/i.test(msg);
      const isModelError = /model|kie\.ai/i.test(msg);
      let hint = '';
      if (isMaintenance) {
        hint = ' The AI server is under maintenance. You can switch to a different model (like GPT-5-4 or Gemini) using the dropdown on the start screen, or try again later.';
      } else if (isModelError) {
        hint = ' Try switching to a different AI model, or try again in a moment.';
      }

      session.messages.push({
        role: 'assistant',
        content: `I ran into an error: ${msg}.${hint}`,
        action: 'error',
      });
      this.touch(session);
    }

    return session;
  }

  // ─── Agent Loop ──────────────────────────────────────────────────────────────

  private async runAgentLoop(session: AgentSession): Promise<void> {
    let turnCount = 0;
    const MAX_TURNS = 5;

    while (turnCount < MAX_TURNS) {
      turnCount++;

      const llmResponse = await this.callLlmForAgent(session);
      const parsed = this.parseLlmAction(llmResponse);

      this.logger.debug(`Agent turn ${turnCount}: action=${parsed.action}`);

      const done = await this.executeAction(session, parsed);
      if (done) return;
    }

    // Max turns reached — summarize and stop
    session.status = 'idle';
    session.messages.push({
      role: 'assistant',
      content:
        'I have an idea brewing but limited myself to a few iterations. Feel free to give more specific feedback or a new request.',
      action: 'think',
    });
    this.touch(session);
  }

  private async executeAction(session: AgentSession, action: LlmAction): Promise<boolean> {
    switch (action.action) {
      case 'think': {
        session.status = 'idle';
        session.messages.push({
          role: 'assistant',
          content: action.content,
          action: 'think',
          tsxSource: session.currentTsx ?? undefined,
          renderUrl: session.lastRenderUrl ?? undefined,
        });
        this.touch(session);
        return true;
      }

      case 'generate': {
        session.status = 'generating';
        this.touch(session);

        try {
          const tsx = await this.remotionService.generateTsx(
            action.content,
            session.model,
            session.canvas,
          );
          session.currentTsx = tsx;
          session.currentTsxLabel = this.extractTitle(action.content);

          // Auto-render after successful generation
          session.status = 'rendering';
          this.touch(session);

          const renderResult = await this.remotionService.renderSource({
            source: tsx,
            durationInFrames: session.durationInFrames,
            fps: session.fps,
            width: session.canvas.width,
            height: session.canvas.height,
          });

          session.lastRenderUrl = renderResult.outputUrl;
          session.status = 'idle';
          session.messages.push({
            role: 'assistant',
            content: `I created a composition${session.currentTsxLabel ? ` about "${session.currentTsxLabel}"` : ''}. Here's the preview — let me know what you'd like to change.`,
            action: 'generate',
            tsxSource: tsx,
            renderUrl: renderResult.outputUrl,
          });
          this.touch(session);
          return true;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          session.status = 'error';
          session.error = msg;
          session.messages.push({
            role: 'assistant',
            content: `Generation failed: ${msg}. Could you describe what you\'re looking for in more detail?`,
            action: 'error',
          });
          this.touch(session);
          return true;
        }
      }

      case 'revise': {
        if (!session.currentTsx) {
          session.messages.push({
            role: 'assistant',
            content:
              'There is no existing composition to revise. Please describe what you want to create from scratch.',
            action: 'think',
          });
          session.status = 'idle';
          this.touch(session);
          return true;
        }

        session.status = 'generating';
        this.touch(session);

        try {
          const tsx = await this.remotionService.reviseTsx(
            session.currentTsx,
            action.content,
            session.model,
            session.canvas,
          );
          session.currentTsx = tsx;

          // Auto-render after revision
          session.status = 'rendering';
          this.touch(session);

          const renderResult = await this.remotionService.renderSource({
            source: tsx,
            durationInFrames: session.durationInFrames,
            fps: session.fps,
            width: session.canvas.width,
            height: session.canvas.height,
          });

          session.lastRenderUrl = renderResult.outputUrl;
          session.status = 'idle';
          session.messages.push({
            role: 'assistant',
            content: `I applied your changes and re-rendered. Take a look — what else should I adjust?`,
            action: 'revise',
            tsxSource: tsx,
            renderUrl: renderResult.outputUrl,
          });
          this.touch(session);
          return true;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          session.status = 'error';
          session.error = msg;
          session.messages.push({
            role: 'assistant',
            content: `Revision failed: ${msg}. Could you rephrase what you\'d like changed?`,
            action: 'error',
          });
          this.touch(session);
          return true;
        }
      }

      case 'render': {
        if (!session.currentTsx) {
          session.messages.push({
            role: 'assistant',
            content:
              'Nothing to render yet. Tell me what kind of video you want to create first.',
            action: 'think',
          });
          session.status = 'idle';
          this.touch(session);
          return true;
        }

        session.status = 'rendering';
        this.touch(session);

        try {
          const renderResult = await this.remotionService.renderSource({
            source: session.currentTsx,
            durationInFrames: session.durationInFrames,
            fps: session.fps,
            width: session.canvas.width,
            height: session.canvas.height,
          });

          session.lastRenderUrl = renderResult.outputUrl;
          session.status = 'idle';
          session.messages.push({
            role: 'assistant',
            content: 'Re-rendered the composition. Here\'s the result.',
            action: 'render',
            tsxSource: session.currentTsx ?? undefined,
            renderUrl: renderResult.outputUrl,
          });
          this.touch(session);
          return true;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          session.status = 'error';
          session.error = msg;
          session.messages.push({
            role: 'assistant',
            content: `Render failed: ${msg}. Let me know if you want to adjust the composition.`,
            action: 'error',
          });
          this.touch(session);
          return true;
        }
      }

      default:
        session.status = 'idle';
        session.messages.push({
          role: 'assistant',
          content:
            'I\'m not sure what action to take. Could you clarify what you\'d like me to do?',
          action: 'think',
        });
        this.touch(session);
        return true;
    }
  }

  // ─── LLM Call ────────────────────────────────────────────────────────────────

  private async callLlmForAgent(session: AgentSession): Promise<string> {
    const stateLines: string[] = [
      `Canvas: ${session.canvas.width} × ${session.canvas.height}`,
      `FPS: ${session.fps}, Duration: ${session.durationInFrames} frames`,
      `Model: ${session.model}`,
      `Has TSX: ${session.currentTsx ? 'yes' : 'no'}`,
      `Has render: ${session.lastRenderUrl ? 'yes' : 'no'}`,
    ];

    const conversationLines: string[] = [];
    for (const msg of session.messages) {
      if (msg.role === 'user') {
        conversationLines.push(`User: ${msg.content}`);
      } else {
        const actionInfo = msg.action ? `[action: ${msg.action}]` : '';
        const renderInfo = msg.renderUrl ? `\n  (render available: ${msg.renderUrl})` : '';
        conversationLines.push(`Assistant${actionInfo}: ${msg.content}${renderInfo}`);
      }
    }

    const systemPrompt = buildAgentSystemPrompt(stateLines.join('\n'));
    const fullPrompt = systemPrompt + conversationLines.join('\n') + '\n\nAssistant:';

    return this.remotionService.callLlmForAgent(session.model, fullPrompt);
  }

  // ─── Action Parsing ──────────────────────────────────────────────────────────

  private parseLlmAction(raw: string): LlmAction {
    const actionMatch = raw.match(/^ACTION:\s*(think|generate|revise|render)\s*$/im);
    if (!actionMatch) {
      return { action: 'think', content: raw.trim() };
    }

    const action = actionMatch[1].toLowerCase() as LlmAction['action'];
    let content = raw.replace(/^ACTION:\s*(think|generate|revise|render)\s*/im, '').trim();
    content = content.replace(/^CONTENT:\s*/im, '').trim();

    if (action === 'generate' || action === 'revise') {
      if (!content) {
        // Try to extract code block
        const codeMatch = raw.match(/```(?:tsx|typescript|ts|jsx)?\s*([\s\S]*?)```/);
        if (codeMatch) {
          content = codeMatch[1].trim();
        }
      }
    }

    return { action, content };
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private extractTitle(prompt: string): string | null {
    const cleaned = prompt.replace(/^(create|make|generate|build|design)\s+/i, '').trim();
    return cleaned.length > 60 ? cleaned.slice(0, 57) + '...' : cleaned;
  }

  private touch(session: AgentSession): void {
    session.updatedAt = Date.now();
  }

  private cleanupStaleSessions(): void {
    const now = Date.now();
    let count = 0;
    for (const [id, session] of this.sessions) {
      if (now - session.updatedAt > SESSION_TTL_MS) {
        this.sessions.delete(id);
        count++;
      }
    }
    if (count > 0) {
      this.logger.log(`Cleaned up ${count} stale agent sessions`);
    }
  }
}
