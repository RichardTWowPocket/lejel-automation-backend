import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as fs from 'fs';
import * as path from 'path';
import { readFile, writeFile } from 'fs/promises';
import { randomUUID } from 'crypto';

const PRESIGN_EXPIRES_SEC = 3600;
/** Longer TTL so Remotion render workers can GET private objects after queue delay. */
const PRESIGN_GET_EXPIRES_SEC = 43_200; // 12h
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

const ALLOWED_UPLOAD_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/quicktime',
]);

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
};

@Injectable()
export class R2Service {
  private readonly logger = new Logger(R2Service.name);
  private client: S3Client | null = null;
  private bucket: string | null = null;

  constructor(private readonly config: ConfigService) {
    const endpoint = this.config.get<string>('R2_ENDPOINT')?.trim();
    const accessKeyId = this.config.get<string>('R2_ACCESS_KEY_ID')?.trim();
    const secretAccessKey = this.config.get<string>('R2_SECRET_ACCESS_KEY')?.trim();
    const bucket = this.config.get<string>('R2_BUCKET')?.trim();
    if (endpoint && accessKeyId && secretAccessKey && bucket) {
      this.bucket = bucket;
      this.client = new S3Client({
        region: 'auto',
        endpoint,
        credentials: { accessKeyId, secretAccessKey },
        forcePathStyle: true,
      });
      this.logger.log('R2 (S3) client initialized');
    } else {
      this.logger.warn(
        'R2 not configured (missing R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, or R2_BUCKET)',
      );
    }
  }

  isEnabled(): boolean {
    return this.client !== null && !!this.bucket;
  }

  assertEnabled(): void {
    if (!this.isEnabled()) {
      throw new ServiceUnavailableException('R2 uploads are not configured on this server');
    }
  }

  userUploadPrefix(userId: string): string {
    return `users/${userId}/uploads/`;
  }

  /** Motion-graphic assets for Remotion (separate prefix from segment media uploads). */
  userRemotionAssetPrefix(userId: string): string {
    return `users/${userId}/remotion-assets/`;
  }

  assertKeyOwnedByUser(objectKey: string, userId: string): void {
    const prefix = this.userUploadPrefix(userId);
    if (!objectKey.startsWith(prefix)) {
      throw new Error(`objectKey must be under ${prefix}`);
    }
    if (objectKey.includes('..') || objectKey.includes('//')) {
      throw new Error('Invalid objectKey');
    }
  }

  /** Accepts video upload keys or Remotion asset keys for this user. */
  assertKeyOwnedByUserOrRemotionAssets(objectKey: string, userId: string): void {
    const uploadP = this.userUploadPrefix(userId);
    const remotionP = this.userRemotionAssetPrefix(userId);
    if (!objectKey.startsWith(uploadP) && !objectKey.startsWith(remotionP)) {
      throw new Error(`objectKey must be under ${uploadP} or ${remotionP}`);
    }
    if (objectKey.includes('..') || objectKey.includes('//')) {
      throw new Error('Invalid objectKey');
    }
  }

  assertRemotionAssetKeyOwnedByUser(objectKey: string, userId: string): void {
    const prefix = this.userRemotionAssetPrefix(userId);
    if (!objectKey.startsWith(prefix)) {
      throw new Error(`objectKey must be under ${prefix}`);
    }
    if (objectKey.includes('..') || objectKey.includes('//')) {
      throw new Error('Invalid objectKey');
    }
  }

  async presignPut(
    userId: string,
    contentType: string,
  ): Promise<{
    uploadUrl: string;
    method: 'PUT';
    headers: Record<string, string>;
    objectKey: string;
    expiresIn: number;
  }> {
    this.assertEnabled();
    const ct = contentType.trim().toLowerCase();
    if (!ALLOWED_UPLOAD_CONTENT_TYPES.has(ct)) {
      throw new Error(`Unsupported content type: ${contentType}`);
    }
    const ext = EXT_BY_MIME[ct] || 'bin';
    const objectKey = `${this.userUploadPrefix(userId)}${randomUUID()}.${ext}`;
    const cmd = new PutObjectCommand({
      Bucket: this.bucket!,
      Key: objectKey,
      ContentType: ct,
      /** Browser uploads cannot set arbitrary ACL; size enforced on complete. */
    });
    const uploadUrl = await getSignedUrl(this.client!, cmd, { expiresIn: PRESIGN_EXPIRES_SEC });
    return {
      uploadUrl,
      method: 'PUT',
      headers: { 'Content-Type': ct },
      objectKey,
      expiresIn: PRESIGN_EXPIRES_SEC,
    };
  }

