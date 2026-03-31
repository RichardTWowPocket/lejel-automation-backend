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

export type YoutubeUploadMode = 'none' | 'pending_approval' | 'direct';
export type VideoRequestStatus =
  | 'draft'
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'pending_youtube_approval';

@Entity('video_requests')
export class VideoRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  userId: string;

  @ManyToOne(() => User, (user) => user.videoRequests, {
    nullable: true,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column('text')
  fullScript: string;

  @Column('simple-json')
  segmentedScripts: string[];

  @Column({ type: 'varchar', length: 64, default: 'pending' })
  status: VideoRequestStatus;

  @Column({ type: 'varchar', length: 32, default: 'none' })
  youtubeUploadMode: YoutubeUploadMode;

  @Column({ type: 'varchar', length: 64, nullable: true })
  contentType: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  profileId: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  imageModel: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  videoModel: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  llmModel: string | null;

  @Column({ type: 'uuid', nullable: true })
  connectionId: string | null;

  @Column('text', { nullable: true })
  resultUrl: string | null;

  @Column('text', { nullable: true })
  finalUrl: string | null;

  @Column('text', { nullable: true })
  debugMetaUrl: string | null;

  @Column('text', { nullable: true })
  errorMessage: string | null;

  @Column('text', { nullable: true })
  youtubeTitle: string | null;

  @Column('text', { nullable: true })
  youtubeDescription: string | null;

  @Column('simple-json', { nullable: true })
  youtubeTags: string[] | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  youtubePrivacyStatus: 'public' | 'private' | 'unlisted' | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  youtubeVideoId: string | null;

  @Column('text', { nullable: true })
  youtubeUrl: string | null;

  @Column('text', { nullable: true })
  youtubeErrorMessage: string | null;

  @Column({ type: 'timestamp', nullable: true })
  submittedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  completedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  youtubeApprovalRejectedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  youtubeApprovalRejectedBy: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
