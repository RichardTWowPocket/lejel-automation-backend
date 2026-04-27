import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as dns from 'dns/promises';
import { isIPv4, isIPv6 } from 'net';

const CRAWL_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function isPrivateOrReservedIp(ip: string): boolean {
  if (isIPv6(ip)) {
    if (ip === '::1') return true;
    const lower = ip.toLowerCase();
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local
    if (lower.startsWith('fe80:')) return true; // link-local
    return false;
  }
  if (!isIPv4(ip)) return true;
  const parts = ip.split('.').map((x) => parseInt(x, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

async function hostnameResolvesToSafeIps(hostname: string): Promise<void> {
  try {
    const v4 = await dns.lookup(hostname, { all: true, verbatim: true });
    for (const r of v4) {
      if (isPrivateOrReservedIp(r.address)) {
        throw new BadRequestException('URL resolves to a non-public address');
      }
    }
  } catch (e) {
    if (e instanceof BadRequestException) throw e;
    throw new BadRequestException('Could not resolve URL host');
  }
}

/** Crawl4AI model_dump puts `markdown` as an object with raw/fit strings, not a plain string. */
function textFromMarkdownField(markdown: unknown): string | null {
  if (typeof markdown === 'string' && markdown.trim()) {
    return markdown.trim();
  }
  if (!markdown || typeof markdown !== 'object') {
    return null;
  }
  const m = markdown as Record<string, unknown>;
  const pick = (key: string): string => {
    const v = m[key];
    return typeof v === 'string' ? v.trim() : '';
  };
  return (
    pick('fit_markdown') ||
    pick('raw_markdown') ||
    pick('markdown_with_citations') ||
    pick('references_markdown') ||
    null
  );
}

function titleFromResultOrMarkdown(
  o: Record<string, unknown>,
  markdownText: string,
): string | undefined {
  if (typeof o.title === 'string' && o.title.trim()) return o.title.trim();
  if (o.metadata && typeof o.metadata === 'object') {
    const metaObj = o.metadata as Record<string, unknown>;
    if (typeof metaObj.title === 'string' && metaObj.title.trim()) {
      return metaObj.title.trim();
    }
  }
  const firstLine = markdownText.split('\n').find((l) => l.trim()) ?? '';
  const m = firstLine.match(/^#\s+(.+)$/);
  if (m) return m[1].trim();
  return undefined;
}

function extractMarkdownFromPayload(data: unknown): { title?: string; text: string } {
  if (!data || typeof data !== 'object') {
    return { text: '' };
  }
  const d = data as Record<string, unknown>;

  /** Prefer markdown / main text; avoid raw page HTML for script generation. */
  const tryResult = (obj: unknown): { title?: string; text?: string } | null => {
    if (!obj || typeof obj !== 'object') return null;
    const o = obj as Record<string, unknown>;
    const fromMd = textFromMarkdownField(o.markdown ?? o.md);
    if (fromMd) {
      return { title: titleFromResultOrMarkdown(o, fromMd), text: fromMd };
    }
    const extracted = o.extracted_content;
    if (typeof extracted === 'string' && extracted.trim()) {
      const t = extracted.trim();
      return { title: titleFromResultOrMarkdown(o, t), text: t };
    }
    const fit = o.fit_html;
    if (typeof fit === 'string' && fit.trim()) {
      return { text: fit.trim() };
    }
    return null;
  };

  const topMd = textFromMarkdownField(d.markdown);
  if (topMd) {
    return { title: titleFromResultOrMarkdown(d, topMd), text: topMd };
  }

  if (Array.isArray(d.results)) {
    for (const r of d.results) {
      const got = tryResult(r);
      if (got?.text) return { title: got.title, text: got.text };
    }
  }
  if (Array.isArray(d.data)) {
    for (const r of d.data) {
      const got = tryResult(r);
      if (got?.text) return { title: got.title, text: got.text };
    }
  }
  const single = tryResult(d);
  if (single?.text) return { title: single.title, text: single.text };

  const first = d.result;
  if (first) {
    const got = tryResult(first);
    if (got?.text) return { title: got.title, text: got.text };
  }

  return { text: '' };
}

@Injectable()
export class Crawl4AiService {
  private readonly logger = new Logger(Crawl4AiService.name);

  constructor(private readonly config: ConfigService) {}

  getBaseUrl(): string | null {
    const u = this.config.get<string>('CRAWL4AI_BASE_URL')?.trim();
    return u || null;
  }

  assertConfigured(): void {
    if (!this.getBaseUrl()) {
      throw new BadRequestException('CRAWL4AI_BASE_URL is not configured');
    }
  }

  async extractArticle(urlRaw: string): Promise<{ title?: string; text: string }> {
    this.assertConfigured();
    let parsed: URL;
    try {
      parsed = new URL(urlRaw.trim());
    } catch {
      throw new BadRequestException('Invalid URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new BadRequestException('Only http and https URLs are allowed');
    }
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host.endsWith('.local') ||
      host === 'metadata.google.internal' ||
      host.endsWith('.internal')
    ) {
      throw new BadRequestException('URL host is not allowed');
    }
    await hostnameResolvesToSafeIps(host);

    const base = this.getBaseUrl()!.replace(/\/$/, '');
    const axiosJson = {
      timeout: CRAWL_TIMEOUT_MS,
      maxContentLength: MAX_RESPONSE_BYTES,
      maxBodyLength: MAX_RESPONSE_BYTES,
      validateStatus: () => true,
      headers: { 'Content-Type': 'application/json' },
    };

    try {
      const mdUrl = `${base}/md`;
      this.logger.log(`Crawl4AI: POST ${mdUrl} (fit markdown) for ${parsed.origin}`);
      const mdRes = await axios.post(
        mdUrl,
        { url: parsed.toString(), f: 'fit', c: '0' },
        axiosJson,
      );
      if (mdRes.status < 400 && mdRes.data && typeof mdRes.data === 'object') {
        const mdData = mdRes.data as Record<string, unknown>;
        const raw = mdData.markdown;
        if (typeof raw === 'string' && raw.trim()) {
          const text = raw.trim();
          return {
            title: titleFromResultOrMarkdown(mdData, text),
            text,
          };
        }
      } else if (mdRes.status >= 400) {
        this.logger.debug(
          `Crawl4AI /md HTTP ${mdRes.status} (falling back to /crawl): ${String(mdRes.data).slice(0, 200)}`,
        );
      }

      const crawlUrl = `${base}/crawl`;
      this.logger.log(`Crawl4AI: POST ${crawlUrl} for ${parsed.origin}`);
      const res = await axios.post(crawlUrl, { urls: [parsed.toString()] }, axiosJson);
      if (res.status >= 400) {
        this.logger.warn(`Crawl4AI HTTP ${res.status}: ${String(res.data).slice(0, 500)}`);
        throw new BadRequestException(`Crawl failed (HTTP ${res.status})`);
      }
      const { title, text } = extractMarkdownFromPayload(res.data);
      if (!text) {
        throw new BadRequestException('Could not extract article text from this page');
      }
      return { title, text };
    } catch (e: unknown) {
      if (e instanceof BadRequestException) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`Crawl4AI error: ${msg}`);
      throw new BadRequestException(`Crawl failed: ${msg}`);
    }
  }
}
