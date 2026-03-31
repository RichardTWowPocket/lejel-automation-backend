import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FontsController } from './fonts.controller';

@Module({
  imports: [AuthModule],
  controllers: [FontsController],
})
export class FontsModule {}

