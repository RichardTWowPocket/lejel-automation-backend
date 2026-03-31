import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  OneToMany,
} from 'typeorm';
import { OAuthCredential } from './oauth-credential.entity';

@Entity('google_clients')
export class GoogleClient {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ default: '' })
  label: string;

  /** Encrypted Google OAuth client ID */
  @Column('text')
  clientIdEnc: string;

  /** Encrypted Google OAuth client secret */
  @Column('text')
  clientSecretEnc: string;

  /** When false, connections using this client are hidden from non-admin users. */
  @Column({ default: true })
  enabled: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @OneToMany(() => OAuthCredential, (cred) => cred.googleClient)
  connections: OAuthCredential[];
}
