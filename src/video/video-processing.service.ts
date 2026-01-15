import { Injectable, Logger, BadRequestException, Inject, forwardRef } from '@nestjs/common';
import * as ffmpeg from 'fluent-ffmpeg';
import * as fs from 'fs';
import { promises as fsPromises } from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { exec } from 'child_process';
import axios from 'axios';
import { SectionMediaDto, MediaType } from './dto/combine-media.dto';
import { TranscriptionService } from '../transcription/transcription.service';

const execAsync = promisify(exec);

@Injectable()
export class VideoProcessingService {
  private readonly logger = new Logger(VideoProcessingService.name);
  private readonly tempDir = './temp';
  private downloadedFiles: string[] = []; // Track downloaded files for cleanup
  private readonly TEMP_FILE_RETENTION_MINUTES = 60; // Keep temp files for 1 hour for debugging, then delete
  
  // Cache for video durations to avoid redundant FFprobe calls
  // Key: video file path, Value: { duration: number, timestamp: number }
  private videoDurationCache = new Map<string, { duration: number; timestamp: number }>();
  private readonly DURATION_CACHE_TTL_MS = 5 * 60 * 1000; // Cache duration for 5 minutes
  
  // LRU Cache for file path resolution (URL downloads) to avoid redundant downloads
  // Key: URL, Value: { filePath: string, timestamp: number }
  private pathResolutionCache = new Map<string, { filePath: string; timestamp: number }>();
  private readonly PATH_CACHE_TTL_MS = 10 * 60 * 1000; // Cache path resolution for 10 minutes
  private readonly PATH_CACHE_MAX_SIZE = 100; // Maximum number of cached paths

  constructor(
    @Inject(forwardRef(() => TranscriptionService))
    private transcriptionService: TranscriptionService,
  ) {
    // Ensure temp directory exists (async initialization will be handled on first use)
    this.ensureTempDir().catch(err => {
      this.logger.error(`Failed to create temp directory: ${err.message}`);
    });
  }

  /**
   * Async helper: Ensure temp directory exists
   */
  private async ensureTempDir(): Promise<void> {
    try {
      await fsPromises.access(this.tempDir);
    } catch {
      await fsPromises.mkdir(this.tempDir, { recursive: true });
    }
  }

  /**
   * Async helper: Check if file exists
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fsPromises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Async helper: Ensure directory exists
   */
  private async ensureDir(dirPath: string): Promise<void> {
    try {
      await fsPromises.access(dirPath);
    } catch {
      await fsPromises.mkdir(dirPath, { recursive: true });
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
   * Download file from URL and return local file path
   */
  private async downloadFile(url: string, outputFileName?: string): Promise<string> {
    this.logger.log(`Downloading file from URL: ${url}`);
    
    try {
      const response = await axios({
        method: 'GET',
        url: url,
        responseType: 'stream',
        timeout: 1200000, // 20 minutes timeout
      });

      // Determine file extension from URL or Content-Type
      let extension = path.extname(new URL(url).pathname);
      if (!extension || extension === '') {
        const contentType = response.headers['content-type'];
        if (contentType?.includes('audio')) {
          extension = '.mp3';
        } else if (contentType?.includes('image/png')) {
          extension = '.png';
        } else if (contentType?.includes('image/jpeg') || contentType?.includes('image/jpg')) {
          extension = '.jpg';
        } else if (contentType?.includes('video')) {
          extension = '.mp4';
        } else {
          extension = '.tmp';
        }
      }

      const fileName = outputFileName || `downloaded_${Date.now()}_${Math.round(Math.random() * 1e9)}${extension}`;
      const filePath = path.join(this.tempDir, fileName);

      const writer = fs.createWriteStream(filePath);
      response.data.pipe(writer);

      return new Promise((resolve, reject) => {
        writer.on('finish', () => {
          this.logger.log(`File downloaded successfully: ${filePath}`);
          this.downloadedFiles.push(filePath);
          resolve(filePath);
        });
        writer.on('error', (error) => {
          this.logger.error(`Error downloading file: ${error.message}`);
          reject(error);
        });
      });
    } catch (error: any) {
      this.logger.error(`Failed to download file from ${url}: ${error.message}`);
      throw new BadRequestException(`Failed to download file from URL: ${error.message}`);
    }
  }

  /**
   * Resolve path or URL to local file path with LRU caching
   * URLs are cached to avoid redundant downloads
   */
  private async resolveFilePath(inputPath: string): Promise<string> {
    // For URLs, check cache first
    if (this.isUrl(inputPath)) {
      const cached = this.pathResolutionCache.get(inputPath);
      const now = Date.now();
      
      if (cached && (now - cached.timestamp) < this.PATH_CACHE_TTL_MS) {
        // Check if cached file still exists
        const exists = await this.fileExists(cached.filePath);
        if (exists) {
          this.logger.debug(`[resolveFilePath] Cache hit for URL: ${inputPath} -> ${cached.filePath}`);
          return cached.filePath;
        } else {
          // Cached file doesn't exist, remove from cache
          this.pathResolutionCache.delete(inputPath);
        }
      }
      
      // Cache miss or expired - download file
      this.logger.debug(`[resolveFilePath] Cache miss, downloading URL: ${inputPath}`);
      const filePath = await this.downloadFile(inputPath);
      
      // Store in cache (with LRU eviction if needed)
      if (this.pathResolutionCache.size >= this.PATH_CACHE_MAX_SIZE) {
        // Remove oldest entry (first in Map)
        const firstKey = this.pathResolutionCache.keys().next().value;
        this.pathResolutionCache.delete(firstKey);
        this.logger.debug(`[resolveFilePath] LRU cache eviction: removed ${firstKey}`);
      }
      
      this.pathResolutionCache.set(inputPath, { filePath, timestamp: now });
      return filePath;
    }
    
    // For local paths, just check if file exists
    const exists = await this.fileExists(inputPath);
    if (!exists) {
      throw new BadRequestException(`File not found: ${inputPath}`);
    }
    
    return inputPath;
  }

  /**
   * Clear expired entries from path resolution cache
   */
  private clearExpiredPathCache(): void {
    const now = Date.now();
    let clearedCount = 0;
    
    for (const [key, value] of this.pathResolutionCache.entries()) {
      if (now - value.timestamp >= this.PATH_CACHE_TTL_MS) {
        this.pathResolutionCache.delete(key);
        clearedCount++;
      }
    }
    
    if (clearedCount > 0) {
      this.logger.debug(`Cleared ${clearedCount} expired entries from path resolution cache`);
    }
  }

  /**
   * Clear all entries from path resolution cache
   */
  private clearPathCache(): void {
    const size = this.pathResolutionCache.size;
    this.pathResolutionCache.clear();
    if (size > 0) {
      this.logger.debug(`Cleared all ${size} entries from path resolution cache`);
    }
  }

  /**
   * Combine multiple sections (media + audio segments from combined audio) into a single output video
   * Now uses full audio track instead of cutting it
   */
  async combineMedia(
    audioPath: string,
    sections: SectionMediaDto[],
    outputFormat: string = 'mp4',
    width: number = 1920,
    height: number = 1080,
    useSubtitle: boolean = false,
    useSocialMediaSubtitle: boolean = false,
    requestId?: string,
  ): Promise<string> {
    const logPrefix = requestId ? `[${requestId}]` : '';
    // Ensure tempDir is absolute
    const absoluteTempDir = path.resolve(this.tempDir);
    await this.ensureDir(absoluteTempDir);
    const outputPath = path.join(
      absoluteTempDir,
      `combined_${Date.now()}.${outputFormat}`,
    );

    this.logger.log(`${logPrefix} [VideoProcessingService] Starting combineMedia`);
    this.logger.log(`${logPrefix} [VideoProcessingService] Output path: ${outputPath}`);
    this.logger.log(`${logPrefix} [VideoProcessingService] Parameters: outputFormat=${outputFormat}, width=${width}, height=${height}, useSubtitle=${useSubtitle}, useSocialMediaSubtitle=${useSocialMediaSubtitle}`);

    // Reset downloaded files tracker
    this.downloadedFiles = [];

    try {
      // Resolve audio path (download if URL) - only if provided
      let resolvedAudioPath: string | null = null;
      let fullAudioDuration = 0;
      
      if (audioPath) {
        this.logger.log(`${logPrefix} [VideoProcessingService] Resolving combined audio path: ${audioPath}`);
        resolvedAudioPath = await this.resolveFilePath(audioPath);
        this.logger.log(`${logPrefix} [VideoProcessingService] Using combined audio file: ${resolvedAudioPath}`);
        
        // Get full audio duration
        fullAudioDuration = await this.getAudioDuration(resolvedAudioPath);
        this.logger.log(`${logPrefix} [VideoProcessingService] Full audio duration: ${fullAudioDuration}s`);
      } else {
        this.logger.log(`${logPrefix} [VideoProcessingService] No combined audio provided - using per-section audio only`);
      }

      // Process each section and burn subtitles per-section
      const processedClipPaths: string[] = [];

      this.logger.log(`${logPrefix} [VideoProcessingService] Starting to process ${sections.length} sections`);

      for (let i = 0; i < sections.length; i++) {
        const section = sections[i];
        this.logger.log(`${logPrefix} [VideoProcessingService] ===== Processing section ${i + 1}/${sections.length} =====`);
        this.logger.log(`${logPrefix} [VideoProcessingService] Section ${i + 1} details: mediaPath=${section.mediaPath}, mediaType=${section.mediaType}, hasTranscript=${!!section.transcript}, transcriptLength=${section.transcript?.length || 0}`);

        // Determine audio source and duration for this section
        let sectionAudioPath: string;
        let sectionDuration: number;
        
        if (section.audioPath) {
          // Use section-specific audio - get duration from audio file
          sectionAudioPath = await this.resolveFilePath(section.audioPath);
          sectionDuration = await this.getAudioDuration(sectionAudioPath);
          this.logger.log(`Using section-specific audio: ${sectionAudioPath} (duration: ${sectionDuration}s)`);
        } else if (resolvedAudioPath) {
          // Extract audio segment from combined audio - use startTime/endTime
          if (section.startTime === undefined || section.endTime === undefined) {
            throw new BadRequestException(
              `Section ${i + 1}: startTime and endTime are required when audioPath is not provided`,
            );
          }
          sectionDuration = section.endTime - section.startTime;
          const extractedAudioPath = path.join(
            this.tempDir,
            `audio_segment_${i}_${Date.now()}.mp3`,
          );
          await this.extractAudioSegment(
            resolvedAudioPath,
            section.startTime,
            sectionDuration,
            extractedAudioPath,
          );
          sectionAudioPath = extractedAudioPath;
          this.logger.log(`Extracted audio segment: ${sectionAudioPath} (${section.startTime}s - ${section.endTime}s)`);
        } else {
          throw new BadRequestException(
            `Section ${i + 1} has no audioPath and no combined audio is provided`,
          );
        }

        // Process section (create video clip) - use calculated duration
        const videoClipPath = await this.processSection(
          section,
          i,
          width,
          height,
          sectionDuration,
        );

        // Add audio to video clip
        const videoWithAudioPath = path.join(
          this.tempDir,
          `section_${i}_with_audio_${Date.now()}.${outputFormat}`,
        );
        await this.addAudioToVideo(
          videoClipPath,
          sectionAudioPath,
          videoWithAudioPath,
          sectionDuration,
        );

        // Cleanup video clip without audio
        const clipExists = await this.fileExists(videoClipPath);
        if (clipExists) {
          await fsPromises.unlink(videoClipPath);
        }

        // Store section video WITHOUT subtitles (subtitles will be added after concatenation)
        this.logger.log(`${logPrefix} [VideoProcessingService] ✅ Section ${i + 1} completed (video with audio, no subtitles yet)`);
        processedClipPaths.push(videoWithAudioPath);

        // Cleanup extracted audio segment if it was created
        if (!section.audioPath) {
          const audioExists = await this.fileExists(sectionAudioPath);
          if (audioExists) {
            setTimeout(async () => {
              const stillExists = await this.fileExists(sectionAudioPath);
              if (stillExists) {
                await fsPromises.unlink(sectionAudioPath);
              }
            }, 5000);
          }
        }
      }

      // Step 2: Concatenate all section videos (without subtitles)
      this.logger.log(`${logPrefix} [VideoProcessingService] ===== STEP 2: CONCATENATING ${processedClipPaths.length} SECTION VIDEOS =====`);
      const combinedVideoPath = path.join(
        this.tempDir,
        `combined_no_subtitles_${Date.now()}.${outputFormat}`,
      );
      await this.concatenateClips(processedClipPaths, combinedVideoPath);
      this.logger.log(`${logPrefix} [VideoProcessingService] ✅ Combined video created: ${combinedVideoPath}`);
      this.logger.log(`${logPrefix} [VideoProcessingService] 💾 Combined video without subtitles saved for debugging: ${combinedVideoPath}`);

      // Cleanup processed section videos
      for (const clipPath of processedClipPaths) {
        const exists = await this.fileExists(clipPath);
        if (exists) {
          setTimeout(async () => {
            const stillExists = await this.fileExists(clipPath);
            if (stillExists) {
              await fsPromises.unlink(clipPath);
            }
          }, 5000);
        }
      }

      // Step 3: Extract audio from combined video and transcribe
      let finalOutputPath = combinedVideoPath;
      const shouldUseWhisper = useSubtitle || useSocialMediaSubtitle;
      
      if (shouldUseWhisper) {
        this.logger.log(`${logPrefix} [VideoProcessingService] ===== STEP 3: TRANSCRIBING COMBINED VIDEO AUDIO =====`);
        this.logger.log(`${logPrefix} [VideoProcessingService] Subtitle settings: useSubtitle=${useSubtitle}, useSocialMediaSubtitle=${useSocialMediaSubtitle}`);
        
        try {
          // Extract audio from combined video
          const extractedAudioPath = path.join(
            this.tempDir,
            `combined_audio_${Date.now()}.mp3`,
          );
          this.logger.log(`${logPrefix} [VideoProcessingService] Extracting audio from combined video...`);
          
          // Get video duration before extraction for verification
          const videoDuration = await this.getVideoDuration(combinedVideoPath);
          this.logger.log(`${logPrefix} [VideoProcessingService] Combined video duration: ${videoDuration}s`);
          
          await this.extractAudioFromVideo(combinedVideoPath, extractedAudioPath);
          this.logger.log(`${logPrefix} [VideoProcessingService] ✅ Audio extracted: ${extractedAudioPath}`);
          
          // Verify extracted audio duration matches video
          const extractedAudioDuration = await this.getAudioDuration(extractedAudioPath);
          this.logger.log(`${logPrefix} [VideoProcessingService] Extracted audio duration: ${extractedAudioDuration}s`);
          const durationDiff = Math.abs(videoDuration - extractedAudioDuration);
          if (durationDiff > 0.1) {
            this.logger.warn(`${logPrefix} [VideoProcessingService] ⚠️ Duration mismatch: video=${videoDuration}s, audio=${extractedAudioDuration}s, diff=${durationDiff}s`);
          } else {
            this.logger.log(`${logPrefix} [VideoProcessingService] ✅ Video and audio durations match (diff: ${durationDiff}s)`);
          }

          // Transcribe combined audio
          const isSocialMediaMode = useSocialMediaSubtitle;
          this.logger.log(`${logPrefix} [VideoProcessingService] 🎤 Transcribing combined audio using Whisper (social media mode: ${isSocialMediaMode})...`);
          
          // For social media subtitles: use verbose_json to get word-level timestamps
          // For regular subtitles: use 'srt' format directly (segment-level timestamps, regular Whisper behavior)
          const responseFormat = isSocialMediaMode ? 'verbose_json' : 'srt';
          this.logger.log(`${logPrefix} [VideoProcessingService] Using response format: ${responseFormat} (${isSocialMediaMode ? 'whisper-timestamped with word-level timestamps' : 'regular Whisper with segment-level timestamps'})`);
          
          const transcriptionResult = await this.transcriptionService.transcribe(
            extractedAudioPath,
            undefined, // Auto-detect language
            responseFormat,
          );
          
          // Log Whisper result structure
          this.logger.log(`${logPrefix} [VideoProcessingService] ===== WHISPER RESULT DEBUG =====`);
          this.logger.log(`${logPrefix} [VideoProcessingService] Transcription result type: ${typeof transcriptionResult}`);
          this.logger.log(`${logPrefix} [VideoProcessingService] Transcription result is array: ${Array.isArray(transcriptionResult)}`);
          
          if (transcriptionResult && typeof transcriptionResult === 'object') {
            this.logger.log(`${logPrefix} [VideoProcessingService] Transcription result keys: ${Object.keys(transcriptionResult).join(', ')}`);
            this.logger.log(`${logPrefix} [VideoProcessingService] Has 'segments' property: ${'segments' in transcriptionResult}`);
            this.logger.log(`${logPrefix} [VideoProcessingService] Has 'text' property: ${'text' in transcriptionResult}`);
            
            if ('segments' in transcriptionResult) {
              const segments = transcriptionResult.segments;
              this.logger.log(`${logPrefix} [VideoProcessingService] Segments type: ${typeof segments}, is array: ${Array.isArray(segments)}, length: ${segments?.length || 0}`);
              
              if (Array.isArray(segments) && segments.length > 0) {
                this.logger.log(`${logPrefix} [VideoProcessingService] First segment structure: ${JSON.stringify(segments[0], null, 2)}`);
                this.logger.log(`${logPrefix} [VideoProcessingService] First segment keys: ${Object.keys(segments[0]).join(', ')}`);
                
                // Log a few segments for debugging
                const segmentsToLog = Math.min(3, segments.length);
                for (let i = 0; i < segmentsToLog; i++) {
                  const seg = segments[i];
                  this.logger.log(`${logPrefix} [VideoProcessingService] Segment ${i + 1}: start=${seg.start}, end=${seg.end}, text="${seg.text}", words=${seg.words?.length || 0}`);
                }
              }
            }
            
            if ('text' in transcriptionResult) {
              this.logger.log(`${logPrefix} [VideoProcessingService] Full text length: ${transcriptionResult.text?.length || 0} characters`);
              this.logger.log(`${logPrefix} [VideoProcessingService] Full text preview: ${transcriptionResult.text?.substring(0, 200) || 'N/A'}`);
            }
            
            // Log full result (truncated if too long)
            const resultStr = JSON.stringify(transcriptionResult, null, 2);
            if (resultStr.length > 2000) {
              this.logger.log(`${logPrefix} [VideoProcessingService] Full result (first 2000 chars): ${resultStr.substring(0, 2000)}...`);
            } else {
              this.logger.log(`${logPrefix} [VideoProcessingService] Full result: ${resultStr}`);
            }
          } else {
            this.logger.log(`${logPrefix} [VideoProcessingService] Transcription result (raw): ${transcriptionResult}`);
          }
          
          this.logger.log(`${logPrefix} [VideoProcessingService] ===== END WHISPER RESULT DEBUG =====`);
          
          // Save Whisper JSON result to temp for debugging
          const whisperJsonPath = path.join(
            this.tempDir,
            `whisper_result_${Date.now()}.json`,
          );
          await fsPromises.writeFile(whisperJsonPath, JSON.stringify(transcriptionResult, null, 2), 'utf8');
          this.logger.log(`${logPrefix} [VideoProcessingService] 💾 Saved Whisper JSON result to: ${whisperJsonPath}`);
          
          // Keep extracted audio for debugging (don't delete immediately)
          this.logger.log(`${logPrefix} [VideoProcessingService] 💾 Extracted audio saved for debugging: ${extractedAudioPath}`);

          // Step 4: Generate subtitle file
          this.logger.log(`${logPrefix} [VideoProcessingService] ===== STEP 4: GENERATING SUBTITLE FILE =====`);
          let subtitleFilePath: string;
          
          if (isSocialMediaMode) {
            // Generate ASS format subtitles with word highlighting (requires verbose_json with word-level timestamps)
            this.logger.log(`${logPrefix} [VideoProcessingService] Generating social media-style ASS subtitles...`);
            this.logger.log(`${logPrefix} [VideoProcessingService] Transcription result type: ${typeof transcriptionResult}`);
            this.logger.log(`${logPrefix} [VideoProcessingService] Transcription result has segments: ${!!transcriptionResult.segments}`);
            this.logger.log(`${logPrefix} [VideoProcessingService] Transcription result segments count: ${transcriptionResult.segments?.length || 0}`);
            
            // Combine all provided transcripts if available
            const combinedTranscript = sections
              .map(s => s.transcript)
              .filter(t => t && t.length > 0)
              .join(' ');
            
            subtitleFilePath = await this.generateSocialMediaSubtitles(
              transcriptionResult,
              combinedTranscript || undefined,
              0, // Use 0 for combined video
            );
            this.logger.log(`${logPrefix} [VideoProcessingService] ✅ ASS file generated: ${subtitleFilePath}`);
            this.logger.log(`${logPrefix} [VideoProcessingService] 💾 ASS file saved for debugging: ${subtitleFilePath}`);
          } else {
            // Regular SRT subtitles - use SRT format directly from Whisper (segment-level timestamps, regular Whisper behavior)
            if (!transcriptionResult) {
              this.logger.error(`${logPrefix} [VideoProcessingService] ❌ Whisper returned null/undefined`);
              throw new Error('Whisper transcription failed: No result returned');
            }
            
            this.logger.log(`${logPrefix} [VideoProcessingService] ===== PROCESSING REGULAR SRT FROM WHISPER =====`);
            this.logger.log(`${logPrefix} [VideoProcessingService] Transcription result type: ${typeof transcriptionResult}`);
            this.logger.log(`${logPrefix} [VideoProcessingService] Transcription result keys: ${Object.keys(transcriptionResult).join(', ')}`);
            
            // When response_format is 'srt', whisper-worker returns: { text: srtContent, format: "srt" }
            let srtContent: string;
            if (transcriptionResult.format === 'srt' && transcriptionResult.text) {
              // Direct SRT content from whisper-worker
              srtContent = transcriptionResult.text;
              this.logger.log(`${logPrefix} [VideoProcessingService] ✅ Using SRT content directly from Whisper (${srtContent.length} characters)`);
              this.logger.log(`${logPrefix} [VideoProcessingService] SRT content preview (first 500 chars):\n${srtContent.substring(0, 500)}`);
            } else if (typeof transcriptionResult === 'string') {
              // Fallback: result is a string (SRT content)
              srtContent = transcriptionResult;
              this.logger.log(`${logPrefix} [VideoProcessingService] ✅ Using SRT content as string (${srtContent.length} characters)`);
            } else {
              this.logger.error(`${logPrefix} [VideoProcessingService] ❌ Unexpected SRT format from Whisper`);
              throw new Error('Whisper returned unexpected format for SRT subtitles');
            }
            
            // Save SRT file
            subtitleFilePath = path.join(
              this.tempDir,
              `combined_subtitles_${Date.now()}.srt`,
            );
            
            // Write SRT with UTF-8 BOM for better compatibility
            const BOM = '\uFEFF';
            await fsPromises.writeFile(subtitleFilePath, BOM + srtContent, 'utf8');
            const srtStats = await fsPromises.stat(subtitleFilePath);
            this.logger.log(`${logPrefix} [VideoProcessingService] ✅ SRT file saved: ${subtitleFilePath} (${srtStats.size} bytes)`);
            this.logger.log(`${logPrefix} [VideoProcessingService] 💾 SRT file saved for debugging: ${subtitleFilePath}`);
          }

          // Step 5: Burn subtitles to combined video
          this.logger.log(`${logPrefix} [VideoProcessingService] ===== STEP 5: BURNING SUBTITLES TO COMBINED VIDEO =====`);
          
          // Verify video duration before burning
          const finalVideoDuration = await this.getVideoDuration(combinedVideoPath);
          this.logger.log(`${logPrefix} [VideoProcessingService] Combined video duration before burning: ${finalVideoDuration}s`);
          
          finalOutputPath = outputPath;
          await this.addSubtitlesToVideo(
            combinedVideoPath,
            subtitleFilePath,
            finalOutputPath,
            width,
            height,
            32,
            isSocialMediaMode, // Social media style if enabled
          );
          
          // Verify final video duration
          const burnedVideoDuration = await this.getVideoDuration(finalOutputPath);
          this.logger.log(`${logPrefix} [VideoProcessingService] Final video duration after burning: ${burnedVideoDuration}s`);
          if (Math.abs(finalVideoDuration - burnedVideoDuration) > 0.1) {
            this.logger.warn(`${logPrefix} [VideoProcessingService] ⚠️ Duration changed after burning: before=${finalVideoDuration}s, after=${burnedVideoDuration}s`);
          }
          
          this.logger.log(`${logPrefix} [VideoProcessingService] ✅ Subtitles burned successfully to final video`);
          
          // Keep subtitle files for debugging (don't delete them)
          this.scheduleFileCleanup(subtitleFilePath);
          this.logger.debug(`${logPrefix} [VideoProcessingService] Scheduled cleanup for subtitle file: ${subtitleFilePath} (${this.TEMP_FILE_RETENTION_MINUTES} minutes)`);
          
          // Keep combined video without subtitles for debugging
          const combinedExists = await this.fileExists(combinedVideoPath);
          if (combinedExists && combinedVideoPath !== finalOutputPath) {
            this.scheduleFileCleanup(combinedVideoPath);
            this.logger.debug(`${logPrefix} [VideoProcessingService] Scheduled cleanup for combined video: ${combinedVideoPath} (${this.TEMP_FILE_RETENTION_MINUTES} minutes)`);
            // Don't delete combinedVideoPath - keep it for debugging
          }
        } catch (error: any) {
          this.logger.error(`${logPrefix} [VideoProcessingService] ❌ Failed to transcribe/burn subtitles: ${error.message}`);
          this.logger.error(`${logPrefix} [VideoProcessingService] Continuing without subtitles...`);
          // Use combined video without subtitles as fallback
          if (combinedVideoPath !== outputPath) {
            await fsPromises.copyFile(combinedVideoPath, outputPath);
            finalOutputPath = outputPath;
          }
        }
      } else {
        // No subtitles requested, just use the combined video
        if (combinedVideoPath !== outputPath) {
          await fsPromises.copyFile(combinedVideoPath, outputPath);
          finalOutputPath = outputPath;
        }
      }

      // Cleanup downloaded files after a delay (to allow file streaming)
      setTimeout(async () => {
        await this.cleanupDownloadedFiles();
      }, 10000); // 10 seconds delay

      this.logger.log(`${logPrefix} [VideoProcessingService] ✅ Successfully created combined video: ${finalOutputPath}`);
      const finalStats = await fsPromises.stat(finalOutputPath);
      this.logger.log(`${logPrefix} [VideoProcessingService] Final video size: ${finalStats.size} bytes`);
      return finalOutputPath;
    } catch (error: any) {
      // Cleanup downloaded files on error
      this.cleanupDownloadedFiles();
      this.logger.error(`${logPrefix} [VideoProcessingService] ❌ Failed to combine media: ${error.message}`, error.stack);
      throw new BadRequestException(`Failed to combine media: ${error.message}`);
    }
  }

  /**
   * Combine media with per-section subtitle burning
   * Flow: For each section -> combine audio+media -> burn transcript -> then concatenate all
   */
  async combineMediaWithPerSectionSubtitles(
    audioPath: string | undefined,
    sections: SectionMediaDto[],
    outputFormat: string = 'mp4',
    width: number = 1920,
    height: number = 1080,
    useSubtitle: boolean = false,
  ): Promise<string> {
    const outputPath = path.join(
      this.tempDir,
      `combined_${Date.now()}.${outputFormat}`,
    );

    // Reset downloaded files tracker
    this.downloadedFiles = [];

    try {
      // Resolve audio path (download if URL) - only if provided
      let resolvedAudioPath: string | null = null;
      
      if (audioPath) {
        resolvedAudioPath = await this.resolveFilePath(audioPath);
        this.logger.log(`[combine-mediaa] Using combined audio file: ${resolvedAudioPath}`);
      } else {
        this.logger.log('[combine-mediaa] No combined audio provided - using per-section audio only');
      }

      // Step 1-3: Process each section individually with subtitle burning
      const processedSectionPaths: string[] = [];

      for (let i = 0; i < sections.length; i++) {
        const section = sections[i];
        this.logger.log(`[combine-mediaa] Processing section ${i + 1}/${sections.length}`);

        // 1. Determine audio source and duration for this section
        let sectionAudioPath: string;
        let sectionDuration: number;
        
        if (section.audioPath) {
          // Use section-specific audio - get duration from audio file
          sectionAudioPath = await this.resolveFilePath(section.audioPath);
          sectionDuration = await this.getAudioDuration(sectionAudioPath);
          this.logger.log(`[combine-mediaa] Section ${i + 1} audio: ${sectionAudioPath} (duration: ${sectionDuration}s)`);
        } else if (resolvedAudioPath) {
          // Extract audio segment from combined audio
          if (section.startTime === undefined || section.endTime === undefined) {
            throw new BadRequestException(
              `Section ${i + 1}: startTime and endTime are required when audioPath is not provided`,
            );
          }
          sectionDuration = section.endTime - section.startTime;
          const extractedAudioPath = path.join(
            this.tempDir,
            `audio_segment_${i}_${Date.now()}.mp3`,
          );
          await this.extractAudioSegment(
            resolvedAudioPath,
            section.startTime,
            sectionDuration,
            extractedAudioPath,
          );
          sectionAudioPath = extractedAudioPath;
          this.logger.log(`[combine-mediaa] Section ${i + 1} extracted audio: ${sectionAudioPath} (${section.startTime}s - ${section.endTime}s)`);
        } else {
          throw new BadRequestException(
            `Section ${i + 1} has no audioPath and no combined audio is provided`,
          );
        }

        // 2. Process section (create video clip from image/video)
        const videoClipPath = await this.processSection(
          section,
          i,
          width,
          height,
          sectionDuration,
        );

        // 3. Add audio to video clip
        const videoWithAudioPath = path.join(
          this.tempDir,
          `section_${i}_with_audio_${Date.now()}.${outputFormat}`,
        );
        await this.addAudioToVideo(
          videoClipPath,
          sectionAudioPath,
          videoWithAudioPath,
          sectionDuration,
        );

        // Cleanup video clip without audio
        const clipExists = await this.fileExists(videoClipPath);
        if (clipExists) {
          await fsPromises.unlink(videoClipPath);
        }

        // 4. Burn subtitles into this section video using Whisper transcription
        let finalSectionPath = videoWithAudioPath;
        // Always use Whisper transcription when transcript is provided OR useSubtitle is true
        const shouldAddSubtitles = section.transcript || useSubtitle;
        if (shouldAddSubtitles) {
          try {
            this.logger.log(`[combine-mediaa] 🎤 Transcribing audio for section ${i + 1} using Whisper for proper timing...`);
            
            // Use Whisper to transcribe audio and get properly timed subtitles
            const transcriptionResult = await this.transcriptionService.transcribe(
              sectionAudioPath,
              undefined, // Auto-detect language
              'srt', // Get SRT format with timestamps
            );
            
            const srtContent = typeof transcriptionResult === 'string' 
              ? transcriptionResult 
              : (transcriptionResult.text || transcriptionResult);
            
            this.logger.log(`[combine-mediaa] ✅ Whisper transcription completed for section ${i + 1}: ${srtContent.length} characters`);
            
            // Save SRT file
            const srtFilePath = path.join(
              this.tempDir,
              `whisper_section_${i}_${Date.now()}.srt`,
            );
            
            // Write SRT with UTF-8 BOM for better compatibility
            const BOM = '\uFEFF';
            await fsPromises.writeFile(srtFilePath, BOM + srtContent, 'utf8');
            this.logger.log(`[combine-mediaa] SRT file saved: ${srtFilePath}`);
            
            // Verify SRT has content
            const segments = this.parseSrtToSegments(srtContent);
            if (segments.length === 0) {
              this.logger.warn(`[combine-mediaa] ⚠️ Whisper returned no subtitle segments, using transcript as fallback`);
              
              // Fallback: Use provided transcript if Whisper returns empty
              if (section.transcript) {
                const fallbackSrtPath = await this.generateSrtFromTranscript(
                  section.transcript,
                  0,
                  sectionDuration,
                  i,
                );
                
                const sectionWithSubtitlesPath = path.join(
                  this.tempDir,
                  `section_${i}_final_${Date.now()}.${outputFormat}`,
                );
                
                await this.addSubtitlesToVideo(
                  videoWithAudioPath,
                  fallbackSrtPath,
                  sectionWithSubtitlesPath,
                  width,
                  height,
                  undefined,
                  false, // Not social media style
                );
                
                finalSectionPath = sectionWithSubtitlesPath;
                
                // Cleanup
                const fallbackExists = await this.fileExists(fallbackSrtPath);
                if (fallbackExists) {
                  await fsPromises.unlink(fallbackSrtPath);
                }
                const videoExists = await this.fileExists(videoWithAudioPath);
                if (videoExists && videoWithAudioPath !== finalSectionPath) {
                  await fsPromises.unlink(videoWithAudioPath);
                }
              } else {
                this.logger.warn(`[combine-mediaa] ⚠️ No subtitles for section ${i + 1} (Whisper returned empty and no transcript provided)`);
              }
            } else {
              this.logger.log(`[combine-mediaa] Using ${segments.length} Whisper-generated subtitle segments with proper timing`);
              
              const sectionWithSubtitlesPath = path.join(
                this.tempDir,
                `section_${i}_final_${Date.now()}.${outputFormat}`,
              );
              
              // Burn subtitles into this section video (SRT timestamps are relative to section start = 0)
              await this.addSubtitlesToVideo(
                videoWithAudioPath,
                srtFilePath,
                sectionWithSubtitlesPath,
                width,
                height,
                32,
                false, // Not social media style
              );
              
              finalSectionPath = sectionWithSubtitlesPath;
              
              // Cleanup
              const srtExists = await this.fileExists(srtFilePath);
              if (srtExists) {
                await fsPromises.unlink(srtFilePath);
              }
              const videoExists = await this.fileExists(videoWithAudioPath);
              if (videoExists && videoWithAudioPath !== finalSectionPath) {
                await fsPromises.unlink(videoWithAudioPath);
              }
              
              this.logger.log(`[combine-mediaa] ✅ Section ${i + 1} completed with Whisper-timed subtitles`);
            }
          } catch (error: any) {
            this.logger.error(`[combine-mediaa] ❌ Failed to transcribe/burn subtitles for section ${i + 1}: ${error.message}`);
            
            // Fallback: If Whisper fails and transcript is provided, use it
            if (section.transcript) {
              this.logger.warn(`[combine-mediaa] ⚠️ Using provided transcript as fallback (Whisper failed)`);
              try {
                const fallbackSrtPath = await this.generateSrtFromTranscript(
                  section.transcript,
                  0,
                  sectionDuration,
                  i,
                );
                
                const sectionWithSubtitlesPath = path.join(
                  this.tempDir,
                  `section_${i}_final_${Date.now()}.${outputFormat}`,
                );
                
                await this.addSubtitlesToVideo(
                  videoWithAudioPath,
                  fallbackSrtPath,
                  sectionWithSubtitlesPath,
                  width,
                  height,
                  32,
                  false, // Not social media style
                );
                
                finalSectionPath = sectionWithSubtitlesPath;
                
                // Cleanup
                const fallbackExists = await this.fileExists(fallbackSrtPath);
                if (fallbackExists) {
                  await fsPromises.unlink(fallbackSrtPath);
                }
                const videoExists = await this.fileExists(videoWithAudioPath);
                if (videoExists && videoWithAudioPath !== finalSectionPath) {
                  await fsPromises.unlink(videoWithAudioPath);
                }
              } catch (fallbackError: any) {
                this.logger.error(`[combine-mediaa] ❌ Fallback subtitle burning also failed: ${fallbackError.message}`);
                throw new BadRequestException(`Failed to burn subtitles for section ${i + 1}: ${error.message}`);
              }
            } else {
              throw new BadRequestException(`Failed to burn subtitles for section ${i + 1}: ${error.message}`);
            }
          }
        } else {
          this.logger.log(`[combine-mediaa] Section ${i + 1} has no transcript and useSubtitle=false, skipping subtitle burning`);
        }

        processedSectionPaths.push(finalSectionPath);

        // Cleanup extracted audio segment if it was created
        if (!section.audioPath) {
          const audioExists = await this.fileExists(sectionAudioPath);
          if (audioExists) {
            setTimeout(async () => {
              const stillExists = await this.fileExists(sectionAudioPath);
              if (stillExists) {
                await fsPromises.unlink(sectionAudioPath);
              }
            }, 5000);
          }
        }
      }

      // Step 4: Concatenate all section videos (each already has burned subtitles)
      this.logger.log(`[combine-mediaa] Concatenating ${processedSectionPaths.length} section videos`);
      await this.concatenateClips(processedSectionPaths, outputPath);

      // Cleanup processed section videos
      for (const clipPath of processedSectionPaths) {
        const clipExists = await this.fileExists(clipPath);
        if (clipExists) {
          setTimeout(async () => {
            const stillExists = await this.fileExists(clipPath);
            if (stillExists) {
              await fsPromises.unlink(clipPath);
            }
          }, 5000);
        }
      }

      // Cleanup downloaded files after a delay
      setTimeout(async () => {
        await this.cleanupDownloadedFiles();
      }, 10000);

      this.logger.log(`[combine-mediaa] Successfully created combined video: ${outputPath}`);
      return outputPath;
    } catch (error: any) {
      // Cleanup downloaded files on error
      this.cleanupDownloadedFiles();
      this.logger.error(`[combine-mediaa] Failed to combine media: ${error.message}`, error.stack);
      throw new BadRequestException(`Failed to combine media: ${error.message}`);
    }
  }

  /**
   * Cleanup downloaded temporary files
   */
  private async cleanupDownloadedFiles(): Promise<void> {
    for (const filePath of this.downloadedFiles) {
      try {
        const fileExists = await this.fileExists(filePath);
        if (fileExists) {
          await fsPromises.unlink(filePath);
          this.logger.log(`Cleaned up downloaded file: ${filePath}`);
        }
      } catch (error: any) {
        this.logger.warn(`Failed to cleanup file ${filePath}: ${error.message}`);
      }
    }
    this.downloadedFiles = [];
  }

  /**
   * Schedule cleanup for a temporary file after retention period
   * Files are kept for debugging for a configurable period, then automatically deleted
   */
  private scheduleFileCleanup(filePath: string, retentionMinutes: number = this.TEMP_FILE_RETENTION_MINUTES): void {
    const retentionMs = retentionMinutes * 60 * 1000;
    setTimeout(async () => {
      try {
        const exists = await this.fileExists(filePath);
        if (exists) {
          await fsPromises.unlink(filePath);
          this.logger.debug(`Cleaned up temporary file after ${retentionMinutes} minutes: ${filePath}`);
        }
      } catch (error: any) {
        this.logger.warn(`Failed to cleanup temporary file ${filePath}: ${error.message}`);
      }
    }, retentionMs);
  }

  /**
   * Cleanup old files in temp directory (older than retention period)
   * This can be called periodically to clean up files that weren't scheduled for cleanup
   */
  private async cleanupOldTempFiles(): Promise<void> {
    try {
      const files = await fsPromises.readdir(this.tempDir);
      const now = Date.now();
      const retentionMs = this.TEMP_FILE_RETENTION_MINUTES * 60 * 1000;
      
      let cleanedCount = 0;
      for (const file of files) {
        const filePath = path.join(this.tempDir, file);
        try {
          const stats = await fsPromises.stat(filePath);
          const age = now - stats.mtimeMs;
          
          if (age > retentionMs) {
            await fsPromises.unlink(filePath);
            cleanedCount++;
            this.logger.debug(`Cleaned up old temp file: ${file} (age: ${Math.round(age / 1000 / 60)} minutes)`);
          }
        } catch (error: any) {
          // Skip files that can't be accessed (might be deleted already)
          this.logger.debug(`Skipping file ${file}: ${error.message}`);
        }
      }
      
      if (cleanedCount > 0) {
        this.logger.log(`Cleaned up ${cleanedCount} old temporary files from ${this.tempDir}`);
      }
    } catch (error: any) {
      this.logger.warn(`Failed to cleanup old temp files: ${error.message}`);
    }
  }

  /**
   * Process a single section: create video clip with image/video (without audio)
   * Audio will be added later as a full track
   */
  private async processSection(
    section: SectionMediaDto,
    index: number,
    width: number,
    height: number,
    duration: number,
  ): Promise<string> {
    const sectionDuration = duration;
    const outputPath = path.join(
      this.tempDir,
      `section_${index}_${Date.now()}.mp4`,
    );

    // Resolve media path (download if URL)
    const resolvedMediaPath = await this.resolveFilePath(section.mediaPath);
    this.logger.log(`Using media file: ${resolvedMediaPath}`);

    try {
      // Create video clip without audio (silent video)
      return new Promise((resolve, reject) => {
        let command = ffmpeg();

        if (section.mediaType === MediaType.IMAGE) {
          // For images: create video from image without audio
          command = command
            .input(resolvedMediaPath)
            .inputOptions(['-loop', '1', '-framerate', '30']) // Higher framerate for smoother playback
            .videoCodec('libx264')
            .outputOptions([
              `-t ${sectionDuration}`, // Set duration to match section
              `-vf scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`, // Scale and pad to maintain aspect ratio
              '-an', // No audio
              '-pix_fmt yuv420p', // Ensure compatibility
              '-r', '30', // Output framerate
              '-avoid_negative_ts', 'make_zero', // Ensure timestamps start at 0
              '-fflags', '+genpts', // Generate presentation timestamps
            ]);
        } else {
          // For videos: trim video to match section duration, remove original audio
          command = command
            .input(resolvedMediaPath)
            .inputOptions([
              `-t ${sectionDuration}`, // Trim video input to section duration
              '-accurate_seek', // More accurate seeking
            ])
            .videoCodec('libx264')
            .outputOptions([
              `-vf scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`, // Scale and pad
              '-an', // No audio
              '-pix_fmt yuv420p',
              '-avoid_negative_ts', 'make_zero', // Ensure timestamps start at 0
              '-fflags', '+genpts', // Generate presentation timestamps
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
              `Section ${index} processed: ${outputPath} (${sectionDuration}s)`,
            );
            resolve(outputPath);
          })
          .on('error', (error) => {
            this.logger.error(`FFmpeg error for section ${index}: ${error.message}`);
            reject(error);
          })
          .run();
      });
    } catch (error: any) {
      throw error;
    }
  }

  /**
   * Extend video duration to match audio duration (by looping last frame)
   */
  private async extendVideoDuration(
    videoPath: string,
    outputPath: string,
    targetDuration: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      this.logger.log(`Extending video duration to ${targetDuration}s`);
      
      ffmpeg()
        .input(videoPath)
        .inputOptions(['-stream_loop', '-1']) // Loop video
        .videoCodec('libx264')
        .outputOptions([
          `-t ${targetDuration}`, // Set target duration
          '-pix_fmt yuv420p',
        ])
        .output(outputPath)
        .on('start', (commandLine) => {
          this.logger.debug(`Extending video command: ${commandLine}`);
        })
        .on('end', () => {
          this.logger.log(`Successfully extended video to ${targetDuration}s`);
          resolve();
        })
        .on('error', (error) => {
          this.logger.error(`Failed to extend video: ${error.message}`);
          reject(error);
        })
        .run();
    });
  }

