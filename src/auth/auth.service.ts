import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User } from '../entities/user.entity';
import { VideoRequest } from '../entities/video-request.entity';
import { AdminCreateUserDto } from './dto/admin-create-user.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { BootstrapDto } from './dto/bootstrap.dto';

export interface JwtPayload {
  sub: string;
  email: string;
}

export interface AuthResult {
  accessToken: string;
  user: { id: string; email: string; name: string; role: 'user' | 'admin' };
}

/** Admin list row: lastActivityAt = max(lastLoginAt, max(video_requests.updatedAt)); not per-request API tracking. */
export type AdminUserRow = {
  id: string;
  email: string;
  name: string;
  role: 'user' | 'admin';
  createdAt: Date;
  lastLoginAt: Date | null;
  lastActivityAt: Date | null;
};

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(VideoRequest)
    private readonly videoRequestRepository: Repository<VideoRequest>,
    private readonly jwtService: JwtService,
  ) {}

  private maxDate(
    a: Date | null | undefined,
    b: Date | null | undefined,
  ): Date | null {
    const tA = a ? a.getTime() : -Infinity;
    const tB = b ? b.getTime() : -Infinity;
    if (tA === -Infinity && tB === -Infinity) {
      return null;
    }
    return new Date(Math.max(tA, tB));
  }

  private async maxVideoRequestUpdatedByUserId(): Promise<Map<string, Date>> {
    const raw = await this.videoRequestRepository
      .createQueryBuilder('vr')
      .select('vr.userId', 'userId')
      .addSelect('MAX(vr.updatedAt)', 'maxUpdated')
      .groupBy('vr.userId')
      .getRawMany<{ userId: string; maxUpdated: string | Date }>();
    const m = new Map<string, Date>();
    for (const r of raw) {
      m.set(r.userId, new Date(r.maxUpdated));
    }
    return m;
  }

  private mapUserToAdminRow(u: User, maxVideoUpdated: Date | undefined): AdminUserRow {
    const lastActivityAt = this.maxDate(u.lastLoginAt ?? null, maxVideoUpdated);
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt ?? null,
      lastActivityAt,
    };
  }

  private async issueToken(user: User): Promise<AuthResult> {
    const accessToken = this.jwtService.sign({
      sub: user.id,
      email: user.email,
    });
    return {
      accessToken,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    };
  }

  async bootstrap(dto: BootstrapDto, secret: string): Promise<AuthResult> {
    const expected = process.env.BOOTSTRAP_SECRET?.trim();
    if (!expected || secret !== expected) {
      throw new UnauthorizedException('Invalid bootstrap secret');
    }
    const count = await this.userRepository.count();
    if (count > 0) {
      throw new ConflictException('Bootstrap is only allowed when no users exist');
    }
    const existing = await this.userRepository.findOne({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException('Email already registered');
    }
    const passwordHash = await bcrypt.hash(dto.password, 10);
    const user = this.userRepository.create({
      email: dto.email,
      passwordHash,
      name: dto.name,
      role: 'admin',
    });
    const saved = await this.userRepository.save(user);
    return this.issueToken(saved);
  }

  async createUserByAdmin(dto: AdminCreateUserDto): Promise<{
    id: string;
    email: string;
    name: string;
    role: 'user' | 'admin';
  }> {
    const existing = await this.userRepository.findOne({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException('Email already registered');
    }
    const passwordHash = await bcrypt.hash(dto.password, 10);
    const role = dto.role ?? 'user';
    const user = this.userRepository.create({
      email: dto.email,
      passwordHash,
      name: dto.name,
      role,
    });
    const saved = await this.userRepository.save(user);
    return { id: saved.id, email: saved.email, name: saved.name, role: saved.role };
  }

  async deleteUserByAdmin(actorUserId: string, targetUserId: string): Promise<void> {
    if (actorUserId === targetUserId) {
      throw new BadRequestException('You cannot delete your own account');
    }
    const target = await this.userRepository.findOne({ where: { id: targetUserId } });
    if (!target) {
      throw new NotFoundException('User not found');
    }
    if (target.role === 'admin') {
      const adminCount = await this.userRepository.count({ where: { role: 'admin' } });
      if (adminCount <= 1) {
        throw new BadRequestException('Cannot delete the last admin user');
      }
    }
    await this.userRepository.remove(target);
  }

  async changePassword(userId: string, dto: ChangePasswordDto): Promise<void> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedException();
    }
    const valid = await bcrypt.compare(dto.currentPassword, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Current password is incorrect');
    }
    user.passwordHash = await bcrypt.hash(dto.newPassword, 10);
    await this.userRepository.save(user);
  }

  async login(email: string, password: string): Promise<AuthResult> {
    const user = await this.userRepository.findOne({ where: { email } });
    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Invalid email or password');
    }
    user.lastLoginAt = new Date();
    await this.userRepository.save(user);
    return this.issueToken(user);
  }

  async findById(id: string): Promise<{ id: string; email: string; name: string; role: 'user' | 'admin' } | null> {
    const user = await this.userRepository.findOne({ where: { id } });
    if (!user) return null;
    return { id: user.id, email: user.email, name: user.name, role: user.role };
  }

  async findAllUsers(): Promise<AdminUserRow[]> {
    const users = await this.userRepository.find({
      order: { createdAt: 'DESC' },
    });
    const maxByUser = await this.maxVideoRequestUpdatedByUserId();
    return users.map((u) => this.mapUserToAdminRow(u, maxByUser.get(u.id)));
  }

  async findRecentActiveUsers(limit: number): Promise<AdminUserRow[]> {
    const rows = await this.findAllUsers();
    rows.sort((a, b) => {
      const ta = a.lastActivityAt ? a.lastActivityAt.getTime() : -Infinity;
      const tb = b.lastActivityAt ? b.lastActivityAt.getTime() : -Infinity;
      return tb - ta;
    });
    return rows.slice(0, Math.max(1, limit));
  }
}
