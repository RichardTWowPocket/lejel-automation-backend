import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GoogleClient } from '../entities/google-client.entity';
import { OAuthCredential } from '../entities/oauth-credential.entity';
import { EncryptionService } from './encryption.service';

@Injectable()
export class GoogleClientService {
  constructor(
    @InjectRepository(GoogleClient)
    private readonly clientRepo: Repository<GoogleClient>,
    @InjectRepository(OAuthCredential)
    private readonly credRepo: Repository<OAuthCredential>,
    private readonly encryption: EncryptionService,
  ) {}

  /** List all Google clients (id, label, createdAt, enabled; no secrets). Admin only. */
  async findAll(): Promise<{ id: string; label: string; createdAt: string; enabled: boolean }[]> {
    const list = await this.clientRepo.find({
      order: { createdAt: 'DESC' },
    });
    return list.map((c) => ({
      id: c.id,
      label: c.label || `Google client ${c.id.slice(0, 8)}`,
      createdAt: c.createdAt.toISOString(),
      enabled: c.enabled,
    }));
  }

  /** List only enabled Google clients (for dropdowns etc). */
  async findAllEnabled(): Promise<{ id: string; label: string; createdAt: string }[]> {
    const list = await this.clientRepo.find({
      where: { enabled: true },
      order: { createdAt: 'DESC' },
    });
    return list.map((c) => ({
      id: c.id,
      label: c.label || `Google client ${c.id.slice(0, 8)}`,
      createdAt: c.createdAt.toISOString(),
    }));
  }

  /** Set enabled flag. Admin only. */
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const client = await this.clientRepo.findOne({ where: { id } });
    if (!client) {
      throw new NotFoundException('Google client not found');
    }
    client.enabled = enabled;
    await this.clientRepo.save(client);
  }

  /** Create a Google client. Returns id and label. */
  async create(clientId: string, clientSecret: string, label?: string): Promise<{ id: string; label: string }> {
    if (!clientId?.trim() || !clientSecret?.trim()) {
      throw new BadRequestException('clientId and clientSecret are required');
    }
    const client = this.clientRepo.create({
      label: label?.trim() || '',
      clientIdEnc: this.encryption.encrypt(clientId.trim()),
      clientSecretEnc: this.encryption.encrypt(clientSecret.trim()),
    });
    const saved = await this.clientRepo.save(client);
    return {
      id: saved.id,
      label: saved.label || `Google client ${saved.id.slice(0, 8)}`,
    };
  }

  /** Delete a Google client. Fails if any connection references it. */
  async delete(id: string): Promise<void> {
    const client = await this.clientRepo.findOne({ where: { id } });
    if (!client) {
      throw new NotFoundException('Google client not found');
    }
    const count = await this.credRepo.count({ where: { googleClientId: id } });
    if (count > 0) {
      throw new BadRequestException(
        `Cannot delete: ${count} connection(s) use this client. Disconnect them first.`,
      );
    }
    await this.clientRepo.delete({ id });
  }

  /** Get decrypted clientId and clientSecret by client id (for OAuth flow). */
  async getCredentials(googleClientId: string): Promise<{ clientId: string; clientSecret: string }> {
    const client = await this.clientRepo.findOne({ where: { id: googleClientId } });
    if (!client) {
      throw new NotFoundException('Google client not found');
    }
    return {
      clientId: this.encryption.decrypt(client.clientIdEnc),
      clientSecret: this.encryption.decrypt(client.clientSecretEnc),
    };
  }
}
