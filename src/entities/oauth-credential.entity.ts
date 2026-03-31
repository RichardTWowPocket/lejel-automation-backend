import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { GoogleClient } from './google-client.entity';

export type OAuthProvider = 'google_youtube';

@Entity('oauth_credentials')
export class OAuthCredential {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  provider: OAuthProvider;

  /** When set, credentials are read from this Google client (preferred). */
  @Column('uuid', { nullable: true })
  googleClientId: string | null;

  @ManyToOne(() => GoogleClient, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'googleClientId' })
  googleClient: GoogleClient | null;

  /** Legacy: encrypted client ID (used only when googleClientId is null). */
  @Column('text', { nullable: true })
  clientIdEnc: string | null;

  /** Legacy: encrypted client secret (used only when googleClientId is null). */
  @Column('text', { nullable: true })
  clientSecretEnc: string | null;

  /** Encrypted access token (null until OAuth complete) */
  @Column('text', { nullable: true })
  accessTokenEnc: string | null;

  /** Encrypted refresh token (null until OAuth complete) */
  @Column('text', { nullable: true })
  refreshTokenEnc: string | null;

  @Column({ type: 'timestamp', nullable: true })
  expiresAt: Date | null;

  @Column({ default: '' })
  scope: string;

  /** Human-readable label (e.g. channel name, "My Channel") */
  @Column({ default: '' })
  label: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
