import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

const MEDIA_DIR = path.join(process.cwd(), 'public', 'media');
const MAX_SIZE = 100 * 1024 * 1024; // 100MB

export type UploadMediaResult = {
  publicUrl: string;
  filePath: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
};

@Injectable()
export class UploadMediaService {
  constructor(private readonly config: ConfigService) {}

  async uploadFromFile(
    file: Express.Multer.File,
    formatHint?: string,
  ): Promise<UploadMediaResult> {
    if (!file?.buffer && !file?.path) {
      throw new BadRequestException('file is required');
    }
    const buffer = file.buffer ?? fs.readFileSync(file.path);
    const contentLength = buffer.length;
    if (contentLength > MAX_SIZE) {
      throw new BadRequestException(`File too large (max ${MAX_SIZE / 1024 / 1024}MB)`);
    }

    let ext = path.extname(file.originalname || '')?.toLowerCase().replace(/[^a-z0-9.]/g, '');
    if (!ext && formatHint) {
      ext = '.' + formatHint.replace(/^\./, '').toLowerCase().replace(/[^a-z0-9]/g, '') || '.bin';
    }
    if (!ext) ext = '.bin';

    const fileName = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`;
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    const filePath = path.join(MEDIA_DIR, fileName);
    fs.writeFileSync(filePath, buffer);

    const baseUrl = this.config.get<string>('BASE_URL', 'http://localhost:3000');
    const publicUrl = `${baseUrl.replace(/\/$/, '')}/media/${fileName}`;
    const mimeType = file.mimetype || 'application/octet-stream';

    return {
      publicUrl,
      filePath,
      fileName,
      fileSize: contentLength,
      mimeType,
    };
  }

  async uploadFromUrl(url: string): Promise<UploadMediaResult> {
    if (!url?.trim()) {
      throw new BadRequestException('url is required');
    }

    let response;
    try {
      response = await axios.get(url, {
        responseType: 'arraybuffer',
        maxContentLength: MAX_SIZE,
        timeout: 120000,
        validateStatus: () => true,
      });
    } catch (err: any) {
      throw new BadRequestException(`Failed to download: ${err.message || 'unknown'}`);
    }

    if (response.status !== 200) {
      throw new BadRequestException(`Download failed with status ${response.status}`);
    }

    const buffer = Buffer.from(response.data);
    const contentLength = buffer.length;
    if (contentLength > MAX_SIZE) {
      throw new BadRequestException(`File too large (max ${MAX_SIZE / 1024 / 1024}MB)`);
    }

    const parsedUrl = new URL(url);
    const ext = path.extname(parsedUrl.pathname) || '.bin';
    const safeExt = ext.toLowerCase().replace(/[^a-z0-9.]/g, '');
    const fileName = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 10)}${safeExt || '.bin'}`;

    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    const filePath = path.join(MEDIA_DIR, fileName);
    fs.writeFileSync(filePath, buffer);

    const baseUrl = this.config.get<string>('BASE_URL', 'http://localhost:3000');
    const publicUrl = `${baseUrl.replace(/\/$/, '')}/media/${fileName}`;

    const mimeType = response.headers['content-type']?.split(';')[0]?.trim() || 'application/octet-stream';

    return {
      publicUrl,
      filePath,
      fileName,
      fileSize: contentLength,
      mimeType,
    };
  }
}
