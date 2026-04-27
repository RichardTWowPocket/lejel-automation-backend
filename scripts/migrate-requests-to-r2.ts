/**
 * Migrate existing request directories from local disk (public/requests/) to Cloudflare R2.
 *
 * Usage:
 *   npx ts-node scripts/migrate-requests-to-r2.ts [--delete-local] [--dry-run] [--update-db]
 *
 * Options:
 *   --delete-local   Remove local dir after successful upload
 *   --dry-run        List what would be uploaded without actually doing it
 *   --update-db      Update video_requests.resultUrl and storageBackend in PostgreSQL
 */

import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import {
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Pool } from 'pg';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const REQUESTS_DIR = path.join(__dirname, '..', 'public', 'requests');
const DRY_RUN = process.argv.includes('--dry-run');
const DELETE_LOCAL = process.argv.includes('--delete-local');
const UPDATE_DB = process.argv.includes('--update-db');

function env(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing env: ${key}`);
  return val;
}

const endpoint = env('R2_ENDPOINT');
const accessKeyId = env('R2_ACCESS_KEY_ID');
const secretAccessKey = env('R2_SECRET_ACCESS_KEY');
const bucket = env('R2_BUCKET');

const client = new S3Client({
  region: 'auto',
  endpoint,
  credentials: { accessKeyId, secretAccessKey },
  forcePathStyle: true,
});

function guessMime(filePath: string): string {
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

function walkDir(dir: string): string[] {
  const files: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isFile()) files.push(full);
      else if (entry.isDirectory()) stack.push(full);
    }
  }
  return files;
}

async function uploadRequestDir(requestId: string, localDir: string): Promise<{ uploaded: number; errors: string[] }> {
  const files = walkDir(localDir);
  let uploaded = 0;
  const errors: string[] = [];

  for (const file of files) {
    const rel = path.relative(localDir, file);
    const key = `requests/${requestId}/${rel}`;
    const buf = fs.readFileSync(file);

    if (DRY_RUN) {
      console.log(`  [DRY] Would upload: ${key} (${buf.length} bytes)`);
      uploaded++;
      continue;
    }

    try {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: buf,
          ContentType: guessMime(file),
        }),
      );
      uploaded++;
      process.stdout.write('.');
    } catch (err: any) {
      const msg = err?.message || String(err);
      errors.push(`${key}: ${msg}`);
      process.stdout.write('E');
    }
  }

  if (!DRY_RUN) console.log();
  return { uploaded, errors };
}

async function main() {
  console.log('Starting R2 migration for request artifacts...');
  console.log(`Bucket: ${bucket}`);
  console.log(`Source: ${REQUESTS_DIR}`);
  if (DRY_RUN) console.log('MODE: DRY RUN (no actual uploads)');
  if (DELETE_LOCAL) console.log('MODE: Will delete local dirs after successful upload');
  if (UPDATE_DB) console.log('MODE: Will update PostgreSQL video_requests rows');

  let pool: Pool | null = null;
  if (UPDATE_DB && !DRY_RUN) {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      console.error('DATABASE_URL not set in .env');
      process.exit(1);
    }
    pool = new Pool({ connectionString: dbUrl });
    try {
      await pool.query('SELECT 1');
      console.log('DB connection OK');
    } catch (err: any) {
      console.error('DB connection failed:', err.message);
      process.exit(1);
    }
  }

  if (!fs.existsSync(REQUESTS_DIR)) {
    console.error(`Requests dir not found: ${REQUESTS_DIR}`);
    process.exit(1);
  }

  const entries = fs.readdirSync(REQUESTS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== '.gitkeep')
    .map((e) => e.name);

  console.log(`Found ${entries.length} request directories\n`);

  let totalUploaded = 0;
  let totalErrors = 0;
  const failedDirs: string[] = [];

  for (let i = 0; i < entries.length; i++) {
    const requestId = entries[i];
    const localDir = path.join(REQUESTS_DIR, requestId);
    console.log(`[${i + 1}/${entries.length}] ${requestId}`);

    try {
      const { uploaded, errors } = await uploadRequestDir(requestId, localDir);
      totalUploaded += uploaded;
      totalErrors += errors.length;

      for (const err of errors) {
        console.error(`  ERROR: ${err}`);
      }

      if (errors.length === 0 && DELETE_LOCAL && !DRY_RUN) {
        fs.rmSync(localDir, { recursive: true, force: true });
        console.log(`  Deleted local: ${localDir}`);
      }

      if (errors.length === 0 && pool && !DRY_RUN) {
        try {
          await pool.query(
            `UPDATE video_requests SET storage_backend = 'r2', result_url = 'final/final-video.mp4', final_url = 'final/final-video.mp4', debug_meta_url = 'meta/pipeline-output.json' WHERE id = $1`,
            [requestId],
          );
          console.log(`  Updated DB: storageBackend=r2, resultUrl=final/final-video.mp4`);
        } catch (dbErr: any) {
          console.error(`  DB update failed: ${dbErr.message}`);
        }
      }
    } catch (err: any) {
      console.error(`  FAILED: ${err?.message || String(err)}`);
      failedDirs.push(requestId);
      totalErrors++;
    }
  }

  console.log(`\n─── Migration Complete ───`);
  console.log(`Total files uploaded: ${totalUploaded}`);
  console.log(`Total errors: ${totalErrors}`);
  if (failedDirs.length) {
    console.log(`Failed directories: ${failedDirs.join(', ')}`);
  }
  if (pool) await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
