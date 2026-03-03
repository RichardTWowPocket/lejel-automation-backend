import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from './user.entity';

export type VideoRequestStatus =
  | 'draft'
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed';

@Entity('video_requests')
export class VideoRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column('text')
  fullScript: string;

  @Column('simple-json')
  segmentedScripts: string[];

  @Column({ default: 'pending' })
  status: VideoRequestStatus;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  submittedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  completedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  resultUrl: string | null;

  @Column({ type: 'text', nullable: true })
  errorMessage: string | null;

  /** OAuth connection ID - when set, upload to this YouTube channel after generation */
  @Column('uuid', { nullable: true })
  connectionId: string | null;
}