  async verifyUploadedObject(
    userId: string,
    objectKey: string,
  ): Promise<{
    objectKey: string;
    contentType: string | undefined;
    contentLength: number;
  }> {
    this.assertEnabled();
    this.assertKeyOwnedByUserOrRemotionAssets(objectKey, userId);
    const head = await this.client!.send(
      new HeadObjectCommand({ Bucket: this.bucket!, Key: objectKey }),
    );
    const len = head.ContentLength ?? 0;
    if (len <= 0) {
      throw new Error('Uploaded object is empty');
    }
    if (len > MAX_UPLOAD_BYTES) {
      throw new Error(`Uploaded object exceeds limit (${MAX_UPLOAD_BYTES} bytes)`);
    }
    const ct = head.ContentType?.toLowerCase() ?? '';
    if (ct && !ALLOWED_UPLOAD_CONTENT_TYPES.has(ct)) {
      throw new Error('Uploaded object has disallowed content type');
    }
    return { objectKey, contentType: head.ContentType, contentLength: len };
  }

  async presignPutRemotionAsset(
    userId: string,
    contentType: string,
  ): Promise<{
    uploadUrl: string;
    method: 'PUT';
    headers: Record<string, string>;
    objectKey: string;
    expiresIn: number;
  }> {
    this.assertEnabled();
    const ct = contentType.trim().toLowerCase();
    if (!ALLOWED_UPLOAD_CONTENT_TYPES.has(ct)) {
      throw new Error(`Unsupported content type: ${contentType}`);
    }
    const ext = EXT_BY_MIME[ct] || 'bin';
    const objectKey = `${this.userRemotionAssetPrefix(userId)}${randomUUID()}.${ext}`;
    const cmd = new PutObjectCommand({
      Bucket: this.bucket!,
      Key: objectKey,
      ContentType: ct,
    });
    const uploadUrl = await getSignedUrl(this.client!, cmd, { expiresIn: PRESIGN_EXPIRES_SEC });
    return {
      uploadUrl,
      method: 'PUT',
      headers: { 'Content-Type': ct },
      objectKey,
      expiresIn: PRESIGN_EXPIRES_SEC,
    };
  }

  /** Presigned GET for Remotion render server or LLM context (same key rules as verify). */
  async presignGetUrl(userId: string, objectKey: string): Promise<string> {
    this.assertEnabled();
    this.assertKeyOwnedByUserOrRemotionAssets(objectKey.trim(), userId);
    const cmd = new GetObjectCommand({ Bucket: this.bucket!, Key: objectKey.trim() });
    return getSignedUrl(this.client!, cmd, { expiresIn: PRESIGN_GET_EXPIRES_SEC });
  }

  /** Worker: download private object to a local path (uses server credentials). */
  async downloadToFile(objectKey: string, destPath: string): Promise<void> {
    this.assertEnabled();
    const out = await this.client!.send(
      new GetObjectCommand({ Bucket: this.bucket!, Key: objectKey }),
    );
    const body = out.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
    if (!body || typeof body.transformToByteArray !== 'function') {
      throw new Error(`R2 GetObject empty body for ${objectKey}`);
    }
    const buf = Buffer.from(await body.transformToByteArray());
    await writeFile(destPath, buf);
  }

  // ── Request artifact storage ──

  requestPrefix(requestId: string): string {
    return `requests/${requestId}/`;
  }

  private guessMime(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const map: Record<string, string> = {
      '.mp3': 'audio/mpeg',
      '.mp4': 'video/mp4',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.json': 'application/json',
      '.srt': 'text/plain',
      '.ass': 'text/plain',
      '.txt': 'text/plain',
      '.bin': 'application/octet-stream',
    };
    return map[ext] || 'application/octet-stream';
  }

  async uploadRequestFile(
    requestId: string,
    relativePath: string,
    localPath: string,
  ): Promise<void> {
    this.assertEnabled();
    const key = `${this.requestPrefix(requestId)}${relativePath}`;
    const buf = await readFile(localPath);
    await this.client!.send(
      new PutObjectCommand({
        Bucket: this.bucket!,
        Key: key,
        Body: buf,
        ContentType: this.guessMime(relativePath),
      }),
    );
  }

