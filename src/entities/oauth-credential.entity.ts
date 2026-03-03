import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

export type OAuthProvider = 'google_youtube';

@Entity('oauth_credentials')
export class OAuthCredential {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  provider: OAuthProvider;

  /** Encrypted Google Client ID (per-credential) */
  @Column('text')
  clientIdEnc: string;

  /** Encrypted Google Client Secret (per-credential) */
  @Column('text')
  clientSecretEnc: string;

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
