import {
  Controller,
  Post,
  Body,
  BadRequestException,
  HttpStatus,
  Res,
  Logger,
  UseInterceptors,
  UploadedFile,
  Req,
  UseGuards,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response, Request } from 'express';
import { VideoProcessingService } from './video-processing.service';
import { CombineMediaDto } from './dto/combine-media.dto';
import { UploadMediaResponseDto } from './dto/upload-media.dto';
import { ApiKeyGuard } from '../auth/api-key.guard';
import * as fs from 'fs';
import * as path from 'path';
import * as multer from 'multer';

@Controller('api')
@UseGuards(ApiKeyGuard)
export class VideoController {
  private readonly logger = new Logger(VideoController.name);
  private readonly publicMediaDir = path.join(process.cwd(), 'public', 'media');

  constructor(
    private readonly videoProcessingService: VideoProcessingService,
  ) {
    // Ensure public/media directory exists
    if (!fs.existsSync(this.publicMediaDir)) {
      fs.mkdirSync(this.publicMediaDir, { recursive: true });
    }
  }

  @Post('combine-media')
  async combineMedia(
    @Body() combineMediaDto: CombineMediaDto,
    @Res() res: Response,
  ) {
    try {
      if (!combineMediaDto.audioPath) {
        throw new BadRequestException('Combined audio path is required');
      }

      if (!combineMediaDto.sections || combineMediaDto.sections.length === 0) {
        throw new BadRequestException(
          'At least one section is required',
        );
      }

      this.logger.log(
        `Processing ${combineMediaDto.sections.length} sections with combined audio: ${combineMediaDto.audioPath}`,
      );

      // Process and combine media
      const outputPath = await this.videoProcessingService.combineMedia(
        combineMediaDto.audioPath,
        combineMediaDto.sections,
        combineMediaDto.outputFormat || 'mp4',
        combineMediaDto.width || 1920,
        combineMediaDto.height || 1080,
      );

      // Check if file exists
      if (!fs.existsSync(outputPath)) {
        throw new BadRequestException('Output file was not created');
      }

      // Get file stats
      const stats = fs.statSync(outputPath);
      const fileName = path.basename(outputPath);

      // Set response headers
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${fileName}"`,
      );
      res.setHeader('Content-Length', stats.size);

      // Stream file to response
      const fileStream = fs.createReadStream(outputPath);
      fileStream.pipe(res);

      // Cleanup file after streaming
      fileStream.on('end', () => {
        setTimeout(() => {
          if (fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath);
            this.logger.log(`Cleaned up output file: ${outputPath}`);
          }
        }, 5000); // Wait 5 seconds before cleanup
      });
    } catch (error: any) {
      this.logger.error(`Error combining media: ${error.message}`, error.stack);
      
      if (error instanceof BadRequestException) {
        throw error;
      }

      throw new BadRequestException(
        `Failed to combine media: ${error.message}`,
      );
    }
  }

  @Post('upload-media')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: multer.diskStorage({
        destination: (req, file, cb) => {
          const publicMediaDir = path.join(process.cwd(), 'public', 'media');
          if (!fs.existsSync(publicMediaDir)) {
            fs.mkdirSync(publicMediaDir, { recursive: true });
          }
          cb(null, publicMediaDir);
        },
        filename: (req, file, cb) => {
          const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
          cb(null, `${uniqueSuffix}${path.extname(file.originalname)}`);
        },
      }),
      limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
    }),
  )
  async uploadMedia(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: Request,
  ): Promise<UploadMediaResponseDto> {
    if (!file) {
      throw new BadRequestException('File is required');
    }

    // Determine media type
    let mediaType: 'image' | 'video' | 'audio';
    if (file.mimetype.startsWith('image/')) {
      mediaType = 'image';
    } else if (file.mimetype.startsWith('video/')) {
      mediaType = 'video';
    } else if (file.mimetype.startsWith('audio/')) {
      mediaType = 'audio';
    } else {
      throw new BadRequestException('Unsupported file type');
    }

    // Generate public URL
    const protocol = req.protocol || 'http';
    const host = req.get('host') || 'localhost:3000';
    const baseUrl = `${protocol}://${host}`;
    const publicUrl = `${baseUrl}/media/${file.filename}`;

    this.logger.log(`Media uploaded: ${file.filename} -> ${publicUrl}`);

    return {
      filePath: file.path,
      fileName: file.filename,
      fileSize: file.size,
      mimeType: file.mimetype,
      mediaType,
      publicUrl,
    };
  }
}

