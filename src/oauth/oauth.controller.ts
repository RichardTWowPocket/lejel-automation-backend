import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Query,
  Req,
  Res,
  Body,
  Param,
  UseGuards,
  BadRequestException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { OAuthService } from './oauth.service';
import { GoogleClientService } from './google-client.service';
import { YouTubeService } from './youtube.service';
import { AdminGuard } from '../auth/admin.guard';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { ApiKeyOrJwtGuard } from '../auth/api-key-or-jwt.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { decodeState } from './oauth-state';

@Controller('api/oauth')
export class OAuthController {
  constructor(
    private readonly oauth: OAuthService,
    private readonly googleClientService: GoogleClientService,
    private readonly youtube: YouTubeService,
    private readonly config: ConfigService,
  ) {}

  // ---------- Google clients (credentials only; no OAuth tokens) ----------

  /**
   * List all Google clients. Admin only (or API key). Response includes enabled.
   */
  @Get('google-clients')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async listGoogleClients() {
    return this.googleClientService.findAll();
  }

  /**
   * Create a Google client. Admin only (or API key).
   * Body: { clientId, clientSecret, label? }. Response: 201 { id, label }.
   */
  @Post('google-clients')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async createGoogleClient(
    @Body('clientId') clientId: string,
    @Body('clientSecret') clientSecret: string,
    @Body('label') label?: string,
  ) {
    const result = await this.googleClientService.create(clientId, clientSecret, label);
    return result;
  }

  /**
   * Delete a Google client. Fails if any connection uses it. Admin only. Response: 204.
   */
  @Delete('google-clients/:id')
  @UseGuards(JwtAuthGuard, AdminGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteGoogleClient(@Param('id') id: string) {
    await this.googleClientService.delete(id);
  }

  /**
   * Enable or disable a Google client. When disabled, its connections are hidden from non-admin users. Admin only.
   */
  @Patch('google-clients/:id')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async setGoogleClientEnabled(
    @Param('id') id: string,
    @Body('enabled') enabled: boolean,
  ) {
    if (typeof enabled !== 'boolean') {
      throw new BadRequestException('enabled must be a boolean');
    }
    await this.googleClientService.setEnabled(id, enabled);
    return { id, enabled };
  }

  // ---------- YouTube connections ----------

  /**
   * Create a YouTube connection using an existing Google client. Admin only (or API key).
   * Body: { googleClientId, label? }. Legacy: clientId/clientSecret for backward compat.
   */
  @Post('youtube/connections')
  @UseGuards(ApiKeyOrJwtGuard, AdminGuard)
  async createConnection(
    @Body('googleClientId') googleClientId: string,
    @Body('label') label?: string,
    @Body('clientId') clientIdLegacy?: string,
    @Body('clientSecret') clientSecretLegacy?: string,
  ) {
    if (googleClientId?.trim()) {
      const cred = await this.oauth.createConnectionWithClient(
        googleClientId.trim(),
        label?.trim() || '',
      );
      return {
        id: cred.id,
        label: cred.label || `Connection ${cred.id.slice(0, 8)}`,
        message: 'Connection created. Now complete the OAuth flow via /google/authorize',
      };
    }
    if (clientIdLegacy?.trim() && clientSecretLegacy?.trim()) {
      const cred = await this.oauth.createConnection(
        clientIdLegacy.trim(),
        clientSecretLegacy.trim(),
        label?.trim() || '',
      );
      return {
        id: cred.id,
        label: cred.label || `Connection ${cred.id.slice(0, 8)}`,
        message: 'Connection created. Now complete the OAuth flow via /google/authorize',
      };
    }
    throw new BadRequestException('Provide googleClientId (or clientId and clientSecret for legacy)');
  }

  /**
   * List YouTube connections. Admin (or API key): all connections + googleClientEnabled. User: only connections whose Google client is enabled.
   */
  @Get('youtube/connections')
  @UseGuards(ApiKeyOrJwtGuard)
  async listConnections(@Req() req: Request & { user?: { role?: string } }) {
    const isAdmin = req.user?.role === 'admin';
    if (isAdmin) {
      return this.oauth.listConnections();
    }
    return this.oauth.listConnectionsForUser();
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
   * Disconnect a YouTube credential. Admin only (or API key).
   */
  @Post('youtube/connections/:id/disconnect')
  @UseGuards(ApiKeyOrJwtGuard, AdminGuard)
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