  /**
   * Add full audio track to video
   */
  private async addFullAudioTrack(
    videoPath: string,
    audioPath: string,
    outputPath: string,
    audioDuration: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      this.logger.log(`Adding full audio track (${audioDuration}s) to video, ensuring exact duration match`);
      
      ffmpeg()
        .input(videoPath)
        .input(audioPath)
        .videoCodec('libx264') // Re-encode video to ensure exact duration control
        .audioCodec('aac')
        .outputOptions([
          '-map 0:v:0', // Map video from first input
          '-map 1:a:0', // Map audio from second input
          `-t ${audioDuration}`, // Set exact duration to match audio
          '-pix_fmt yuv420p',
          '-crf 23', // Good quality
          '-preset fast', // Faster encoding for better performance
          '-avoid_negative_ts', 'make_zero', // Ensure timestamps start at 0
          '-fflags', '+genpts', // Generate presentation timestamps
          '-vsync', 'cfr', // Constant frame rate for sync
          '-async', '1', // Audio sync
        ])
        .output(outputPath)
        .on('start', (commandLine) => {
          this.logger.debug(`Adding audio command: ${commandLine}`);
        })
        .on('progress', (progress) => {
          this.logger.debug(`Adding audio: ${JSON.stringify(progress)}`);
        })
        .on('end', async () => {
          this.logger.log(`Successfully added full audio track to video`);
          
          // Verify output duration matches audio duration
          try {
            const outputDuration = await this.getVideoDuration(outputPath);
            const durationDiff = Math.abs(audioDuration - outputDuration);
            if (durationDiff > 0.1) { // More than 100ms difference
              this.logger.warn(`⚠️ Duration mismatch: video=${outputDuration}s, audio=${audioDuration}s, diff=${durationDiff}s`);
            } else {
              this.logger.log(`✅ Duration verified: video=${outputDuration}s, audio=${audioDuration}s, diff=${durationDiff}s`);
            }
          } catch (error: any) {
            this.logger.warn(`Could not verify output duration: ${error.message}`);
          }
          
          resolve();
        })
        .on('error', (error) => {
          this.logger.error(`Failed to add audio track: ${error.message}`);
          reject(error);
        })
        .run();
    });
  }
  
  /**
   * Trim video to exact duration
   */
  private async trimVideoToExactDuration(
    inputPath: string,
    outputPath: string,
    targetDuration: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      this.logger.log(`Trimming video to exact duration: ${targetDuration}s`);
      
      ffmpeg()
        .input(inputPath)
        .videoCodec('libx264')
        .audioCodec('aac')
        .outputOptions([
          `-t ${targetDuration}`, // Set exact duration
          '-pix_fmt yuv420p',
          '-crf 23',
          '-preset fast', // Faster encoding for better performance
          '-avoid_negative_ts', 'make_zero',
          '-fflags', '+genpts',
          '-vsync', 'cfr',
          '-async', '1',
        ])
        .output(outputPath)
        .on('start', (commandLine) => {
          this.logger.debug(`Trim command: ${commandLine}`);
        })
        .on('end', () => {
          this.logger.log(`Successfully trimmed video to ${targetDuration}s`);
          resolve();
        })
        .on('error', (error) => {
          this.logger.error(`Failed to trim video: ${error.message}`);
          reject(error);
        })
        .run();
    });
  }

  /**
   * Add audio to video clip (for individual sections)
   */
  private async addAudioToVideo(
    videoPath: string,
    audioPath: string,
    outputPath: string,
    duration: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      this.logger.log(`[addAudioToVideo] Adding audio to video clip (${duration}s)`);
      
      ffmpeg()
        .input(videoPath)
        .input(audioPath)
        .videoCodec('libx264')
        .audioCodec('aac')
        .outputOptions([
          '-map 0:v:0', // Map video from first input
          '-map 1:a:0', // Map audio from second input
          `-t ${duration}`, // Exact duration
          '-shortest', // Finish when shortest stream ends
          '-pix_fmt yuv420p',
          '-avoid_negative_ts', 'make_zero', // Ensure timestamps start at 0
          '-fflags', '+genpts', // Generate presentation timestamps
          '-vsync', 'cfr', // Constant frame rate for sync
          '-async', '1', // Audio sync
        ])
        .output(outputPath)
        .on('start', (commandLine) => {
          this.logger.debug(`[addAudioToVideo] Command: ${commandLine}`);
        })
        .on('end', () => {
          this.logger.log(`[addAudioToVideo] ✅ Successfully added audio to video clip`);
          resolve();
        })
        .on('error', (error) => {
          this.logger.error(`[addAudioToVideo] ❌ Failed to add audio to clip: ${error.message}`);
          reject(error);
        })
        .run();
    });
  }

  /**
   * Generate SRT file from transcript text for a specific time range
   */
  private async generateSrtFromTranscript(
    transcript: string,
    startTime: number,
    duration: number,
    sectionIndex: number,
  ): Promise<string> {
    const srtFilePath = path.join(
      this.tempDir,
      `transcript_section_${sectionIndex}_${Date.now()}.srt`,
    );

    // Create a simple SRT with the transcript text for the entire duration
    // Format: subtitle number, time range, text
    const endTime = startTime + duration;
    const startTimeStr = this.formatSrtTime(startTime);
    const endTimeStr = this.formatSrtTime(endTime);
    
    const srtContent = `1\n${startTimeStr} --> ${endTimeStr}\n${transcript}\n\n`;
    
    await fsPromises.writeFile(srtFilePath, srtContent);
    this.logger.log(`Generated SRT from transcript for section ${sectionIndex}: ${srtFilePath}`);
    
    return srtFilePath;
  }

  /**
   * Format time in seconds to SRT time format (HH:MM:SS,mmm)
   */
  private formatSrtTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const milliseconds = Math.floor((seconds % 1) * 1000);
    
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(milliseconds).padStart(3, '0')}`;
  }

  /**
   * Adjust SRT timestamps by adding an offset
   */
  private adjustSrtTimestamps(srtContent: string, offsetSeconds: number): string {
    if (offsetSeconds === 0) {
      return srtContent;
    }

    const lines = srtContent.split('\n');
    const adjustedLines: string[] = [];
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // Check if line contains timestamp (format: HH:MM:SS,mmm --> HH:MM:SS,mmm)
      const timestampRegex = /(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/;
      const match = line.match(timestampRegex);
      
      if (match) {
        const startTime = this.parseSrtTime(match[1]);
        const endTime = this.parseSrtTime(match[2]);
        
        const adjustedStartTime = startTime + offsetSeconds;
        const adjustedEndTime = endTime + offsetSeconds;
        
        const adjustedLine = line.replace(
          timestampRegex,
          `${this.formatSrtTime(adjustedStartTime)} --> ${this.formatSrtTime(adjustedEndTime)}`
        );
        adjustedLines.push(adjustedLine);
      } else {
        adjustedLines.push(line);
      }
    }
    
    return adjustedLines.join('\n');
  }

  /**
   * Parse SRT time format (HH:MM:SS,mmm) to seconds
   */
  private parseSrtTime(timeStr: string): number {
    const [timePart, milliseconds] = timeStr.split(',');
    const [hours, minutes, seconds] = timePart.split(':').map(Number);
    
    return hours * 3600 + minutes * 60 + seconds + (Number(milliseconds) / 1000);
  }

  /**
   * Parse SRT content into segments array
   */
  private parseSrtToSegments(srtContent: string): Array<{ startTime: number; endTime: number; text: string }> {
    const segments: Array<{ startTime: number; endTime: number; text: string }> = [];
    const blocks = srtContent.trim().split(/\n\s*\n/);

    for (const block of blocks) {
      const lines = block.trim().split('\n');
      if (lines.length < 3) continue;

      // Parse timestamp line (format: HH:MM:SS,mmm --> HH:MM:SS,mmm)
      const timestampLine = lines[1];
      const match = timestampLine.match(/(\d{2}:\d{2}:\d{2}[,\d]+)\s*-->\s*(\d{2}:\d{2}:\d{2}[,\d]+)/);
      if (!match) continue;

      const startTime = this.parseSrtTime(match[1]);
      const endTime = this.parseSrtTime(match[2]);
      const text = lines.slice(2).join(' ').trim();

      if (text) {
        segments.push({ startTime, endTime, text });
      }
    }

    return segments;
  }

  /**
   * Generate combined SRT file from subtitle segments
   */
  private async generateCombinedSrt(
    segments: Array<{ startTime: number; duration: number; transcript: string }>,
  ): Promise<string> {
    const srtFilePath = path.join(
      this.tempDir,
      `combined_subtitles_${Date.now()}.srt`,
    );

    let srtContent = '';
    let subtitleIndex = 1;

    for (const segment of segments) {
      const startTimeStr = this.formatSrtTime(segment.startTime);
      const endTimeStr = this.formatSrtTime(segment.startTime + segment.duration);
      
      srtContent += `${subtitleIndex}\n`;
      srtContent += `${startTimeStr} --> ${endTimeStr}\n`;
      srtContent += `${segment.transcript}\n\n`;
      
      subtitleIndex++;
    }

    await fsPromises.writeFile(srtFilePath, srtContent);
    this.logger.log(`Generated combined SRT file: ${srtFilePath} with ${segments.length} segments`);
    this.logger.debug(`SRT content preview: ${srtContent.substring(0, 500)}`);
    
    return srtFilePath;
  }

  /**
   * Generate ASS format subtitles with social media style (3-6 words with highlighted current word)
   * Uses Ravid-Clipping approach with createSocialMediaStyleSubtitles
   * @param whisperResult Whisper verbose_json result with word-level timestamps
   * @param providedTranscript Optional transcript text (if provided, used for word matching)
   * @param sectionIndex Section index for file naming
   * @returns Path to generated ASS file
   */
  private async generateSocialMediaSubtitles(
    whisperResult: any,
    providedTranscript: string | undefined,
    sectionIndex: number,
  ): Promise<string> {
    const assFilePath = path.join(
      this.tempDir,
      `social_media_section_${sectionIndex}_${Date.now()}.ass`,
    );

    this.logger.log(`[generateSocialMediaSubtitles] ===== STARTING SOCIAL MEDIA SUBTITLE GENERATION FOR SECTION ${sectionIndex} =====`);
    this.logger.log(`[generateSocialMediaSubtitles] Provided transcript: ${providedTranscript ? `"${providedTranscript.substring(0, 100)}${providedTranscript.length > 100 ? '...' : ''}"` : 'none'}`);
    this.logger.log(`[generateSocialMediaSubtitles] Whisper result has ${whisperResult.segments?.length || 0} segments`);

    // Prepare transcript object with words array (like Ravid-Clipping expects)
    const transcript = {
      segments: whisperResult.segments || [],
      words: this.extractWordsFromWhisperResult(whisperResult),
      text: whisperResult.text || providedTranscript || '',
    };

    this.logger.log(`[generateSocialMediaSubtitles] Extracted ${transcript.words.length} words from Whisper result`);
    this.logger.log(`[generateSocialMediaSubtitles] Transcript text length: ${transcript.text.length} characters`);
    if (transcript.words.length > 0) {
      this.logger.log(`[generateSocialMediaSubtitles] First word: "${transcript.words[0].word}" (${transcript.words[0].start}s - ${transcript.words[0].end}s)`);
      this.logger.log(`[generateSocialMediaSubtitles] Last word: "${transcript.words[transcript.words.length - 1].word}" (${transcript.words[transcript.words.length - 1].start}s - ${transcript.words[transcript.words.length - 1].end}s)`);
    }

    // Use Ravid-Clipping's createSocialMediaStyleSubtitles to process transcript
    this.logger.log(`[generateSocialMediaSubtitles] Calling createSocialMediaStyleSubtitles with maxWordsPerSubtitle=6...`);
    const socialMediaTranscript = this.createSocialMediaStyleSubtitles(transcript, {
      maxWordsPerSubtitle: 6, // 3-6 words per subtitle
      emphasizeKeyWords: true,
      minWordDuration: 0.5,
      maxWordDuration: 2.0,
    });

    this.logger.log(`[generateSocialMediaSubtitles] ✅ Created ${socialMediaTranscript.segments.length} social media subtitle segments`);
    this.logger.log(`[generateSocialMediaSubtitles] Using word timestamps: ${socialMediaTranscript.usingWordTimestamps}`);
    if (socialMediaTranscript.segments.length > 0) {
      this.logger.log(`[generateSocialMediaSubtitles] First segment: "${socialMediaTranscript.segments[0].text}" (${socialMediaTranscript.segments[0].start}s - ${socialMediaTranscript.segments[0].end}s)`);
      this.logger.log(`[generateSocialMediaSubtitles] Last segment: "${socialMediaTranscript.segments[socialMediaTranscript.segments.length - 1].text}" (${socialMediaTranscript.segments[socialMediaTranscript.segments.length - 1].start}s - ${socialMediaTranscript.segments[socialMediaTranscript.segments.length - 1].end}s)`);
    }

    // Generate ASS file using Ravid-Clipping approach
    this.logger.log(`[generateSocialMediaSubtitles] Generating ASS file with karaoke highlighting...`);
    const assOptions = {
      fontsize: 14,
      fontname: 'Arial',
      primaryColour: '#FFFF00', // Yellow for highlight
      secondaryColour: '#FFFFFF', // White for normal
      outlineColour: '#000000',
      backColour: 'rgba(0,0,0,0.7)',
      bold: -1,
      italic: 0,
      borderStyle: 1,
      outline: 1,
      shadow: 0,
      alignment: 2, // Bottom center
      marginL: 10,
      marginR: 10,
      marginV: 60,
    };

    this.logger.log(`[generateSocialMediaSubtitles] ASS options: fontsize=${assOptions.fontsize}, alignment=${assOptions.alignment}, marginV=${assOptions.marginV}`);
    const assContent = this.generateASS(socialMediaTranscript, assOptions);
    this.logger.log(`[generateSocialMediaSubtitles] Generated ASS content: ${assContent.length} characters`);

    // Write ASS file with UTF-8 BOM for better compatibility
    const BOM = '\uFEFF';
    await fsPromises.writeFile(assFilePath, BOM + assContent, 'utf8');
    const fileStats = await fsPromises.stat(assFilePath);
    this.logger.log(`[generateSocialMediaSubtitles] ✅ ASS file created: ${assFilePath} (${fileStats.size} bytes)`);
    this.logger.log(`[generateSocialMediaSubtitles] 💾 ASS file saved for debugging: ${assFilePath}`);
    this.logger.log(`[generateSocialMediaSubtitles] ASS file preview (first 500 chars): ${assContent.substring(0, 500)}`);
    
    // Also save the processed transcript JSON for debugging
    const transcriptJsonPath = path.join(
      path.dirname(assFilePath),
      `social_media_transcript_${sectionIndex}_${Date.now()}.json`,
    );
    await fsPromises.writeFile(transcriptJsonPath, JSON.stringify(socialMediaTranscript, null, 2), 'utf8');
    this.logger.log(`[generateSocialMediaSubtitles] 💾 Processed transcript JSON saved for debugging: ${transcriptJsonPath}`);
    
    this.logger.log(`[generateSocialMediaSubtitles] ===== SOCIAL MEDIA SUBTITLE GENERATION COMPLETED =====`);

    return assFilePath;
  }

  /**
   * Extract words array from Whisper result (for Ravid-Clipping compatibility)
   */
  private extractWordsFromWhisperResult(whisperResult: any): Array<{ word: string; start: number; end: number; confidence?: number }> {
    this.logger.log(`[extractWordsFromWhisperResult] Extracting words from Whisper result...`);
    const allWords: Array<{ word: string; start: number; end: number; confidence?: number }> = [];
    const segments = whisperResult.segments || [];

    this.logger.log(`[extractWordsFromWhisperResult] Processing ${segments.length} segments`);
    for (const segment of segments) {
      const words = segment.words || [];
      this.logger.debug(`[extractWordsFromWhisperResult] Segment has ${words.length} words`);
      for (const wordInfo of words) {
        const word = wordInfo.word?.trim() || '';
        // Skip disfluency markers
        if (word && word !== '[*]' && word.length > 0) {
          allWords.push({
            word: word,
            start: wordInfo.start || segment.start || 0,
            end: wordInfo.end || segment.end || 0,
            confidence: wordInfo.confidence,
          });
        }
      }
    }

    this.logger.log(`[extractWordsFromWhisperResult] ✅ Extracted ${allWords.length} words total`);
    return allWords;
  }

  /**
   * Generate ASS subtitle file with karaoke-style word highlighting (from Ravid-Clipping)
   */
  private generateASS(
    transcript: any,
    options: {
      fontsize?: number;
      fontname?: string;
      primaryColour?: string;
      secondaryColour?: string;
      outlineColour?: string;
      backColour?: string;
      bold?: number;
      italic?: number;
      borderStyle?: number;
      outline?: number;
      shadow?: number;
      alignment?: number;
      marginL?: number;
      marginR?: number;
      marginV?: number;
    },
  ): string {
    this.logger.log('[generateASS] ===== STARTING ASS FILE GENERATION =====');
    this.logger.log(`[generateASS] Transcript has ${transcript.segments?.length || 0} segments`);
    this.logger.log(`[generateASS] Options: fontsize=${options.fontsize}, fontname=${options.fontname}, alignment=${options.alignment}`);

    const finalOptions = {
      fontsize: options.fontsize || 14,
      fontname: options.fontname || 'Arial',
      primaryColour: options.primaryColour || '#FFFFFF',
      secondaryColour: options.secondaryColour || '#FFD700',
      outlineColour: options.outlineColour || '#000000',
      backColour: options.backColour || 'rgba(0,0,0,0.7)',
      bold: options.bold !== undefined ? options.bold : -1,
      italic: options.italic !== undefined ? options.italic : 0,
      borderStyle: options.borderStyle || 1,
      outline: options.outline || 1,
      shadow: options.shadow !== undefined ? options.shadow : 0,
      alignment: options.alignment || 2,
      marginL: options.marginL || 10,
      marginR: options.marginR || 10,
      marginV: options.marginV || 60,
    };

    // ASS file header
    let assContent = `[Script Info]