  async uploadRequestDir(requestId: string, localDir: string): Promise<number> {
    this.assertEnabled();
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isFile()) files.push(full);
        else if (entry.isDirectory()) walk(full);
      }
    };
    walk(localDir);
    let count = 0;
    for (const file of files) {
      const rel = path.relative(localDir, file);
      this.logger.log(`R2 upload: ${this.requestPrefix(requestId)}${rel}`);
      try {
        await this.uploadRequestFile(requestId, rel, file);
        count++;
      } catch (e: unknown) {
        this.logger.error(
          `R2 upload failed for ${rel}: ${e instanceof Error ? e.message : String(e)}`,
        );
        throw e;
      }
    }
    this.logger.log(`R2 uploaded ${count} files for request ${requestId}`);
    return count;
  }

  async presignGetRequestUrl(requestId: string, relativePath: string): Promise<string> {
    this.assertEnabled();
    const key = `${this.requestPrefix(requestId)}${relativePath}`;
    const cmd = new GetObjectCommand({ Bucket: this.bucket!, Key: key });
    return getSignedUrl(this.client!, cmd, { expiresIn: PRESIGN_GET_EXPIRES_SEC });
  }

  async listRequestFiles(requestId: string, subdir?: string): Promise<string[]> {
    this.assertEnabled();
    let prefix = this.requestPrefix(requestId);
    if (subdir) prefix = `${prefix}${subdir}/`;
    const result: string[] = [];
    let continuationToken: string | undefined;
    do {
      const res = await this.client!.send(
        new ListObjectsV2Command({
          Bucket: this.bucket!,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const obj of res.Contents ?? []) {
        if (obj.Key && obj.Key !== prefix) {
          result.push(obj.Key!.replace(prefix, ''));
        }
      }
      continuationToken = res.NextContinuationToken as string | undefined;
    } while (continuationToken);
    return result.sort();
  }

  /** True if at least one file exists under this request prefix in R2. */
  async hasRequestArtifacts(requestId: string): Promise<boolean> {
    if (!this.isEnabled()) return false;
    try {
      const res = await this.client!.send(
        new ListObjectsV2Command({
          Bucket: this.bucket!,
          Prefix: this.requestPrefix(requestId),
          MaxKeys: 1,
        }),
      );
      return (res.Contents?.length ?? 0) > 0;
    } catch {
      return false;
    }
  }

  /** Download a request artifact and parse as JSON. Returns null on error. */
  async readRequestJson<T = unknown>(requestId: string, relativePath: string): Promise<T | null> {
    if (!this.isEnabled()) return null;
    try {
      const key = `${this.requestPrefix(requestId)}${relativePath}`;
      const out = await this.client!.send(new GetObjectCommand({ Bucket: this.bucket!, Key: key }));
      const body = out.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
      if (!body || typeof body.transformToByteArray !== 'function') return null;
      const buf = Buffer.from(await body.transformToByteArray());
      return JSON.parse(buf.toString('utf-8')) as T;
    } catch {
      return null;
    }
  }

  async deleteRequestDir(requestId: string): Promise<void> {
    this.assertEnabled();
    const prefix = this.requestPrefix(requestId);
    let continuationToken: string | undefined;
    let deleted = 0;
    do {
      const res = await this.client!.send(
        new ListObjectsV2Command({
          Bucket: this.bucket!,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      const keys = (res.Contents ?? []).map((o) => o.Key!).filter(Boolean);
      if (keys.length > 0) {
        await this.client!.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket!,
            Delete: { Objects: keys.map((k) => ({ Key: k })) },
          }),
        );
        deleted += keys.length;
      }
      continuationToken = res.NextContinuationToken as string | undefined;
    } while (continuationToken);
    this.logger.log(`R2 deleted ${deleted} objects for request ${requestId}`);
  }

  async downloadRequestFile(
    requestId: string,
    relativePath: string,
    destPath: string,
  ): Promise<void> {
    this.assertEnabled();
    const key = `${this.requestPrefix(requestId)}${relativePath}`;
    await this.downloadToFile(key, destPath);
  }
}
