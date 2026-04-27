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

@Entity('remotion_templates')
export class RemotionTemplate {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  userId: string;

  @ManyToOne(() => User, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  /** The full TSX source code for this template (default-export Remotion component). */
  @Column('text')
  tsxSource: string;

  /** The original natural-language prompt used to generate this template. */
  @Column('text', { nullable: true })
  generationPrompt: string | null;

  @Column({ type: 'int', default: 300 })
  durationInFrames: number;

  @Column({ type: 'int', default: 30 })
  fps: number;

  @Column({ type: 'int', default: 1080 })
  width: number;

  @Column({ type: 'int', default: 1920 })
  height: number;

  /** JSON object of default inputProps to pass when rendering. */
  @Column('simple-json', { nullable: true })
  defaultInputProps: Record<string, unknown> | null;

  /**
   * Stable R2 keys for motion assets (order matches userAsset0.. in TSX).
   * At render time the server merges fresh presigned GET URLs into inputProps.
   */
  @Column('simple-json', { nullable: true })
  remotionAssetRefs: Array<{ objectKey: string; label: string; kind: 'image' | 'video' }> | null;

  /** Public URL to the last rendered MP4 (via render server /requests/ static path). */
  @Column('text', { nullable: true })
  lastOutputUrl: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
