import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from './user.entity';
import { OAuthCredential } from './oauth-credential.entity';

@Entity('automation_channels')
export class AutomationChannel {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  /** Public webhook path segment (unguessable). */
  @Column({ type: 'varchar', length: 64, unique: true })
  webhookSlug: string;

  @Column({ type: 'varchar', length: 128 })
  webhookSecretHash: string;

  /** First chars of last generated secret (for admin identification only). */
  @Column({ type: 'varchar', length: 8, default: '' })
  webhookSecretPrefix: string;

  @Column('uuid')
  connectionId: string;

  @ManyToOne(() => OAuthCredential, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'connectionId' })
  connection: OAuthCredential;

  @Column('uuid')
  ownerUserId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ownerUserId' })
  owner: User;

  @Column({ type: 'varchar', length: 128, nullable: true })
  profileId: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  contentType: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  imageModel: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  videoModel: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  llmModel: string | null;

  /** Extra instructions for LLM when splitting webhook title+body into TTS segments (automation only). */
  @Column('text', { nullable: true })
  scriptSegmentationPrompt: string | null;

  @Column({ type: 'varchar', length: 32, default: 'private' })
  youtubePrivacyStatus: 'public' | 'private' | 'unlisted';

  @Column('simple-json', { nullable: true })
  youtubeTags: string[] | null;

  @Column('text', { nullable: true })
  youtubeDescriptionTemplate: string | null;

  /** static = template + static tags; llm = one LLM call for title/description/tags. */
  @Column({ type: 'varchar', length: 16, default: 'static' })
  youtubeMetadataMode: 'static' | 'llm';

  @Column('text', { nullable: true })
  youtubeTitlePrompt: string | null;

  @Column('text', { nullable: true })
  youtubeDescriptionPrompt: string | null;

  @Column('text', { nullable: true })
  youtubeTagsPrompt: string | null;

  /** Appended after generated or template description (plain text CTA). */
  @Column('text', { nullable: true })
  youtubeDescriptionCta: string | null;

  /** Always prepended (order preserved) before static or LLM tags; deduped case-insensitively. */
  @Column('simple-json', { nullable: true })
  youtubeTagPrefixes: string[] | null;

  @Column({ default: true })
  enabled: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
