import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  OneToMany,
} from 'typeorm';
import { VideoRequest } from './video-request.entity';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  email: string;

  @Column()
  passwordHash: string;

  @Column()
  name: string;

  @Column({ type: 'varchar', length: 20, default: 'user' })
  role: 'user' | 'admin';

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  lastLoginAt: Date | null;

  @OneToMany(() => VideoRequest, (vr) => vr.user)
  videoRequests: VideoRequest[];
}
