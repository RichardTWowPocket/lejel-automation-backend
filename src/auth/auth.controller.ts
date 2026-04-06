import {
  Controller,
  Post,
  Body,
  Get,
  Patch,
  Delete,
  Param,
  UseGuards,
  Headers,
  Query,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { AdminCreateUserDto } from './dto/admin-create-user.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { BootstrapDto } from './dto/bootstrap.dto';
import { JwtAuthGuard } from './jwt-auth.guard';
import { AdminGuard } from './admin.guard';
import { User as ReqUser } from './user.decorator';

@Controller('api/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /** One-time: create first admin when DB is empty. Header: X-Bootstrap-Secret */
  @Post('bootstrap')
  async bootstrap(
    @Headers('x-bootstrap-secret') secret: string,
    @Body() dto: BootstrapDto,
  ) {
    return this.authService.bootstrap(dto, secret || '');
  }

  @Post('login')
  async login(@Body() dto: LoginDto) {
    return this.authService.login(dto.email, dto.password);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(
    @ReqUser() user: { id: string; email: string; name: string; role: 'user' | 'admin' },
  ) {
    return { user };
  }

  @Patch('me/password')
  @UseGuards(JwtAuthGuard)
  async changePassword(
    @ReqUser() user: { id: string },
    @Body() dto: ChangePasswordDto,
  ) {
    await this.authService.changePassword(user.id, dto);
    return { ok: true };
  }

  @Get('admin/users/recent-activity')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async listRecentActiveUsers(@Query('limit') limit?: string) {
    const n = Math.min(Math.max(parseInt(limit || '5', 10) || 5, 1), 50);
    return this.authService.findRecentActiveUsers(n);
  }

  @Get('admin/users')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async listAllUsers() {
    return this.authService.findAllUsers();
  }

  @Post('admin/users')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async createUser(@Body() dto: AdminCreateUserDto) {
    return this.authService.createUserByAdmin(dto);
  }

  @Delete('admin/users/:id')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async deleteUser(
    @Param('id') id: string,
    @ReqUser() user: { id: string },
  ) {
    await this.authService.deleteUserByAdmin(user.id, id);
    return { ok: true };
  }
}
