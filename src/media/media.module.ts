import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { MediaController } from './media.controller';
import { R2Service } from './r2.service';

/** Global so R2Service can inject into VideoRequestModule / VideoModule without duplicate route registration. */
@Global()
@Module({
  imports: [ConfigModule, AuthModule],
  controllers: [MediaController],
  providers: [R2Service],
  exports: [R2Service],
})
export class MediaModule {}
