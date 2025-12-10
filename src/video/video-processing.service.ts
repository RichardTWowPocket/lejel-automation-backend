import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import * as ffmpeg from 'fluent-ffmpeg';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { exec } from 'child_process';
import { SectionMediaDto, MediaType } from './dto/combine-media.dto';

const execAsync = promisify(exec);

@Injectable()
export class VideoProcessingService {
  private readonly logger = new Logger(VideoProcessingService.name);
  private readonly tempDir = './temp';

  constructor() {
    // Ensure temp directory exists
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  /**
   * Combine multiple sections (media + audio segments from combined audio) into a single output video
   */
  async combineMedia(
    audioPath: string,
    sections: SectionMediaDto[],
    outputFormat: string = 'mp4',
    width: number = 1920,
    height: number = 1080,
  ): Promise<string> {
    const outputPath = path.join(
      this.tempDir,
      `combined_${Date.now()}.${outputFormat}`,
    );

    // Verify combined audio file exists
    if (!fs.existsSync(audioPath)) {
      throw new BadRequestException(
        `Combined audio file not found: ${audioPath}`,
      );
    }

    try {
      // Process each section and create video clips
      const clipPaths: string[] = [];

      for (let i = 0; i < sections.length; i++) {
        const section = sections[i];
        this.logger.log(`Processing section ${i + 1}/${sections.length}`);

        const clipPath = await this.processSection(
          audioPath,
          section,
          i,
          width,
          height,
        );
        clipPaths.push(clipPath);
      }

      // Concatenate all clips into final video
      await this.concatenateClips(clipPaths, outputPath);

      // Cleanup temporary clips
      for (const clipPath of clipPaths) {
        if (fs.existsSync(clipPath)) {
          fs.unlinkSync(clipPath);
        }
      }

      this.logger.log(`Successfully created combined video: ${outputPath}`);
      return outputPath;
    } catch (error: any) {
      this.logger.error(`Failed to combine media: ${error.message}`, error.stack);
      throw new BadRequestException(`Failed to combine media: ${error.message}`);
    }
  }

  /**
   * Process a single section: extract audio segment from combined audio and combine with image/video
   */
  private async processSection(
    combinedAudioPath: string,
    section: SectionMediaDto,
    index: number,
    width: number,
    height: number,
  ): Promise<string> {
    const audioDuration = section.endTime - section.startTime;
    const outputPath = path.join(
      this.tempDir,
      `section_${index}_${Date.now()}.mp4`,
    );

    // Verify media file exists
    if (!fs.existsSync(section.mediaPath)) {
      throw new BadRequestException(
        `Media file not found: ${section.mediaPath}`,
      );
    }

    // Extract audio segment from combined audio
    const audioSegmentPath = path.join(
      this.tempDir,
      `audio_segment_${index}_${Date.now()}.mp3`,
    );

    try {
      // First, extract the audio segment from the combined audio
      await this.extractAudioSegment(
        combinedAudioPath,
        section.startTime,
        audioDuration,
        audioSegmentPath,
      );

      // Then process the section with the extracted audio segment
      return new Promise((resolve, reject) => {
        let command = ffmpeg();

        if (section.mediaType === MediaType.IMAGE) {
          // For images: create video from image with audio duration
          command = command
            .input(section.mediaPath)
            .inputOptions(['-loop', '1', '-framerate', '1'])
            .input(audioSegmentPath)
            .videoCodec('libx264')
            .audioCodec('aac')
            .outputOptions([
              `-t ${audioDuration}`, // Set duration to match audio
              `-vf scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`, // Scale and pad to maintain aspect ratio
              '-shortest', // Finish encoding when the shortest input stream ends
              '-pix_fmt yuv420p', // Ensure compatibility
            ]);
        } else {
          // For videos: trim video to match audio duration, replace audio with extracted audio segment
          command = command
            .input(section.mediaPath)
            .inputOptions([`-t ${audioDuration}`]) // Trim video input to audio duration first
            .input(audioSegmentPath)
            .videoCodec('libx264')
            .audioCodec('aac')
            .outputOptions([
              `-vf scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`, // Scale and pad
              '-shortest', // Finish encoding when the shortest input stream ends (audio)
              '-map 0:v:0', // Map first input's video stream
              '-map 1:a:0', // Map second input's audio stream
              '-pix_fmt yuv420p',
            ]);
        }

        command
          .output(outputPath)
          .on('start', (commandLine) => {
            this.logger.debug(`FFmpeg command: ${commandLine}`);
          })
          .on('progress', (progress) => {
            this.logger.debug(`Processing: ${JSON.stringify(progress)}`);
          })
          .on('end', () => {
            this.logger.log(
              `Section ${index} processed: ${outputPath} (${audioDuration}s)`,
            );
            // Cleanup extracted audio segment
            if (fs.existsSync(audioSegmentPath)) {
              fs.unlinkSync(audioSegmentPath);
            }
            resolve(outputPath);
          })
          .on('error', (error) => {
            this.logger.error(`FFmpeg error for section ${index}: ${error.message}`);
            // Cleanup extracted audio segment on error
            if (fs.existsSync(audioSegmentPath)) {
              fs.unlinkSync(audioSegmentPath);
            }
            reject(error);
          })
          .run();
      });
    } catch (error: any) {
      // Cleanup extracted audio segment on error
      if (fs.existsSync(audioSegmentPath)) {
        fs.unlinkSync(audioSegmentPath);
      }
      throw error;
    }
  }

  /**
   * Extract audio segment from combined audio file
   */
  private async extractAudioSegment(
    audioPath: string,
    startTime: number,
    duration: number,
    outputPath: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      ffmpeg()
        .input(audioPath)
        .inputOptions([
          `-ss ${startTime}`, // Start time
          `-t ${duration}`, // Duration
        ])
        .audioCodec('copy') // Copy codec for faster processing
        .output(outputPath)
        .on('start', (commandLine) => {
          this.logger.debug(`Extracting audio segment: ${commandLine}`);
        })
        .on('end', () => {
          this.logger.debug(`Audio segment extracted: ${outputPath}`);
          resolve();
        })
        .on('error', (error) => {
          this.logger.error(`Failed to extract audio segment: ${error.message}`);
          reject(error);
        })
        .run();
    });
  }

  /**
   * Concatenate multiple video clips into one
   */
  private async concatenateClips(
    clipPaths: string[],
    outputPath: string,
  ): Promise<void> {
    if (clipPaths.length === 0) {
      throw new BadRequestException('No clips to concatenate');
    }

    if (clipPaths.length === 1) {
      // If only one clip, just copy it
      fs.copyFileSync(clipPaths[0], outputPath);
      return;
    }

    // Create concat file list for FFmpeg
    const concatFilePath = path.join(
      this.tempDir,
      `concat_${Date.now()}.txt`,
    );

    try {
      const concatContent = clipPaths
        .map((clipPath) => `file '${path.resolve(clipPath)}'`)
        .join('\n');
      fs.writeFileSync(concatFilePath, concatContent);

      return new Promise((resolve, reject) => {
        ffmpeg()
          .input(concatFilePath)
          .inputOptions(['-f', 'concat', '-safe', '0'])
          .outputOptions(['-c', 'copy']) // Copy codec (faster, no re-encoding)
          .output(outputPath)
          .on('start', (commandLine) => {
            this.logger.debug(`Concat command: ${commandLine}`);
          })
          .on('end', () => {
            this.logger.log(`Successfully concatenated ${clipPaths.length} clips`);
            resolve();
          })
          .on('error', (error) => {
            this.logger.error(`Concat error: ${error.message}`);
            reject(error);
          })
          .run();
      });
    } finally {
      // Cleanup concat file
      if (fs.existsSync(concatFilePath)) {
        fs.unlinkSync(concatFilePath);
      }
    }
  }

  /**
   * Get duration of audio file in seconds
   */
  async getAudioDuration(audioPath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(audioPath, (err, metadata) => {
        if (err) {
          reject(err);
          return;
        }
        const duration = metadata.format.duration || 0;
        resolve(duration);
      });
    });
  }

  /**
   * Get duration of video file in seconds
   */
  async getVideoDuration(videoPath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) {
          reject(err);
          return;
        }
        const duration = metadata.format.duration || 0;
        resolve(duration);
      });
    });
  }
}