Title: Karaoke Subtitles
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${finalOptions.fontname},${finalOptions.fontsize},&H00${this.convertColorToASS(finalOptions.primaryColour)},&H00${this.convertColorToASS(finalOptions.secondaryColour)},&H00${this.convertColorToASS(finalOptions.outlineColour)},&H80000000,${finalOptions.bold},${finalOptions.italic},0,0,100,100,0,0,${finalOptions.borderStyle},${finalOptions.outline},${finalOptions.shadow},${finalOptions.alignment},${finalOptions.marginL},${finalOptions.marginR},${finalOptions.marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

    // Process each segment with karaoke highlighting
    let dialogueCount = 0;
    let segmentsWithWords = 0;
    let segmentsWithoutWords = 0;
    
    for (const segment of transcript.segments || []) {
      const startTime = this.formatAssTime(segment.start);
      const endTime = this.formatAssTime(segment.end);
      
      this.logger.debug(`[generateASS] Processing segment ${dialogueCount + 1}: "${segment.text?.substring(0, 50) || 'no text'}" (${startTime} - ${endTime})`);
      
      if (!segment.words || segment.words.length === 0) {
        segmentsWithoutWords++;
        // Fallback for segments without word timing - split text into words and estimate timing
        const text = segment.text || '';
        const words = text.split(/\s+/).filter((w: string) => w.length > 0);
        const segmentDuration = segment.end - segment.start;
        const wordDuration = segmentDuration / Math.max(1, words.length);
        
        let karaokeText = '';
        for (let i = 0; i < words.length; i++) {
          const cleanWord = this.escapeTextForAss(words[i]);
          const highlightCs = Math.max(10, Math.round(wordDuration * 100));
          karaokeText += `{\\k${highlightCs}}${cleanWord}`;
          if (i < words.length - 1) {
            karaokeText += ' ';
          }
        }
        
        assContent += `Dialogue: 0,${startTime},${endTime},Default,,0,0,0,,${karaokeText}\n`;
        dialogueCount++;
        continue;
      }

      // Create karaoke text with word timing using {\k} tags
      segmentsWithWords++;
      this.logger.debug(`[generateASS] Segment has ${segment.words.length} words for karaoke`);
      let karaokeText = '';
      
      for (let i = 0; i < segment.words.length; i++) {
        const word = segment.words[i];
        const wordText = word.word || word.text || '';
        if (!wordText) continue;
        
        const cleanWord = this.escapeTextForAss(wordText);
        
        // Use the actual word duration from whisper-timestamped
        const actualWordDuration = (word.end || segment.end) - (word.start || segment.start);
        
        // Calculate timing for this word highlight (in centiseconds for ASS format)
        const highlightCs = Math.max(10, Math.round(actualWordDuration * 100));
        
        // Simple karaoke effect: {\k<duration>} makes the word highlight for that duration
        karaokeText += `{\\k${highlightCs}}${cleanWord}`;
        
        // Add space between words (except for the last word)
        if (i < segment.words.length - 1) {
          karaokeText += ' ';
        }
      }
      
      // Add the dialogue line
      assContent += `Dialogue: 0,${startTime},${endTime},Default,,0,0,0,,${karaokeText}\n`;
      dialogueCount++;
    }

    this.logger.log(`[generateASS] ✅ Generated ${dialogueCount} dialogue lines for ASS file`);
    this.logger.log(`[generateASS] Segments with words: ${segmentsWithWords}, segments without words: ${segmentsWithoutWords}`);
    this.logger.log(`[generateASS] ASS content length: ${assContent.length} characters`);
    this.logger.log(`[generateASS] ===== ASS FILE GENERATION COMPLETED =====`);
    return assContent;
  }

  /**
   * Convert hex color to ASS format (BGR)
   */
  private convertColorToASS(hexColor: string): string {
    // Remove # if present
    const hex = hexColor.replace('#', '');
    
    // Convert RGB to BGR for ASS format
    if (hex.length === 6) {
      const r = hex.substr(0, 2);
      const g = hex.substr(2, 2);
      const b = hex.substr(4, 2);
      return `${b}${g}${r}`.toUpperCase();
    }
    
    return 'FFFFFF'; // Default to white
  }

  /**
   * Generate ASS file for headline overlay (top and/or bottom)
   * Supports <br> for line breaks and <h>text</h> for highlights (red color)
   */
  private async generateHeadlineASS(
    topHeadlineText: string | undefined,
    bottomHeadlineText: string | undefined,
    videoDuration: number,
    width: number,
    height: number,
    tempDir: string,
  ): Promise<string> {
    const assFilePath = path.join(tempDir, `headline_${Date.now()}.ass`);
    
    // ASS header
    let assContent = `[Script Info]
Title: Headline Overlay
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: TopWhite,Hakgyoansim Jiugae,120,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,0,8,50,50,150,1
Style: TopRed,Hakgyoansim Jiugae,120,&H000000FF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,0,8,50,50,150,1
Style: BottomWhite,Hakgyoansim Jiugae,100,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,0,2,50,50,150,1
Style: BottomRed,Hakgyoansim Jiugae,100,&H000000FF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,0,2,50,50,150,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

    // Helper to format time for ASS (h:mm:ss.cc)
    const formatTime = (seconds: number): string => {
      const hours = Math.floor(seconds / 3600);
      const mins = Math.floor((seconds % 3600) / 60);
      const secs = Math.floor(seconds % 60);
      const centiseconds = Math.floor((seconds % 1) * 100);
      return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${centiseconds.toString().padStart(2, '0')}`;
    };

    // Helper to parse text with <h>highlight</h> tags and convert to ASS format
    // Returns inline style overrides for red highlights
    const parseTextWithHighlight = (text: string): string => {
      // Normalize spaces
      const normalized = text.replace(/\s+/g, ' ').trim();
      
      let result = '';
      const regex = /<h>(.*?)<\/h>/g;
      let lastIndex = 0;
      let match;

      while ((match = regex.exec(normalized)) !== null) {
        // Add normal text before highlight
        if (match.index > lastIndex) {
          const normalText = normalized.substring(lastIndex, match.index);
          if (normalText) {
            result += normalText;
          }
        }
        // Add highlighted text with color override (red)
        if (match[1]) {
          result += `{\\c&H0000FF&}${match[1]}{\\c&HFFFFFF&}`;
        }
        lastIndex = regex.lastIndex;
      }

      // Add remaining normal text
      if (lastIndex < normalized.length) {
        const normalText = normalized.substring(lastIndex);
        if (normalText) {
          result += normalText;
        }
      }

      return result || normalized;
    };

    const startTime = formatTime(0);
    const endTime = formatTime(videoDuration);

    // Add top headline
    if (topHeadlineText) {
      // Handle <br> or </br> tags for line breaks
      const lines = topHeadlineText.replace(/<\/?br\s*\/?>/gi, '\n').split('\n').filter(l => l.trim());
      
      // Build multi-line text with \\N separators
      const textLines = lines.map(line => parseTextWithHighlight(line));
      const fullText = textLines.join('\\N');
      
      // Single Dialogue entry with multiple lines
      assContent += `Dialogue: 0,${startTime},${endTime},TopWhite,,0,0,0,,${fullText}\n`;
    }

    // Add bottom headline
    if (bottomHeadlineText) {
      // Handle <br> or </br> tags for line breaks
      const lines = bottomHeadlineText.replace(/<\/?br\s*\/?>/gi, '\n').split('\n').filter(l => l.trim());
      
      // Build multi-line text with \\N separators
      const textLines = lines.map(line => parseTextWithHighlight(line));
      const fullText = textLines.join('\\N');
      
      // Single Dialogue entry with multiple lines
      assContent += `Dialogue: 0,${startTime},${endTime},BottomWhite,,0,0,0,,${fullText}\n`;
    }

    // Write ASS file
    await fsPromises.writeFile(assFilePath, assContent, 'utf-8');
    this.logger.log(`[generateHeadlineASS] ✅ Created headline ASS file: ${assFilePath}`);
    this.logger.debug(`[generateHeadlineASS] ASS Content:\n${assContent}`);
    
    return assFilePath;
  }

  /**
   * Convert transcript into social media style short key words/phrases (from Ravid-Clipping)
   * Groups words into chunks based on maxWordsPerSubtitle
   */
  private createSocialMediaStyleSubtitles(
    transcript: any,
    options: {
      maxWordsPerSubtitle?: number;
      emphasizeKeyWords?: boolean;
      minWordDuration?: number;
      maxWordDuration?: number;
    } = {},
  ): any {
    this.logger.log('[createSocialMediaStyleSubtitles] ===== STARTING SOCIAL MEDIA STYLE CONVERSION =====');
    const {
      maxWordsPerSubtitle = 2,
      emphasizeKeyWords = true,
      minWordDuration = 0.5,
      maxWordDuration = 1.5,
    } = options;

    this.logger.log(`[createSocialMediaStyleSubtitles] Options: maxWordsPerSubtitle=${maxWordsPerSubtitle}, emphasizeKeyWords=${emphasizeKeyWords}`);
    this.logger.log(`[createSocialMediaStyleSubtitles] Transcript has ${transcript.words?.length || 0} words, ${transcript.segments?.length || 0} segments`);

    const socialMediaSegments: any[] = [];

    // Check if we have word-level timestamps from Whisper
    if (transcript.words && transcript.words.length > 0) {
      this.logger.log('[createSocialMediaStyleSubtitles] 🎯 Using precise word-level timestamps from Whisper');
      
      // Group words with precise timing
      this.logger.log(`[createSocialMediaStyleSubtitles] Grouping ${transcript.words.length} words into chunks of ${maxWordsPerSubtitle} words`);
      for (let i = 0; i < transcript.words.length; i += maxWordsPerSubtitle) {
        const wordGroup = transcript.words.slice(i, i + maxWordsPerSubtitle);
        
        if (wordGroup.length > 0) {
          const startTime = wordGroup[0].start;
          const endTime = wordGroup[wordGroup.length - 1].end;
          const displayText = wordGroup.map((w: any) => w.word).join(' ');
          
          // Make key words uppercase for emphasis
          const finalText = emphasizeKeyWords ? this.emphasizeKeyWords(displayText) : displayText;

          socialMediaSegments.push({
            text: finalText,
            start: startTime,
            end: endTime,
            duration: endTime - startTime,
            wordCount: wordGroup.length,
            isKeyPhrase: this.isKeyPhrase(finalText),
            words: wordGroup, // Include original word data
          });
          
          if (socialMediaSegments.length <= 3 || socialMediaSegments.length % 10 === 0) {
            this.logger.debug(`[createSocialMediaStyleSubtitles] Created segment ${socialMediaSegments.length}: "${finalText}" (${startTime}s - ${endTime}s)`);
          }
        }
      }
      this.logger.log(`[createSocialMediaStyleSubtitles] ✅ Created ${socialMediaSegments.length} segments from word timestamps`);
    } else {
      this.logger.log('[createSocialMediaStyleSubtitles] ⚠️ No word-level timestamps available, using estimated timing');
      
      // Fallback to estimated timing (original method)
      for (const segment of transcript.segments || []) {
        const words = segment.text.trim().split(/\s+/);
        const totalDuration = segment.end - segment.start;
        const wordDuration = Math.max(minWordDuration, Math.min(maxWordDuration, totalDuration / words.length));

        // Group words into small chunks
        for (let i = 0; i < words.length; i += maxWordsPerSubtitle) {
          const wordGroup = words.slice(i, i + maxWordsPerSubtitle);
          const startTime = segment.start + (i * wordDuration);
          const endTime = Math.min(segment.end, startTime + (wordGroup.length * wordDuration));

          // Process words for social media style
          let displayText = wordGroup.join(' ');
          
          // Make key words uppercase for emphasis
          if (emphasizeKeyWords) {
            displayText = this.emphasizeKeyWords(displayText);
          }

          socialMediaSegments.push({
            text: displayText,
            start: startTime,
            end: endTime,
            duration: endTime - startTime,
            wordCount: wordGroup.length,
            isKeyPhrase: this.isKeyPhrase(displayText),
          });
        }
      }
    }

    const result = {
      ...transcript,
      segments: socialMediaSegments,
      style: 'social-media',
      totalWords: socialMediaSegments.length,
      usingWordTimestamps: transcript.words && transcript.words.length > 0,
    };
    
    this.logger.log(`[createSocialMediaStyleSubtitles] ✅ Conversion complete: ${socialMediaSegments.length} social media segments created`);
    this.logger.log(`[createSocialMediaStyleSubtitles] Using word timestamps: ${result.usingWordTimestamps}`);
    this.logger.log(`[createSocialMediaStyleSubtitles] ===== SOCIAL MEDIA STYLE CONVERSION COMPLETED =====`);
    return result;
  }

  /**
   * Emphasize key words by making them uppercase
   */
  private emphasizeKeyWords(text: string): string {
    const keyWords = [
      // Indonesian
      'bilang', 'kata', 'gitu', 'banget', 'gimana', 'kenapa', 'bagus', 'jelek',
      'penting', 'bener', 'salah', 'harus', 'jangan', 'boleh', 'bisa', 'tidak',
      'iya', 'enggak', 'udah', 'belum', 'lagi', 'masih', 'sudah', 'mau',
      'nggak', 'gak', 'dong', 'sih', 'kok', 'deh', 'nih',
      // English  
      'amazing', 'awesome', 'crazy', 'insane', 'perfect', 'terrible', 'horrible',
      'important', 'necessary', 'must', 'should', 'need', 'want', 'love', 'hate',
      'yes', 'no', 'maybe', 'definitely', 'absolutely', 'never', 'always',
      'really', 'very', 'super', 'ultra', 'mega', 'best', 'worst',
      'wow', 'omg', 'damn', 'shit', 'fuck', 'hell', 'god',
    ];

    let emphasized = text;
    keyWords.forEach(word => {
      const regex = new RegExp(`\\b${word}\\b`, 'gi');
      emphasized = emphasized.replace(regex, word.toUpperCase());
    });

    return emphasized;
  }

  /**
   * Check if a phrase contains key words that should be emphasized
   */
  private isKeyPhrase(text: string): boolean {
    const keyPhraseIndicators = [
      'bilang', 'kata', 'penting', 'harus', 'jangan', 'amazing', 'crazy',
      'must', 'need', 'important', 'wow', 'omg', 'really', 'very',
    ];
    
    const lowerText = text.toLowerCase();
    return keyPhraseIndicators.some(indicator => lowerText.includes(indicator));
  }

  /**
   * Create ASS file content with social media-style subtitles
   * Groups words into 3-6 word chunks with karaoke highlighting (like Ravid-Clipping backend)
   */
  private createAssFileContent(words: Array<{ word: string; start: number; end: number }>): string {
    // ASS file header - font size 14 for social media style
    let assContent = `[Script Info]
Title: Social Media Subtitles
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,14,&H00FFFFFF,&H00FFFF00,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,1,0,2,10,10,60,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

    // Group words into chunks of 3-6 words (social media style)
    const minWords = 3;
    const maxWords = 6;
    
    // Process words in groups
    for (let i = 0; i < words.length; i += maxWords) {
      // Get a chunk of 3-6 words
      const chunk = words.slice(i, Math.min(i + maxWords, words.length));
      
      // Ensure we have at least minWords if possible
      if (chunk.length < minWords && i + chunk.length < words.length) {
        // Try to get more words to reach minWords
        const remainingWords = words.slice(i, Math.min(i + minWords, words.length));
        if (remainingWords.length >= minWords) {
          chunk.length = 0;
          chunk.push(...remainingWords);
        }
      }
      
      if (chunk.length === 0) continue;
      
      // Calculate timing for this chunk
      const chunkStart = chunk[0].start;
      const chunkEnd = chunk[chunk.length - 1].end;
      
      // Build karaoke text with word-by-word highlighting using {\k} tags
      // {\k<duration>} highlights the word for that duration (in centiseconds)
      let karaokeText = '';
      
      for (let j = 0; j < chunk.length; j++) {
        const word = chunk[j];
        const cleanWord = this.escapeTextForAss(word.word);
        
        // Calculate word duration in centiseconds
        const wordDuration = word.end - word.start;
        const highlightCs = Math.max(10, Math.round(wordDuration * 100));
        
        // Add karaoke tag: {\k<duration>}word
        karaokeText += `{\\k${highlightCs}}${cleanWord}`;
        
        // Add space between words (except for the last word)
        if (j < chunk.length - 1) {
          karaokeText += ' ';
        }
      }
      
      // Format timestamps
      const startTime = this.formatAssTime(chunkStart);
      const endTime = this.formatAssTime(chunkEnd);
      
      // Add dialogue entry for this chunk
      assContent += `Dialogue: 0,${startTime},${endTime},Default,,0,0,0,,${karaokeText}\n`;
    }

    return assContent;
  }

  /**
   * Escape text for ASS format
   */
  private escapeTextForAss(text: string): string {
    if (!text) return '';
    return text
      .replace(/\\/g, '\\\\')  // Escape backslashes
      .replace(/\n/g, '\\N')    // Convert newlines to ASS format
      .replace(/\{/g, '\\{')    // Escape opening braces
      .replace(/\}/g, '\\}');   // Escape closing braces
  }

  /**
   * Format time in seconds to ASS time format (H:MM:SS.cc)
   */
  private formatAssTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const centiseconds = Math.floor((seconds % 1) * 100);
    
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`;
  }

  /**
   * Create fallback social media subtitle when word-level timestamps are not available
   * Uses same karaoke approach as main method
   */
  private async createFallbackSocialMediaSubtitle(
    text: string,
    duration: number,
    assFilePath: string,
  ): Promise<string> {
    const words = text.split(/\s+/).filter(w => w.length > 0);
    
    if (words.length === 0) {
      throw new BadRequestException('No words in transcript text');
    }

    // Create ASS content with karaoke highlighting (same as main method)
    let assContent = `[Script Info]
Title: Social Media Subtitles
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,14,&H00FFFFFF,&H00FFFF00,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,1,0,2,10,10,60,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

    const minWords = 3;
    const maxWords = 6;
    const wordDuration = duration / words.length;

    // Group words into chunks of 3-6 words
    for (let i = 0; i < words.length; i += maxWords) {
      const chunk = words.slice(i, Math.min(i + maxWords, words.length));
      
      // Ensure we have at least minWords if possible
      if (chunk.length < minWords && i + chunk.length < words.length) {
        const remainingWords = words.slice(i, Math.min(i + minWords, words.length));
        if (remainingWords.length >= minWords) {
          chunk.length = 0;
          chunk.push(...remainingWords);
        }
      }
      
      if (chunk.length === 0) continue;
      
      // Calculate timing for this chunk
      const chunkStart = i * wordDuration;
      const chunkEnd = Math.min(duration, (i + chunk.length) * wordDuration);
      
      // Build karaoke text with {\k} tags
      let karaokeText = '';
      for (let j = 0; j < chunk.length; j++) {
        const word = chunk[j];
        const cleanWord = this.escapeTextForAss(word);
        const wordDur = wordDuration;
        const highlightCs = Math.max(10, Math.round(wordDur * 100));
        
        karaokeText += `{\\k${highlightCs}}${cleanWord}`;
        if (j < chunk.length - 1) {
          karaokeText += ' ';
        }
      }
      
      const startTimeStr = this.formatAssTime(chunkStart);
      const endTimeStr = this.formatAssTime(chunkEnd);
      
      assContent += `Dialogue: 0,${startTimeStr},${endTimeStr},Default,,0,0,0,,${karaokeText}\n`;
    }

    const BOM = '\uFEFF';
    await fsPromises.writeFile(assFilePath, BOM + assContent, 'utf8');
    this.logger.log(`[generateSocialMediaSubtitles] Created fallback ASS file: ${assFilePath}`);
    
    return assFilePath;
  }

  /**
   * Add subtitles to video using SRT or ASS file - BURNS subtitles into video
   * Subtitles are positioned in the middle and 35% from the bottom
   * @param isSocialMediaStyle If true, expects ASS format file with word highlighting
   */
  async addSubtitlesToVideo(
    videoPath: string,
    subtitleFilePath: string,
    outputPath: string,
    width: number,
    height: number,
    subtitleFontSize?: number,
    isSocialMediaStyle: boolean = false,
  ): Promise<void> {
    const subtitleType = isSocialMediaStyle ? 'ASS' : 'SRT';
    this.logger.log(`[addSubtitlesToVideo] ===== STARTING SUBTITLE BURNING (${subtitleType}) =====`);
    this.logger.log(`[addSubtitlesToVideo] Input video: ${videoPath}`);
    this.logger.log(`[addSubtitlesToVideo] Subtitle file: ${subtitleFilePath} (${subtitleType})`);
    this.logger.log(`[addSubtitlesToVideo] Output video: ${outputPath}`);
    this.logger.log(`[addSubtitlesToVideo] Video dimensions: ${width}x${height}`);
    this.logger.log(`[addSubtitlesToVideo] Social media style: ${isSocialMediaStyle}`);
    
    // Verify input video exists
    const videoExists = await this.fileExists(videoPath);
    if (!videoExists) {
      throw new Error(`Input video file not found: ${videoPath}`);
    }
    const videoStats = await fsPromises.stat(videoPath);
    this.logger.log(`[addSubtitlesToVideo] Input video exists: ${videoStats.size} bytes`);
    
    // Verify subtitle file exists
    const subtitleExists = await this.fileExists(subtitleFilePath);
    if (!subtitleExists) {
      throw new Error(`Subtitle file not found: ${subtitleFilePath}`);
    }

    // Read subtitle file to verify it exists and has content
    const subtitleFileContent = await fsPromises.readFile(subtitleFilePath, 'utf8');
      
    if (!subtitleFileContent || subtitleFileContent.trim().length === 0) {
      throw new Error(`Subtitle file is empty: ${subtitleFilePath}`);
    }
    
    // Get video duration for sync verification and to preserve it
    let inputVideoDuration: number = 0;
    try {
      inputVideoDuration = await this.getVideoDuration(videoPath);
      this.logger.log(`[addSubtitlesToVideo] Input video duration: ${inputVideoDuration}s`);
      
      // Parse SRT to check timestamp alignment
      if (!isSocialMediaStyle) {
        const srtLines = subtitleFileContent.split('\n');
        let firstSubtitleTime: number | null = null;
        let lastSubtitleTime: number | null = null;
        
        for (let i = 0; i < srtLines.length; i++) {
          const line = srtLines[i].trim();
          const timeMatch = line.match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
          if (timeMatch) {
            const startHours = parseInt(timeMatch[1]);
            const startMins = parseInt(timeMatch[2]);
            const startSecs = parseInt(timeMatch[3]);
            const startMs = parseInt(timeMatch[4]);
            const startTime = startHours * 3600 + startMins * 60 + startSecs + startMs / 1000;
            
            if (firstSubtitleTime === null) {
              firstSubtitleTime = startTime;
            }
            lastSubtitleTime = startTime;
          }
        }
        
        if (firstSubtitleTime !== null && lastSubtitleTime !== null) {
          this.logger.log(`[addSubtitlesToVideo] First subtitle timestamp: ${firstSubtitleTime}s`);
          this.logger.log(`[addSubtitlesToVideo] Last subtitle timestamp: ${lastSubtitleTime}s`);
          this.logger.log(`[addSubtitlesToVideo] Video duration: ${inputVideoDuration}s`);
          
          if (firstSubtitleTime > 0.1) {
            this.logger.warn(`[addSubtitlesToVideo] ⚠️ First subtitle starts at ${firstSubtitleTime}s (expected ~0s)`);
          }
          if (Math.abs(lastSubtitleTime - inputVideoDuration) > 1) {
            this.logger.warn(`[addSubtitlesToVideo] ⚠️ Last subtitle at ${lastSubtitleTime}s, video ends at ${inputVideoDuration}s (diff: ${Math.abs(lastSubtitleTime - inputVideoDuration)}s)`);
          }
        }
      }
    } catch (err: any) {
      this.logger.warn(`[addSubtitlesToVideo] Could not get video duration: ${err.message}`);
    }
      
    this.logger.log(`[addSubtitlesToVideo] ✅ Subtitle file verified: ${subtitleFileContent.length} bytes`);
    this.logger.debug(`[addSubtitlesToVideo] Subtitle content preview (first 1500 chars): ${subtitleFileContent.substring(0, 1500)}`);
    
    // Count subtitle entries (for SRT format)
    if (!isSocialMediaStyle) {
      const subtitleCount = (subtitleFileContent.match(/^\d+$/gm) || []).length;
      this.logger.debug(`[addSubtitlesToVideo] Detected ${subtitleCount} subtitle entries in SRT file`);
    }
    
    // Calculate subtitle position: middle horizontally, 35% from bottom
    // MarginV in ASS format is pixels from bottom
    const marginV = Math.round(height * 0.35);
    
    // Get absolute path for subtitle file (Windows-compatible)
    const absoluteSubtitlePath = path.resolve(subtitleFilePath);
    
    // FFmpeg subtitles filter with styling - FORCES re-encoding to burn in subtitles
    // Alignment=2 means bottom center
    // MarginV is margin from bottom in pixels
    // For regular SRT subtitles: use Noto Sans KR, font size 14, with black background box
    const fontSize = subtitleFontSize ?? 14; // Allow caller override for layouts
    
    this.logger.log(`[addSubtitlesToVideo] ===== DEBUG INFO =====`);
    this.logger.log(`[addSubtitlesToVideo] Video dimensions: ${width}x${height}`);
    this.logger.log(`[addSubtitlesToVideo] Subtitle styling: marginV=${marginV}px, fontSize=${fontSize}px`);
    this.logger.log(`[addSubtitlesToVideo] Subtitle type: ${isSocialMediaStyle ? 'ASS (social media)' : 'SRT (regular)'}`);
    
    // Log subtitle file content preview for debugging
    try {
      const subtitleContentPreview = await fsPromises.readFile(subtitleFilePath, 'utf8');
      const previewLines = subtitleContentPreview.split('\n').slice(0, 20).join('\n');
      this.logger.log(`[addSubtitlesToVideo] Subtitle file preview (first 20 lines):\n${previewLines}`);
      const subtitleLineCount = subtitleContentPreview.split('\n').length;
      const subtitleEntryCount = (subtitleContentPreview.match(/^\d+$/gm) || []).length;
      this.logger.log(`[addSubtitlesToVideo] Subtitle file stats: ${subtitleLineCount} lines, ${subtitleEntryCount} entries`);
    } catch (err: any) {
      this.logger.warn(`[addSubtitlesToVideo] Could not read subtitle file for preview: ${err.message}`);
    }
    
    // Ensure output path is absolute and directory exists
    // Resolve relative to process.cwd() to ensure correct path
    const absoluteOutputPath = path.isAbsolute(outputPath) 
      ? outputPath 
      : path.resolve(process.cwd(), outputPath);
    const outputDir = path.dirname(absoluteOutputPath);
    
    this.logger.debug(`[addSubtitlesToVideo] Output directory: ${outputDir}`);
    const outputDirExists = await this.fileExists(outputDir);
    
    if (!outputDirExists) {
      await this.ensureDir(outputDir);
      this.logger.debug(`[addSubtitlesToVideo] Created output directory: ${outputDir}`);
    }
    
    // Ensure input video path is absolute
    const absoluteVideoPath = path.isAbsolute(videoPath) 
      ? videoPath 
      : path.resolve(process.cwd(), videoPath);
    
    this.logger.debug(`[addSubtitlesToVideo] Absolute output path: ${absoluteOutputPath}`);
    this.logger.debug(`[addSubtitlesToVideo] Absolute video path: ${absoluteVideoPath}`);
    const videoFileExists = await this.fileExists(absoluteVideoPath);
    this.logger.debug(`[addSubtitlesToVideo] Video file exists: ${videoFileExists}`);
    
    // Build the complete filter string - this BURNS subtitles into the video
    // Normalize path for FFmpeg (use forward slashes, escape special characters)
    // FFmpeg ASS filter requires proper path escaping
    let normalizedSubtitlePath = absoluteSubtitlePath.replace(/\\/g, '/');
    
    // Verify ASS file content is valid before using it
    try {
      const assContent = await fsPromises.readFile(absoluteSubtitlePath, 'utf8');
      if (!assContent.includes('[Script Info]') || !assContent.includes('[Events]')) {
        this.logger.error(`[addSubtitlesToVideo] ❌ Invalid ASS file: missing required sections`);
        throw new Error('Invalid ASS subtitle file format');
      }
      const dialogueCount = (assContent.match(/^Dialogue:/gm) || []).length;
      this.logger.log(`[addSubtitlesToVideo] ASS file validation: ${dialogueCount} dialogue entries found`);
      if (dialogueCount === 0) {
        this.logger.warn(`[addSubtitlesToVideo] ⚠️ ASS file has no dialogue entries - subtitles may not appear`);
      }
    } catch (err: any) {
      this.logger.error(`[addSubtitlesToVideo] ❌ Failed to validate ASS file: ${err.message}`);
      throw new Error(`Invalid subtitle file: ${err.message}`);
    }
    
    // Escape special characters for FFmpeg filter
    // For ASS filter, the path needs to be properly escaped
    // FFmpeg ASS filter syntax: ass=filename (no quotes needed if path is properly escaped)
    // Escape special characters that might break the filter
    let escapedSubtitlePath = normalizedSubtitlePath
      .replace(/\\/g, '/')     // Normalize to forward slashes
      .replace(/:/g, '\\:')    // Escape colons (important for Windows paths)
      .replace(/\[/g, '\\[')   // Escape brackets
      .replace(/\]/g, '\\]')   // Escape brackets
      .replace(/'/g, "\\'")    // Escape single quotes
      .replace(/ /g, '\\ ');   // Escape spaces
    
    // Use ASS filter for both social media and regular subtitles (ASS has better styling support)
    let filterString: string;
    if (isSocialMediaStyle) {
      // Use ASS filter for karaoke subtitles (like Ravid-Clipping)
      this.logger.log(`[addSubtitlesToVideo] Using ASS filter for karaoke subtitles`);
      // Use single quotes around the path to handle spaces and special chars
      filterString = `ass=${escapedSubtitlePath}`;
    } else {
      // Use ASS filter for regular subtitles (plain style, no background)
      // The ASS file already contains all styling (font, etc.) in its header
      this.logger.log(`[addSubtitlesToVideo] Using ASS filter for regular subtitles (plain style)`);
      this.logger.log(`[addSubtitlesToVideo] ASS file contains: Font=Noto Sans CJK KR, Size=14, Plain style (white text with thin outline/shadow for visibility), Word wrapping enabled`);
      // Use single quotes around the path to handle spaces and special chars
      filterString = `ass=${escapedSubtitlePath}`;
    }
    
    this.logger.log(`[addSubtitlesToVideo] Final subtitle filter: ${filterString}`);
    this.logger.log(`[addSubtitlesToVideo] Absolute subtitle path: ${absoluteSubtitlePath}`);
    this.logger.log(`[addSubtitlesToVideo] Normalized subtitle path: ${normalizedSubtitlePath}`);
    this.logger.log(`[addSubtitlesToVideo] Escaped subtitle path: ${escapedSubtitlePath}`);
    const subtitleFileExists = await this.fileExists(absoluteSubtitlePath);
    this.logger.log(`[addSubtitlesToVideo] Subtitle file exists: ${subtitleFileExists}`);
    if (subtitleFileExists) {
      try {
        const subtitleStats = await fsPromises.stat(absoluteSubtitlePath);
        this.logger.log(`[addSubtitlesToVideo] Subtitle file size: ${subtitleStats.size} bytes`);
      } catch (err: any) {
        this.logger.warn(`[addSubtitlesToVideo] Could not get subtitle file stats: ${err.message}`);
      }
    } else {
      throw new Error(`Subtitle file does not exist: ${absoluteSubtitlePath}`);
    }
    
    // Get video duration first to preserve it
    const videoDuration = await this.getVideoDuration(absoluteVideoPath);
    
    return new Promise((resolve, reject) => {
      const ffmpegCommand = ffmpeg()
        .input(absoluteVideoPath)
        .videoCodec('libx264') // Force re-encoding to burn in subtitles
        .audioCodec('copy') // Copy audio to avoid re-encoding (faster and preserves quality)
        .videoFilters(filterString) // Pass filter string directly (fluent-ffmpeg handles it)
        .outputOptions([
          `-t ${videoDuration}`, // Preserve exact input duration
          '-pix_fmt yuv420p',
          '-crf 23', // Good quality for burned-in subtitles
          '-preset fast', // Faster encoding for better performance
          '-movflags +faststart', // Web optimization
          '-avoid_negative_ts', 'make_zero',
          '-fflags', '+genpts',
          '-vsync', 'cfr',
        ])
        .output(absoluteOutputPath);
      
      ffmpegCommand
        .on('start', (commandLine) => {
          this.logger.log(`[addSubtitlesToVideo] ===== FFMPEG COMMAND STARTED =====`);
          this.logger.log(`[addSubtitlesToVideo] Complete FFmpeg command: ${commandLine}`);
          this.logger.log(`[addSubtitlesToVideo] Input video: ${absoluteVideoPath}`);
          this.logger.log(`[addSubtitlesToVideo] Subtitle file: ${absoluteSubtitlePath}`);
          this.logger.log(`[addSubtitlesToVideo] Output video: ${absoluteOutputPath}`);
          this.logger.log(`[addSubtitlesToVideo] Video dimensions: ${width}x${height}`);
          this.logger.log(`[addSubtitlesToVideo] Video duration: ${videoDuration}s`);
          this.logger.log(`[addSubtitlesToVideo] Filter string: ${filterString}`);
        })
        .on('progress', (progress) => {
          if (progress.percent) {
            this.logger.debug(`Burning subtitles progress: ${Math.round(progress.percent)}%`);
          }
        })
        .on('end', async () => {
          // Verify output file was created
          const outputExists = await this.fileExists(absoluteOutputPath);
          if (outputExists) {
            const outputStats = await fsPromises.stat(absoluteOutputPath);
            this.logger.log(`[addSubtitlesToVideo] ✅ Successfully burned subtitles into video: ${absoluteOutputPath}`);
            this.logger.debug(`[addSubtitlesToVideo] Output video size: ${outputStats.size} bytes`);
            
            // Verify output duration matches input
            try {
              const outputDuration = await this.getVideoDuration(absoluteOutputPath);
              const durationDiff = Math.abs(videoDuration - outputDuration);
              if (durationDiff > 0.1) {
                this.logger.warn(`[addSubtitlesToVideo] ⚠️ Duration changed: input=${videoDuration}s, output=${outputDuration}s, diff=${durationDiff}s`);
              } else {
                this.logger.debug(`[addSubtitlesToVideo] ✅ Duration preserved: input=${videoDuration}s, output=${outputDuration}s, diff=${durationDiff}s`);
              }
            } catch (err: any) {
              this.logger.warn(`[addSubtitlesToVideo] Could not verify output duration: ${err.message}`);
            }
            
            this.logger.log(`[addSubtitlesToVideo] ===== SUBTITLE BURNING COMPLETED =====`);
          } else {
            this.logger.error(`[addSubtitlesToVideo] ❌ Output file was not created: ${absoluteOutputPath}`);
            reject(new Error(`Output file was not created: ${absoluteOutputPath}`));
            return;
          }
          resolve();
        })
        .on('error', async (error: any) => {
          this.logger.error(`[addSubtitlesToVideo] ❌ Failed to burn subtitles: ${error.message}`);
          this.logger.error(`[addSubtitlesToVideo] Error details: ${JSON.stringify(error, null, 2)}`);
          if (error.stderr) {
            this.logger.error(`[addSubtitlesToVideo] FFmpeg stderr output:\n${error.stderr}`);
          }
          this.logger.error(`[addSubtitlesToVideo] Subtitle file path: ${absoluteSubtitlePath}`);
          const subtitleExists = await this.fileExists(absoluteSubtitlePath);
          const videoExists = await this.fileExists(absoluteVideoPath);
          const dirExists = await this.fileExists(outputDir);
          this.logger.error(`[addSubtitlesToVideo] Subtitle file exists: ${subtitleExists}`);
          this.logger.error(`[addSubtitlesToVideo] Video file: ${absoluteVideoPath}`);
          this.logger.error(`[addSubtitlesToVideo] Video file exists: ${videoExists}`);
          this.logger.error(`[addSubtitlesToVideo] Output file: ${absoluteOutputPath}`);
          this.logger.error(`[addSubtitlesToVideo] Output directory exists: ${dirExists}`);
          this.logger.error(`[addSubtitlesToVideo] Error details: ${JSON.stringify(error)}`);
          reject(error);
        })
        .run();
    });
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
      this.logger.log(`[extractAudioSegment] Extracting audio from ${startTime}s for ${duration}s`);
      
      // Use input seeking first, then output options for precise timing
      // This avoids codec-specific seeking issues that can cause delays
      ffmpeg()
        .input(audioPath)
        .inputOptions([
          `-ss ${startTime}`, // Start seeking at input (more accurate)
          '-accurate_seek', // More accurate seeking
        ])
        .audioCodec('aac') // Re-encode to ensure clean cuts (copy can cause sync issues)
        .audioBitrate('128k')
        .outputOptions([
          `-t ${duration}`, // Exact duration
          '-avoid_negative_ts', 'make_zero', // Ensure timestamps start at 0
          '-fflags', '+genpts', // Generate presentation timestamps
          '-af', 'aresample=async=1', // Resample for sync
        ])
        .output(outputPath)
        .on('start', (commandLine) => {
          this.logger.debug(`[extractAudioSegment] Command: ${commandLine}`);
        })
        .on('end', () => {
          this.logger.log(`[extractAudioSegment] ✅ Audio segment extracted: ${outputPath}`);
          resolve();
        })
        .on('error', (error) => {
          this.logger.error(`[extractAudioSegment] ❌ Failed to extract audio segment: ${error.message}`);
          reject(error);
        })
        .run();
    });
  }

  /**
   * Extract audio from video file for transcription
   */
  private async extractAudioFromVideo(
    videoPath: string,
    outputPath: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      this.logger.log(`[extractAudioFromVideo] Extracting audio from video: ${videoPath}`);
      ffmpeg()
        .input(videoPath)
        .audioCodec('libmp3lame') // Use MP3 codec for Whisper compatibility
        .audioFrequency(16000) // 16kHz sample rate (Whisper standard)
        .audioChannels(1) // Mono audio
        .outputOptions([
          '-map', '0:a', // Map only audio stream (no video)
          '-avoid_negative_ts', 'make_zero', // Ensure timestamps start at 0
          '-fflags', '+genpts', // Generate presentation timestamps
        ])
        .output(outputPath)
        .on('start', (commandLine) => {
          this.logger.debug(`[extractAudioFromVideo] FFmpeg command: ${commandLine}`);
        })
        .on('progress', (progress) => {
          this.logger.debug(`[extractAudioFromVideo] Progress: ${JSON.stringify(progress)}`);
        })
        .on('end', () => {
          this.logger.log(`[extractAudioFromVideo] ✅ Audio extracted: ${outputPath}`);
          resolve();
        })
        .on('error', (error) => {
          this.logger.error(`[extractAudioFromVideo] ❌ Failed to extract audio: ${error.message}`);
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
      await fsPromises.copyFile(clipPaths[0], outputPath);
      return;
    }

    // Create concat file list for FFmpeg
    const concatFilePath = path.resolve(
      this.tempDir,
      `concat_${Date.now()}.txt`,
    );

    try {
      // Ensure all clip paths are absolute
      const absoluteClipPaths = clipPaths.map((clipPath) => path.resolve(clipPath));
      
      const concatContent = absoluteClipPaths
        .map((clipPath) => `file '${clipPath.replace(/'/g, "'\\''")}'`) // Escape single quotes in paths
        .join('\n');
      
      await fsPromises.writeFile(concatFilePath, concatContent);
      this.logger.debug(`Created concat file: ${concatFilePath}`);
      this.logger.log(`💾 Concat file saved for debugging: ${concatFilePath}`);
      this.logger.debug(`Concat file content:\n${concatContent}`);

      return new Promise((resolve, reject) => {
        ffmpeg()
          .input(concatFilePath)
          .inputOptions(['-f', 'concat', '-safe', '0'])
          .videoCodec('libx264') // Re-encode to ensure compatibility (needed for subtitle burning)
          .audioCodec('aac') // Re-encode audio
          .outputOptions([
            '-pix_fmt yuv420p',
            '-crf 23', // Good quality
            '-preset fast', // Faster encoding for better performance
            '-avoid_negative_ts', 'make_zero', // Ensure timestamps start at 0
            '-fflags', '+genpts', // Generate presentation timestamps
            '-vsync', 'cfr', // Constant frame rate for sync
            '-async', '1', // Audio sync
          ])
          .output(outputPath)
          .on('start', (commandLine) => {
            this.logger.log(`Concat command: ${commandLine}`);
          })
          .on('progress', (progress) => {
            if (progress.percent) {
              this.logger.log(`Concatenating progress: ${Math.round(progress.percent)}%`);
            }
          })
          .on('end', () => {
            this.logger.log(`Successfully concatenated ${clipPaths.length} clips`);
            // Schedule cleanup for concat file
            this.scheduleFileCleanup(concatFilePath);
            this.logger.debug(`Scheduled cleanup for concat file: ${concatFilePath} (${this.TEMP_FILE_RETENTION_MINUTES} minutes)`);
            resolve();
          })
          .on('error', (error) => {
            this.logger.error(`Concat error: ${error.message}`);
            // Schedule cleanup for concat file even on error
            this.scheduleFileCleanup(concatFilePath);
            this.logger.debug(`Scheduled cleanup for concat file: ${concatFilePath} (${this.TEMP_FILE_RETENTION_MINUTES} minutes)`);
            reject(error);
          })
          .run();
      });
    } catch (error: any) {
      // Schedule cleanup for concat file even on exception
      this.scheduleFileCleanup(concatFilePath);
      this.logger.debug(`Scheduled cleanup for concat file: ${concatFilePath} (${this.TEMP_FILE_RETENTION_MINUTES} minutes)`);
      throw error;
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
   * Convert audio file to MP3 format (for Whisper compatibility)
   */
  async convertAudioToMp3(inputPath: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .audioCodec('libmp3lame')
        .audioBitrate(128)
        .format('mp3')
        .on('end', () => {
          this.logger.debug(`Audio converted to MP3: ${outputPath}`);
          resolve();
        })
        .on('error', (error) => {
          this.logger.error(`Audio conversion error: ${error.message}`);
          reject(error);
        })
        .save(outputPath);
    });
  }

  /**
   * Convert media file to specified format
   * Supports audio and video formats
   */
  async convertMediaFormat(
    inputPath: string,
    outputFormat: string,
    outputPath: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const command = ffmpeg(inputPath);

      // Set output format
      command.format(outputFormat);

      // Audio-specific settings
      if (['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'].includes(outputFormat.toLowerCase())) {
        if (outputFormat.toLowerCase() === 'mp3') {
          command.audioCodec('libmp3lame').audioBitrate(128);
        } else if (outputFormat.toLowerCase() === 'wav') {
          command.audioCodec('pcm_s16le');
        } else if (outputFormat.toLowerCase() === 'ogg') {
          command.audioCodec('libvorbis');
        } else if (outputFormat.toLowerCase() === 'flac') {
          command.audioCodec('flac');
        } else if (outputFormat.toLowerCase() === 'm4a' || outputFormat.toLowerCase() === 'aac') {
          command.audioCodec('aac');
        }
      }
      // Video-specific settings
      else if (['mp4', 'webm', 'avi', 'mov', 'mkv'].includes(outputFormat.toLowerCase())) {
        if (outputFormat.toLowerCase() === 'mp4') {
          command.videoCodec('libx264').audioCodec('aac');
        } else if (outputFormat.toLowerCase() === 'webm') {
          command.videoCodec('libvpx-vp9').audioCodec('libopus');
        }
      }

      command
        .on('end', () => {
          this.logger.debug(`Media converted to ${outputFormat}: ${outputPath}`);
          resolve();
        })
        .on('error', (error) => {
          this.logger.error(`Media conversion error: ${error.message}`);
          reject(error);
        })
        .save(outputPath);
    });
  }

  /**
   * Get duration of video file in seconds with caching to avoid redundant FFprobe calls
   * Cache is valid for 5 minutes per file
   */
  async getVideoDuration(videoPath: string, useCache: boolean = true): Promise<number> {
    // Check cache first if enabled
    if (useCache) {
      const cached = this.videoDurationCache.get(videoPath);
      const now = Date.now();
      
      if (cached && (now - cached.timestamp) < this.DURATION_CACHE_TTL_MS) {
        this.logger.debug(`[getVideoDuration] Cache hit for: ${videoPath} (${cached.duration}s)`);
        return cached.duration;
      }
    }
    
    // Cache miss or cache disabled - fetch from FFprobe
    this.logger.debug(`[getVideoDuration] Cache miss, fetching from FFprobe: ${videoPath}`);
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) {
          reject(err);
          return;
        }
        const duration = metadata.format.duration || 0;
        
        // Store in cache
        if (useCache) {
          this.videoDurationCache.set(videoPath, { duration, timestamp: Date.now() });
        }
        
        resolve(duration);
      });
    });
  }

  /**
   * Clear expired entries from video duration cache
   */
  private clearExpiredDurationCache(): void {
    const now = Date.now();
    let clearedCount = 0;
    
    for (const [key, value] of this.videoDurationCache.entries()) {
      if (now - value.timestamp >= this.DURATION_CACHE_TTL_MS) {
        this.videoDurationCache.delete(key);
        clearedCount++;
      }
    }
    
    if (clearedCount > 0) {
      this.logger.debug(`Cleared ${clearedCount} expired entries from video duration cache`);
    }
  }

  /**
   * Clear all entries from video duration cache
   * Useful for cleanup after processing completes
   */
  private clearDurationCache(): void {
    const size = this.videoDurationCache.size;
    this.videoDurationCache.clear();
    if (size > 0) {
      this.logger.debug(`Cleared all ${size} entries from video duration cache`);
    }
  }

  /**
   * Get video dimensions (width and height)
   */
  async getVideoDimensions(videoPath: string): Promise<{ width: number; height: number }> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) {
          reject(err);
          return;
        }
        const videoStream = metadata.streams.find((stream) => stream.codec_type === 'video');
        if (!videoStream || !videoStream.width || !videoStream.height) {
          reject(new Error('Could not determine video dimensions'));
          return;
        }
        resolve({
          width: videoStream.width,
          height: videoStream.height,
        });
      });
    });
  }

  /**
   * Burn subtitles to a video from URL
   * Downloads video, creates SRT file, and burns subtitles
   */
  async burnSubtitlesToVideo(
    videoUrl: string,
    subtitleContent: string,
    width?: number,
    height?: number,
    requestId?: string,
  ): Promise<string> {
    const logPrefix = requestId ? `[${requestId}]` : '';
    const outputPath = path.join(
      this.tempDir,
      `burned_subtitles_${Date.now()}.mp4`,
    );

    this.logger.log(`${logPrefix} [VideoProcessingService] Starting burnSubtitlesToVideo`);
    this.logger.log(`${logPrefix} [VideoProcessingService] Video URL: ${videoUrl}`);
    this.logger.log(`${logPrefix} [VideoProcessingService] Subtitle content length: ${subtitleContent.length} characters`);

    // Reset downloaded files tracker
    this.downloadedFiles = [];

    try {
      // Step 1: Download video from URL
      this.logger.log(`${logPrefix} [VideoProcessingService] Downloading video from URL...`);
      const videoPath = await this.resolveFilePath(videoUrl);
      this.logger.log(`${logPrefix} [VideoProcessingService] Video downloaded to: ${videoPath}`);

      // Step 2: Get video dimensions if not provided
      let videoWidth = width;
      let videoHeight = height;
      
      if (!videoWidth || !videoHeight) {
        this.logger.log(`${logPrefix} [VideoProcessingService] Getting video dimensions...`);
        const dimensions = await this.getVideoDimensions(videoPath);
        videoWidth = dimensions.width;
        videoHeight = dimensions.height;
        this.logger.log(`${logPrefix} [VideoProcessingService] Video dimensions: ${videoWidth}x${videoHeight}`);
      } else {
        this.logger.log(`${logPrefix} [VideoProcessingService] Using provided dimensions: ${videoWidth}x${videoHeight}`);
      }

      // Step 3: Create SRT file from subtitle content
      this.logger.log(`${logPrefix} [VideoProcessingService] Creating SRT file from subtitle content...`);
      const srtFilePath = path.join(
        this.tempDir,
        `subtitles_${Date.now()}.srt`,
      );
      
      // Write subtitle content to SRT file with UTF-8 encoding (required for Korean/Unicode characters)
      // Add UTF-8 BOM for better compatibility with FFmpeg
      const BOM = '\uFEFF';
      await fsPromises.writeFile(srtFilePath, BOM + subtitleContent, 'utf8');
      this.logger.log(`${logPrefix} [VideoProcessingService] SRT file created: ${srtFilePath} (UTF-8 with BOM)`);
      
      // Verify SRT file
      const srtFileContent = await fsPromises.readFile(srtFilePath, 'utf8');
      const subtitleCount = (srtFileContent.match(/^\d+$/gm) || []).length;
      this.logger.log(`${logPrefix} [VideoProcessingService] SRT file verified: ${srtFileContent.length} bytes, ${subtitleCount} subtitle entries`);

      // Step 4: Burn subtitles into video
      this.logger.log(`${logPrefix} [VideoProcessingService] Burning subtitles into video...`);
      await this.addSubtitlesToVideo(
        videoPath,
        srtFilePath,
        outputPath,
        videoWidth,
        videoHeight,
        undefined,
        false, // Not social media style (this is for burnSubtitlesToVideo method)
      );

      // Step 5: Cleanup SRT file
      const srtExists = await this.fileExists(srtFilePath);
      if (srtExists) {
        await fsPromises.unlink(srtFilePath);
        this.logger.log(`${logPrefix} [VideoProcessingService] Cleaned up SRT file`);
      }

      // Cleanup downloaded video file after a delay
      setTimeout(async () => {
        await this.cleanupDownloadedFiles();
      }, 10000); // 10 seconds delay

      this.logger.log(`${logPrefix} [VideoProcessingService] ✅ Successfully burned subtitles to video: ${outputPath}`);
      const finalStats = await fsPromises.stat(outputPath);
      this.logger.log(`${logPrefix} [VideoProcessingService] Final video size: ${finalStats.size} bytes`);
      
      return outputPath;
    } catch (error: any) {
      // Cleanup downloaded files on error
      this.cleanupDownloadedFiles();
      this.logger.error(`${logPrefix} [VideoProcessingService] ❌ Failed to burn subtitles: ${error.message}`, error.stack);
      throw new BadRequestException(`Failed to burn subtitles: ${error.message}`);
    }
  }

  /**
   * Combine medias with transcripts - new workflow
   * 1. Transcribe full audio with whisper-timestamped
   * 2. Match transcripts to whisper segments to get timestamps
   * 3. Generate subtitle file (SRT or ASS)
   * 4. Create video from images based on subtitle timestamps
   * 5. Combine video with audio
   * 6. Burn subtitles
   */
  async combineMediasWithTranscripts(
    audioPath: string,
    sections: Array<{ transcript: string; imagePath: string }>,
    outputFormat: string = 'mp4',
    width: number = 1920,
    height: number = 1080,
    useSubtitle: boolean = false,
    useSocialMediaSubtitle: boolean = false,
    requestId?: string,
    layout?: string,
    topHeadlineText?: string,
    bottomHeadlineText?: string,
    verticalGap?: number,
    imageAspect?: string,
    inputRatio?: string,
    bottomHeadlineAppear?: string,
  ): Promise<string> {
    const logPrefix = requestId ? `[${requestId}]` : '';
    const absoluteTempDir = path.resolve(this.tempDir);
    await this.ensureDir(absoluteTempDir);
    const outputPath = path.join(
      absoluteTempDir,
      `combined_medias_${Date.now()}.${outputFormat}`,
    );

    this.logger.log(`${logPrefix} [combineMediasWithTranscripts] Processing ${sections.length} sections (useSubtitle=${useSubtitle}, useSocialMediaSubtitle=${useSocialMediaSubtitle}, layout=${layout || 'default'})`);

    try {
      // Step 1: Resolve audio path and get audio duration
      this.logger.debug(`${logPrefix} [combineMediasWithTranscripts] Step 1: Resolving audio path...`);
      const resolvedAudioPath = await this.resolveFilePath(audioPath);
      this.logger.debug(`${logPrefix} [combineMediasWithTranscripts] Audio path resolved: ${resolvedAudioPath}`);
      
      // Get audio duration first to ensure video matches exactly
      const audioDuration = await this.getAudioDuration(resolvedAudioPath);
      this.logger.log(`${logPrefix} [combineMediasWithTranscripts] Audio duration: ${audioDuration}s`);

      // Step 2: Transcribe full audio with whisper-timestamped (only if subtitles needed)
      let transcriptionResult: any = null;
      let subtitleFilePath: string;
      let sectionTimings: Array<{ start: number; end: number; duration: number }> = [];

      if (useSubtitle || useSocialMediaSubtitle) {
        this.logger.log(`${logPrefix} [combineMediasWithTranscripts] Step 2: Transcribing full audio with whisper-timestamped...`);
        const responseFormat = 'verbose_json'; // Use verbose_json to get word-level timestamps
        transcriptionResult = await this.transcriptionService.transcribe(
          resolvedAudioPath,
          undefined, // Auto-detect language
          responseFormat,
        );

        // Save original Whisper response for debugging (only in debug mode or non-production)
        if (process.env.LOG_LEVEL === 'debug' || process.env.NODE_ENV !== 'production') {
          const timestamp = Date.now();
          const whisperJsonPath = path.join(absoluteTempDir, `whisper_result_medias_${timestamp}.json`);
          await fsPromises.writeFile(whisperJsonPath, JSON.stringify(transcriptionResult, null, 2), 'utf8');
          this.scheduleFileCleanup(whisperJsonPath);
          this.logger.debug(`${logPrefix} [combineMediasWithTranscripts] Saved original Whisper response: ${whisperJsonPath}`);
          
          const summary = {
            timestamp: new Date().toISOString(),
            requestId: requestId,
            audioPath: resolvedAudioPath,
            responseKeys: Object.keys(transcriptionResult),
            totalSegments: transcriptionResult.segments?.length || 0,
            totalWords: transcriptionResult.segments?.reduce((sum: number, seg: any) => sum + (seg.words?.length || 0), 0) || 0,
            fullText: transcriptionResult.text || '',
            language: transcriptionResult.language || 'unknown',
            fullResponse: transcriptionResult,
          };
          const summaryPath = path.join(absoluteTempDir, `whisper_summary_${timestamp}.json`);
          await fsPromises.writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
          this.scheduleFileCleanup(summaryPath);
          this.logger.debug(`${logPrefix} [combineMediasWithTranscripts] Saved Whisper summary: ${summaryPath}`);
        }

        // Step 3: Match transcripts to whisper segments and generate subtitle file
        this.logger.debug(`${logPrefix} [combineMediasWithTranscripts] Step 3: Matching transcripts to whisper segments...`);
        
        if (useSocialMediaSubtitle) {
          // Generate ASS with word-level timestamps
          subtitleFilePath = await this.generateASSFromTranscripts(
            transcriptionResult,
            sections.map(s => s.transcript),
            absoluteTempDir,
            logPrefix,
            true, // useKaraokeStyle = true for social media
          );
          // Log ASS file path for debugging
          this.logger.debug(`${logPrefix} [combineMediasWithTranscripts] ASS file saved: ${subtitleFilePath}`);
          const subtitleExists = await this.fileExists(subtitleFilePath);
          if (subtitleExists) {
            const assStats = await fsPromises.stat(subtitleFilePath);
            this.logger.debug(`${logPrefix} [combineMediasWithTranscripts] ASS file size: ${assStats.size} bytes`);
          }
          // Calculate section timings from ASS (first word to last word of each section)
          sectionTimings = await this.calculateSectionTimingsFromWhisper(
            transcriptionResult,
            sections.map(s => s.transcript),
            logPrefix,
          );
          } else if (useSubtitle) {
          // Generate ASS with word-level timestamps (same method as social media, but plain white/black style)
          subtitleFilePath = await this.generateASSFromTranscripts(
            transcriptionResult,
            sections.map(s => s.transcript),
            absoluteTempDir,
            logPrefix,
            false, // plainStyle = false means use plain white/black (not karaoke)
          );
          // Log ASS file path for debugging
          this.logger.debug(`${logPrefix} [combineMediasWithTranscripts] ASS file saved: ${subtitleFilePath}`);
          const subtitleExists = await this.fileExists(subtitleFilePath);
          if (subtitleExists) {
            const assStats = await fsPromises.stat(subtitleFilePath);
            this.logger.debug(`${logPrefix} [combineMediasWithTranscripts] ASS file size: ${assStats.size} bytes`);
          }
          // Calculate section timings from ASS (first word to last word of each section)
          sectionTimings = await this.calculateSectionTimingsFromWhisper(
            transcriptionResult,
            sections.map(s => s.transcript),
            logPrefix,
          );
          }
      } else {
        // No subtitles - skip Whisper transcription and use equal duration per section
        this.logger.log(`${logPrefix} [combineMediasWithTranscripts] Skipping Whisper transcription (subtitles disabled)`);
        const durationPerSection = audioDuration / sections.length;
        sectionTimings = sections.map((_, i) => ({
          start: i * durationPerSection,
          end: (i + 1) * durationPerSection,
          duration: durationPerSection,
        }));
        this.logger.log(`${logPrefix} [combineMediasWithTranscripts] Using equal duration per section: ${durationPerSection}s`);
      }

      // Adjust first section to start at 00:00 (no black space)
      if (sectionTimings.length > 0 && sectionTimings[0].start > 0) {
        const firstSectionOffset = sectionTimings[0].start;
        this.logger.debug(`${logPrefix} [combineMediasWithTranscripts] Adjusting first section: ${sectionTimings[0].start}s -> 0s (offset: ${firstSectionOffset}s)`);
        sectionTimings = sectionTimings.map((timing, i) => {
          if (i === 0) {
            return { start: 0, end: timing.end - timing.start, duration: timing.end - timing.start };
          }
          return { start: timing.start - firstSectionOffset, end: timing.end - firstSectionOffset, duration: timing.duration };
        });
      }
      
      // Normalize section timings to ensure total duration matches audio exactly
      const totalVideoDuration = sectionTimings.reduce((sum, timing) => sum + timing.duration, 0);
      const durationDifference = audioDuration - totalVideoDuration;
      
      if (Math.abs(durationDifference) > 0.01) { // More than 10ms difference
        this.logger.debug(`${logPrefix} [combineMediasWithTranscripts] Adjusting video duration: ${totalVideoDuration}s -> ${audioDuration}s (difference: ${durationDifference}s)`);
        
        if (durationDifference > 0) {
          // Video is shorter - extend last section
          const lastIndex = sectionTimings.length - 1;
          sectionTimings[lastIndex] = {
            ...sectionTimings[lastIndex],
            duration: sectionTimings[lastIndex].duration + durationDifference,
            end: sectionTimings[lastIndex].end + durationDifference,
          };
          this.logger.debug(`${logPrefix} [combineMediasWithTranscripts] Extended last section by ${durationDifference}s`);
        } else {
          // Video is longer - proportionally reduce sections
          const scaleFactor = audioDuration / totalVideoDuration;
          let currentEnd = 0;
          sectionTimings = sectionTimings.map((timing, i) => {
            const newDuration = timing.duration * scaleFactor;
            const newStart = currentEnd;
            const newEnd = newStart + newDuration;
            currentEnd = newEnd;
            return { start: newStart, end: newEnd, duration: newDuration };
          });
          this.logger.debug(`${logPrefix} [combineMediasWithTranscripts] Scaled all sections by factor ${scaleFactor}`);
        }
      }
      
      // Verify final total duration
      const finalTotalDuration = sectionTimings.reduce((sum, timing) => sum + timing.duration, 0);
      this.logger.debug(`${logPrefix} [combineMediasWithTranscripts] Final video duration: ${finalTotalDuration}s (audio: ${audioDuration}s, difference: ${Math.abs(audioDuration - finalTotalDuration)}s)`);

      // Step 4: Create video clips from images based on timings
      this.logger.log(`${logPrefix} [combineMediasWithTranscripts] Step 4: Creating ${sections.length} video clips from images...`);
      
      // For vertical poster layout, force 9:16 aspect ratio
      let finalWidth = width;
      let finalHeight = height;
      const subtitleFontSize = layout === 'vertical_poster' ? 42 : undefined;
      if (layout === 'vertical_poster') {
        finalWidth = 1080;
        finalHeight = 1920;
        this.logger.log(`${logPrefix} [combineMediasWithTranscripts] Vertical poster layout: forcing 9:16 canvas (${finalWidth}x${finalHeight})`);
      }
      
      // Resolve all image paths first
      const resolvedPaths = await Promise.all(
        sections.map(section => this.resolveFilePath(section.imagePath))
      );
      
      // Helper function to limit concurrency (process max 3 videos at a time to avoid OOM)
      const processInBatches = async <T, R>(
        items: T[],
        batchSize: number,
        processor: (item: T, index: number) => Promise<R>,
      ): Promise<R[]> => {
        const results: R[] = [];
        for (let i = 0; i < items.length; i += batchSize) {
          const batch = items.slice(i, i + batchSize);
          const batchResults = await Promise.all(
            batch.map((item, batchIndex) => processor(item, i + batchIndex))
          );
          results.push(...batchResults);
        }
        return results;
      };
      
      // Create video clips in batches (max 2 at a time to prevent memory exhaustion)
      // Each FFmpeg process uses ~2GB, so 2 videos = ~4GB max, staying well under available memory
      const MAX_CONCURRENT_VIDEOS = 2;
      this.logger.log(`${logPrefix} [combineMediasWithTranscripts] Creating ${sections.length} video clips in batches of ${MAX_CONCURRENT_VIDEOS}...`);
      
      const videoClipPaths = await processInBatches(
        sections,
        MAX_CONCURRENT_VIDEOS,
        async (section, i) => {
          const timing = sectionTimings[i] || sectionTimings[sectionTimings.length - 1]; // Fallback to last timing
          const resolvedImagePath = resolvedPaths[i];
          // Use unique timestamp per video to avoid filename conflicts when processing in parallel
          const uniqueTimestamp = Date.now() + i; // Add index to ensure uniqueness even in same millisecond
          const clipPath = path.join(absoluteTempDir, `section_${i}_${uniqueTimestamp}.mp4`);
          
          this.logger.debug(`${logPrefix} [combineMediasWithTranscripts] Section ${i + 1}/${sections.length}: image=${section.imagePath}, duration=${timing.duration}s`);
          
          // Check if this is the last section for bottom headline logic
          const isLastSection = i === sections.length - 1;
          const shouldShowBottomHeadline = layout === 'vertical_poster' && 
            bottomHeadlineText && 
            (bottomHeadlineAppear === 'start' || (bottomHeadlineAppear === 'last' && isLastSection));
          
          // Create video clip from image with specified duration
          if (layout === 'vertical_poster') {
            await this.createVerticalPosterVideo(
              resolvedImagePath,
              clipPath,
              timing.duration,
              finalWidth,
              finalHeight,
              topHeadlineText,
              shouldShowBottomHeadline ? bottomHeadlineText : undefined,
              verticalGap || 24,
              inputRatio || '3:4',
              logPrefix,
              true, // Skip headline rendering - will use ASS overlay instead
            );
          } else {
            await this.createVideoFromImage(resolvedImagePath, clipPath, timing.duration, finalWidth, finalHeight);
          }
          return clipPath;
        }
      );
      
      this.logger.log(`${logPrefix} [combineMediasWithTranscripts] ✅ Created ${videoClipPaths.length} video clips`);

      // Step 5: Concatenate video clips
      this.logger.debug(`${logPrefix} [combineMediasWithTranscripts] Step 5: Concatenating ${videoClipPaths.length} video clips...`);
      const combinedVideoPath = path.join(absoluteTempDir, `combined_video_${Date.now()}.${outputFormat}`);
      await this.concatenateClips(videoClipPaths, combinedVideoPath);

      // Step 6: Add audio to combined video (ensuring exact duration match)
      this.logger.debug(`${logPrefix} [combineMediasWithTranscripts] Step 6: Adding audio to combined video...`);
      const videoWithAudioPath = path.join(absoluteTempDir, `video_with_audio_${Date.now()}.${outputFormat}`);
      await this.addFullAudioTrack(combinedVideoPath, resolvedAudioPath, videoWithAudioPath, audioDuration);

      // Step 6.5: Burn headline ASS if vertical poster layout and headlines exist
      let videoAfterHeadline = videoWithAudioPath;
      if (layout === 'vertical_poster' && (topHeadlineText || bottomHeadlineText)) {
        this.logger.log(`${logPrefix} [combineMediasWithTranscripts] Step 6.5: Burning headline overlay (ASS)...`);
        
        // Determine which headline to show
        const shouldShowBottomHeadline = bottomHeadlineText && (bottomHeadlineAppear === 'start' || bottomHeadlineAppear === 'last');
        
        const headlineAssPath = await this.generateHeadlineASS(
          topHeadlineText,
          shouldShowBottomHeadline ? bottomHeadlineText : undefined,
          audioDuration,
          finalWidth,
          finalHeight,
          absoluteTempDir,
        );
        
        // Burn headline ASS
        const videoWithHeadlinePath = path.join(absoluteTempDir, `video_with_headline_${Date.now()}.${outputFormat}`);
        await new Promise<void>((resolve, reject) => {
          ffmpeg(videoWithAudioPath)
            .outputOptions([
              `-vf ass=${headlineAssPath}`,
              '-c:a copy', // Copy audio without re-encoding
            ])
            .output(videoWithHeadlinePath)
            .on('start', (cmd) => {
              this.logger.debug(`${logPrefix} [combineMediasWithTranscripts] Headline burn FFmpeg: ${cmd}`);
            })
            .on('end', () => {
              this.logger.log(`${logPrefix} [combineMediasWithTranscripts] ✅ Headline overlay burned`);
              resolve();
            })
            .on('error', (err) => {
              this.logger.error(`${logPrefix} [combineMediasWithTranscripts] ❌ Failed to burn headline: ${err.message}`);
              reject(err);
            })
            .run();
        });
        
        videoAfterHeadline = videoWithHeadlinePath;
        
        // Cleanup headline ASS file
        try {
          await fsPromises.unlink(headlineAssPath);
        } catch (err) {
          this.logger.warn(`${logPrefix} [combineMediasWithTranscripts] Failed to cleanup headline ASS: ${err}`);
        }
      }

      // Step 7: Burn subtitles (if enabled)
      if (useSubtitle || useSocialMediaSubtitle) {
        this.logger.log(`${logPrefix} [combineMediasWithTranscripts] Step 7: Burning subtitles to video...`);
        const videoDurationBeforeSubtitles = await this.getVideoDuration(videoAfterHeadline);
        this.logger.debug(`${logPrefix} [combineMediasWithTranscripts] Video duration before subtitles: ${videoDurationBeforeSubtitles}s (audio: ${audioDuration}s)`);
        
        // Use finalWidth and finalHeight (which account for vertical_poster layout) for subtitle positioning
        await this.addSubtitlesToVideo(
          videoAfterHeadline,
          subtitleFilePath,
          outputPath,
          finalWidth,
          finalHeight,
          subtitleFontSize,
          useSocialMediaSubtitle,
        );
        
        // Verify final output duration matches audio
        const finalVideoDuration = await this.getVideoDuration(outputPath);
        const durationDiff = Math.abs(audioDuration - finalVideoDuration);
        if (durationDiff > 0.1) {
          this.logger.warn(`${logPrefix} [combineMediasWithTranscripts] ⚠️ Final video duration mismatch: video=${finalVideoDuration}s, audio=${audioDuration}s, diff=${durationDiff}s`);
          // Trim or extend to match exactly
          const correctedOutputPath = path.join(absoluteTempDir, `corrected_output_${Date.now()}.${outputFormat}`);
          await this.trimVideoToExactDuration(outputPath, correctedOutputPath, audioDuration);
          await fsPromises.copyFile(correctedOutputPath, outputPath);
          await fsPromises.unlink(correctedOutputPath);
          const correctedDuration = await this.getVideoDuration(outputPath);
          this.logger.debug(`${logPrefix} [combineMediasWithTranscripts] ✅ Corrected duration: ${correctedDuration}s`);
        } else {
          this.logger.debug(`${logPrefix} [combineMediasWithTranscripts] ✅ Final video duration verified: ${finalVideoDuration}s (audio: ${audioDuration}s, diff: ${durationDiff}s)`);
        }
      } else {
        // No subtitles - just copy the video with audio (and headline if applied)
        await fsPromises.copyFile(videoAfterHeadline, outputPath);
        
        // Verify final output duration matches audio
        const finalVideoDuration = await this.getVideoDuration(outputPath);
        const durationDiff = Math.abs(audioDuration - finalVideoDuration);
        if (durationDiff > 0.1) {
          this.logger.warn(`${logPrefix} [combineMediasWithTranscripts] ⚠️ Final video duration mismatch: video=${finalVideoDuration}s, audio=${audioDuration}s, diff=${durationDiff}s`);
          // Trim or extend to match exactly
          const correctedOutputPath = path.join(absoluteTempDir, `corrected_output_${Date.now()}.${outputFormat}`);
          await this.trimVideoToExactDuration(outputPath, correctedOutputPath, audioDuration);
          await fsPromises.copyFile(correctedOutputPath, outputPath);
          await fsPromises.unlink(correctedOutputPath);
          const correctedDuration = await this.getVideoDuration(outputPath);
          this.logger.debug(`${logPrefix} [combineMediasWithTranscripts] ✅ Corrected duration: ${correctedDuration}s`);
        } else {
          this.logger.debug(`${logPrefix} [combineMediasWithTranscripts] ✅ Final video duration verified: ${finalVideoDuration}s (audio: ${audioDuration}s, diff: ${durationDiff}s)`);
        }
      }

      // Schedule cleanup for intermediate files (keep for debugging for retention period, then auto-delete)
      videoClipPaths.forEach(clipPath => {
        this.scheduleFileCleanup(clipPath);
        this.logger.debug(`${logPrefix} [combineMediasWithTranscripts] Scheduled cleanup for clip: ${clipPath} (${this.TEMP_FILE_RETENTION_MINUTES} minutes)`);
      });
      
      this.scheduleFileCleanup(combinedVideoPath);
      this.logger.debug(`${logPrefix} [combineMediasWithTranscripts] Scheduled cleanup for combined video: ${combinedVideoPath}`);
      
      this.scheduleFileCleanup(videoWithAudioPath);
      this.logger.debug(`${logPrefix} [combineMediasWithTranscripts] Scheduled cleanup for video with audio: ${videoWithAudioPath}`);
      
      // Schedule cleanup for subtitle files
      if (useSocialMediaSubtitle && subtitleFilePath) {
        this.scheduleFileCleanup(subtitleFilePath);
        const assExists = await this.fileExists(subtitleFilePath);
        if (assExists) {
          const assStats = await fsPromises.stat(subtitleFilePath);
          this.logger.debug(`${logPrefix} [combineMediasWithTranscripts] ASS subtitle file: ${subtitleFilePath} (${assStats.size} bytes, cleanup in ${this.TEMP_FILE_RETENTION_MINUTES} minutes)`);
        }
      } else if (useSubtitle && subtitleFilePath) {
        this.scheduleFileCleanup(subtitleFilePath);
        this.logger.debug(`${logPrefix} [combineMediasWithTranscripts] Scheduled cleanup for SRT subtitle file: ${subtitleFilePath}`);
      }
      
      // Also cleanup whisper JSON files if they exist
      try {
        const whisperJsonFiles = await fsPromises.readdir(absoluteTempDir);
        for (const file of whisperJsonFiles) {
          if (file.startsWith('whisper_')) {
            const whisperPath = path.join(absoluteTempDir, file);
            this.scheduleFileCleanup(whisperPath);
          }
        }
      } catch (error) {
        // Ignore readdir errors
      }

      // Clear caches after processing completes to free memory
      this.clearDurationCache();
      this.clearPathCache();
      
      this.logger.log(`${logPrefix} [combineMediasWithTranscripts] ===== WORKFLOW COMPLETED + UPDATED2 =====`);
      return outputPath;
    } catch (error: any) {
      this.logger.error(`${logPrefix} [combineMediasWithTranscripts] ❌ Error: ${error.message}`, error.stack);
      throw new BadRequestException(`Failed to combine medias: ${error.message}`);
    }
  }


  /**
   * Generate SRT from transcripts matched to whisper words
   * SIMPLIFIED APPROACH:
   * 1. Extract all words from whisper segments (already split)
   * 2. Split each user transcript section into words
   * 3. Compare each user word to whisper words sequentially
   * 4. Get first and last matched word timestamps from whisper
   * 5. Generate SRT using user's transcript text with whisper timestamps
   */
  private async generateSRTFromTranscripts(
    whisperResult: any,
    transcripts: string[],
    tempDir: string,
    logPrefix: string,
  ): Promise<{ filePath: string; sectionTimings: Array<{ start: number; end: number; duration: number }> }> {
    this.logger.log(`${logPrefix} [generateSRTFromTranscripts] ===== NEW WORD MATCHING LOGIC =====`);
    this.logger.log(`${logPrefix} [generateSRTFromTranscripts] Matching ${transcripts.length} transcript sections to whisper words...`);
    
    // Step 1: Combine all words from all segments into a single array
    const segments = whisperResult.segments || [];
    this.logger.log(`${logPrefix} [generateSRTFromTranscripts] Total whisper segments: ${segments.length}`);
    
    const whisperWords: Array<{ word: string; start: number; end: number; segmentIndex: number }> = [];
    
    for (let segIdx = 0; segIdx < segments.length; segIdx++) {
      const segment = segments[segIdx];
      const words = segment.words || [];
      
      for (const wordInfo of words) {
        const word = (wordInfo.text || wordInfo.word || '').trim();
        // Filter out disfluency markers and empty words
        if (word && word !== '[*]' && word.length > 0) {
          whisperWords.push({
            word: word,
            start: wordInfo.start || segment.start || 0,
            end: wordInfo.end || segment.end || 0,
            segmentIndex: segIdx,
          });
        }
      }
    }
    
    this.logger.log(`${logPrefix} [generateSRTFromTranscripts] Combined ${whisperWords.length} words from ${segments.length} segments`);
    this.logger.log(`${logPrefix} [generateSRTFromTranscripts] First 10 whisper words: ${whisperWords.slice(0, 10).map((w, i) => `[${i}]"${w.word}"`).join(', ')}`);
    
    const sectionTimings: Array<{ start: number; end: number; duration: number }> = [];
    let srtContent = '';
    let subtitleIndex = 1;
    // Create a mutable copy of whisperWords that we can remove from
    let availableWords = [...whisperWords];
    let firstSectionOffset = 0; // Track the offset for the first section

    // Step 2-7: Process each transcript section
    for (let i = 0; i < transcripts.length; i++) {
      const userTranscript = transcripts[i].trim();
      this.logger.log(`${logPrefix} [generateSRTFromTranscripts] ===== Section ${i + 1} =====`);
      this.logger.log(`${logPrefix} [generateSRTFromTranscripts] Section ${i + 1} user transcript: "${userTranscript}"`);
      
      // Step 2: Split user transcript into words
      const userWords = userTranscript.split(/\s+/).filter(w => w.length > 0);
      this.logger.log(`${logPrefix} [generateSRTFromTranscripts] Section ${i + 1}: Split into ${userWords.length} words: [${userWords.join(', ')}]`);
      
      if (userWords.length === 0) {
        this.logger.warn(`${logPrefix} [generateSRTFromTranscripts] ⚠️ Section ${i + 1}: Empty transcript, skipping`);
        continue;
      }
      
      // Step 3: Find first word
      let firstWordIndex = -1;
      let firstWordStartTime = 0;
      
      if (i === 0) {
        // For first section: find first word (try first, then second, etc. if not found)
        for (let wordIdx = 0; wordIdx < userWords.length; wordIdx++) {
          const userWord = userWords[wordIdx];
          const normalizedUserWord = this.normalizeWord(userWord);
          
          // Search for this word in available words
          for (let j = 0; j < availableWords.length; j++) {
            const whisperWord = availableWords[j];
            const normalizedWhisperWord = this.normalizeWord(whisperWord.word);
            
            if (this.wordsMatch(normalizedUserWord, normalizedWhisperWord)) {
              firstWordIndex = j;
              firstWordStartTime = whisperWord.start;
              this.logger.log(`${logPrefix} [generateSRTFromTranscripts] Section ${i + 1}: Found first word "${userWord}" at index ${j} (start: ${firstWordStartTime}s)`);
              break;
            }
      }
      
          if (firstWordIndex !== -1) {
            break;
          }
        }
        
        if (firstWordIndex === -1) {
          this.logger.warn(`${logPrefix} [generateSRTFromTranscripts] ⚠️ Section ${i + 1}: First word not found, using fallback`);
        // Fallback: estimate based on previous section
        const prevEnd = i > 0 ? sectionTimings[i - 1].end : 0;
        const estimatedDuration = 5;
        sectionTimings.push({ start: prevEnd, end: prevEnd + estimatedDuration, duration: estimatedDuration });
        
        const startTimeStr = this.formatSrtTime(prevEnd);
        const endTimeStr = this.formatSrtTime(prevEnd + estimatedDuration);
        srtContent += `${subtitleIndex}\n`;
        srtContent += `${startTimeStr} --> ${endTimeStr}\n`;
        srtContent += `${userTranscript}\n\n`;
        subtitleIndex++;
        continue;
      }
      } else {
        // For subsequent sections: first word is at index 0 (since we removed previous sections)
        if (availableWords.length === 0) {
          this.logger.warn(`${logPrefix} [generateSRTFromTranscripts] ⚠️ Section ${i + 1}: No available words left, using fallback`);
          const prevEnd = sectionTimings[i - 1].end;
          const estimatedDuration = 5;
          sectionTimings.push({ start: prevEnd, end: prevEnd + estimatedDuration, duration: estimatedDuration });
          
          const startTimeStr = this.formatSrtTime(prevEnd);
          const endTimeStr = this.formatSrtTime(prevEnd + estimatedDuration);
          srtContent += `${subtitleIndex}\n`;
          srtContent += `${startTimeStr} --> ${endTimeStr}\n`;
          srtContent += `${userTranscript}\n\n`;
          subtitleIndex++;
          continue;
        }
        firstWordIndex = 0;
        firstWordStartTime = availableWords[0].start;
        this.logger.log(`${logPrefix} [generateSRTFromTranscripts] Section ${i + 1}: Using first available word at index 0 (start: ${firstWordStartTime}s)`);
      }
      
      // Step 4: Find last word (handle punctuation like periods)
      let lastWordIndex = -1;
      let lastWordEndTime = 0;
      
      // Search from the end of user words
      for (let wordIdx = userWords.length - 1; wordIdx >= 0; wordIdx--) {
        const userWord = userWords[wordIdx];
        const normalizedUserWord = this.normalizeWord(userWord);
        
        // Search for this word in available words (starting from firstWordIndex)
        for (let j = firstWordIndex; j < availableWords.length; j++) {
          const whisperWord = availableWords[j];
          const normalizedWhisperWord = this.normalizeWord(whisperWord.word);
          
          if (this.wordsMatch(normalizedUserWord, normalizedWhisperWord)) {
            lastWordIndex = j;
            lastWordEndTime = whisperWord.end;
            this.logger.log(`${logPrefix} [generateSRTFromTranscripts] Section ${i + 1}: Found last word "${userWord}" at index ${j} (end: ${lastWordEndTime}s)`);
            break;
          }
        }
        
        if (lastWordIndex !== -1) {
          break;
        }
      }
      
      if (lastWordIndex === -1) {
        // If last word not found, use the first word's end time
        lastWordIndex = firstWordIndex;
        lastWordEndTime = availableWords[firstWordIndex].end;
        this.logger.warn(`${logPrefix} [generateSRTFromTranscripts] Section ${i + 1}: Last word not found, using first word's end time`);
      }
      
      // Step 5: Get start and end times
      let startTime = firstWordStartTime;
      let endTime = lastWordEndTime;
      
      // Store the offset for the first section, then apply it to all sections
      if (i === 0) {
        firstSectionOffset = startTime;
        this.logger.log(`${logPrefix} [generateSRTFromTranscripts] Section ${i + 1}: First section offset: ${firstSectionOffset}s`);
      }
      
      // Apply offset to all sections (so first section starts at 0.00)
      startTime = startTime - firstSectionOffset;
      endTime = endTime - firstSectionOffset;
      
      const duration = endTime - startTime;
      sectionTimings.push({ start: startTime, end: endTime, duration });
      
      this.logger.log(`${logPrefix} [generateSRTFromTranscripts] Section ${i + 1}: ${startTime}s - ${endTime}s (duration: ${duration}s)`);
      
      // Step 6: Generate SRT entry using USER's transcript text with whisper timestamps
      const startTimeStr = this.formatSrtTime(startTime);
      const endTimeStr = this.formatSrtTime(endTime);
      
      srtContent += `${subtitleIndex}\n`;
      srtContent += `${startTimeStr} --> ${endTimeStr}\n`;
      srtContent += `${userTranscript}\n\n`; // Use user's original transcript text
      
      subtitleIndex++;
      
      // Step 7: Remove matched words from availableWords array
      // Remove all words from firstWordIndex to lastWordIndex (inclusive)
      if (lastWordIndex >= firstWordIndex) {
        const removedCount = lastWordIndex - firstWordIndex + 1;
        availableWords.splice(firstWordIndex, removedCount);
        this.logger.log(`${logPrefix} [generateSRTFromTranscripts] Section ${i + 1}: Removed ${removedCount} words from available words (${availableWords.length} remaining)`);
      }
    }

    // Write SRT file
    const srtFilePath = path.join(tempDir, `transcripts_srt_${Date.now()}.srt`);
    const BOM = '\uFEFF';
    await fsPromises.writeFile(srtFilePath, BOM + srtContent, 'utf8');
    const srtStats = await fsPromises.stat(srtFilePath);
    this.logger.log(`${logPrefix} [generateSRTFromTranscripts] ✅ SRT file created: ${srtFilePath} (${srtStats.size} bytes)`);

    return { filePath: srtFilePath, sectionTimings };
  }

  /**
   * Generate regular ASS subtitles with black background box
   * Uses the same word matching logic as SRT but outputs ASS format
   */
  private async generateRegularASSFromTranscripts(
    whisperResult: any,
    transcripts: string[],
    tempDir: string,
    logPrefix: string,
    width: number,
    height: number,
  ): Promise<{ filePath: string; sectionTimings: Array<{ start: number; end: number; duration: number }> }> {
    this.logger.log(`${logPrefix} [generateRegularASSFromTranscripts] ===== GENERATING REGULAR ASS WITH BLACK BACKGROUND =====`);
    this.logger.log(`${logPrefix} [generateRegularASSFromTranscripts] Matching ${transcripts.length} transcript sections to whisper words...`);
    
    // Step 1: Combine all words from all segments into a single array (same as SRT)
    const segments = whisperResult.segments || [];
    this.logger.log(`${logPrefix} [generateRegularASSFromTranscripts] Total whisper segments: ${segments.length}`);
    
    const whisperWords: Array<{ word: string; start: number; end: number; segmentIndex: number }> = [];
    
    for (let segIdx = 0; segIdx < segments.length; segIdx++) {
      const segment = segments[segIdx];
      const words = segment.words || [];
      
      for (const wordInfo of words) {
        const word = (wordInfo.text || wordInfo.word || '').trim();
        if (word && word !== '[*]' && word.length > 0) {
          whisperWords.push({
            word: word,
            start: wordInfo.start || segment.start || 0,
            end: wordInfo.end || segment.end || 0,
            segmentIndex: segIdx,
          });
        }
      }
    }
    
    this.logger.log(`${logPrefix} [generateRegularASSFromTranscripts] Combined ${whisperWords.length} words from ${segments.length} segments`);
    
    // Calculate subtitle position: 35% from bottom
    const marginV = Math.round(height * 0.35);
    // Add horizontal margins to prevent text from going off screen (10% on each side)
    const marginL = Math.round(width * 0.10);
    const marginR = Math.round(width * 0.10);
    
    // ASS header with plain styling (no background box, no outline)
    let assContent = `[Script Info]
Title: Plain Subtitles
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Noto Sans CJK KR,14,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,${marginL},${marginR},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

    const sectionTimings: Array<{ start: number; end: number; duration: number }> = [];
    let availableWords = [...whisperWords];
    let firstSectionOffset = 0;

    // Process each transcript section (same logic as SRT)
    for (let i = 0; i < transcripts.length; i++) {
      const userTranscript = transcripts[i].trim();
      this.logger.log(`${logPrefix} [generateRegularASSFromTranscripts] ===== Section ${i + 1} =====`);
      this.logger.log(`${logPrefix} [generateRegularASSFromTranscripts] Section ${i + 1} user transcript: "${userTranscript}"`);
      
      const userWords = userTranscript.split(/\s+/).filter(w => w.length > 0);
      
      if (userWords.length === 0) {
        this.logger.warn(`${logPrefix} [generateRegularASSFromTranscripts] ⚠️ Section ${i + 1}: Empty transcript, skipping`);
        continue;
      }
      
      // Find first word
      let firstWordIndex = -1;
      let firstWordStartTime = 0;
      
      if (i === 0) {
        for (let wordIdx = 0; wordIdx < userWords.length; wordIdx++) {
          const userWord = userWords[wordIdx];
          const normalizedUserWord = this.normalizeWord(userWord);
          
          for (let j = 0; j < availableWords.length; j++) {
            const whisperWord = availableWords[j];
            const normalizedWhisperWord = this.normalizeWord(whisperWord.word);
            
            if (this.wordsMatch(normalizedUserWord, normalizedWhisperWord)) {
              firstWordIndex = j;
              firstWordStartTime = whisperWord.start;
              break;
            }
          }
          
          if (firstWordIndex !== -1) break;
        }
        
        if (firstWordIndex === -1) {
          this.logger.warn(`${logPrefix} [generateRegularASSFromTranscripts] ⚠️ Section ${i + 1}: First word not found, using fallback`);
          const prevEnd = i > 0 ? sectionTimings[i - 1].end : 0;
          const estimatedDuration = 5;
          sectionTimings.push({ start: prevEnd, end: prevEnd + estimatedDuration, duration: estimatedDuration });
          
          const startTimeStr = this.formatAssTime(prevEnd);
          const endTimeStr = this.formatAssTime(prevEnd + estimatedDuration);
          const escapedText = this.escapeTextForAss(userTranscript);
          assContent += `Dialogue: 0,${startTimeStr},${endTimeStr},Default,,0,0,0,,{\\q2}${escapedText}\n`;
          continue;
        }
      } else {
        if (availableWords.length === 0) {
          this.logger.warn(`${logPrefix} [generateRegularASSFromTranscripts] ⚠️ Section ${i + 1}: No available words left, using fallback`);
          const prevEnd = sectionTimings[i - 1].end;
          const estimatedDuration = 5;
          sectionTimings.push({ start: prevEnd, end: prevEnd + estimatedDuration, duration: estimatedDuration });
          
          const startTimeStr = this.formatAssTime(prevEnd);
          const endTimeStr = this.formatAssTime(prevEnd + estimatedDuration);
          const escapedText = this.escapeTextForAss(userTranscript);
          assContent += `Dialogue: 0,${startTimeStr},${endTimeStr},Default,,0,0,0,,{\\q2}${escapedText}\n`;
          continue;
        }
        firstWordIndex = 0;
        firstWordStartTime = availableWords[0].start;
      }
      
      // Find last word
      let lastWordIndex = -1;
      let lastWordEndTime = 0;
      
      for (let wordIdx = userWords.length - 1; wordIdx >= 0; wordIdx--) {
        const userWord = userWords[wordIdx];
        const normalizedUserWord = this.normalizeWord(userWord);
        
        for (let j = firstWordIndex; j < availableWords.length; j++) {
          const whisperWord = availableWords[j];
          const normalizedWhisperWord = this.normalizeWord(whisperWord.word);
          
          if (this.wordsMatch(normalizedUserWord, normalizedWhisperWord)) {
            lastWordIndex = j;
            lastWordEndTime = whisperWord.end;
            break;
          }
        }
        
        if (lastWordIndex !== -1) break;
      }
      
      if (lastWordIndex === -1) {
        lastWordIndex = firstWordIndex;
        lastWordEndTime = availableWords[firstWordIndex].end;
        this.logger.warn(`${logPrefix} [generateRegularASSFromTranscripts] Section ${i + 1}: Last word not found, using first word's end time`);
      }
      
      // Get start and end times
      let startTime = firstWordStartTime;
      let endTime = lastWordEndTime;
      
      if (i === 0) {
        firstSectionOffset = startTime;
      }
      
      startTime = startTime - firstSectionOffset;
      endTime = endTime - firstSectionOffset;
      
      const duration = endTime - startTime;
      sectionTimings.push({ start: startTime, end: endTime, duration });
      
      // Generate ASS dialogue entry with word wrapping to prevent text from going off screen
      const startTimeStr = this.formatAssTime(startTime);
      const endTimeStr = this.formatAssTime(endTime);
      const escapedText = this.escapeTextForAss(userTranscript);
      // Add word wrapping tag (\q2 = word wrap) to ensure text stays within screen bounds
      assContent += `Dialogue: 0,${startTimeStr},${endTimeStr},Default,,0,0,0,,{\\q2}${escapedText}\n`;
      
      // Remove matched words
      if (lastWordIndex >= firstWordIndex) {
        const removedCount = lastWordIndex - firstWordIndex + 1;
        availableWords.splice(firstWordIndex, removedCount);
      }
    }

    // Write ASS file
    const assFilePath = path.join(tempDir, `transcripts_regular_ass_${Date.now()}.ass`);
    const BOM = '\uFEFF';
    await fsPromises.writeFile(assFilePath, BOM + assContent, 'utf8');
    const assStats = await fsPromises.stat(assFilePath);
    this.logger.log(`${logPrefix} [generateRegularASSFromTranscripts] ✅ ASS file created: ${assFilePath} (${assStats.size} bytes)`);
    this.logger.log(`${logPrefix} [generateRegularASSFromTranscripts] Font: Noto Sans CJK KR, Size: 14, Plain style (white text with thin outline/shadow for visibility), Word wrapping enabled`);

    return { filePath: assFilePath, sectionTimings };
  }

  /**
   * Match user words to whisper words sequentially
   * Returns array of whisper word indices that matched
   */
  private matchUserWordsToWhisperWords(
    userWords: string[],
    whisperWords: Array<{ word: string; start: number; end: number; segmentIndex: number }>,
    startIndex: number,
    logPrefix: string,
    sectionNumber: number,
  ): number[] {
    this.logger.log(`${logPrefix} [matchUserWordsToWhisperWords] ===== Section ${sectionNumber} Word Matching =====`);
    this.logger.log(`${logPrefix} [matchUserWordsToWhisperWords] User words (${userWords.length}): [${userWords.slice(0, 10).join(', ')}${userWords.length > 10 ? '...' : ''}]`);
    this.logger.log(`${logPrefix} [matchUserWordsToWhisperWords] Whisper words: ${whisperWords.length} total, starting search from index ${startIndex}`);
    
    if (startIndex < whisperWords.length) {
      const nextWhisperWords = whisperWords.slice(startIndex, Math.min(startIndex + 10, whisperWords.length));
      this.logger.log(`${logPrefix} [matchUserWordsToWhisperWords] Next whisper words: [${nextWhisperWords.map((w, i) => `${startIndex + i}:"${w.word}"`).join(', ')}]`);
    }
    
    const matchedIndices: number[] = [];
    let currentSearchIndex = startIndex;
    
    // Normalize user words (lowercase, trim, remove punctuation)
    const normalizedUserWords = userWords.map(w => w.toLowerCase().trim().replace(/[.,!?;:]/g, ''));
    
    // Compare each user word to whisper words sequentially
    for (let i = 0; i < normalizedUserWords.length; i++) {
      const userWord = normalizedUserWords[i];
      const originalUserWord = userWords[i];
      let found = false;
      
      this.logger.log(`${logPrefix} [matchUserWordsToWhisperWords] 🔍 Searching for user word ${i + 1}/${userWords.length}: "${originalUserWord}" (normalized: "${userWord}")`);
      this.logger.log(`${logPrefix} [matchUserWordsToWhisperWords] Starting from whisper word index ${currentSearchIndex}`);
      
      // Search from currentSearchIndex onwards (limit to reasonable distance)
      const maxSearchDistance = Math.min(100, whisperWords.length - currentSearchIndex);
      
      for (let j = currentSearchIndex; j < currentSearchIndex + maxSearchDistance && j < whisperWords.length; j++) {
        const whisperWord = whisperWords[j].word.toLowerCase().trim().replace(/[.,!?;:]/g, '');
        const originalWhisperWord = whisperWords[j].word;
        
        // Log every 10th word or potential matches
        if ((j - currentSearchIndex) % 10 === 0 || whisperWord.includes(userWord) || userWord.includes(whisperWord)) {
          this.logger.debug(`${logPrefix} [matchUserWordsToWhisperWords] Checking whisper word [${j}]: "${originalWhisperWord}" (normalized: "${whisperWord}") vs user word "${userWord}"`);
        }
        
        // Check if words match
        const isMatch = this.wordsMatch(userWord, whisperWord);
        
        if (isMatch) {
          // Check if this word is next to the previous matched word (or is the first word)
          if (matchedIndices.length === 0) {
            // First word - accept it
            matchedIndices.push(j);
            currentSearchIndex = j + 1;
            found = true;
            this.logger.log(`${logPrefix} [matchUserWordsToWhisperWords] ✅ Matched word ${i + 1}/${userWords.length}: "${originalUserWord}" → "${originalWhisperWord}" at whisper index ${j} (FIRST WORD)`);
            break;
          } else {
            const lastMatchedIndex = matchedIndices[matchedIndices.length - 1];
            const gap = j - lastMatchedIndex;
            
            if (gap === 1) {
              // Perfect sequential match
              matchedIndices.push(j);
              currentSearchIndex = j + 1;
              found = true;
              this.logger.log(`${logPrefix} [matchUserWordsToWhisperWords] ✅ Matched word ${i + 1}/${userWords.length}: "${originalUserWord}" → "${originalWhisperWord}" at whisper index ${j} (SEQUENTIAL)`);
              break;
            } else if (gap <= 5 && gap > 0) {
              // Small gap allowed
              matchedIndices.push(j);
              currentSearchIndex = j + 1;
              found = true;
              this.logger.log(`${logPrefix} [matchUserWordsToWhisperWords] ✅ Matched word ${i + 1}/${userWords.length}: "${originalUserWord}" → "${originalWhisperWord}" at whisper index ${j} (GAP: ${gap})`);
              break;
            }
          }
        }
      }
      
      if (!found) {
        const checkedCount = Math.min(maxSearchDistance, whisperWords.length - currentSearchIndex);
        this.logger.warn(`${logPrefix} [matchUserWordsToWhisperWords] ❌ User word ${i + 1}/${userWords.length} "${originalUserWord}" NOT FOUND after checking ${checkedCount} whisper words`);
      }
    }
    
    if (matchedIndices.length > 0) {
      const firstWord = whisperWords[matchedIndices[0]];
      const lastWord = whisperWords[matchedIndices[matchedIndices.length - 1]];
      this.logger.log(`${logPrefix} [matchUserWordsToWhisperWords] ✅ Final: Matched ${matchedIndices.length}/${userWords.length} user words`);
      this.logger.log(`${logPrefix} [matchUserWordsToWhisperWords] First whisper word: [${matchedIndices[0]}] "${firstWord.word}" at ${firstWord.start}s`);
      this.logger.log(`${logPrefix} [matchUserWordsToWhisperWords] Last whisper word: [${matchedIndices[matchedIndices.length - 1]}] "${lastWord.word}" at ${lastWord.end}s`);
    } else {
      this.logger.warn(`${logPrefix} [matchUserWordsToWhisperWords] ❌ No words matched for section ${sectionNumber}`);
    }
    
    return matchedIndices;
  }

  /**
   * Find words from transcript in the combined whisper transcript
   * Checks if words exist and are next to each other (sequential matching)
   * 
   * @param transcriptWords - Words from the input transcript section
   * @param allWords - All words from whisper (combined from all segments)
   * @param logPrefix - Logging prefix
   * @param sectionNumber - Section number for logging
   * @param startSearchIndex - Optional: where to start searching (for sequential sections)
   */
  private findWordsInCombinedTranscript(
    transcriptWords: string[],
    allWords: Array<{ word: string; start: number; end: number; segmentIndex: number }>,
    logPrefix: string,
    sectionNumber: number,
    startSearchIndex: number = 0,
  ): number[] {
    this.logger.log(`${logPrefix} [findWordsInCombinedTranscript] ===== Section ${sectionNumber} Word Matching =====`);
    this.logger.log(`${logPrefix} [findWordsInCombinedTranscript] Looking for ${transcriptWords.length} words: [${transcriptWords.slice(0, 5).join(', ')}${transcriptWords.length > 5 ? '...' : ''}]`);
    this.logger.log(`${logPrefix} [findWordsInCombinedTranscript] In ${allWords.length} whisper words, starting from index ${startSearchIndex}`);
    if (startSearchIndex < allWords.length) {
      this.logger.log(`${logPrefix} [findWordsInCombinedTranscript] Next whisper word at index ${startSearchIndex}: "${allWords[startSearchIndex].word}"`);
    }
    
    const matchedIndices: number[] = [];
    let currentSearchIndex = startSearchIndex;
    
    // Normalize transcript words (lowercase, trim, remove punctuation)
    const normalizedTranscriptWords = transcriptWords.map(w => w.toLowerCase().trim().replace(/[.,!?;:]/g, ''));
    
    // Strategy 1: Try to find words sequentially starting from startSearchIndex
    for (let i = 0; i < normalizedTranscriptWords.length; i++) {
      const targetWord = normalizedTranscriptWords[i];
      const originalWord = transcriptWords[i];
      let found = false;
      
      this.logger.log(`${logPrefix} [findWordsInCombinedTranscript] 🔍 Searching for word ${i + 1}/${transcriptWords.length}: "${originalWord}" (normalized: "${targetWord}")`);
      this.logger.log(`${logPrefix} [findWordsInCombinedTranscript] Starting search from whisper word index ${currentSearchIndex}`);
      
      // Show next few whisper words for context
      const contextWords = allWords.slice(currentSearchIndex, Math.min(currentSearchIndex + 10, allWords.length));
      const contextText = contextWords.map((w, idx) => `[${currentSearchIndex + idx}]"${w.word}"`).join(', ');
      this.logger.log(`${logPrefix} [findWordsInCombinedTranscript] Next whisper words: ${contextText}`);
      
      // Search from currentSearchIndex onwards (but limit search window to prevent going too far)
      const maxSearchDistance = Math.min(100, allWords.length - currentSearchIndex); // Limit to 100 words ahead
      this.logger.log(`${logPrefix} [findWordsInCombinedTranscript] Will search up to ${maxSearchDistance} words ahead (until index ${currentSearchIndex + maxSearchDistance - 1})`);
      
      let checkedCount = 0;
      for (let j = currentSearchIndex; j < currentSearchIndex + maxSearchDistance && j < allWords.length; j++) {
        const whisperWord = allWords[j].word.toLowerCase().trim().replace(/[.,!?;:]/g, '');
        const originalWhisperWord = allWords[j].word;
        
        checkedCount++;
        
        // Log every 10th word checked, or if it's a potential match
        if (checkedCount % 10 === 0 || whisperWord.includes(targetWord) || targetWord.includes(whisperWord)) {
          this.logger.debug(`${logPrefix} [findWordsInCombinedTranscript] Checking whisper word [${j}]: "${originalWhisperWord}" (normalized: "${whisperWord}") vs target "${targetWord}"`);
        }
        
        // Check if words match (exact, contains, or similar)
        const isMatch = this.wordsMatch(targetWord, whisperWord);
        
        if (isMatch) {
          this.logger.log(`${logPrefix} [findWordsInCombinedTranscript] ✅ MATCH FOUND! Word [${j}]: "${originalWhisperWord}" matches "${originalWord}"`);
          
          // Check if this word is next to the previous matched word (or is the first word)
          if (matchedIndices.length === 0) {
            // First word - accept it
            matchedIndices.push(j);
            currentSearchIndex = j + 1;
            found = true;
            this.logger.log(`${logPrefix} [findWordsInCombinedTranscript] ✅ Matched word ${i + 1}/${transcriptWords.length}: "${originalWord}" → "${originalWhisperWord}" at index ${j} (FIRST WORD)`);
            break;
          } else {
            const lastMatchedIndex = matchedIndices[matchedIndices.length - 1];
            const gap = j - lastMatchedIndex;
            const lastMatchedWord = allWords[lastMatchedIndex].word;
            
            this.logger.log(`${logPrefix} [findWordsInCombinedTranscript] Previous match: word [${lastMatchedIndex}] "${lastMatchedWord}", gap: ${gap} words`);
            
            if (gap === 1) {
              // Perfect sequential match
              matchedIndices.push(j);
              currentSearchIndex = j + 1;
              found = true;
              this.logger.log(`${logPrefix} [findWordsInCombinedTranscript] ✅ Matched word ${i + 1}/${transcriptWords.length}: "${originalWord}" → "${originalWhisperWord}" at index ${j} (SEQUENTIAL, gap=1)`);
              break;
            } else if (gap <= 5 && gap > 0) {
              // Small gap allowed (up to 5 words)
              matchedIndices.push(j);
              currentSearchIndex = j + 1;
              found = true;
              this.logger.log(`${logPrefix} [findWordsInCombinedTranscript] ✅ Matched word ${i + 1}/${transcriptWords.length}: "${originalWord}" → "${originalWhisperWord}" at index ${j} (GAP ALLOWED, gap=${gap})`);
              break;
            } else {
              this.logger.debug(`${logPrefix} [findWordsInCombinedTranscript] Match found but gap too large (${gap} > 5), continuing search...`);
            }
          }
        }
      }
      
      if (!found) {
        this.logger.warn(`${logPrefix} [findWordsInCombinedTranscript] ❌ Word ${i + 1}/${transcriptWords.length} "${originalWord}" NOT FOUND after checking ${checkedCount} whisper words (from index ${currentSearchIndex} to ${currentSearchIndex + checkedCount - 1})`);
        // Show what words were checked
        const checkedWords = allWords.slice(currentSearchIndex, currentSearchIndex + Math.min(checkedCount, 20));
        const checkedWordsText = checkedWords.map((w, idx) => `[${currentSearchIndex + idx}]"${w.word}"`).join(', ');
        this.logger.warn(`${logPrefix} [findWordsInCombinedTranscript] Checked whisper words: ${checkedWordsText}${checkedCount > 20 ? '...' : ''}`);
      }
    }
    
    // Strategy 2: If we found very few words, try to find the first few words as a sequence
    if (matchedIndices.length < normalizedTranscriptWords.length * 0.3 && normalizedTranscriptWords.length > 0) {
      this.logger.log(`${logPrefix} [findWordsInCombinedTranscript] Only matched ${matchedIndices.length}/${transcriptWords.length} words, trying sequence matching...`);
      
      // Try to find first 3-5 words as a sequence starting from startSearchIndex
      const sequenceLength = Math.min(5, normalizedTranscriptWords.length);
      const firstWords = normalizedTranscriptWords.slice(0, sequenceLength);
      let bestMatchIndex = -1;
      let bestMatchCount = 0;
      
      // Search for the best sequence match
      for (let j = startSearchIndex; j < allWords.length - sequenceLength; j++) {
        let matchCount = 0;
        for (let k = 0; k < firstWords.length; k++) {
          const whisperWord = allWords[j + k].word.toLowerCase().trim().replace(/[.,!?;:]/g, '');
          const targetWord = firstWords[k];
          if (this.wordsMatch(targetWord, whisperWord)) {
            matchCount++;
          }
        }
        
        if (matchCount > bestMatchCount) {
          bestMatchCount = matchCount;
          bestMatchIndex = j;
        }
        
        // If we found a good match (3+ words), use it
        if (matchCount >= 3) {
          this.logger.log(`${logPrefix} [findWordsInCombinedTranscript] ✅ Found sequence of ${matchCount} words starting at index ${j}`);
          // Clear previous matches and use this sequence
          matchedIndices.length = 0;
          for (let i = 0; i < normalizedTranscriptWords.length && j + i < allWords.length; i++) {
            matchedIndices.push(j + i);
          }
          break;
        }
      }
      
      // If we found a partial sequence match, use it
      if (matchedIndices.length === 0 && bestMatchIndex >= 0 && bestMatchCount >= 2) {
        this.logger.log(`${logPrefix} [findWordsInCombinedTranscript] Using partial sequence match: ${bestMatchCount} words starting at index ${bestMatchIndex}`);
        for (let i = 0; i < normalizedTranscriptWords.length && bestMatchIndex + i < allWords.length; i++) {
          matchedIndices.push(bestMatchIndex + i);
        }
      }
    }
    
    if (matchedIndices.length > 0) {
      const firstWord = allWords[matchedIndices[0]];
      const lastWord = allWords[matchedIndices[matchedIndices.length - 1]];
      this.logger.log(`${logPrefix} [findWordsInCombinedTranscript] ✅ Final: Matched ${matchedIndices.length}/${transcriptWords.length} words`);
      this.logger.log(`${logPrefix} [findWordsInCombinedTranscript] First word: "${firstWord.word}" at ${firstWord.start}s, Last word: "${lastWord.word}" at ${lastWord.end}s`);
    } else {
      this.logger.warn(`${logPrefix} [findWordsInCombinedTranscript] ❌ No words matched for section ${sectionNumber}`);
    }
    
    return matchedIndices;
  }

  /**
   * Check if two words match (handles transliteration differences like Lido vs 리도)
   */
  private wordsMatch(word1: string, word2: string): boolean {
    // Exact match
    if (word1 === word2) return true;
    
    // Contains match (one contains the other)
    if (word1.includes(word2) || word2.includes(word1)) return true;
    
    // For Korean/English transliteration, we can't easily match "Lido" with "리도"
    // So we'll be more lenient - if words are similar length and share some characters, consider it a match
    // This is a simple heuristic - for production, you might want to use a proper transliteration library
    
    // Remove all non-alphanumeric characters for comparison
    const clean1 = word1.replace(/[^a-zA-Z0-9가-힣]/g, '');
    const clean2 = word2.replace(/[^a-zA-Z0-9가-힣]/g, '');
    
    if (clean1 === clean2) return true;
    if (clean1.includes(clean2) || clean2.includes(clean1)) return true;
    
    return false;
  }

  /**
   * Generate ASS from transcripts with word-level timestamps (3 words per subtitle)
   */
  private async generateASSFromTranscripts(
    whisperResult: any,
    transcripts: string[],
    tempDir: string,
    logPrefix: string,
    useKaraokeStyle: boolean = true, // true = karaoke (social media), false = plain white/black
  ): Promise<string> {
    this.logger.log(`${logPrefix} [generateASSFromTranscripts] Generating ASS from ${transcripts.length} transcripts...`);
    
    const segments = whisperResult.segments || [];
    let currentSegmentIndex = 0; // Track which segments we've already used
    
    // ASS header - use different styles based on useKaraokeStyle
    const title = useKaraokeStyle ? 'Social Media Subtitles' : 'Plain Subtitles';
    const fontName = 'Noto Sans CJK KR'; // Force CJK font for all subtitle styles
    const fontSize = useKaraokeStyle ? '10' : '12'; // 10px for social media, 12px for plain
    const primaryColor = useKaraokeStyle ? '&H00FFFF' : '&H00FFFFFF'; // Yellow for karaoke, White for plain
    const secondaryColor = '&H00FFFFFF'; // White
    const outlineColor = '&H00000000'; // Black
    const backColor = useKaraokeStyle ? '&H80000000' : '&H80000000'; // Semi-transparent black for both styles
    const bold = useKaraokeStyle ? '-1' : '0'; // Bold for karaoke, normal for plain
    const borderStyle = useKaraokeStyle ? '1' : '3'; // Outline and drop shadow for karaoke, opaque box for plain
    const outline = useKaraokeStyle ? '1' : '2'; // 1px for karaoke, 2px for plain (required for BorderStyle 3)
    const shadow = useKaraokeStyle ? '0' : '0'; // No shadow for both styles
    const marginV = useKaraokeStyle ? '80' : '80'; // 80px from bottom for both styles
    const marginL = useKaraokeStyle ? '10' : '10'; // 10px for both styles
    const marginR = useKaraokeStyle ? '10' : '10'; // 10px for both styles
    
    let assContent = `[Script Info]
Title: ${title}
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontName},${fontSize},${primaryColor},${secondaryColor},${outlineColor},${backColor},${bold},0,0,0,100,100,0,0,${borderStyle},${outline},${shadow},2,${marginL},${marginR},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

    // Step 1: Extract all words from whisper segments (already split)
    const whisperWords: Array<{ word: string; start: number; end: number; segmentIndex: number }> = [];
    
    for (let segIdx = 0; segIdx < segments.length; segIdx++) {
      const segment = segments[segIdx];
      const words = segment.words || [];
      
      for (const wordInfo of words) {
        const word = (wordInfo.text || wordInfo.word || '').trim();
        if (word && word !== '[*]' && word.length > 0) {
          whisperWords.push({
            word: word,
            start: wordInfo.start || segment.start || 0,
            end: wordInfo.end || segment.end || 0,
            segmentIndex: segIdx,
          });
        }
      }
    }
    
    this.logger.log(`${logPrefix} [generateASSFromTranscripts] Extracted ${whisperWords.length} words from ${segments.length} segments`);
    this.logger.log(`${logPrefix} [generateASSFromTranscripts] First 10 whisper words: ${whisperWords.slice(0, 10).map((w, i) => `[${i}]"${w.word}"`).join(', ')}`);
    
    // Create a mutable copy of whisperWords that we can remove from
    let availableWords = [...whisperWords];
    let firstSectionOffset = 0; // Track the offset for the first section

    for (let i = 0; i < transcripts.length; i++) {
      const userTranscript = transcripts[i].trim();
      this.logger.log(`${logPrefix} [generateASSFromTranscripts] ===== Section ${i + 1} =====`);
      this.logger.log(`${logPrefix} [generateASSFromTranscripts] Section ${i + 1} user transcript: "${userTranscript}"`);
      
      // Split user transcript into words
      const userWords = userTranscript.split(/\s+/).filter(w => w.length > 0);
      this.logger.log(`${logPrefix} [generateASSFromTranscripts] Section ${i + 1}: Split into ${userWords.length} words: [${userWords.join(', ')}]`);
      
      if (userWords.length === 0) {
        this.logger.warn(`${logPrefix} [generateASSFromTranscripts] ⚠️ Section ${i + 1}: Empty transcript, skipping`);
        continue;
      }
      
      // Find first word
      let firstWordIndex = -1;
      let firstWordStartTime = 0;
      
      if (i === 0) {
        // For first section: find first word (try first, then second, etc. if not found)
        for (let wordIdx = 0; wordIdx < userWords.length; wordIdx++) {
          const userWord = userWords[wordIdx];
          const normalizedUserWord = this.normalizeWord(userWord);
          
          // Search for this word in available words
          for (let j = 0; j < availableWords.length; j++) {
            const whisperWord = availableWords[j];
            const normalizedWhisperWord = this.normalizeWord(whisperWord.word);
            
            if (this.wordsMatch(normalizedUserWord, normalizedWhisperWord)) {
              firstWordIndex = j;
              firstWordStartTime = whisperWord.start;
              this.logger.log(`${logPrefix} [generateASSFromTranscripts] Section ${i + 1}: Found first word "${userWord}" at index ${j} (start: ${firstWordStartTime}s)`);
              break;
            }
          }
          
          if (firstWordIndex !== -1) {
            break;
          }
      }
      
        if (firstWordIndex === -1) {
          this.logger.warn(`${logPrefix} [generateASSFromTranscripts] ⚠️ Section ${i + 1}: First word not found, skipping`);
        continue;
      }
      } else {
        // For subsequent sections: first word is at index 0 (since we removed previous sections)
        if (availableWords.length === 0) {
          this.logger.warn(`${logPrefix} [generateASSFromTranscripts] ⚠️ Section ${i + 1}: No available words left, skipping`);
          continue;
        }
        firstWordIndex = 0;
        firstWordStartTime = availableWords[0].start;
        this.logger.log(`${logPrefix} [generateASSFromTranscripts] Section ${i + 1}: Using first available word at index 0 (start: ${firstWordStartTime}s)`);
      }
      
      // Find last word (handle punctuation like periods)
      let lastWordIndex = -1;
      let lastWordEndTime = 0;
      
      // Search from the end of user words
      for (let wordIdx = userWords.length - 1; wordIdx >= 0; wordIdx--) {
        const userWord = userWords[wordIdx];
        const normalizedUserWord = this.normalizeWord(userWord);
        
        // Search for this word in available words (starting from firstWordIndex)
        for (let j = firstWordIndex; j < availableWords.length; j++) {
          const whisperWord = availableWords[j];
          const normalizedWhisperWord = this.normalizeWord(whisperWord.word);
          
          if (this.wordsMatch(normalizedUserWord, normalizedWhisperWord)) {
            lastWordIndex = j;
            lastWordEndTime = whisperWord.end;
            this.logger.log(`${logPrefix} [generateASSFromTranscripts] Section ${i + 1}: Found last word "${userWord}" at index ${j} (end: ${lastWordEndTime}s)`);
            break;
          }
        }
        
        if (lastWordIndex !== -1) {
          break;
        }
      }
      
      if (lastWordIndex === -1) {
        // If last word not found, use the first word's end time
        lastWordIndex = firstWordIndex;
        lastWordEndTime = availableWords[firstWordIndex].end;
        this.logger.warn(`${logPrefix} [generateASSFromTranscripts] Section ${i + 1}: Last word not found, using first word's end time`);
      }
      
      // Get all words from firstWordIndex to lastWordIndex (Whisper words for timestamps only)
      const whisperWordsForTiming = availableWords.slice(firstWordIndex, lastWordIndex + 1);
      
      this.logger.log(`${logPrefix} [generateASSFromTranscripts] Section ${i + 1}: Matched ${whisperWordsForTiming.length} whisper words from index ${firstWordIndex} to ${lastWordIndex}`);
      this.logger.log(`${logPrefix} [generateASSFromTranscripts] Section ${i + 1}: User transcript: "${userTranscript}"`);
      
      if (whisperWordsForTiming.length === 0) {
        this.logger.warn(`${logPrefix} [generateASSFromTranscripts] ⚠️ Section ${i + 1}: No matching words, skipping`);
        continue;
      }

      // Store the offset for the first section, then apply it to all sections
      if (i === 0) {
        firstSectionOffset = firstWordStartTime;
        this.logger.log(`${logPrefix} [generateASSFromTranscripts] Section ${i + 1}: First section offset: ${firstSectionOffset}s`);
      }
      
      // Calculate overall timing from Whisper (first word start to last word end)
      const sectionStartTime = whisperWordsForTiming[0].start - firstSectionOffset;
      const sectionEndTime = whisperWordsForTiming[whisperWordsForTiming.length - 1].end - firstSectionOffset;
      const sectionDuration = sectionEndTime - sectionStartTime;
      
      // Map user transcript words to timestamps (distribute Whisper timing across user words)
      const userWordsCount = userWords.length;
      const wordsWithTiming: Array<{ text: string; start: number; end: number }> = [];
      
      for (let wordIdx = 0; wordIdx < userWordsCount; wordIdx++) {
        // Distribute time evenly across user words
        const wordDuration = sectionDuration / userWordsCount;
        const wordStart = sectionStartTime + (wordIdx * wordDuration);
        const wordEnd = wordStart + wordDuration;
        
        wordsWithTiming.push({
          text: userWords[wordIdx], // Use USER's transcript word, not Whisper's
          start: wordStart,
          end: wordEnd,
        });
      }
      
      this.logger.log(`${logPrefix} [generateASSFromTranscripts] Section ${i + 1}: Using ${userWordsCount} user words with Whisper timestamps (${sectionStartTime.toFixed(2)}s - ${sectionEndTime.toFixed(2)}s)`);

      // Group words into chunks of 3
      for (let j = 0; j < wordsWithTiming.length; j += 3) {
        const chunkWords = wordsWithTiming.slice(j, j + 3);
        if (chunkWords.length === 0) continue;

        const firstWord = chunkWords[0];
        const lastWord = chunkWords[chunkWords.length - 1];
        
        const startTime = firstWord.start;
        const endTime = lastWord.end;
        
        // Build text - karaoke style with {\k} tags OR plain text
        let subtitleText = '';
        if (useKaraokeStyle) {
          // Build karaoke text with {\k} tags using USER's transcript words
          for (let k = 0; k < chunkWords.length; k++) {
            const word = chunkWords[k];
            const wordDuration = word.end - word.start;
            const highlightCs = Math.max(10, Math.round(wordDuration * 100)); // Convert to centiseconds
            
            subtitleText += `{\\k${highlightCs}}${this.escapeTextForAss(word.text)}`; // Use user's text, not Whisper's
            if (k < chunkWords.length - 1) {
              subtitleText += ' ';
            }
          }
        } else {
          // Plain text - just join words with spaces, add word wrapping
          const plainText = chunkWords.map(w => this.escapeTextForAss(w.text)).join(' ');
          subtitleText = `{\\q2}${plainText}`; // {\q2} = word wrapping
        }

        const startTimeStr = this.formatAssTime(startTime);
        const endTimeStr = this.formatAssTime(endTime);
        
        this.logger.log(`${logPrefix} [generateASSFromTranscripts] Section ${i + 1} chunk ${Math.floor(j/3) + 1}: "${subtitleText}" (${startTimeStr} - ${endTimeStr})`);
        assContent += `Dialogue: 0,${startTimeStr},${endTimeStr},Default,,0,0,0,,${subtitleText}\n`;
      }
      
      // Remove matched words from availableWords array
      // Remove all words from firstWordIndex to lastWordIndex (inclusive)
      if (lastWordIndex >= firstWordIndex) {
        const removedCount = lastWordIndex - firstWordIndex + 1;
        availableWords.splice(firstWordIndex, removedCount);
        this.logger.log(`${logPrefix} [generateASSFromTranscripts] Section ${i + 1}: Removed ${removedCount} words from available words (${availableWords.length} remaining)`);
      }
    }

    // Write ASS file
    const assFilePath = path.join(tempDir, `transcripts_ass_${Date.now()}.ass`);
    const BOM = '\uFEFF';
    await fsPromises.writeFile(assFilePath, BOM + assContent, 'utf8');
    const assFileStats = await fsPromises.stat(assFilePath);
    this.logger.log(`${logPrefix} [generateASSFromTranscripts] ✅ ASS file created: ${assFilePath} (${assFileStats.size} bytes)`);
    this.logger.log(`${logPrefix} [generateASSFromTranscripts] 💾 ASS file saved for debugging: ${assFilePath}`);
    this.logger.log(`${logPrefix} [generateASSFromTranscripts] 📁 ASS file absolute path: ${path.resolve(assFilePath)}`);
    
    // Log a preview of the ASS content
    const previewLines = assContent.split('\n').slice(0, 10).join('\n');
    this.logger.log(`${logPrefix} [generateASSFromTranscripts] 📝 ASS file preview (first 10 lines):\n${previewLines}`);

    return assFilePath;
  }

  /**
   * Calculate section timings from whisper result by matching transcripts
   * Uses word-level matching: combines all words, then finds transcript words sequentially
   */
  private async calculateSectionTimingsFromWhisper(
    whisperResult: any,
    transcripts: string[],
    logPrefix: string,
  ): Promise<Array<{ start: number; end: number; duration: number }>> {
    this.logger.log(`${logPrefix} [calculateSectionTimingsFromWhisper] Using new word-level matching for ${transcripts.length} sections`);
    
    // Step 1: Combine all words from all segments into a single array
    const segments = whisperResult.segments || [];
    const allWords: Array<{ word: string; start: number; end: number; segmentIndex: number }> = [];
    
    for (let segIdx = 0; segIdx < segments.length; segIdx++) {
      const segment = segments[segIdx];
      const words = segment.words || [];
      
      for (const wordInfo of words) {
        const word = (wordInfo.text || wordInfo.word || '').trim();
        if (word && word !== '[*]' && word.length > 0) {
          allWords.push({
            word: word,
            start: wordInfo.start || segment.start || 0,
            end: wordInfo.end || segment.end || 0,
            segmentIndex: segIdx,
          });
        }
      }
    }
    
    this.logger.log(`${logPrefix} [calculateSectionTimingsFromWhisper] Combined ${allWords.length} words from ${segments.length} segments`);
    
    const sectionTimings: Array<{ start: number; end: number; duration: number }> = [];
    // Create a mutable copy of allWords that we can remove from
    let availableWords = [...allWords];
    let firstSectionOffset = 0; // Track the offset for the first section

    for (let i = 0; i < transcripts.length; i++) {
      const transcript = transcripts[i].trim();
      this.logger.log(`${logPrefix} [calculateSectionTimingsFromWhisper] ===== Section ${i + 1} =====`);
      this.logger.log(`${logPrefix} [calculateSectionTimingsFromWhisper] Section ${i + 1} transcript: "${transcript}"`);
      
      // Step 2: Split section into words
      const sectionWords = transcript.split(/\s+/).filter(w => w.length > 0);
      
      if (sectionWords.length === 0) {
        const prevEnd = i > 0 ? sectionTimings[i - 1].end : 0;
        sectionTimings.push({ start: prevEnd, end: prevEnd + 5, duration: 5 });
        this.logger.warn(`${logPrefix} [calculateSectionTimingsFromWhisper] Section ${i + 1}: Empty transcript, using fallback`);
        continue;
      }
      
      this.logger.log(`${logPrefix} [calculateSectionTimingsFromWhisper] Section ${i + 1} words: [${sectionWords.join(', ')}]`);
      
      // Step 3: Find first word
      let firstWordIndex = -1;
      let firstWordStartTime = 0;
      
      if (i === 0) {
        // For first section: find first word (try first, then second, etc. if not found)
        for (let wordIdx = 0; wordIdx < sectionWords.length; wordIdx++) {
          const sectionWord = sectionWords[wordIdx];
          const normalizedSectionWord = this.normalizeWord(sectionWord);
      
          // Search for this word in available words
          for (let j = 0; j < availableWords.length; j++) {
            const whisperWord = availableWords[j];
            const normalizedWhisperWord = this.normalizeWord(whisperWord.word);
            
            if (this.wordsMatch(normalizedSectionWord, normalizedWhisperWord)) {
              firstWordIndex = j;
              firstWordStartTime = whisperWord.start;
              this.logger.log(`${logPrefix} [calculateSectionTimingsFromWhisper] Section ${i + 1}: Found first word "${sectionWord}" at index ${j} (start: ${firstWordStartTime}s)`);
              break;
            }
      }
      
          if (firstWordIndex !== -1) {
            break;
          }
        }
        
        if (firstWordIndex === -1) {
          this.logger.warn(`${logPrefix} [calculateSectionTimingsFromWhisper] Section ${i + 1}: First word not found, using fallback`);
        const prevEnd = i > 0 ? sectionTimings[i - 1].end : 0;
        sectionTimings.push({ start: prevEnd, end: prevEnd + 5, duration: 5 });
        continue;
      }
      } else {
        // For subsequent sections: first word is at index 0 (since we removed previous sections)
        if (availableWords.length === 0) {
          this.logger.warn(`${logPrefix} [calculateSectionTimingsFromWhisper] Section ${i + 1}: No available words left, using fallback`);
          const prevEnd = sectionTimings[i - 1].end;
          sectionTimings.push({ start: prevEnd, end: prevEnd + 5, duration: 5 });
          continue;
        }
        firstWordIndex = 0;
        firstWordStartTime = availableWords[0].start;
        this.logger.log(`${logPrefix} [calculateSectionTimingsFromWhisper] Section ${i + 1}: Using first available word at index 0 (start: ${firstWordStartTime}s)`);
      }
      
      // Step 4: Find last word (handle punctuation like periods)
      let lastWordIndex = -1;
      let lastWordEndTime = 0;
      
      // Search from the end of section words
      for (let wordIdx = sectionWords.length - 1; wordIdx >= 0; wordIdx--) {
        const sectionWord = sectionWords[wordIdx];
        const normalizedSectionWord = this.normalizeWord(sectionWord);
        
        // Search for this word in available words (starting from firstWordIndex)
        for (let j = firstWordIndex; j < availableWords.length; j++) {
          const whisperWord = availableWords[j];
          const normalizedWhisperWord = this.normalizeWord(whisperWord.word);
          
          if (this.wordsMatch(normalizedSectionWord, normalizedWhisperWord)) {
            lastWordIndex = j;
            lastWordEndTime = whisperWord.end;
            this.logger.log(`${logPrefix} [calculateSectionTimingsFromWhisper] Section ${i + 1}: Found last word "${sectionWord}" at index ${j} (end: ${lastWordEndTime}s)`);
            break;
          }
        }
        
        if (lastWordIndex !== -1) {
          break;
        }
      }
      
      if (lastWordIndex === -1) {
        // If last word not found, use the first word's end time
        lastWordIndex = firstWordIndex;
        lastWordEndTime = availableWords[firstWordIndex].end;
        this.logger.warn(`${logPrefix} [calculateSectionTimingsFromWhisper] Section ${i + 1}: Last word not found, using first word's end time`);
      }
      
      // Step 5: Get start and end times
      let startTime = firstWordStartTime;
      let endTime = lastWordEndTime;
      
      // Store the offset for the first section, then apply it to all sections
      if (i === 0) {
        firstSectionOffset = startTime;
        this.logger.log(`${logPrefix} [calculateSectionTimingsFromWhisper] Section ${i + 1}: First section offset: ${firstSectionOffset}s`);
      }
      
      // Apply offset to all sections (so first section starts at 0.00)
      startTime = startTime - firstSectionOffset;
      endTime = endTime - firstSectionOffset;
      
      const duration = endTime - startTime;
      sectionTimings.push({ start: startTime, end: endTime, duration });
      
      this.logger.log(`${logPrefix} [calculateSectionTimingsFromWhisper] Section ${i + 1}: ${startTime}s - ${endTime}s (duration: ${duration}s)`);
      
      // Step 6: Remove matched words from availableWords array
      // Remove all words from firstWordIndex to lastWordIndex (inclusive)
      if (lastWordIndex >= firstWordIndex) {
        const removedCount = lastWordIndex - firstWordIndex + 1;
        availableWords.splice(firstWordIndex, removedCount);
        this.logger.log(`${logPrefix} [calculateSectionTimingsFromWhisper] Section ${i + 1}: Removed ${removedCount} words from available words (${availableWords.length} remaining)`);
      }
    }

    return sectionTimings;
  }

  /**
   * Normalize word for comparison (lowercase, remove punctuation)
   */
  private normalizeWord(word: string): string {
    return word.toLowerCase().trim().replace(/[.,!?;:]/g, '');
  }

  /**
   * Find matching segments sequentially starting from a given index
   * This ensures each transcript gets unique, non-overlapping segments
   * 
   * MATCHING LOGIC EXPLANATION:
   * 1. Takes transcript text and splits it into words
   * 2. Starts from startIndex and accumulates segment texts
   * 3. For each segment added, counts how many transcript words are found in accumulated text
   * 4. If 60%+ words match, considers it a good match and stops
   * 5. If no good match after 20 segments, uses fallback (consumes remaining segments)
   * 
   * PROBLEM: If a transcript doesn't match well, it can consume ALL remaining segments
   */
  private findMatchingSegmentsSequential(
    transcript: string,
    segments: any[],
    startIndex: number,
    logPrefix: string,
  ): { segments: any[]; nextIndex: number } {
    const transcriptLower = transcript.toLowerCase().trim();
    const transcriptWords = transcriptLower.split(/\s+/).filter(w => w.length > 0);
    
    this.logger.log(`${logPrefix} [findMatchingSegmentsSequential] ===== MATCHING START =====`);
    this.logger.log(`${logPrefix} [findMatchingSegmentsSequential] Transcript: "${transcript.substring(0, 80)}..." (${transcriptWords.length} words)`);
    this.logger.log(`${logPrefix} [findMatchingSegmentsSequential] Starting from segment index ${startIndex} (total segments: ${segments.length})`);
    this.logger.log(`${logPrefix} [findMatchingSegmentsSequential] Available segments: ${segments.length - startIndex}`);
    
    if (transcriptWords.length === 0 || startIndex >= segments.length) {
      this.logger.warn(`${logPrefix} [findMatchingSegmentsSequential] ⚠️ No segments available (startIndex=${startIndex}, total=${segments.length})`);
      return { segments: [], nextIndex: startIndex };
    }

    const matchingSegments: any[] = [];
    let accumulatedText = '';
    let matchedWordCount = 0;
    let bestMatchRatio = 0;
    let bestMatchIndex = -1;
    
    // Start from startIndex and look for matching segments (limit to reasonable number)
    const maxSegmentsToCheck = Math.min(20, segments.length - startIndex);
    this.logger.log(`${logPrefix} [findMatchingSegmentsSequential] Will check up to ${maxSegmentsToCheck} segments`);
    
    for (let i = startIndex; i < segments.length && i < startIndex + maxSegmentsToCheck; i++) {
      const segment = segments[i];
      const segmentText = (segment.text || '').toLowerCase().trim();
      
      if (!segmentText) {
        this.logger.debug(`${logPrefix} [findMatchingSegmentsSequential] Segment ${i}: Empty text, skipping`);
        continue;
      }
      
      this.logger.debug(`${logPrefix} [findMatchingSegmentsSequential] Segment ${i}: "${segmentText.substring(0, 60)}..."`);
      
      accumulatedText += ' ' + segmentText;
      matchingSegments.push(segment);
      
      // Count how many transcript words are found in accumulated text
      matchedWordCount = 0;
      const matchedWords: string[] = [];
      for (const word of transcriptWords) {
        if (accumulatedText.includes(word)) {
          matchedWordCount++;
          matchedWords.push(word);
        }
      }
      
      const matchRatio = matchedWordCount / transcriptWords.length;
      
      // Track best match
      if (matchRatio > bestMatchRatio) {
        bestMatchRatio = matchRatio;
        bestMatchIndex = i;
      }
      
      this.logger.debug(`${logPrefix} [findMatchingSegmentsSequential] After segment ${i}: ${matchedWordCount}/${transcriptWords.length} words matched (${(matchRatio * 100).toFixed(1)}%)`);
      if (matchedWords.length > 0 && matchedWords.length <= 5) {
        this.logger.debug(`${logPrefix} [findMatchingSegmentsSequential] Matched words: ${matchedWords.join(', ')}`);
      }
      
      // If we've matched at least 60% of words, this is a good match
      if (matchRatio >= 0.6) {
        // Try to get a few more segments to ensure we capture the full transcript
        let additionalSegments = 0;
        for (let j = i + 1; j < segments.length && j < i + 3 && additionalSegments < 2; j++) {
          const nextSegment = segments[j];
          const nextText = (nextSegment.text || '').toLowerCase().trim();
          if (nextText) {
            matchingSegments.push(nextSegment);
            additionalSegments++;
            this.logger.debug(`${logPrefix} [findMatchingSegmentsSequential] Added additional segment ${j}`);
          }
        }
        this.logger.log(`${logPrefix} [findMatchingSegmentsSequential] ✅ GOOD MATCH: ${matchedWordCount}/${transcriptWords.length} words (${(matchRatio * 100).toFixed(1)}%) using ${matchingSegments.length} segments (indices ${startIndex}-${i + additionalSegments})`);
        this.logger.log(`${logPrefix} [findMatchingSegmentsSequential] Next section will start at segment index ${i + additionalSegments + 1}`);
        return { segments: matchingSegments, nextIndex: i + additionalSegments + 1 };
      }
    }

    // If no good match found, use a few segments anyway (fallback)
    // BUT: Limit fallback to prevent consuming all segments
    const remainingSegments = segments.length - startIndex;
    const segmentsPerSection = Math.max(1, Math.floor(remainingSegments / 10)); // Divide remaining segments roughly
    const fallbackLimit = Math.min(segmentsPerSection * 2, remainingSegments); // Use at most 2x average per section
    
    if (matchingSegments.length === 0 && startIndex < segments.length) {
      // Use limited fallback
      for (let i = startIndex; i < segments.length && i < startIndex + fallbackLimit; i++) {
        matchingSegments.push(segments[i]);
      }
      this.logger.warn(`${logPrefix} [findMatchingSegmentsSequential] ⚠️ No good match found, using LIMITED fallback: ${matchingSegments.length} segments (limit: ${fallbackLimit})`);
      this.logger.warn(`${logPrefix} [findMatchingSegmentsSequential] Best match was ${(bestMatchRatio * 100).toFixed(1)}% at segment ${bestMatchIndex}`);
      return { segments: matchingSegments, nextIndex: startIndex + matchingSegments.length };
    }

    // Partial match - also limit to prevent consuming all
    const limitedSegments = matchingSegments.slice(0, Math.min(matchingSegments.length, fallbackLimit));
    this.logger.warn(`${logPrefix} [findMatchingSegmentsSequential] ⚠️ PARTIAL MATCH: ${matchedWordCount}/${transcriptWords.length} words (${(bestMatchRatio * 100).toFixed(1)}%), using LIMITED ${limitedSegments.length} segments (was ${matchingSegments.length}, limit: ${fallbackLimit})`);
    this.logger.warn(`${logPrefix} [findMatchingSegmentsSequential] Best match was at segment ${bestMatchIndex}`);
    return { segments: limitedSegments, nextIndex: startIndex + limitedSegments.length };
  }

  /**
   * Find matching words in whisper result for a given transcript
   * Uses sequential matching to avoid reusing segments
   */
  private findMatchingWords(
    transcript: string,
    segments: any[],
    logPrefix: string,
    startIndex: number = 0,
  ): { words: Array<{ word: string; start: number; end: number }>; nextIndex: number } {
    const transcriptWords = transcript.split(/\s+/).filter(w => w.length > 0);
    const matchingWords: Array<{ word: string; start: number; end: number }> = [];
    
    // Find matching segments sequentially
    const matchingResult = this.findMatchingSegmentsSequential(transcript, segments, startIndex, logPrefix);
    
    if (matchingResult.segments.length === 0) {
      return { words: [], nextIndex: startIndex };
    }

    // Extract words from matching segments
    for (const segment of matchingResult.segments) {
      const words = segment.words || [];
      for (const wordInfo of words) {
        const word = (wordInfo.word || '').trim();
        if (word && word !== '[*]' && word.length > 0) {
          matchingWords.push({
            word: word,
            start: wordInfo.start || segment.start || 0,
            end: wordInfo.end || segment.end || 0,
          });
        }
      }
    }

    this.logger.debug(`${logPrefix} [findMatchingWords] Found ${matchingWords.length} matching words for transcript (${transcriptWords.length} words)`);
    return { words: matchingWords, nextIndex: matchingResult.nextIndex };
  }

  /**
   * Create video from image with specified duration
   */
  private async createVideoFromImage(
    imagePath: string,
    outputPath: string,
    duration: number,
    width: number,
    height: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // Calculate zoom parameters
      // Start at 80% scale, end at 100% scale
      const startScale = 0.8;
      const endScale = 1.0;
      const fps = 30;
      
      // Create complex filter for Ken Burns effect with blurred background
      // Strategy: Use the same image twice - once for background (blurred), once for foreground (zoomed)
      // Bottom layer: 100% scale + blur
      // Top layer: 80% to 100% zoom (centered) - scale from larger to smaller
      
      // For the zoom effect: we need to scale from a larger size (showing 80%) to full size (showing 100%)
      // So we start with the image scaled to show 80% of it, then zoom to show 100%
      // This means: start scale = width/0.8, end scale = width
      const startWidth = Math.round(width / startScale);
      const startHeight = Math.round(height / startScale);
      
      // Calculate zoom values: start at 1.25 (shows 80% of image), end at 1.0 (shows 100%)
      const zoomStart = 1.0 / startScale; // 1.25
      const zoomEnd = 1.0 / endScale; // 1.0
      const zoomDecrement = (zoomStart - zoomEnd) / (duration * fps); // Per-frame decrement
      
      const filterComplex = [
        // Bottom layer: scale to full size and apply blur
        `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,boxblur=20:1[bg]`,
        // Top layer: animated zoom from 80% to 100%
        // Scale the image larger first, then use zoompan to zoom from center
        // zoompan: z starts at 1.25 (showing 80%) and decreases to 1.0 (showing 100%)
        `[0:v]scale=${startWidth}:${startHeight}:force_original_aspect_ratio=decrease,pad=${startWidth}:${startHeight}:(ow-iw)/2:(oh-ih)/2:black,zoompan=z='if(lte(zoom,${zoomStart}),${zoomStart}-${zoomDecrement}*on,${zoomEnd})':d=${Math.round(duration * fps)}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${width}x${height}[fg]`,
        // Overlay: center the top layer on the bottom layer
        `[bg][fg]overlay=(W-w)/2:(H-h)/2`
      ].join(';');
      
      this.logger.log(`[createVideoFromImage] Creating video with Ken Burns effect: ${duration}s, ${width}x${height}`);
      this.logger.log(`[createVideoFromImage] Zoom: ${startScale * 100}% → ${endScale * 100}%`);
      this.logger.log(`[createVideoFromImage] Source size for zoom: ${startWidth}x${startHeight}`);
      
      ffmpeg()
        .input(imagePath)
        .inputOptions(['-loop', '1', '-framerate', `${fps}`])
        .videoCodec('libx264')
        .outputOptions([
          `-t ${duration}`,
          `-filter_complex`, filterComplex,
          '-pix_fmt yuv420p',
          `-r ${fps}`,
          '-avoid_negative_ts', 'make_zero',
          '-fflags', '+genpts',
          '-preset', 'fast',
          '-crf', '23',
        ])
        .output(outputPath)
        .on('start', (commandLine) => {
          this.logger.debug(`[createVideoFromImage] FFmpeg command: ${commandLine}`);
        })
        .on('end', () => {
          this.logger.log(`[createVideoFromImage] ✅ Video created with Ken Burns effect: ${outputPath}`);
          resolve();
        })
        .on('error', (error) => {
          this.logger.error(`[createVideoFromImage] ❌ Error creating video: ${error.message}`);
          reject(error);
        })
        .run();
    });
  }

  private async createVerticalPosterVideo(
    imagePath: string,
    outputPath: string,
    duration: number,
    canvasWidth: number,
    canvasHeight: number,
    topHeadlineText?: string,
    bottomHeadlineText?: string,
    verticalGap: number = 24,
    inputRatio: string = '3:4',
    logPrefix: string = '',
    skipHeadlineRendering: boolean = false, // NEW: Skip headline rendering (will use ASS instead)
  ): Promise<void> {
    return new Promise(async (resolve, reject) => {
      const fps = 30;

      // Fixed layout for vertical poster:
      // - Image area 1080x1440 positioned at y=240 on 1080x1920 canvas
      const imageWidth = canvasWidth;
      const imageHeight = 1440;
      const imageTop = 240;

      const topHeadlineFontSize = 96;
      const bottomHeadlineFontSize = 80;
      const borderWidth = 5;
      const lineHeight = 1.15;
      // Increased padding from 200px (100px each side) to 120px each side for better spacing
      const horizontalPadding = 120;
      const textMaxWidth = canvasWidth - (horizontalPadding * 2);

      // Use Hakgyoansim font for headlines
      const projectFontPath = path.join(process.cwd(), 'public', 'hakgyoansim-jiugae', 'HakgyoansimJiugaeR.ttf');
      const dockerFontPath = '/app/public/hakgyoansim-jiugae/HakgyoansimJiugaeR.ttf';
      const cjkFontPath = '/usr/share/fonts/noto/NotoSansCJK-Bold.ttc';
      
      // Prioritize Hakgyoansim font, fallback to CJK if not found
      const headlineFontPath = [
        projectFontPath,
        dockerFontPath,
        cjkFontPath,
      ].find(p => fs.existsSync(p)) || cjkFontPath;

      const wrapText = (text: string, fontSize: number, maxWidth: number, maxLines: number): string[] => {
        const clean = text.trim();
        if (!clean) return [];
        
        // For CJK (Korean, Chinese, Japanese), character width is approximately equal to font size
        // For Latin characters, use 0.6x font size
        const hasCJK = /[\u3131-\uD79D\uAC00-\uD7A3\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(clean);
        const avgCharWidth = hasCJK ? fontSize * 0.95 : fontSize * 0.6;
        const maxChars = Math.max(4, Math.floor(maxWidth / avgCharWidth));
        
        // For Korean text, split by spaces but also handle cases where we need to break within long phrases
        const words = clean.split(/\s+/).filter(Boolean);

        const lines: string[] = [];
        let current = '';
        for (const word of words) {
          const next = current ? `${current} ${word}` : word;
          // Estimate width: count characters and multiply by avgCharWidth
          const estimatedWidth = next.length * avgCharWidth;
          
          if (estimatedWidth <= maxWidth || current.length === 0) {
            current = next;
          } else {
            lines.push(current);
            current = word;
            if (lines.length >= maxLines - 1) {
              break;
            }
          }
        }
        if (current && lines.length < maxLines) {
          lines.push(current);
        }

        if (lines.length === 0) return [clean];
        if (lines.length > maxLines) {
          return [...lines.slice(0, maxLines - 1), lines.slice(maxLines - 1).join(' ')];
        }
        return lines;
      };

      // Process top headline (skip if using ASS overlay instead)
      const topHeadlineLines: string[] = [];
      if (!skipHeadlineRendering && topHeadlineText) {
        // Handle <br> or </br> tags for manual line breaks
        const textWithBreaks = topHeadlineText.replace(/<\/?br\s*\/?>/gi, '\n');
        const manualLines = textWithBreaks.split('\n').filter(line => line.trim().length > 0);
        
        // If manual line breaks exist, use them; otherwise use auto-wrapping
        if (manualLines.length > 1) {
          // Manual line breaks - respect user's formatting
          topHeadlineLines.push(...manualLines.map(line => line.trim()));
        } else {
          // Auto-wrap if no manual breaks
          topHeadlineLines.push(...wrapText(topHeadlineText, topHeadlineFontSize, textMaxWidth, 3));
        }
      }

      // Process bottom headline (skip if using ASS overlay instead)
      const bottomHeadlineLines: string[] = [];
      if (!skipHeadlineRendering && bottomHeadlineText) {
        // Handle <br> or </br> tags for manual line breaks
        const textWithBreaks = bottomHeadlineText.replace(/<\/?br\s*\/?>/gi, '\n');
        const manualLines = textWithBreaks.split('\n').filter(line => line.trim().length > 0);
        
        // If manual line breaks exist, use them; otherwise use auto-wrapping
        if (manualLines.length > 1) {
          // Manual line breaks - respect user's formatting
          bottomHeadlineLines.push(...manualLines.map(line => line.trim()));
        } else {
          // Auto-wrap if no manual breaks
          bottomHeadlineLines.push(...wrapText(bottomHeadlineText, bottomHeadlineFontSize, textMaxWidth, 3));
        }
      }

      const filters: string[] = [];
      filters.push(`[0:v]scale=${imageWidth}:${imageHeight}:force_original_aspect_ratio=decrease,pad=${imageWidth}:${imageHeight}:(ow-iw)/2:(oh-ih)/2:black[img]`);
      filters.push(`color=black:size=${canvasWidth}x${canvasHeight}:duration=${duration}:rate=${fps}[bg]`);
      filters.push(`[bg][img]overlay=0:${imageTop}[v1]`);

      // Helper function to parse text with <h>...</h> highlight tags
      const parseHighlightedText = (text: string): Array<{ text: string; isHighlight: boolean }> => {
        // Normalize spaces first (collapse multiple spaces to single space)
        const normalized = text.replace(/\s+/g, ' ').trim();
        
        const segments: Array<{ text: string; isHighlight: boolean }> = [];
        const regex = /<h>(.*?)<\/h>/g;
        let lastIndex = 0;
        let match;

        while ((match = regex.exec(normalized)) !== null) {
          // Add normal text before the highlight
          if (match.index > lastIndex) {
            const normalText = normalized.substring(lastIndex, match.index);
            if (normalText) {
              segments.push({ text: normalText, isHighlight: false });
            }
          }
          // Add highlighted text  
          if (match[1]) {
            segments.push({ text: match[1], isHighlight: true });
          }
          lastIndex = regex.lastIndex;
        }

        // Add remaining normal text
        if (lastIndex < normalized.length) {
          const normalText = normalized.substring(lastIndex);
          if (normalText) {
            segments.push({ text: normalText, isHighlight: false });
          }
        }

        // If no segments found, return the whole text as normal
        return segments.length > 0 ? segments : [{ text: normalized, isHighlight: false }];
      };

      // Helper: Create temp text file for drawtext textfile parameter
      // This is the CORRECT way to handle any text (Korean, emojis, special chars, user input)
      const createTextFile = async (text: string, identifier: string): Promise<string> => {
        const textDir = path.join(this.tempDir, 'drawtext');
        await this.ensureDir(textDir);
        const textFilePath = path.join(textDir, `${identifier}_${Date.now()}.txt`);
        await fsPromises.writeFile(textFilePath, text, 'utf-8');
        return textFilePath;
      };

      // Helper function to estimate text width (approximation for centering)
      const estimateTextWidth = (text: string, fontSize: number): number => {
        const hasCJK = /[\u3131-\uD79D\uAC00-\uD7A3\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(text);
        const avgCharWidth = hasCJK ? fontSize * 0.95 : fontSize * 0.6;
        return text.length * avgCharWidth;
      };

      let currentLabel = 'v1';
      // Adjust top headline Y position: if 2 lines, move up 90px for better spacing
      const baseTopHeadlineY = 280;
      const topHeadlineY = topHeadlineLines.length >= 2 ? baseTopHeadlineY - 90 : baseTopHeadlineY;
      console.log('topHeadlineLines - 90');
      console.log('topHeadlineY', topHeadlineY);
      const bottomHeadlineY = 1560;
      const topFontPath = headlineFontPath;
      const bottomFontPath = headlineFontPath;

      // Track text files for cleanup
      const textFiles: string[] = [];

      // Draw top headline - each line with highlight support
      if (topHeadlineLines.length > 0) {
        for (let i = 0; i < topHeadlineLines.length; i++) {
          const line = topHeadlineLines[i];
          const lineY = topHeadlineY + (i * topHeadlineFontSize * lineHeight);
          const segments = parseHighlightedText(line);

          // Calculate total line width for centering
          const totalWidth = segments.reduce((sum, seg) => sum + estimateTextWidth(seg.text, topHeadlineFontSize), 0);
          const startX = (canvasWidth - totalWidth) / 2;

          // Render each segment
          let cumulativeX = startX;
          for (let segIndex = 0; segIndex < segments.length; segIndex++) {
            const segment = segments[segIndex];
            // 🚀 BULLETPROOF: Use textfile instead of inline text
            const textFilePath = await createTextFile(segment.text, `top_${i}_${segIndex}`);
            textFiles.push(textFilePath);
            
            const segmentColor = segment.isHighlight ? 'red' : 'white';
            const segmentWidth = estimateTextWidth(segment.text, topHeadlineFontSize);
            const isLastSegment = segIndex === segments.length - 1 && i === topHeadlineLines.length - 1;
            const nextLabel = isLastSegment ? 'toptext' : `topline${i}_seg${segIndex}`;

            // ✅ NO ESCAPING NEEDED - textfile handles everything!
            filters.push(
              `[${currentLabel}]drawtext=textfile=${textFilePath}:fontsize=${topHeadlineFontSize}:fontcolor=${segmentColor}:x=${cumulativeX}:y=${lineY}:fontfile=${topFontPath}:bordercolor=black@1.0:borderw=${borderWidth}[${nextLabel}]`
            );
            currentLabel = nextLabel;
            cumulativeX += segmentWidth;
          }
        }
      }

      // Draw bottom headline - each line with highlight support
      if (bottomHeadlineLines.length > 0) {
        for (let i = 0; i < bottomHeadlineLines.length; i++) {
          const line = bottomHeadlineLines[i];
          const lineY = bottomHeadlineY + (i * bottomHeadlineFontSize * lineHeight);
          const segments = parseHighlightedText(line);

          // Calculate total line width for centering
          const totalWidth = segments.reduce((sum, seg) => sum + estimateTextWidth(seg.text, bottomHeadlineFontSize), 0);
          const startX = (canvasWidth - totalWidth) / 2;

          // Render each segment
          let cumulativeX = startX;
          for (let segIndex = 0; segIndex < segments.length; segIndex++) {
            const segment = segments[segIndex];
            // 🚀 BULLETPROOF: Use textfile instead of inline text
            const textFilePath = await createTextFile(segment.text, `bottom_${i}_${segIndex}`);
            textFiles.push(textFilePath);
            
            const segmentColor = segment.isHighlight ? 'red' : 'white';
            const segmentWidth = estimateTextWidth(segment.text, bottomHeadlineFontSize);
            const isLastSegment = segIndex === segments.length - 1 && i === bottomHeadlineLines.length - 1;
            const nextLabel = isLastSegment ? 'out' : `bottomline${i}_seg${segIndex}`;

            // ✅ NO ESCAPING NEEDED - textfile handles everything!
            filters.push(
              `[${currentLabel}]drawtext=textfile=${textFilePath}:fontsize=${bottomHeadlineFontSize}:fontcolor=${segmentColor}:x=${cumulativeX}:y=${lineY}:fontfile=${bottomFontPath}:bordercolor=black@1.0:borderw=${borderWidth}[${nextLabel}]`
            );
            currentLabel = nextLabel;
            cumulativeX += segmentWidth;
          }
        }
      }
      
      // If no headlines were drawn, ensure output label exists
      if (currentLabel !== 'out') {
        filters.push(`[${currentLabel}]null[out]`);
      }

      const filterComplex = filters.join(';');

      ffmpeg()
        .input(imagePath)
        .inputOptions(['-loop', '1', '-framerate', `${fps}`])
        .videoCodec('libx264')
        .outputOptions([
          `-t ${duration}`,
          `-filter_complex`, filterComplex,
          '-map', '[out]',
          '-pix_fmt', 'yuv420p',
          `-r ${fps}`,
          '-avoid_negative_ts', 'make_zero',
          '-fflags', '+genpts',
          '-preset', 'fast',
          '-crf', '23',
        ])
        .output(outputPath)
        .on('start', (commandLine) => {
          this.logger.debug(`${logPrefix} [createVerticalPosterVideo] FFmpeg command: ${commandLine}`);
        })
        .on('end', async () => {
          this.logger.log(`${logPrefix} [createVerticalPosterVideo] ✅ Vertical poster video created: ${outputPath}`);
          
          // Cleanup text files
          for (const textFile of textFiles) {
            try {
              await fsPromises.unlink(textFile);
            } catch (err) {
              this.logger.warn(`${logPrefix} [createVerticalPosterVideo] Failed to cleanup text file: ${textFile}`);
            }
          }
          
          resolve();
        })
        .on('error', async (error) => {
          this.logger.error(`${logPrefix} [createVerticalPosterVideo] ❌ Error creating vertical poster: ${error.message}`);
          
          // Cleanup text files even on error
          for (const textFile of textFiles) {
            try {
              await fsPromises.unlink(textFile);
            } catch (err) {
              // Silent cleanup on error
            }
          }
          
          reject(error);
        })
        .run();
    });
  }
}

