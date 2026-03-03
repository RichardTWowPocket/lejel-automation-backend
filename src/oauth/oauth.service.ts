import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios from 'axios';
import { OAuthCredential, OAuthProvider } from '../entities/oauth-credential.entity';
import { EncryptionService } from './encryption.service';

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
  ) {}

  /**
   * Create a new YouTube connection with custom Google client ID and secret.
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
   * List all YouTube connections.
   */
  async listConnections(provider: OAuthProvider = 'google_youtube') {
    const list = await this.credRepo.find({
      where: { provider },
      order: { createdAt: 'DESC' },
    });
    return list.map((c) => ({
      id: c.id,
      label: c.label || `Connection ${c.id.slice(0, 8)}`,
      connected: !!(c.accessTokenEnc && c.refreshTokenEnc),
      expiresAt: c.expiresAt,
      createdAt: c.createdAt,
    }));
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
    const clientId = this.encryption.decrypt(cred.clientIdEnc);
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
    const clientId = this.encryption.decrypt(cred.clientIdEnc);
    const clientSecret = this.encryption.decrypt(cred.clientSecretEnc);

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
    const clientId = this.encryption.decrypt(cred.clientIdEnc);
    const clientSecret = this.encryption.decrypt(cred.clientSecretEnc);

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
