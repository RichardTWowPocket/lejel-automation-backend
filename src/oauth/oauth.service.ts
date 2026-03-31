import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios from 'axios';
import { OAuthCredential, OAuthProvider } from '../entities/oauth-credential.entity';
import { EncryptionService } from './encryption.service';
import { GoogleClientService } from './google-client.service';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/youtube.upload',
].join(' ');

import { encodeState } from './oauth-state';

@Injectable()
export class OAuthService {
  constructor(
    @InjectRepository(OAuthCredential)
    private readonly credRepo: Repository<OAuthCredential>,
    private readonly config: ConfigService,
    private readonly encryption: EncryptionService,
    private readonly googleClientService: GoogleClientService,
  ) {}

  /**
   * Create a YouTube connection using an existing Google client (no raw credentials).
   */
  async createConnectionWithClient(
    googleClientId: string,
    label: string,
    provider: OAuthProvider = 'google_youtube',
  ): Promise<OAuthCredential> {
    await this.googleClientService.getCredentials(googleClientId);
    const cred = this.credRepo.create({
      provider,
      googleClientId,
      scope: YOUTUBE_SCOPES,
      label: label?.trim() || '',
    });
    return this.credRepo.save(cred);
  }

  /**
   * Legacy: Create a new YouTube connection with raw Google client ID and secret.
   */
  async createConnection(
    clientId: string,
    clientSecret: string,
    label: string,
    provider: OAuthProvider = 'google_youtube',
  ): Promise<OAuthCredential> {
    if (!clientId?.trim() || !clientSecret?.trim()) {
      throw new BadRequestException('clientId and clientSecret are required');
    }
    const cred = this.credRepo.create({
      provider,
      clientIdEnc: this.encryption.encrypt(clientId.trim()),
      clientSecretEnc: this.encryption.encrypt(clientSecret.trim()),
      scope: YOUTUBE_SCOPES,
      label: label?.trim() || '',
    });
    return this.credRepo.save(cred);
  }

  /**
   * List all YouTube connections (admin). Includes googleClientEnabled for each.
   */
  async listConnections(provider: OAuthProvider = 'google_youtube') {
    const list = await this.credRepo.find({
      where: { provider },
      relations: ['googleClient'],
      order: { createdAt: 'DESC' },
    });
    return list.map((c) => ({
      id: c.id,
      label: c.label || `Connection ${c.id.slice(0, 8)}`,
      connected: !!(c.accessTokenEnc && c.refreshTokenEnc),
      expiresAt: c.expiresAt,
      createdAt: c.createdAt,
      googleClientEnabled: c.googleClient ? c.googleClient.enabled : true,
    }));
  }

  /**
   * List YouTube connections available to non-admin users (only those whose Google client is enabled).
   */
  async listConnectionsForUser(provider: OAuthProvider = 'google_youtube') {
    const list = await this.credRepo.find({
      where: { provider },
      relations: ['googleClient'],
      order: { createdAt: 'DESC' },
    });
    const filtered = list.filter(
      (c) => !c.googleClientId || (c.googleClient != null && c.googleClient.enabled),
    );
    return filtered.map((c) => ({
      id: c.id,
      label: c.label || `Connection ${c.id.slice(0, 8)}`,
      connected: !!(c.accessTokenEnc && c.refreshTokenEnc),
      expiresAt: c.expiresAt,
      createdAt: c.createdAt,
    }));
  }

  /** Resolve clientId and clientSecret for a credential (from Google client or legacy fields). */
  private async getCredentialsForCredential(cred: OAuthCredential): Promise<{ clientId: string; clientSecret: string }> {
    if (cred.googleClientId) {
      return this.googleClientService.getCredentials(cred.googleClientId);
    }
    if (cred.clientIdEnc && cred.clientSecretEnc) {
      return {
        clientId: this.encryption.decrypt(cred.clientIdEnc),
        clientSecret: this.encryption.decrypt(cred.clientSecretEnc),
      };
    }
    throw new BadRequestException('Connection has no credentials (missing Google client or legacy clientId/clientSecret)');
  }

