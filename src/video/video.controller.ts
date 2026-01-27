import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  BadRequestException,
  NotFoundException,
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
import { JobQueueService, JobStatus } from './job-queue.service';
import { CombineMediaDto, SectionMediaDto, MediaType } from './dto/combine-media.dto';
import { CombineMediasDto } from './dto/combine-medias.dto';
import { CombineMediaProfileDto } from './dto/combine-media-profile.dto';
import { UploadMediaRequestDto, UploadMediaResponseDto } from './dto/upload-media.dto';
import { CombineWithSubtitlesDto } from './dto/combine-with-subtitles.dto';
import { BurnSubtitlesDto } from './dto/burn-subtitles.dto';
import { ApiKeyGuard } from '../auth/api-key.guard';
import * as fs from 'fs';
import * as path from 'path';
import * as multer from 'multer';
import axios from 'axios';

@Controller('api')
@UseGuards(ApiKeyGuard)
export class VideoController {
  private readonly logger = new Logger(VideoController.name);
  private readonly publicMediaDir = path.join(process.cwd(), 'public', 'media');

  constructor(
    private readonly videoProcessingService: VideoProcessingService,
    private readonly jobQueueService: JobQueueService,
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
    @Req() req: Request,
  ) {
    const requestId = `req_${Date.now()}_${Math.round(Math.random() * 1000)}`;
    this.logger.log(`[${requestId}] ========== /combine-media API CALL STARTED ==========`);
    this.logger.log(`[${requestId}] Request received with ${combineMediaDto.sections?.length || 0} sections`);

    try {
      // Validate sections
      if (!combineMediaDto.sections || combineMediaDto.sections.length === 0) {
        this.logger.error(`[${requestId}] Validation failed: No sections provided`);
        throw new BadRequestException(
          'At least one section is required',
        );
      }

      this.logger.log(`[${requestId}] Validating ${combineMediaDto.sections.length} sections...`);

      // Validate each section: if no audioPath, then startTime and endTime are required
      for (let i = 0; i < combineMediaDto.sections.length; i++) {
        const section = combineMediaDto.sections[i];
        this.logger.debug(`[${requestId}] Validating section ${i + 1}: mediaPath=${section.mediaPath}, mediaType=${section.mediaType}, hasAudioPath=${!!section.audioPath}, hasTranscript=${!!section.transcript}`);

        if (!section.audioPath) {
          if (section.startTime === undefined || section.endTime === undefined) {
            this.logger.error(`[${requestId}] Section ${i + 1} validation failed: Missing startTime/endTime`);
            throw new BadRequestException(
              `Section ${i + 1}: startTime and endTime are required when audioPath is not provided`,
            );
          }
          if (!combineMediaDto.audioPath) {
            this.logger.error(`[${requestId}] Section ${i + 1} validation failed: No audio source`);
            throw new BadRequestException(
              `Section ${i + 1}: Either audioPath must be provided, or combined audioPath with startTime/endTime`,
            );
          }
        }
      }

      // Check if async mode is enabled
      const asyncMode = combineMediaDto.asyncMode === 'yes' ||
        combineMediaDto.asyncMode === 'true';

      if (asyncMode) {
        // Create job and return immediately
        const jobId = this.jobQueueService.createJob();
        this.logger.log(`[${requestId}] Async mode enabled, created job: ${jobId}`);

        // Process in background (don't await)
        this.processCombineMediaAsync(jobId, combineMediaDto, req, requestId);

        // Return job ID immediately
        return res.status(HttpStatus.ACCEPTED).json({
          jobId,
          status: 'pending',
          message: 'Job created successfully. Use /api/job/{jobId}/status to check status.',
        });
      }

      const audioSource = combineMediaDto.audioPath
        ? `combined audio: ${combineMediaDto.audioPath}`
        : 'per-section audio';
      this.logger.log(
        `[${requestId}] Processing ${combineMediaDto.sections.length} sections with ${audioSource}`,
      );

      // Check if subtitles should be used (handle both string and boolean)
      const useSubtitle = combineMediaDto.useSubtitle === true ||
        combineMediaDto.useSubtitle === 'true' ||
        (typeof combineMediaDto.useSubtitle === 'string' && combineMediaDto.useSubtitle.toLowerCase() === 'yes');

      // Check if social media subtitles should be used (handle both string and boolean)
      const useSocialMediaSubtitle = combineMediaDto.useSocialMediaSubtitle === true ||
        combineMediaDto.useSocialMediaSubtitle === 'true' ||
        (typeof combineMediaDto.useSocialMediaSubtitle === 'string' && combineMediaDto.useSocialMediaSubtitle.toLowerCase() === 'yes');

      this.logger.log(`[${requestId}] Subtitle settings: useSubtitle=${useSubtitle}, useSocialMediaSubtitle=${useSocialMediaSubtitle}`);
      this.logger.log(`[${requestId}] Subtitle params: useSubtitle="${combineMediaDto.useSubtitle}", useSocialMediaSubtitle="${combineMediaDto.useSocialMediaSubtitle}"`);

      // Log transcript status for each section
      let sectionsWithTranscripts = 0;
      for (let i = 0; i < combineMediaDto.sections.length; i++) {
        const section = combineMediaDto.sections[i];
        if (section.transcript) {
          sectionsWithTranscripts++;
          this.logger.log(`[${requestId}] Section ${i + 1} has transcript: "${section.transcript.substring(0, 50)}${section.transcript.length > 50 ? '...' : ''}"`);
        } else {
          this.logger.log(`[${requestId}] Section ${i + 1} has NO transcript`);
        }
      }
      this.logger.log(`[${requestId}] Summary: ${sectionsWithTranscripts}/${combineMediaDto.sections.length} sections have transcripts`);

      // Process and combine media
      this.logger.log(`[${requestId}] Starting video processing service...`);
      const outputPath = await this.videoProcessingService.combineMedia(
        combineMediaDto.audioPath,
        combineMediaDto.sections,
        combineMediaDto.outputFormat || 'mp4',
        combineMediaDto.width || 1920,
        combineMediaDto.height || 1080,
        useSubtitle,
        useSocialMediaSubtitle,
        requestId, // Pass requestId for logging
      );
      this.logger.log(`[${requestId}] Video processing completed. Output path: ${outputPath}`);

      // Check if file exists
      if (!fs.existsSync(outputPath)) {
        this.logger.error(`[${requestId}] Output file does not exist: ${outputPath}`);
        throw new BadRequestException('Output file was not created');
      }

      const outputStats = fs.statSync(outputPath);
      this.logger.log(`[${requestId}] Output file exists: ${outputPath} (${outputStats.size} bytes)`);

      // Check if returnUrl is requested
      const returnUrl = combineMediaDto.returnUrl?.toLowerCase() === 'yes' ||
        combineMediaDto.returnUrl?.toLowerCase() === 'true';
      this.logger.log(`[${requestId}] Return URL requested: ${returnUrl}`);

      if (returnUrl) {
        // Move file to public/media directory
        const fileName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(outputPath)}`;
        const publicPath = path.join(this.publicMediaDir, fileName);

        fs.copyFileSync(outputPath, publicPath);
        this.logger.log(`[${requestId}] Saved output file to public directory: ${publicPath}`);

        // Cleanup temp file
        if (fs.existsSync(outputPath)) {
          fs.unlinkSync(outputPath);
        }

        // Generate public URL
        const protocol = req.protocol || 'http';
        const host = req.get('host') || 'localhost:3000';
        const baseUrl = `${protocol}://${host}`;
        const publicUrl = `${baseUrl}/media/${fileName}`;

        this.logger.log(`[${requestId}] ========== /combine-media API CALL COMPLETED ==========`);
        this.logger.log(`[${requestId}] Returning public URL: ${publicUrl}`);

        // Return URL as plain text string
        res.setHeader('Content-Type', 'text/plain');
        return res.send(publicUrl);
      }

      // Stream file to response (original behavior)
      const stats = fs.statSync(outputPath);
      const fileName = path.basename(outputPath);

      this.logger.log(`[${requestId}] Streaming file to response: ${fileName} (${stats.size} bytes)`);

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
        this.logger.log(`[${requestId}] File streaming completed`);
        setTimeout(() => {
          if (fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath);
            this.logger.log(`[${requestId}] Cleaned up output file: ${outputPath}`);
          }
        }, 5000); // Wait 5 seconds before cleanup
      });

      this.logger.log(`[${requestId}] ========== /combine-media API CALL COMPLETED ==========`);
    } catch (error: any) {
      this.logger.error(`[${requestId}] Error combining media: ${error.message}`, error.stack);

      if (error instanceof BadRequestException) {
        throw error;
      }

      throw new BadRequestException(
        `Failed to combine media: ${error.message}`,
      );
    }
  }

  /**
   * Check if a string is a URL
   */
  private isUrl(str: string): boolean {
    try {
      const url = new URL(str);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }

  /**
   * Download file from URL and save to public/media directory
   */
  private async downloadFileFromUrl(
    url: string,
    req: Request,
    format?: string,
  ): Promise<UploadMediaResponseDto> {
    this.logger.log(`Downloading file from URL: ${url}`);

    try {
      const response = await axios({
        method: 'GET',
        url: url,
        responseType: 'stream',
        timeout: 1200000, // 20 minutes timeout
        maxContentLength: 500 * 1024 * 1024, // 500MB max
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'image/*,video/*,audio/*,*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': new URL(url).origin,
        },
        maxRedirects: 10,
        validateStatus: (status) => status >= 200 && status < 400, // Accept 2xx and 3xx
      });

      // Determine file extension from URL or Content-Type
      let extension = path.extname(new URL(url).pathname);
      if (!extension || extension === '') {
        const contentType = response.headers['content-type'];
        if (contentType?.includes('image/png')) {
          extension = '.png';
        } else if (contentType?.includes('image/jpeg') || contentType?.includes('image/jpg')) {
          extension = '.jpg';
        } else if (contentType?.includes('image/gif')) {
          extension = '.gif';
        } else if (contentType?.includes('image/webp')) {
          extension = '.webp';
        } else if (contentType?.includes('image/svg+xml')) {
          extension = '.svg';
        } else if (contentType?.includes('video/mp4')) {
          extension = '.mp4';
        } else if (contentType?.includes('video/webm')) {
          extension = '.webm';
        } else if (contentType?.includes('audio/mpeg') || contentType?.includes('audio/mp3')) {
          extension = '.mp3';
        } else if (contentType?.includes('audio/wav')) {
          extension = '.wav';
        } else if (contentType?.includes('video')) {
          extension = '.mp4';
        } else if (contentType?.includes('audio')) {
          extension = '.mp3';
        } else if (contentType?.includes('image')) {
          extension = '.jpg';
        } else {
          extension = '.tmp';
        }
      }

      const fileName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`;
      const filePath = path.join(this.publicMediaDir, fileName);

      const writer = fs.createWriteStream(filePath);
      response.data.pipe(writer);

      await new Promise<void>((resolve, reject) => {
        writer.on('finish', () => resolve());
        writer.on('error', reject);
      });

      // Get file stats
      const stats = fs.statSync(filePath);
      const mimeType = response.headers['content-type'] || 'application/octet-stream';

      // Determine media type
      let mediaType: 'image' | 'video' | 'audio';
      if (mimeType.startsWith('image/')) {
        mediaType = 'image';
      } else if (mimeType.startsWith('video/')) {
        mediaType = 'video';
      } else if (mimeType.startsWith('audio/')) {
        mediaType = 'audio';
      } else {
        // Try to determine from extension as fallback
        const ext = extension.toLowerCase();
        if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'].includes(ext)) {
          mediaType = 'image';
        } else if (['.mp4', '.webm', '.avi', '.mov', '.mkv'].includes(ext)) {
          mediaType = 'video';
        } else if (['.mp3', '.wav', '.ogg', '.flac', '.m4a'].includes(ext)) {
          mediaType = 'audio';
        } else {
          throw new BadRequestException('Unable to determine media type from URL');
        }
      }

      let finalFilePath = filePath;
      let finalFileName = fileName;
      let finalMimeType = mimeType;
      let finalFileSize = stats.size;

      // Handle format conversion if requested
      if (format) {
        const requestedFormat = format.toLowerCase().replace('.', '');
        const originalExt = extension.toLowerCase().replace('.', '');

        // Only convert if format is different
        if (originalExt !== requestedFormat) {
          this.logger.log(`Converting downloaded file from ${originalExt} to ${requestedFormat}`);

          const outputFileName = `${path.parse(fileName).name}.${requestedFormat}`;
          const outputPath = path.join(this.publicMediaDir, outputFileName);

          try {
            await this.videoProcessingService.convertMediaFormat(
              filePath,
              requestedFormat,
              outputPath,
            );

            // Cleanup original file
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
            }

            finalFilePath = outputPath;
            finalFileName = outputFileName;
            finalFileSize = fs.statSync(outputPath).size;

            // Update MIME type and media type based on format
            const mimeTypeMap: { [key: string]: string } = {
              mp3: 'audio/mpeg',
              wav: 'audio/wav',
              ogg: 'audio/ogg',
              flac: 'audio/flac',
              m4a: 'audio/mp4',
              aac: 'audio/aac',
              mp4: 'video/mp4',
              webm: 'video/webm',
              avi: 'video/x-msvideo',
              mov: 'video/quicktime',
              mkv: 'video/x-matroska',
            };
            finalMimeType = mimeTypeMap[requestedFormat] || mimeType;

            // Update media type if needed
            if (finalMimeType.startsWith('audio/')) {
              mediaType = 'audio';
            } else if (finalMimeType.startsWith('video/')) {
              mediaType = 'video';
            } else if (finalMimeType.startsWith('image/')) {
              mediaType = 'image';
            }

            this.logger.log(`Conversion successful: ${finalFileName} (${finalFileSize} bytes)`);
          } catch (error: any) {
            this.logger.error(`Format conversion failed: ${error.message}`);
            throw new BadRequestException(
              `Failed to convert file to ${requestedFormat}: ${error.message}`,
            );
          }
        }
      }

      // Generate public URL
      const protocol = req.protocol || 'http';
      const host = req.get('host') || 'localhost:3000';
      const baseUrl = `${protocol}://${host}`;
      const publicUrl = `${baseUrl}/media/${finalFileName}`;

      this.logger.log(`File downloaded from URL: ${finalFileName} -> ${publicUrl}`);

      return {
        filePath: finalFilePath,
        fileName: finalFileName,
        fileSize: finalFileSize,
        mimeType: finalMimeType,
        mediaType,
        publicUrl,
      };
    } catch (error: any) {
      this.logger.error(`Failed to download file from URL: ${error.message}`);
      if (error.response?.status === 403) {
        throw new BadRequestException('Access forbidden (403). The server may be blocking the request. Please check if the URL is publicly accessible.');
      } else if (error.response?.status === 404) {
        throw new BadRequestException('File not found at the provided URL (404)');
      } else if (error.response?.status === 401) {
        throw new BadRequestException('Unauthorized (401). The URL may require authentication.');
      } else if (error.code === 'ECONNABORTED') {
        throw new BadRequestException('Request timeout while downloading file');
      } else if (error.response?.status === 413 || error.message?.includes('maxContentLength')) {
        throw new BadRequestException('File size exceeds 500MB limit');
      } else if (error.response?.status) {
        throw new BadRequestException(`Failed to download file from URL: HTTP ${error.response.status} - ${error.response.statusText}`);
      }
      throw new BadRequestException(`Failed to download file from URL: ${error.message}`);
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
    @Body() uploadMediaDto: UploadMediaRequestDto,
    @Req() req: Request,
  ): Promise<UploadMediaResponseDto> {
    // Check if URL is provided
    if (uploadMediaDto?.url) {
      if (file) {
        throw new BadRequestException('Please provide either a file or a URL, not both');
      }
      return await this.downloadFileFromUrl(uploadMediaDto.url, req, uploadMediaDto.format);
    }

    // If no URL, require file upload
    if (!file) {
      throw new BadRequestException('Either a file or a URL is required');
    }

    let finalFilePath = file.path;
    let finalFileName = file.filename;
    let finalMimeType = file.mimetype;
    let finalFileSize = file.size;

    // Handle format conversion if requested
    if (uploadMediaDto?.format) {
      const requestedFormat = uploadMediaDto.format.toLowerCase().replace('.', '');
      const originalExt = path.extname(file.originalname).toLowerCase().replace('.', '');

      // Only convert if format is different
      if (originalExt !== requestedFormat) {
        this.logger.log(`Converting ${file.originalname} from ${originalExt} to ${requestedFormat}`);

        const outputFileName = `${path.parse(file.filename).name}.${requestedFormat}`;
        const outputPath = path.join(this.publicMediaDir, outputFileName);

        try {
          await this.videoProcessingService.convertMediaFormat(
            file.path,
            requestedFormat,
            outputPath,
          );

          // Cleanup original file
          if (fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
          }

          finalFilePath = outputPath;
          finalFileName = outputFileName;
          finalFileSize = fs.statSync(outputPath).size;

          // Update MIME type based on format
          const mimeTypeMap: { [key: string]: string } = {
            mp3: 'audio/mpeg',
            wav: 'audio/wav',
            ogg: 'audio/ogg',
            flac: 'audio/flac',
            m4a: 'audio/mp4',
            aac: 'audio/aac',
            mp4: 'video/mp4',
            webm: 'video/webm',
            avi: 'video/x-msvideo',
            mov: 'video/quicktime',
            mkv: 'video/x-matroska',
          };
          finalMimeType = mimeTypeMap[requestedFormat] || file.mimetype;

          this.logger.log(`Conversion successful: ${finalFileName} (${finalFileSize} bytes)`);
        } catch (error: any) {
          this.logger.error(`Format conversion failed: ${error.message}`);
          throw new BadRequestException(
            `Failed to convert file to ${requestedFormat}: ${error.message}`,
          );
        }
      }
    }

    // Determine media type
    let mediaType: 'image' | 'video' | 'audio';
    if (finalMimeType.startsWith('image/')) {
      mediaType = 'image';
    } else if (finalMimeType.startsWith('video/')) {
      mediaType = 'video';
    } else if (finalMimeType.startsWith('audio/')) {
      mediaType = 'audio';
    } else {
      throw new BadRequestException('Unsupported file type');
    }

    // Generate public URL
    const protocol = req.protocol || 'http';
    const host = req.get('host') || 'localhost:3000';
    const baseUrl = `${protocol}://${host}`;
    const publicUrl = `${baseUrl}/media/${finalFileName}`;

    this.logger.log(`Media uploaded: ${finalFileName} -> ${publicUrl}`);

    return {
      filePath: finalFilePath,
      fileName: finalFileName,
      fileSize: finalFileSize,
      mimeType: finalMimeType,
      mediaType,
      publicUrl,
    };
  }

  /**
   * Determine if a URL points to an image or video based on extension
   */
  private detectMediaTypeFromUrl(url: string): MediaType {
    const urlLower = url.toLowerCase();
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'];
    const videoExtensions = ['.mp4', '.webm', '.avi', '.mov', '.mkv', '.flv', '.wmv'];

    // Check extension
    for (const ext of imageExtensions) {
      if (urlLower.includes(ext)) {
        return MediaType.IMAGE;
      }
    }

    for (const ext of videoExtensions) {
      if (urlLower.includes(ext)) {
        return MediaType.VIDEO;
      }
    }

    // Default to image if cannot determine
    this.logger.warn(`Cannot determine media type from URL: ${url}, defaulting to image`);
    return MediaType.IMAGE;
  }

  @Post('combine-with-subtitles')
  async combineWithSubtitles(
    @Body() combineWithSubtitlesDto: CombineWithSubtitlesDto,
    @Res() res: Response,
    @Req() req: Request,
  ) {
    try {
      // Validate results
      if (!combineWithSubtitlesDto.results || combineWithSubtitlesDto.results.length === 0) {
        throw new BadRequestException('At least one result is required');
      }

      this.logger.log(
        `Processing ${combineWithSubtitlesDto.results.length} results with subtitles`,
      );

      // Transform user's format to existing SectionMediaDto format
      const sections: SectionMediaDto[] = combineWithSubtitlesDto.results.map((result, idx) => {
        // Determine media URL (prefer videoUrl over imageUrl if both provided)
        const mediaUrl = result.videoUrl || result.imageUrl;
        if (!mediaUrl) {
          throw new BadRequestException(
            `Result ${result.index || idx + 1}: Either imageUrl or videoUrl is required`,
          );
        }

        // Detect media type (if videoUrl is provided, it's definitely a video)
        const mediaType = result.videoUrl
          ? MediaType.VIDEO
          : this.detectMediaTypeFromUrl(mediaUrl);

        // Create section DTO
        const section: SectionMediaDto = {
          mediaPath: mediaUrl, // URL will be resolved by resolveFilePath
          mediaType: mediaType,
          audioPath: result.audio, // Audio URL
          transcript: result.script, // Subtitle text
        };

        return section;
      });

      // Process and combine media with per-section subtitle burning
      // Always use subtitles for this endpoint (it's specifically for subtitles)
      const outputPath = await this.videoProcessingService.combineMediaWithPerSectionSubtitles(
        undefined, // No combined audio - each section has its own audio
        sections,
        combineWithSubtitlesDto.outputFormat || 'mp4',
        combineWithSubtitlesDto.width || 1920,
        combineWithSubtitlesDto.height || 1080,
        true, // Always use subtitles for combine-with-subtitles endpoint
      );

      // Check if file exists
      if (!fs.existsSync(outputPath)) {
        throw new BadRequestException('Output file was not created');
      }

      // Check if returnUrl is requested
      const returnUrl = combineWithSubtitlesDto.returnUrl?.toLowerCase() === 'yes' ||
        combineWithSubtitlesDto.returnUrl?.toLowerCase() === 'true';

      if (returnUrl) {
        // Move file to public/media directory
        const fileName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(outputPath)}`;
        const publicPath = path.join(this.publicMediaDir, fileName);

        fs.copyFileSync(outputPath, publicPath);
        this.logger.log(`Saved output file to public directory: ${publicPath}`);

        // Cleanup temp file
        if (fs.existsSync(outputPath)) {
          fs.unlinkSync(outputPath);
        }

        // Generate public URL
        const protocol = req.protocol || 'http';
        const host = req.get('host') || 'localhost:3000';
        const baseUrl = `${protocol}://${host}`;
        const publicUrl = `${baseUrl}/media/${fileName}`;

        // Return URL as plain text string
        res.setHeader('Content-Type', 'text/plain');
        return res.send(publicUrl);
      }

      // Stream file to response (original behavior)
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
      this.logger.error(`Error combining media with subtitles: ${error.message}`, error.stack);

      if (error instanceof BadRequestException) {
        throw error;
      }

      throw new BadRequestException(
        `Failed to combine media with subtitles: ${error.message}`,
      );
    }
  }

  @Post('burn-subtitles')
  async burnSubtitles(
    @Body() burnSubtitlesDto: BurnSubtitlesDto,
    @Res() res: Response,
    @Req() req: Request,
  ) {
    const requestId = `req_${Date.now()}_${Math.round(Math.random() * 1000)}`;
    this.logger.log(`[${requestId}] ========== /burn-subtitles API CALL STARTED ==========`);
    this.logger.log(`[${requestId}] Video URL: ${burnSubtitlesDto.videoUrl}`);
    this.logger.log(`[${requestId}] Subtitle content length: ${burnSubtitlesDto.subtitleContent.length} characters`);

    try {
      // Validate subtitle content
      if (!burnSubtitlesDto.subtitleContent || burnSubtitlesDto.subtitleContent.trim().length === 0) {
        this.logger.error(`[${requestId}] Validation failed: Empty subtitle content`);
        throw new BadRequestException('Subtitle content is required');
      }

      // Process and burn subtitles
      this.logger.log(`[${requestId}] Starting subtitle burning process...`);
      const outputPath = await this.videoProcessingService.burnSubtitlesToVideo(
        burnSubtitlesDto.videoUrl,
        burnSubtitlesDto.subtitleContent,
        burnSubtitlesDto.width,
        burnSubtitlesDto.height,
        requestId,
      );
      this.logger.log(`[${requestId}] Subtitle burning completed. Output path: ${outputPath}`);

      // Check if file exists
      if (!fs.existsSync(outputPath)) {
        this.logger.error(`[${requestId}] Output file does not exist: ${outputPath}`);
        throw new BadRequestException('Output file was not created');
      }

      const outputStats = fs.statSync(outputPath);
      this.logger.log(`[${requestId}] Output file exists: ${outputPath} (${outputStats.size} bytes)`);

      // Check if returnUrl is requested
      const returnUrl = burnSubtitlesDto.returnUrl?.toLowerCase() === 'yes' ||
        burnSubtitlesDto.returnUrl?.toLowerCase() === 'true';
      this.logger.log(`[${requestId}] Return URL requested: ${returnUrl}`);

      if (returnUrl) {
        // Move file to public/media directory
        const fileName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(outputPath)}`;
        const publicPath = path.join(this.publicMediaDir, fileName);

        fs.copyFileSync(outputPath, publicPath);
        this.logger.log(`[${requestId}] Saved output file to public directory: ${publicPath}`);

        // Cleanup temp file
        if (fs.existsSync(outputPath)) {
          fs.unlinkSync(outputPath);
        }

        // Generate public URL
        const protocol = req.protocol || 'http';
        const host = req.get('host') || 'localhost:3000';
        const baseUrl = `${protocol}://${host}`;
        const publicUrl = `${baseUrl}/media/${fileName}`;

        this.logger.log(`[${requestId}] ========== /burn-subtitles API CALL COMPLETED ==========`);
        this.logger.log(`[${requestId}] Returning public URL: ${publicUrl}`);

        // Return URL as plain text string
        res.setHeader('Content-Type', 'text/plain');
        return res.send(publicUrl);
      }

      // Stream file to response (original behavior)
      const stats = fs.statSync(outputPath);
      const fileName = path.basename(outputPath);

      this.logger.log(`[${requestId}] Streaming file to response: ${fileName} (${stats.size} bytes)`);

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
        this.logger.log(`[${requestId}] File streaming completed`);
        setTimeout(() => {
          if (fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath);
            this.logger.log(`[${requestId}] Cleaned up output file: ${outputPath}`);
          }
        }, 5000); // Wait 5 seconds before cleanup
      });

      this.logger.log(`[${requestId}] ========== /burn-subtitles API CALL COMPLETED ==========`);
    } catch (error: any) {
      this.logger.error(`[${requestId}] Error burning subtitles: ${error.message}`, error.stack);

      if (error instanceof BadRequestException) {
        throw error;
      }

      throw new BadRequestException(
        `Failed to burn subtitles: ${error.message}`,
      );
    }
  }

  @Post('combine-medias')
  async combineMedias(
    @Body() combineMediasDto: CombineMediasDto,
    @Res() res: Response,
    @Req() req: Request,
  ) {
    const requestId = `req_${Date.now()}_${Math.round(Math.random() * 1000)}`;
    this.logger.log(`[${requestId}] ========== /combine-medias API CALL STARTED ==========`);
    this.logger.log(`[${requestId}] Request received with ${combineMediasDto.sections?.length || 0} sections`);

    try {
      // Validate sections
      if (!combineMediasDto.sections || combineMediasDto.sections.length === 0) {
        this.logger.error(`[${requestId}] Validation failed: No sections provided`);
        throw new BadRequestException('At least one section is required');
      }

      // Validate audio path
      if (!combineMediasDto.audioPath) {
        this.logger.error(`[${requestId}] Validation failed: No audio path provided`);
        throw new BadRequestException('audioPath is required');
      }

      // Validate each section has transcript and imagePath
      for (let i = 0; i < combineMediasDto.sections.length; i++) {
        const section = combineMediasDto.sections[i];
        if (!section.transcript || section.transcript.trim().length === 0) {
          throw new BadRequestException(`Section ${i + 1}: transcript is required`);
        }
        if (!section.imagePath) {
          throw new BadRequestException(`Section ${i + 1}: imagePath is required`);
        }
      }

      // Check if subtitles should be used
      const useSubtitle = combineMediasDto.useSubtitle === true ||
        combineMediasDto.useSubtitle === 'true' ||
        (typeof combineMediasDto.useSubtitle === 'string' && combineMediasDto.useSubtitle.toLowerCase() === 'yes');

      const useSocialMediaSubtitle = combineMediasDto.useSocialMediaSubtitle === true ||
        combineMediasDto.useSocialMediaSubtitle === 'true' ||
        (typeof combineMediasDto.useSocialMediaSubtitle === 'string' && combineMediasDto.useSocialMediaSubtitle.toLowerCase() === 'yes');

      this.logger.log(`[${requestId}] Subtitle settings: useSubtitle=${useSubtitle}, useSocialMediaSubtitle=${useSocialMediaSubtitle}`);

      // Log layout settings if vertical_poster
      if (combineMediasDto.layout === 'vertical_poster') {
        this.logger.log(`[${requestId}] Vertical poster layout enabled`);
        this.logger.log(`[${requestId}] Top headline: ${combineMediasDto.topHeadlineText || 'not provided'}`);
        this.logger.log(`[${requestId}] Bottom headline: ${combineMediasDto.bottomHeadlineText || 'not provided'}`);
        this.logger.log(`[${requestId}] Bottom headline appear: ${combineMediasDto.bottomHeadlineAppear || 'start (default)'}`);
        this.logger.log(`[${requestId}] Image aspect: ${combineMediasDto.imageAspect || '3:4 (default)'}`);
        this.logger.log(`[${requestId}] Input ratio: ${combineMediasDto.inputRatio || '3:4 (default)'}`);
        this.logger.log(`[${requestId}] Vertical gap: ${combineMediasDto.verticalGap || '24 (default)'}`);
      }

      // Check if async mode is enabled
      const asyncMode = combineMediasDto.asyncMode === 'yes' ||
        combineMediasDto.asyncMode === 'true';

      if (asyncMode) {
        // Create job and return immediately
        const jobId = this.jobQueueService.createJob();
        this.logger.log(`[${requestId}] Async mode enabled, created job: ${jobId}`);

        // Process in background (don't await)
        this.processCombineMediasAsync(jobId, combineMediasDto, req, requestId);

        // Return job ID immediately
        return res.status(HttpStatus.ACCEPTED).json({
          jobId,
          status: 'pending',
          message: 'Job created successfully. Use /api/job/{jobId}/status to check status.',
        });
      }

      // Process and combine media with new workflow
      this.logger.log(`[${requestId}] Starting video processing service...`);

      // Build profile config from request parameters for backward compatibility
      const profileConfigFromRequest = {
        subtitle: {
          useSubtitle,
          useSocialMediaSubtitle,
          fontFamily: 'Noto Sans CJK KR',
          fontSize: 48,
          fontFile: '',
          primaryColor: '&H00FFFFFF&',
          outlineColor: '&H00000000&',
          backColor: '&H80000000&',
          outline: 5,
          shadow: 0,
          alignment: 2,
          marginL: 50,
          marginR: 50,
          marginV: 600,
          bold: false,
          italic: false,
          scaleX: 100,
          scaleY: 100,
        },
        headline: {
          topHeadline: {
            fontFamily: 'Hakgyoansim Jiugae',
            fontSize: 120,
            fontFile: '',
            color: '#FFFFFF',
            highlightColor: '#FF0000',
            highlightColorASS: '&H0000FF&',
            borderColor: '#000000',
            borderWidth: 5,
            y: 150,
            alignment: 8,
            marginL: 50,
            marginR: 50,
            marginV: 150,
            bold: true,
            italic: false,
            lineHeight: 1.0,
          },
          bottomHeadline: {
            fontFamily: 'Hakgyoansim Jiugae',
            fontSize: 100,
            fontFile: '',
            color: '#FFFFFF',
            borderColor: '#000000',
            borderWidth: 5,
            alignment: 2,
            bold: true,
            italic: false,
          },
        },
        layout: {
          type: combineMediasDto.layout || 'default',
          canvasWidth: combineMediasDto.width || 1920,
          canvasHeight: combineMediasDto.height || 1080,
          imageWidth: combineMediasDto.width || 1920,
          imageHeight: combineMediasDto.height || 1080,
          imageTop: 0,
          imageAspect: combineMediasDto.imageAspect || '16:9',
          inputRatio: combineMediasDto.inputRatio || '16:9',
          verticalGap: combineMediasDto.verticalGap || 24,
        },
      };

      const outputPath = await this.videoProcessingService.combineMediasWithTranscripts(
        combineMediasDto.audioPath,
        combineMediasDto.sections.map(s => ({ transcript: s.transcript, imagePath: s.imagePath })),
        combineMediasDto.outputFormat || 'mp4',
        requestId,
        profileConfigFromRequest,
        combineMediasDto.topHeadlineText,
        combineMediasDto.bottomHeadlineText,
        combineMediasDto.bottomHeadlineAppear,
      );
      this.logger.log(`[${requestId}] Video processing completed. Output path: ${outputPath}`);

      // Check if file exists
      if (!fs.existsSync(outputPath)) {
        this.logger.error(`[${requestId}] Output file does not exist: ${outputPath}`);
        throw new BadRequestException('Output file was not created');
      }

      const outputStats = fs.statSync(outputPath);
      this.logger.log(`[${requestId}] Output file exists: ${outputPath} (${outputStats.size} bytes)`);

      // Check if returnUrl is requested
      const returnUrl = combineMediasDto.returnUrl?.toLowerCase() === 'yes' ||
        combineMediasDto.returnUrl?.toLowerCase() === 'true';
      this.logger.log(`[${requestId}] Return URL requested: ${returnUrl}`);

      if (returnUrl) {
        // Move file to public/media directory
        const fileName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(outputPath)}`;
        const publicPath = path.join(this.publicMediaDir, fileName);

        fs.copyFileSync(outputPath, publicPath);
        this.logger.log(`[${requestId}] Saved output file to public directory: ${publicPath}`);

        // Cleanup temp file
        if (fs.existsSync(outputPath)) {
          fs.unlinkSync(outputPath);
        }

        // Generate public URL
        const protocol = req.protocol || 'http';
        const host = req.get('host') || 'localhost:3000';
        const baseUrl = `${protocol}://${host}`;
        const publicUrl = `${baseUrl}/media/${fileName}`;

        this.logger.log(`[${requestId}] ========== /combine-medias API CALL COMPLETED ==========`);
        this.logger.log(`[${requestId}] Returning public URL: ${publicUrl}`);

        // Return URL as plain text string
        res.setHeader('Content-Type', 'text/plain');
        return res.send(publicUrl);
      }

      // Stream file to response (original behavior)
      const stats = fs.statSync(outputPath);
      const fileName = path.basename(outputPath);

      this.logger.log(`[${requestId}] Streaming file to response: ${fileName} (${stats.size} bytes)`);

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
        this.logger.log(`[${requestId}] File streaming completed`);
        setTimeout(() => {
          if (fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath);
            this.logger.log(`[${requestId}] Cleaned up output file: ${outputPath}`);
          }
        }, 5000); // Wait 5 seconds before cleanup
      });

      this.logger.log(`[${requestId}] ========== /combine-medias API CALL COMPLETED ==========`);
    } catch (error: any) {
      this.logger.error(`[${requestId}] Error combining medias: ${error.message}`, error.stack);

      if (error instanceof BadRequestException) {
        throw error;
      }

      throw new BadRequestException(
        `Failed to combine medias: ${error.message}`,
      );
    }
  }

  /**
   * Process combine-medias in background (async mode)
   */
  private async processCombineMediasAsync(
    jobId: string,
    combineMediasDto: CombineMediasDto,
    req: Request,
    requestId: string,
  ): Promise<void> {
    try {
      this.jobQueueService.updateJobStatus(jobId, JobStatus.PROCESSING);
      this.logger.log(`[${jobId}] [${requestId}] Starting async video processing for combine-medias...`);

      // Check if subtitles should be used
      const useSubtitle = combineMediasDto.useSubtitle === true ||
        combineMediasDto.useSubtitle === 'true' ||
        (typeof combineMediasDto.useSubtitle === 'string' && combineMediasDto.useSubtitle.toLowerCase() === 'yes');

      const useSocialMediaSubtitle = combineMediasDto.useSocialMediaSubtitle === true ||
        combineMediasDto.useSocialMediaSubtitle === 'true' ||
        (typeof combineMediasDto.useSocialMediaSubtitle === 'string' && combineMediasDto.useSocialMediaSubtitle.toLowerCase() === 'yes');

      // Build profile config from request parameters
      const profileConfigFromRequest = {
        subtitle: { useSubtitle, useSocialMediaSubtitle, fontFamily: 'Noto Sans CJK KR', fontSize: 48, fontFile: '', primaryColor: '&H00FFFFFF&', outlineColor: '&H00000000&', backColor: '&H80000000&', outline: 5, shadow: 0, alignment: 2, marginL: 50, marginR: 50, marginV: 600, bold: false, italic: false, scaleX: 100, scaleY: 100 },
        headline: { topHeadline: { fontFamily: 'Hakgyoansim Jiugae', fontSize: 120, fontFile: '', color: '#FFFFFF', highlightColor: '#FF0000', highlightColorASS: '&H0000FF&', borderColor: '#000000', borderWidth: 5, y: 150, alignment: 8, marginL: 50, marginR: 50, marginV: 150, bold: true, italic: false, lineHeight: 1.0 }, bottomHeadline: { fontFamily: 'Hakgyoansim Jiugae', fontSize: 100, fontFile: '', color: '#FFFFFF', borderColor: '#000000', borderWidth: 5, alignment: 2, bold: true, italic: false } },
        layout: { type: combineMediasDto.layout || 'default', canvasWidth: combineMediasDto.width || 1920, canvasHeight: combineMediasDto.height || 1080, imageWidth: combineMediasDto.width || 1920, imageHeight: combineMediasDto.height || 1080, imageTop: 0, imageAspect: combineMediasDto.imageAspect || '16:9', inputRatio: combineMediasDto.inputRatio || '16:9', verticalGap: combineMediasDto.verticalGap || 24 },
      };

      // Process video
      const outputPath = await this.videoProcessingService.combineMediasWithTranscripts(
        combineMediasDto.audioPath,
        combineMediasDto.sections.map(s => ({ transcript: s.transcript, imagePath: s.imagePath })),
        combineMediasDto.outputFormat || 'mp4',
        `${requestId}_${jobId}`,
        profileConfigFromRequest,
        combineMediasDto.topHeadlineText,
        combineMediasDto.bottomHeadlineText,
        combineMediasDto.bottomHeadlineAppear,
      );

      if (!fs.existsSync(outputPath)) {
        throw new Error('Output file was not created');
      }

      // Move file to public/media directory
      const fileName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(outputPath)}`;
      const publicPath = path.join(this.publicMediaDir, fileName);

      fs.copyFileSync(outputPath, publicPath);
      this.logger.log(`[${jobId}] [${requestId}] Saved output file to public directory: ${publicPath}`);

      // Cleanup temp file
      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
      }

      // Generate public URL
      const protocol = req.protocol || 'http';
      const host = req.get('host') || 'localhost:3000';
      const baseUrl = `${protocol}://${host}`;
      const publicUrl = `${baseUrl}/media/${fileName}`;

      // Set job result
      this.jobQueueService.setJobResult(jobId, publicUrl, publicPath);
      this.logger.log(`[${jobId}] [${requestId}] Job completed successfully: ${publicUrl}`);
    } catch (error: any) {
      this.logger.error(`[${jobId}] [${requestId}] Error processing job: ${error.message}`, error.stack);
      this.jobQueueService.setJobError(jobId, error.message || 'Unknown error occurred');
    }
  }

  /**
   * Process combine-media in background (async mode)
   */
  private async processCombineMediaAsync(
    jobId: string,
    combineMediaDto: CombineMediaDto,
    req: Request,
    requestId: string,
  ): Promise<void> {
    try {
      this.jobQueueService.updateJobStatus(jobId, JobStatus.PROCESSING);
      this.logger.log(`[${jobId}] [${requestId}] Starting async video processing...`);

      // Check if subtitles should be used
      const useSubtitle = combineMediaDto.useSubtitle === true ||
        combineMediaDto.useSubtitle === 'true' ||
        (typeof combineMediaDto.useSubtitle === 'string' && combineMediaDto.useSubtitle.toLowerCase() === 'yes');

      const useSocialMediaSubtitle = combineMediaDto.useSocialMediaSubtitle === true ||
        combineMediaDto.useSocialMediaSubtitle === 'true' ||
        (typeof combineMediaDto.useSocialMediaSubtitle === 'string' && combineMediaDto.useSocialMediaSubtitle.toLowerCase() === 'yes');

      // Process video
      const outputPath = await this.videoProcessingService.combineMedia(
        combineMediaDto.audioPath,
        combineMediaDto.sections,
        combineMediaDto.outputFormat || 'mp4',
        combineMediaDto.width || 1920,
        combineMediaDto.height || 1080,
        useSubtitle,
        useSocialMediaSubtitle,
        `${requestId}_${jobId}`,
      );

      if (!fs.existsSync(outputPath)) {
        throw new Error('Output file was not created');
      }

      // Move file to public/media directory
      const fileName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(outputPath)}`;
      const publicPath = path.join(this.publicMediaDir, fileName);

      fs.copyFileSync(outputPath, publicPath);
      this.logger.log(`[${jobId}] [${requestId}] Saved output file to public directory: ${publicPath}`);

      // Cleanup temp file
      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
      }

      // Generate public URL
      const protocol = req.protocol || 'http';
      const host = req.get('host') || 'localhost:3000';
      const baseUrl = `${protocol}://${host}`;
      const publicUrl = `${baseUrl}/media/${fileName}`;

      // Set job result
      this.jobQueueService.setJobResult(jobId, publicUrl, publicPath);
      this.logger.log(`[${jobId}] [${requestId}] Job completed successfully: ${publicUrl}`);
    } catch (error: any) {
      this.logger.error(`[${jobId}] [${requestId}] Error processing job: ${error.message}`, error.stack);
      this.jobQueueService.setJobError(jobId, error.message || 'Unknown error occurred');
    }
  }

  /**
   * Load profile JSON file
   */
  private async loadProfile(profileId: string = 'default'): Promise<any> {
    const profilesDir = path.join(process.cwd(), 'profiles');
    const profileFileName = profileId === 'default' ? 'default.json' : `${profileId}.json`;
    const profilePath = path.join(profilesDir, profileFileName);

    if (!fs.existsSync(profilePath)) {
      this.logger.warn(`Profile ${profileId} not found, falling back to default`);
      const defaultPath = path.join(profilesDir, 'default.json');
      if (!fs.existsSync(defaultPath)) {
        throw new BadRequestException(`Profile file not found: ${profilePath}`);
      }
      const profileContent = fs.readFileSync(defaultPath, 'utf-8');
      return JSON.parse(profileContent);
    }

    const profileContent = fs.readFileSync(profilePath, 'utf-8');
    return JSON.parse(profileContent);
  }

  /**
   * Combine media with profile-based styling
   */
  @Post('combine-media-profile')
  async combineMediaProfile(
    @Body() combineMediaProfileDto: CombineMediaProfileDto,
    @Res() res: Response,
    @Req() req: Request,
  ) {
    const requestId = `req_${Date.now()}_${Math.round(Math.random() * 1000)}`;
    this.logger.log(`[${requestId}] ========== /combine-media-profile API CALL STARTED ==========`);
    this.logger.log(`[${requestId}] Request received with ${combineMediaProfileDto.sections?.length || 0} sections`);

    try {
      // Validate sections
      if (!combineMediaProfileDto.sections || combineMediaProfileDto.sections.length === 0) {
        this.logger.error(`[${requestId}] Validation failed: No sections provided`);
        throw new BadRequestException('At least one section is required');
      }

      // Validate audio path
      if (!combineMediaProfileDto.audioPath) {
        this.logger.error(`[${requestId}] Validation failed: No audio path provided`);
        throw new BadRequestException('audioPath is required');
      }

      // Validate each section has transcript and imagePath
      for (let i = 0; i < combineMediaProfileDto.sections.length; i++) {
        const section = combineMediaProfileDto.sections[i];
        if (!section.transcript || section.transcript.trim().length === 0) {
          throw new BadRequestException(`Section ${i + 1}: transcript is required`);
        }
        if (!section.imagePath) {
          throw new BadRequestException(`Section ${i + 1}: imagePath is required`);
        }
      }

      // Load profile
      const profileId = combineMediaProfileDto.profile || 'default';
      this.logger.log(`[${requestId}] Loading profile: ${profileId}`);
      const profile = await this.loadProfile(profileId);
      this.logger.log(`[${requestId}] Profile loaded: ${profile.name} (${profile.profileId})`);

      // Extract config from profile
      const profileConfig = profile.config;
      const subtitleConfig = profileConfig.subtitle;
      const layoutConfig = profileConfig.layout;
      const headlineConfig = profileConfig.headline;

      const useSubtitle = subtitleConfig.useSubtitle === true;
      const useSocialMediaSubtitle = subtitleConfig.useSocialMediaSubtitle === true;

      this.logger.log(`[${requestId}] Profile subtitle settings: useSubtitle=${useSubtitle}, useSocialMediaSubtitle=${useSocialMediaSubtitle}`);
      this.logger.log(`[${requestId}] Profile layout: ${layoutConfig.type}`);
      this.logger.log(`[${requestId}] Profile canvas: ${layoutConfig.canvasWidth}x${layoutConfig.canvasHeight}`);

      const layout = layoutConfig.type === 'vertical_poster' ? 'vertical_poster' : 'default';
      const topHeadlineText = combineMediaProfileDto.topHeadlineText || '';
      const bottomHeadlineText = combineMediaProfileDto.bottomHeadlineText || '';
      const width = layoutConfig.canvasWidth || 1920;
      const height = layoutConfig.canvasHeight || 1080;

      // Check if async mode is enabled
      const asyncMode = combineMediaProfileDto.asyncMode === 'yes' ||
        combineMediaProfileDto.asyncMode === 'true';

      if (asyncMode) {
        // Create job and return immediately
        const jobId = this.jobQueueService.createJob();
        this.logger.log(`[${requestId}] Async mode enabled, created job: ${jobId}`);

        // Process in background (don't await)
        this.processCombineMediaProfileAsync(jobId, combineMediaProfileDto, profile, req, requestId);

        // Return job ID immediately
        return res.status(HttpStatus.ACCEPTED).json({
          jobId,
          status: 'pending',
          message: 'Job created successfully. Use /api/job/{jobId}/status to check status.',
        });
      }

      // Get highlight color from profile
      const highlightColorASS = headlineConfig?.topHeadline?.highlightColorASS || '&H0000FF&';
      this.logger.log(`[${requestId}] Using highlight color from profile: ${highlightColorASS}`);
      this.logger.log(`[${requestId}] Using headline font from profile: ${headlineConfig?.topHeadline?.fontFamily || 'Hakgyoansim Jiugae (default)'}`);

      // Process and combine media with profile settings
      this.logger.log(`[${requestId}] Starting video processing service...`);
      const outputPath = await this.videoProcessingService.combineMediasWithTranscripts(
        combineMediaProfileDto.audioPath,
        combineMediaProfileDto.sections.map(s => ({ transcript: s.transcript, imagePath: s.imagePath })),
        combineMediaProfileDto.outputFormat || 'mp4',
        requestId,
        profileConfig, // Pass full profile config
        topHeadlineText,
        bottomHeadlineText,
        combineMediaProfileDto.bottomHeadlineAppear || 'start', // bottomHeadlineAppear
      );
      this.logger.log(`[${requestId}] Video processing completed. Output path: ${outputPath}`);

      // Check if file exists
      if (!fs.existsSync(outputPath)) {
        this.logger.error(`[${requestId}] Output file does not exist: ${outputPath}`);
        throw new BadRequestException('Output file was not created');
      }

      const outputStats = fs.statSync(outputPath);
      this.logger.log(`[${requestId}] Output file exists: ${outputPath} (${outputStats.size} bytes)`);

      // Check if returnUrl is requested
      const returnUrl = combineMediaProfileDto.returnUrl?.toLowerCase() === 'yes' ||
        combineMediaProfileDto.returnUrl?.toLowerCase() === 'true';
      this.logger.log(`[${requestId}] Return URL requested: ${returnUrl}`);

      if (returnUrl) {
        // Move file to public/media directory
        const fileName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(outputPath)}`;
        const publicPath = path.join(this.publicMediaDir, fileName);

        fs.copyFileSync(outputPath, publicPath);
        this.logger.log(`[${requestId}] Saved output file to public directory: ${publicPath}`);

        // Cleanup temp file
        if (fs.existsSync(outputPath)) {
          fs.unlinkSync(outputPath);
        }

        // Generate public URL
        const protocol = req.protocol || 'http';
        const host = req.get('host') || 'localhost:3000';
        const baseUrl = `${protocol}://${host}`;
        const publicUrl = `${baseUrl}/media/${fileName}`;

        this.logger.log(`[${requestId}] ========== /combine-media-profile API CALL COMPLETED ==========`);
        this.logger.log(`[${requestId}] Returning public URL: ${publicUrl}`);

        // Return URL as plain text string
        res.setHeader('Content-Type', 'text/plain');
        return res.send(publicUrl);
      }

      // Stream file to response (original behavior)
      const stats = fs.statSync(outputPath);
      const fileName = path.basename(outputPath);

      this.logger.log(`[${requestId}] Streaming file to response: ${fileName} (${stats.size} bytes)`);

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
        this.logger.log(`[${requestId}] File streaming completed`);
        setTimeout(() => {
          if (fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath);
            this.logger.log(`[${requestId}] Cleaned up output file: ${outputPath}`);
          }
        }, 5000); // Wait 5 seconds before cleanup
      });

      this.logger.log(`[${requestId}] ========== /combine-media-profile API CALL COMPLETED ==========`);
    } catch (error: any) {
      this.logger.error(`[${requestId}] Error combining media with profile: ${error.message}`, error.stack);

      if (error instanceof BadRequestException) {
        throw error;
      }

      throw new BadRequestException(
        `Failed to combine media with profile: ${error.message}`,
      );
    }
  }

  /**
   * Process combine-media-profile in background (async mode)
   */
  private async processCombineMediaProfileAsync(
    jobId: string,
    combineMediaProfileDto: CombineMediaProfileDto,
    profile: any,
    req: Request,
    requestId: string,
  ): Promise<void> {
    try {
      this.jobQueueService.updateJobStatus(jobId, JobStatus.PROCESSING);
      this.logger.log(`[${jobId}] [${requestId}] Starting async video processing for combine-media-profile...`);

      // Extract config from profile
      const profileConfig = profile.config;
      const subtitleConfig = profileConfig.subtitle;
      const layoutConfig = profileConfig.layout;
      const headlineConfig = profileConfig.headline;

      const useSubtitle = subtitleConfig.useSubtitle === true;
      const useSocialMediaSubtitle = subtitleConfig.useSocialMediaSubtitle === true;

      const layout = layoutConfig.type === 'vertical_poster' ? 'vertical_poster' : 'default';
      const topHeadlineText = combineMediaProfileDto.topHeadlineText || '';
      const bottomHeadlineText = combineMediaProfileDto.bottomHeadlineText || '';
      const width = layoutConfig.canvasWidth || 1920;
      const height = layoutConfig.canvasHeight || 1080;
      const highlightColorASS = headlineConfig?.topHeadline?.highlightColorASS || '&H0000FF&';

      this.logger.log(`[${jobId}] [${requestId}] Using highlight color from profile: ${highlightColorASS}`);
      this.logger.log(`[${jobId}] [${requestId}] Using headline font from profile: ${headlineConfig?.topHeadline?.fontFamily || 'Hakgyoansim Jiugae (default)'}`);

      // Process video with full profile config
      const outputPath = await this.videoProcessingService.combineMediasWithTranscripts(
        combineMediaProfileDto.audioPath,
        combineMediaProfileDto.sections.map(s => ({ transcript: s.transcript, imagePath: s.imagePath })),
        combineMediaProfileDto.outputFormat || 'mp4',
        requestId,
        profile.config, // Pass full profile config from loaded profile
        topHeadlineText,
        bottomHeadlineText,
        combineMediaProfileDto.bottomHeadlineAppear || 'start', // bottomHeadlineAppear
      );

      this.logger.log(`[${jobId}] [${requestId}] Video processing completed. Output path: ${outputPath}`);

      // Check if returnUrl is requested
      const returnUrl = combineMediaProfileDto.returnUrl?.toLowerCase() === 'yes' ||
        combineMediaProfileDto.returnUrl?.toLowerCase() === 'true';

      if (returnUrl) {
        // Move file to public/media directory
        const fileName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(outputPath)}`;
        const publicPath = path.join(this.publicMediaDir, fileName);

        fs.copyFileSync(outputPath, publicPath);
        this.logger.log(`[${jobId}] [${requestId}] Saved output file to public directory: ${publicPath}`);

        // Cleanup temp file
        if (fs.existsSync(outputPath)) {
          fs.unlinkSync(outputPath);
        }

        // Generate public URL
        const protocol = req.protocol || 'http';
        const host = req.get('host') || 'localhost:3000';
        const baseUrl = `${protocol}://${host}`;
        const publicUrl = `${baseUrl}/media/${fileName}`;

        // Set job result with URL
        this.jobQueueService.setJobResult(jobId, publicUrl);
        this.logger.log(`[${jobId}] [${requestId}] Job completed with URL: ${publicUrl}`);
      } else {
        // Set job result with file path
        this.jobQueueService.setJobResult(jobId, undefined, outputPath);
        this.logger.log(`[${jobId}] [${requestId}] Job completed. File available at: ${outputPath}`);
      }
    } catch (error: any) {
      this.logger.error(`[${jobId}] [${requestId}] Error processing combine-media-profile: ${error.message}`, error.stack);
      this.jobQueueService.setJobError(jobId, error.message);
    }
  }

  /**
   * Get job status
   */
  @Get('job/:jobId/status')
  async getJobStatus(@Param('jobId') jobId: string) {
    const job = this.jobQueueService.getJob(jobId);

    if (!job) {
      throw new NotFoundException(`Job with ID ${jobId} not found`);
    }

    return {
      jobId: job.id,
      status: job.status,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      progress: job.progress,
      result: job.result?.url ? { url: job.result.url } : undefined,
      error: job.result?.error,
    };
  }

  /**
   * Get job result (URL when completed)
   */
  @Get('job/:jobId/result')
  async getJobResult(@Param('jobId') jobId: string) {
    const job = this.jobQueueService.getJob(jobId);

    if (!job) {
      throw new NotFoundException(`Job with ID ${jobId} not found`);
    }

    if (job.status === JobStatus.PENDING || job.status === JobStatus.PROCESSING) {
      throw new BadRequestException(`Job ${jobId} is still ${job.status}. Please check status first.`);
    }

    if (job.status === JobStatus.FAILED) {
      throw new BadRequestException(`Job ${jobId} failed: ${job.result?.error || 'Unknown error'}`);
    }

    if (!job.result?.url) {
      throw new BadRequestException(`Job ${jobId} completed but no result URL available`);
    }

    return {
      jobId: job.id,
      status: job.status,
      url: job.result.url,
      completedAt: job.completedAt,
    };
  }
}

