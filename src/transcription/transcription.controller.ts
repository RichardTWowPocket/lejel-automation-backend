import {
  Controller,
  Post,
  UseInterceptors,
  UploadedFile,
  Body,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { TranscriptionService } from './transcription.service';
import { TranscribeAudioDto } from './dto/transcribe-audio.dto';
import * as multer from 'multer';
import * as path from 'path';
import * as fs from 'fs';

const uploadDir = './temp';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, `${uniqueSuffix}${path.extname(file.originalname)}`);
  },
});

const fileFilter = (req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  // Accept audio files
  const allowedMimes = [
    'audio/mpeg',
    'audio/mp3',
    'audio/wav',
    'audio/webm',
    'audio/ogg',
    'audio/flac',
    'audio/m4a',
    'audio/x-m4a',
    'audio/mp4',
    'audio/x-wav',
  ];
  
  // Also check file extension as fallback
  const allowedExts = ['.mp3', '.wav', '.webm', '.ogg', '.flac', '.m4a', '.mp4'];
  const ext = path.extname(file.originalname).toLowerCase();
  
  if (allowedMimes.includes(file.mimetype) || allowedExts.includes(ext)) {
    cb(null, true);
  } else {
    cb(
      new BadRequestException(
        `Invalid file type. Allowed types: ${allowedMimes.join(', ')}`,
      ),
    );
  }
};

@Controller('api')
export class TranscriptionController {
  constructor(private readonly transcriptionService: TranscriptionService) {}

  @Post('transcribe-audio')
  @UseInterceptors(
    FileInterceptor('audio', {
      storage,
      limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
      fileFilter,
    }),
  )
  async transcribeAudio(
    @UploadedFile() audioFile: Express.Multer.File,
    @Body() transcribeAudioDto: TranscribeAudioDto,
  ) {
    if (!audioFile) {
      throw new BadRequestException('Audio file is required');
    }

    try {
      const result = await this.transcriptionService.transcribe(
        audioFile.path,
        transcribeAudioDto.language,
        transcribeAudioDto.format || 'verbose_json',
      );

      // Clean up uploaded file
      if (fs.existsSync(audioFile.path)) {
        fs.unlinkSync(audioFile.path);
      }

      return result;
    } catch (error) {
      // Clean up uploaded file on error
      if (audioFile && fs.existsSync(audioFile.path)) {
        fs.unlinkSync(audioFile.path);
      }
      throw error;
    }
  }
}





