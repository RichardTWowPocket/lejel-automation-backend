import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as FormData from 'form-data';
import axios from 'axios';

@Injectable()
export class AssemblyAIService {
    private readonly logger = new Logger(AssemblyAIService.name);
    private readonly apiKey: string;
    private readonly baseUrl = 'https://api.assemblyai.com/v2';
    private readonly maxRetries = 3;

    constructor(private configService: ConfigService) {
        this.apiKey = this.configService.get<string>('ASSEMBLY_API_KEY');
        if (!this.apiKey || this.apiKey === 'your_assembly_api_key_here') {
            this.logger.warn('AssemblyAI API key not configured. Transcription will fail.');
        }
    }

    private errorMessage(err: unknown): string {
        if (axios.isAxiosError(err)) {
            return err.message;
        }
        if (err instanceof Error) {
            return err.message;
        }
        return String(err);
    }

    private isRetryableError(err: unknown): boolean {
        const msg = this.errorMessage(err).toLowerCase();
        // DNS/network/transient gateway errors.
        return (
            msg.includes('eai_again') ||
            msg.includes('etimedout') ||
            msg.includes('timeout') ||
            msg.includes('econnreset') ||
            msg.includes('socket hang up') ||
            msg.includes('enotfound') ||
            msg.includes('econnrefused') ||
            msg.includes('502') ||
            msg.includes('503') ||
            msg.includes('504')
        );
    }

    private async withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
        let lastError: unknown;
        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
            try {
                return await fn();
            } catch (err) {
                lastError = err;
                const retryable = this.isRetryableError(err);
                const message = this.errorMessage(err);
                this.logger.warn(
                    `[AssemblyAI] ${label} failed (attempt ${attempt}/${this.maxRetries}) retryable=${retryable}: ${message}`,
                );
                if (!retryable || attempt >= this.maxRetries) {
                    throw err;
                }
            }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    /**
     * Upload audio file to AssemblyAI and get upload URL
     */
    private async uploadAudio(audioPath: string): Promise<string> {
        this.logger.log(`[AssemblyAI] Uploading audio file: ${audioPath}`);

        const stats = fs.statSync(audioPath);

        try {
            const response = await this.withRetry('Upload audio', async () => {
                // New stream per attempt (streams are single-use).
                const fileStream = fs.createReadStream(audioPath);
                return axios.post(
                    `${this.baseUrl}/upload`,
                    fileStream,
                    {
                        headers: {
                            'Authorization': this.apiKey,
                            'Content-Type': 'application/octet-stream',
                            'Content-Length': stats.size.toString(),
                        },
                        maxContentLength: Infinity,
                        maxBodyLength: Infinity,
                    }
                );
            });

            const uploadUrl = response.data.upload_url;
            this.logger.log(`[AssemblyAI] Audio uploaded successfully: ${uploadUrl}`);
            return uploadUrl;
        } catch (error) {
            this.logger.error(`[AssemblyAI] Failed to upload audio: ${error.message}`);
            throw new Error(`AssemblyAI upload failed: ${error.message}`);
        }
    }

    /**
     * Submit transcription request to AssemblyAI.
     * When languageCode is omitted or empty, uses automatic language detection.
     */
    private async submitTranscription(audioUrl: string, languageCode?: string | null): Promise<string> {
        const useAutoLanguage = !languageCode || languageCode.trim() === '';
        this.logger.log(`[AssemblyAI] Submitting transcription request (language: ${useAutoLanguage ? 'auto-detect' : languageCode})`);

        try {
            const body: Record<string, any> = {
                audio_url: audioUrl,
                punctuate: true,
                format_text: true,
                // Disable expensive features we don't need
                auto_chapters: false,
                auto_highlights: false,
                content_safety: false,
                entity_detection: false,
                iab_categories: false,
                sentiment_analysis: false,
                summarization: false,
                speaker_labels: false,
            };
            if (useAutoLanguage) {
                body.language_detection = true;
            } else {
                body.language_code = languageCode!.trim();
            }

            const response = await this.withRetry('Submit transcription', async () =>
                axios.post(
                    `${this.baseUrl}/transcript`,
                    body,
                    {
                        headers: {
                            'Authorization': this.apiKey,
                            'Content-Type': 'application/json',
                        },
                    }
                )
            );

            const transcriptId = response.data.id;
            this.logger.log(`[AssemblyAI] Transcription submitted: ${transcriptId}`);
            return transcriptId;
        } catch (error) {
            this.logger.error(`[AssemblyAI] Failed to submit transcription: ${error.message}`);
            throw new Error(`AssemblyAI transcription submission failed: ${error.message}`);
        }
    }

