import './polyfill-crypto';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { NestExpressApplication } from '@nestjs/platform-express';
import * as express from 'express';
import { join } from 'path';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  
  // Trust proxy to get correct protocol (http/https) from X-Forwarded-Proto header
  app.set('trust proxy', true);
  
  // Increase body size limit to 100MB for large audio files
  app.use(express.json({ limit: '100mb' }));
  app.use(express.urlencoded({ limit: '100mb', extended: true }));
  
  // Serve static files from public/media directory
  app.useStaticAssets(join(__dirname, '..', 'public', 'media'), {
    prefix: '/media/',
  });
  app.useStaticAssets(join(__dirname, '..', 'public', 'requests'), {
    prefix: '/requests/',
  });
  
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // CORS: allow frontend origins (comma-separated in CORS_ORIGIN, e.g. "http://localhost:3000,http://localhost:3002")
  const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:3000';
  const origins = corsOrigin.split(',').map((o) => o.trim()).filter(Boolean);
  app.enableCors({
    origin: origins.length > 1 ? origins : origins[0] || 'http://localhost:3000',
    credentials: true,
  });

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`Application is running on: http://localhost:${port}`);
  console.log(`Media files available at: http://localhost:${port}/media/`);
  console.log(`Request files available at: http://localhost:${port}/requests/`);
}
bootstrap();





