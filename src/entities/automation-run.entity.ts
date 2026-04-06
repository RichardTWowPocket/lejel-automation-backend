import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { AutomationChannel } from './automation-channel.entity';
import { VideoRequest } from './video-request.entity';

export type AutomationRunStatus =
  | 'received'
  | 'segmenting'
  | 'queued'
  | 'processing'
  | 'uploading'
  | 'completed'
  | 'failed';

@Entity('automation_runs')
export class AutomationRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  channelId: string;

  @ManyToOne(() => AutomationChannel, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'channelId' })
  channel: AutomationChannel;

  @Column('uuid', { nullable: true })
  videoRequestId: string | null;

  @ManyToOne(() => VideoRequest, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'videoRequestId' })
  videoRequest: VideoRequest | null;

  @Column({ type: 'varchar', length: 32 })
  status: AutomationRunStatus;

  @Column('text', { nullable: true })
  inputTitle: string | null;

  @Column('text')
  inputBody: string;

  @Column('text', { nullable: true })
  youtubeUrl: string | null;

  @Column('text', { nullable: true })
  errorMessage: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