  async getGoogleAuthUrl(
    redirectUri: string,
    credentialId: string,
    successRedirect: string,
  ): Promise<string> {
    const cred = await this.credRepo.findOne({ where: { id: credentialId } });
    if (!cred) {
      throw new NotFoundException('Connection not found');
    }
    const { clientId } = await this.getCredentialsForCredential(cred);
    const state = encodeState(credentialId, successRedirect);
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: YOUTUBE_SCOPES,
      access_type: 'offline',
      prompt: 'consent',
      state,
    });
    return `${GOOGLE_AUTH_URL}?${params.toString()}`;
  }

  async exchangeCodeForTokens(
    code: string,
    redirectUri: string,
    credentialId: string,
  ): Promise<OAuthCredential> {
    const cred = await this.credRepo.findOne({ where: { id: credentialId } });
    if (!cred) {
      throw new NotFoundException('Connection not found');
    }
    const { clientId, clientSecret } = await this.getCredentialsForCredential(cred);

    const res = await axios.post(
      GOOGLE_TOKEN_URL,
      new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000,
      },
    );

    const { access_token, refresh_token, expires_in } = res.data;
    if (!access_token || !refresh_token) {
      throw new Error('Google did not return access_token or refresh_token');
    }

    cred.accessTokenEnc = this.encryption.encrypt(access_token);
    cred.refreshTokenEnc = this.encryption.encrypt(refresh_token);
    cred.expiresAt = new Date(Date.now() + (expires_in || 3600) * 1000);

    return this.credRepo.save(cred);
  }

  async getValidAccessToken(credentialId: string): Promise<string> {
    const cred = await this.credRepo.findOne({ where: { id: credentialId } });
    if (!cred) {
      throw new NotFoundException(`Connection ${credentialId} not found`);
    }
    if (!cred.accessTokenEnc || !cred.refreshTokenEnc) {
      throw new BadRequestException('Connection not yet authorized. Complete OAuth flow first.');
    }

    const now = new Date();
    if (cred.expiresAt && cred.expiresAt > new Date(now.getTime() + 60 * 1000)) {
      return this.encryption.decrypt(cred.accessTokenEnc);
    }

    const refreshToken = this.encryption.decrypt(cred.refreshTokenEnc);
    const { clientId, clientSecret } = await this.getCredentialsForCredential(cred);

    const res = await axios.post(
      GOOGLE_TOKEN_URL,
      new URLSearchParams({
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
      }),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000,
      },
    );

    const { access_token, expires_in } = res.data;
    cred.accessTokenEnc = this.encryption.encrypt(access_token);
    cred.expiresAt = new Date(Date.now() + (expires_in || 3600) * 1000);
    await this.credRepo.save(cred);

    return access_token;
  }

  async getCredentialStatus(credentialId?: string) {
    if (credentialId) {
      const cred = await this.credRepo.findOne({ where: { id: credentialId } });
      if (!cred) return { connected: false };
      return {
        connected: !!(cred.accessTokenEnc && cred.refreshTokenEnc),
        id: cred.id,
        label: cred.label || undefined,
        expiresAt: cred.expiresAt,
      };
    }
    const list = await this.listConnections();
    return { connections: list };
  }

  async disconnect(credentialId: string): Promise<void> {
    const result = await this.credRepo.delete({ id: credentialId });
    if (result.affected === 0) {
      throw new NotFoundException('Connection not found');
    }
  }

  /** Get first connected credential (for backward compat when no connectionId specified) */
  async getFirstConnectedCredentialId(provider: OAuthProvider = 'google_youtube'): Promise<string | null> {
    const cred = await this.credRepo.findOne({
      where: { provider },
      order: { createdAt: 'DESC' },
    });
    if (!cred || !cred.accessTokenEnc || !cred.refreshTokenEnc) return null;
    return cred.id;
  }
}
