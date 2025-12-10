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
  
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Enable CORS if needed
  app.enableCors();

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`Application is running on: http://localhost:${port}`);
  console.log(`Media files available at: http://localhost:${port}/media/`);
}
bootstrap();





