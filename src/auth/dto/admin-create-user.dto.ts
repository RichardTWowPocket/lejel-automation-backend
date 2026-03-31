import { IsEmail, IsIn, IsOptional, IsString, MinLength } from 'class-validator';

export class AdminCreateUserDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(6, { message: 'Password must be at least 6 characters' })
  password: string;

  @IsString()
  @MinLength(1, { message: 'Name is required' })
  name: string;

  @IsOptional()
  @IsIn(['user', 'admin'])
  role?: 'user' | 'admin';
}
