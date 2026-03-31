import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

type RequestSubdir =
  | 'audio'
  | 'transcript'
  | 'subtitles'
  | 'segments'
  | 'final'
  | 'meta';

@Injectable()
export class RequestFsService {
  getRequestDir(requestId: string): string {
    return path.join(process.cwd(), 'public', 'requests', requestId);
  }

  ensureRequestDirs(requestId: string): Record<RequestSubdir, string> {
    const root = this.getRequestDir(requestId);
    const dirs: Record<RequestSubdir, string> = {
      audio: path.join(root, 'audio'),
      transcript: path.join(root, 'transcript'),
      subtitles: path.join(root, 'subtitles'),
      segments: path.join(root, 'segments'),
      final: path.join(root, 'final'),
      meta: path.join(root, 'meta'),
    };
    for (const dir of Object.values(dirs)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dirs;
  }

  writeJson(filePath: string, data: unknown): void {
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
  }

  timestamp(): string {
    return Date.now().toString();
  }

  toPublicUrl(baseUrl: string, requestId: string, relativePath: string): string {
    const cleanBase = baseUrl.replace(/\/$/, '');
    const rel = relativePath.replace(/^\/+/, '');
    return `${cleanBase}/requests/${requestId}/${rel}`;
  }
}

