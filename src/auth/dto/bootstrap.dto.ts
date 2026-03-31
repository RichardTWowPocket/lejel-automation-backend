import { IsEmail, IsString, MinLength } from 'class-validator';

/** First admin when database is empty; requires X-Bootstrap-Secret header. */
export class BootstrapDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(6, { message: 'Password must be at least 6 characters' })
  password: string;

  @IsString()
  @MinLength(1, { message: 'Name is required' })
  name: string;
}
