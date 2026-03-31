import {
  Injectable,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User } from '../entities/user.entity';
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

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly jwtService: JwtService,
  ) {}

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
    return this.issueToken(user);
  }

  async findById(id: string): Promise<{ id: string; email: string; name: string; role: 'user' | 'admin' } | null> {
    const user = await this.userRepository.findOne({ where: { id } });
    if (!user) return null;
    return { id: user.id, email: user.email, name: user.name, role: user.role };
  }

  async findAllUsers() {
    const users = await this.userRepository.find({
      order: { createdAt: 'DESC' },
    });
    return users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      createdAt: u.createdAt,
    }));
  }
}
