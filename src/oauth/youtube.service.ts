import { Injectable } from '@nestjs/common';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { OAuthService } from './oauth.service';

export interface YouTubeUploadOptions {
  title: string;
  description?: string;
  tags?: string[];
  privacyStatus?: 'public' | 'private' | 'unlisted';
}

@Injectable()
export class YouTubeService {
  constructor(private readonly oauth: OAuthService) {}

  private async getAccessToken(credentialId?: string): Promise<string> {
    const id = credentialId || (await this.oauth.getFirstConnectedCredentialId());
    if (!id) throw new Error('No YouTube connection found. Create a connection and complete OAuth first.');
    return this.oauth.getValidAccessToken(id);
  }

  /**
   * Upload a video file to YouTube using the stored OAuth credentials.
   * @param filePath - Path to the video file (e.g. ./public/media/xxx.mp4)
   * @param options - Video metadata
   * @returns YouTube video ID
   */
  async uploadVideo(filePath: string, options: YouTubeUploadOptions, credentialId?: string): Promise<string> {
    const accessToken = await this.getAccessToken(credentialId);
    const stats = fs.statSync(filePath);
    const fileSize = stats.size;

    const metadata = {
      snippet: {
        title: options.title,
        description: options.description || '',
        tags: options.tags || [],
      },
      status: {
        privacyStatus: options.privacyStatus || 'private',
      },
    };

    const metadataStr = JSON.stringify(metadata);
    const initRes = await axios.post(
      'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
      metadata,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'Content-Length': Buffer.byteLength(metadataStr, 'utf8').toString(),
          'X-Upload-Content-Length': fileSize.toString(),
          'X-Upload-Content-Type': 'video/*',
        },
      },
    );

    const uploadUrl = initRes.headers['location'];
    if (!uploadUrl) {
      throw new Error('YouTube API did not return upload URL');
    }

    const fileStream = fs.createReadStream(filePath);
    const uploadRes = await axios.put(uploadUrl, fileStream, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Length': fileSize.toString(),
        'Content-Type': 'application/octet-stream',
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    return uploadRes.data.id;
  }

  /**
   * Upload from a URL (download first, then upload).
   * Useful when the video is hosted elsewhere (e.g. from your media URL).
   */
  async uploadVideoFromUrl(
    videoUrl: string,
    options: YouTubeUploadOptions,
    tempDir = './temp',
    credentialId?: string,
  ): Promise<string> {
    const axios = (await import('axios')).default;
    const res = await axios.get(videoUrl, { responseType: 'arraybuffer' });
    const ext = path.extname(new URL(videoUrl).pathname) || '.mp4';
    const tempPath = path.join(tempDir, `yt-upload-${Date.now()}${ext}`);
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(tempPath, res.data);
    try {
      const videoId = await this.uploadVideo(tempPath, options, credentialId);
      return videoId;
    } finally {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    }
  }
}