    /**
     * Poll for transcription completion
     */
    private async pollTranscription(transcriptId: string, maxAttempts: number = 60): Promise<any> {
        this.logger.log(`[AssemblyAI] Polling for transcription completion: ${transcriptId}`);

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                const response = await this.withRetry('Poll transcription status', async () =>
                    axios.get(
                        `${this.baseUrl}/transcript/${transcriptId}`,
                        {
                            headers: {
                                'Authorization': this.apiKey,
                            },
                        }
                    )
                );

                const status = response.data.status;
                this.logger.debug(`[AssemblyAI] Transcription status: ${status} (attempt ${attempt + 1}/${maxAttempts})`);

                if (status === 'completed') {
                    this.logger.log(`[AssemblyAI] Transcription completed successfully`);
                    return response.data;
                } else if (status === 'error') {
                    throw new Error(`AssemblyAI transcription failed: ${response.data.error}`);
                }

                // Wait 2 seconds before next poll
                await new Promise(resolve => setTimeout(resolve, 2000));
            } catch (error) {
                if (error.message.includes('AssemblyAI transcription failed')) {
                    throw error;
                }
                this.logger.error(`[AssemblyAI] Polling error: ${error.message}`);
                throw new Error(`AssemblyAI polling failed: ${error.message}`);
            }
        }

        throw new Error(`AssemblyAI transcription timeout after ${maxAttempts} attempts`);
    }

    /**
     * Transform AssemblyAI response to Whisper-compatible format
     */
    private transformToWhisperFormat(assemblyResponse: any): any {
        this.logger.log(`[AssemblyAI] Transforming response to Whisper format`);

        const words = assemblyResponse.words || [];

        // Convert milliseconds to seconds and transform structure
        const whisperWords = words.map((word: any) => ({
            word: word.text,
            start: word.start / 1000, // Convert ms to seconds
            end: word.end / 1000,     // Convert ms to seconds
            probability: word.confidence || 0.99,
        }));

        // Group words into segments (similar to Whisper's structure)
        const segments = [];
        if (whisperWords.length > 0) {
            segments.push({
                start: whisperWords[0].start,
                end: whisperWords[whisperWords.length - 1].end,
                text: assemblyResponse.text || '',
                words: whisperWords,
            });
        }

        const result = {
            text: assemblyResponse.text || '',
            segments: segments,
            language: assemblyResponse.language_code || 'ko',
        };

        this.logger.log(`[AssemblyAI] Transformed ${words.length} words into Whisper format`);
        return result;
    }

    /**
     * Fetch SRT subtitles from AssemblyAI
     */
    async getSrtSubtitles(transcriptId: string): Promise<string> {
        this.logger.log(`[AssemblyAI] Fetching SRT subtitles for transcript: ${transcriptId}`);

        try {
            const response = await axios.get(
                `${this.baseUrl}/transcript/${transcriptId}/srt`,
                {
                    headers: {
                        'Authorization': this.apiKey,
                    },
                }
            );

            this.logger.log(`[AssemblyAI] SRT subtitles fetched successfully (${response.data.length} bytes)`);
            return response.data;
        } catch (error) {
            this.logger.error(`[AssemblyAI] Failed to fetch SRT: ${error.message}`);
            throw new Error(`AssemblyAI SRT fetch failed: ${error.message}`);
        }
    }

    /**
     * Main transcription method.
     * @param languageCode Optional. If omitted or empty, AssemblyAI will auto-detect the language.
     */
    async transcribe(audioPath: string, languageCode?: string | null): Promise<{ whisperFormat: any; transcriptId: string }> {
        this.logger.log(`[AssemblyAI] Starting transcription for: ${audioPath}`);

        try {
            // Step 1: Upload audio
            const uploadUrl = await this.uploadAudio(audioPath);

            // Step 2: Submit transcription (auto-detect language when languageCode not provided)
            const transcriptId = await this.submitTranscription(uploadUrl, languageCode);

            // Step 3: Poll for completion
            const assemblyResponse = await this.pollTranscription(transcriptId);

            // Step 4: Transform to Whisper format
            const whisperFormat = this.transformToWhisperFormat(assemblyResponse);

            this.logger.log(`[AssemblyAI] Transcription completed successfully`);
            return {
                whisperFormat,
                transcriptId,
            };
        } catch (error) {
            this.logger.error(`[AssemblyAI] Transcription failed: ${error.message}`);
            throw error;
        }
    }
}
