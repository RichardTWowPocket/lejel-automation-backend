import { Injectable, BadRequestException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import * as fs from 'fs';
import { ContainerManagerService } from './container-manager.service';

// Fix for form-data CommonJS/ESM interop
// eslint-disable-next-line @typescript-eslint/no-var-requires
const FormDataModule = require('form-data');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const FormData = (FormDataModule.default || FormDataModule) as typeof import('form-data');

@Injectable()
export class TranscriptionService {
  private readonly logger = new Logger(TranscriptionService.name);
  private whisperServiceUrl: string;
  private axiosInstance: AxiosInstance;

  constructor(
    private configService: ConfigService,
    private containerManager: ContainerManagerService,
  ) {
    this.whisperServiceUrl =
      this.configService.get<string>('WHISPER_SERVICE_URL') || 'http://whisper-worker:8000';
    
    this.axiosInstance = axios.create({
      timeout: 600000, // 10 minutes timeout for long audio files
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });
  }

  async transcribe(
    audioFilePath: string,
    language?: string,
    responseFormat: string = 'verbose_json',
    useWhisperTimestamp?: boolean,
  ): Promise<any> {
    // Check if file exists
    if (!fs.existsSync(audioFilePath)) {
      throw new BadRequestException('Audio file not found');
    }

    // Ensure whisper-worker container is running before making request
    await this.containerManager.ensureContainerRunning();

    // Prepare form data (outside try block so it's accessible in catch)
    const formData = new FormData();
    formData.append('file', fs.createReadStream(audioFilePath));
    
    if (language) {
      formData.append('language', language);
    }
    
    formData.append('response_format', responseFormat);
    formData.append('model', 'medium');
    
    // VAD is disabled - word-level timestamps work without it and are faster
    // The useWhisperTimestamp parameter is kept for API compatibility but doesn't enable VAD
    if (useWhisperTimestamp === true) {
      this.logger.log('Word-level timestamps enabled (VAD disabled for faster processing)');
    }

    try {
      // Send request to Whisper worker service
      const response = await this.axiosInstance.post(
        `${this.whisperServiceUrl}/transcribe`,
        formData,
        {
          headers: {
            ...formData.getHeaders(),
          },
        },
      );

      return response.data;
    } catch (error: any) {
      if (error.response) {
        throw new BadRequestException(
          `Whisper service error: ${error.response.status} - ${JSON.stringify(error.response.data)}`,
        );
      } else if (error.code === 'ECONNREFUSED' || error.code === 'EAI_AGAIN') {
        // DNS resolution or connection failed - container might not be ready yet
        // Try to ensure container is running one more time
        this.logger.warn(`Connection failed (${error.code}), ensuring container is running...`);
        try {
          await this.containerManager.ensureContainerRunning();
          // Wait a bit more for DNS to resolve
          await new Promise((resolve) => setTimeout(resolve, 5000));
          
          // Recreate form data for retry (streams can't be reused)
          const retryFormData = new FormData();
          retryFormData.append('file', fs.createReadStream(audioFilePath));
          
          if (language) {
            retryFormData.append('language', language);
          }
          
          retryFormData.append('response_format', responseFormat);
          retryFormData.append('model', 'medium');
          
          // VAD is disabled - word-level timestamps work without it
          
          // Retry the request
          const retryResponse = await this.axiosInstance.post(
            `${this.whisperServiceUrl}/transcribe`,
            retryFormData,
            {
              headers: {
                ...retryFormData.getHeaders(),
              },
            },
          );
          return retryResponse.data;
        } catch (retryError: any) {
          throw new ServiceUnavailableException(
            `Whisper worker service is not available (${error.code}). Container may still be starting or failed to start. Please try again in a moment.`,
          );
        }
      } else if (error.code === 'ETIMEDOUT') {
        throw new ServiceUnavailableException(
          'Request to Whisper service timed out. The audio file might be too long.',
        );
      } else {
        throw new BadRequestException(
          `Failed to transcribe audio: ${error.message || 'Unknown error'}`,
        );
      }
    }
  }
}

