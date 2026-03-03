import {
  Controller,
  Get,
  Post,
  Query,
  Res,
  Body,
  Param,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { OAuthService } from './oauth.service';
import { YouTubeService } from './youtube.service';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { decodeState } from './oauth-state';

@Controller('api/oauth')
export class OAuthController {
  constructor(
    private readonly oauth: OAuthService,
    private readonly youtube: YouTubeService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Create a new YouTube connection with custom Google client ID and secret.
   * Requires API key.
   */
  @Post('youtube/connections')
  @UseGuards(ApiKeyGuard)
  async createConnection(
    @Body('clientId') clientId: string,
    @Body('clientSecret') clientSecret: string,
    @Body('label') label?: string,
  ) {
    const cred = await this.oauth.createConnection(clientId, clientSecret, label || '');
    return {
      id: cred.id,
      label: cred.label || `Connection ${cred.id.slice(0, 8)}`,
      message: 'Connection created. Now complete the OAuth flow via /google/authorize',
    };
  }

  /**
   * List all YouTube connections.
   */
  @Get('youtube/connections')
  async listConnections() {
    return this.oauth.listConnections();
  }

  /**
   * Get the redirect URL to start Google OAuth flow.
   * Requires connectionId (from createConnection) and success_redirect (frontend URL).
   */
  @Get('google/authorize')
  async getAuthorizeUrl(
    @Query('connectionId') connectionId: string,
    @Query('success_redirect') successRedirect: string,
  ) {
    if (!connectionId) {
      throw new BadRequestException('connectionId is required');
    }
    const baseUrl = this.config.get<string>('BASE_URL', 'http://localhost:3000');
    const callbackUrl = `${baseUrl.replace(/\/$/, '')}/api/oauth/google/callback`;
    const url = await this.oauth.getGoogleAuthUrl(
      callbackUrl,
      connectionId,
      successRedirect || baseUrl,
    );
    return { url, callbackUrl };
  }

  /**
   * OAuth callback - Google redirects here.
   * Add this URL to each Google Cloud project's redirect URIs:
   * https://lejel-backend.richardtandean.my.id/api/oauth/google/callback
   */
  @Get('google/callback')
  async handleCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    const baseUrl = this.config.get<string>('BASE_URL', 'http://localhost:3000');
    const { credentialId, successRedirect } = decodeState(state || '');
    const fallbackRedirect = successRedirect || baseUrl;

    if (!code) {
      return res.redirect(`${fallbackRedirect}${fallbackRedirect.includes('?') ? '&' : '?'}oauth=error&message=missing_code`);
    }
    if (!credentialId) {
      return res.redirect(`${fallbackRedirect}${fallbackRedirect.includes('?') ? '&' : '?'}oauth=error&message=invalid_state`);
    }
    try {
      const callbackUrl = `${baseUrl.replace(/\/$/, '')}/api/oauth/google/callback`;
      await this.oauth.exchangeCodeForTokens(code, callbackUrl, credentialId);
      return res.redirect(`${fallbackRedirect}${fallbackRedirect.includes('?') ? '&' : '?'}oauth=success&connectionId=${credentialId}`);
    } catch (err: any) {
      const errMsg = encodeURIComponent(err.message || 'OAuth failed');
      return res.redirect(`${fallbackRedirect}${fallbackRedirect.includes('?') ? '&' : '?'}oauth=error&message=${errMsg}`);
    }
  }

  /**
   * Check YouTube connection status. Pass connectionId for a single connection, or omit for all.
   */
  @Get('youtube/status')
  async getYoutubeStatus(@Query('connectionId') connectionId?: string) {
    return this.oauth.getCredentialStatus(connectionId);
  }

  /**
   * Disconnect a YouTube credential. Requires API key.
   */
  @Post('youtube/connections/:id/disconnect')
  @UseGuards(ApiKeyGuard)
  async disconnectYoutube(@Param('id') id: string) {
    await this.oauth.disconnect(id);
    return { success: true };
  }

  /**
   * Upload a video to YouTube. Requires API key.
   * Pass connectionId to use a specific connection, or omit to use the first connected one.
   */
  @Post('youtube/upload')
  @UseGuards(ApiKeyGuard)
  async uploadToYouTube(
    @Body('videoUrl') videoUrl: string,
    @Body('title') title: string,
    @Body('connectionId') connectionId?: string,
    @Body('description') description?: string,
    @Body('privacyStatus') privacyStatus?: 'public' | 'private' | 'unlisted',
    @Body('tags') tags?: string[],
  ) {
    if (!videoUrl || !title) {
      throw new BadRequestException('videoUrl and title are required');
    }
    const videoId = await this.youtube.uploadVideoFromUrl(
      videoUrl,
      { title, description, tags, privacyStatus: privacyStatus || 'private' },
      './temp',
      connectionId,
    );
    return { videoId, url: `https://www.youtube.com/watch?v=${videoId}` };
  }
}
