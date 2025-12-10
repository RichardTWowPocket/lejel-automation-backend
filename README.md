# Lejel Automation Backend

Backend service for Lejel automation with audio transcription capabilities using OpenAI Whisper.

## Architecture

This project consists of two microservices:

1. **Backend Service** (NestJS): Main API server that handles requests and routes transcription tasks
2. **Whisper Worker Service** (Python/FastAPI): Dedicated worker node that performs audio transcription using OpenAI Whisper medium model

## Features

- REST API endpoint `/api/transcribe-audio` for audio transcription
- Supports multiple audio formats (MP3, WAV, WEBM, OGG, FLAC, M4A, MP4)
- Returns transcribed text with timestamps
- Multiple output formats: JSON, text, SRT, VTT, verbose JSON
- Dockerized architecture for easy deployment
- Scalable worker node design

## Prerequisites

- Docker and Docker Compose
- Node.js 20+ (for local development)
- Python 3.11+ (for local development)

## Quick Start

1. **Clone the repository and navigate to the project directory**

2. **Create environment file** (optional, defaults are provided):
   ```bash
   cp .env.example .env
   ```

3. **Configure DNS**: Make sure `lejel-backend.richardtandean.my.id` points to your server's IP address

4. **Build and start services with Docker Compose**:
   ```bash
   docker-compose up -d --build
   ```

   This will:
   - Build backend and whisper-worker services
   - Start backend on port 3002 (localhost only)
   - Set up networking between services
   
   **Note**: This service uses the existing `n8n-nginx` reverse proxy (shared), so you don't need a separate nginx instance.

5. **Set up SSL Certificate**:
   ```bash
   cd /root/n8n-richard
   ./init-letsencrypt-lejel.sh
   ```

   This will request and configure SSL certificates from Let's Encrypt using the shared nginx setup.

6. **Check service health**:
   ```bash
   # Backend health check via HTTPS
   curl https://lejel-backend.richardtandean.my.id/health

   # Or check internal backend (if needed)
   docker-compose exec backend curl http://localhost:3000/health
   ```

For detailed nginx and SSL setup instructions, see [NGINX_SSL_SETUP.md](./NGINX_SSL_SETUP.md).

## API Usage

### Transcribe Audio

**Endpoint**: `POST /api/transcribe-audio`

**Content-Type**: `multipart/form-data`

**Parameters**:
- `audio` (file, required): Audio file to transcribe
- `language` (string, optional): Language code (e.g., 'en', 'es', 'fr'). If not provided, Whisper will auto-detect
- `format` (string, optional): Response format. Options: `json`, `text`, `srt`, `verbose_json`, `vtt`. Default: `verbose_json`

**Example using cURL**:
```bash
# Using HTTPS domain (production)
curl -X POST https://lejel-backend.richardtandean.my.id/api/transcribe-audio \
  -F "audio=@path/to/audio.mp3" \
  -F "language=en" \
  -F "format=verbose_json"

# Or using localhost (development, if nginx not running)
curl -X POST http://localhost:3000/api/transcribe-audio \
  -F "audio=@path/to/audio.mp3" \
  -F "language=en" \
  -F "format=verbose_json"
```

**Example using JavaScript/Node.js**:
```javascript
const formData = new FormData();
formData.append('audio', fs.createReadStream('audio.mp3'));
formData.append('language', 'en');
formData.append('format', 'verbose_json');

// Use HTTPS domain in production
const response = await fetch('https://lejel-backend.richardtandean.my.id/api/transcribe-audio', {
  method: 'POST',
  body: formData
});

const result = await response.json();
console.log(result);
```

**Example Response (verbose_json format)**:
```json
{
  "text": "Full transcription text here...",
  "segments": [
    {
      "id": 0,
      "seek": 0,
      "start": 0.0,
      "end": 5.5,
      "text": "Segment text here...",
      "tokens": [1234, 5678],
      "temperature": 0.0,
      "avg_logprob": -0.5,
      "compression_ratio": 1.2,
      "no_speech_prob": 0.05
    }
  ],
  "language": "en"
}
```

## Response Formats

- **`verbose_json`** (default): Full transcription with segments, timestamps, and metadata
- **`json`**: Simple JSON with just the text
- **`text`**: Plain text transcription
- **`srt`**: SubRip subtitle format with timestamps
- **`vtt`**: WebVTT subtitle format with timestamps

## Local Development

### Backend Service

```bash
cd /root/lejel-automation-backend

# Install dependencies
npm install

# Start in development mode
npm run start:dev

# Build for production
npm run build
npm run start:prod
```

### Whisper Worker Service

```bash
cd /root/lejel-automation-backend/whisper-worker

# Install dependencies
pip install -r requirements.txt

# Run the service
python app.py
```

**Note**: For local development, make sure to update `WHISPER_SERVICE_URL` in `.env` to point to your local whisper service (e.g., `http://localhost:8000`).

## Docker Commands

```bash
# Build and start services
docker-compose up -d --build

# View logs
docker-compose logs -f

# View logs for specific service
docker-compose logs -f backend
docker-compose logs -f whisper-worker

# Stop services
docker-compose down

# Stop and remove volumes (clears Whisper model cache)
docker-compose down -v

# Rebuild specific service
docker-compose build whisper-worker
docker-compose up -d whisper-worker
```

## Configuration

### Environment Variables

**Backend**:
- `PORT`: Backend server port (default: 3000)
- `NODE_ENV`: Environment mode (default: production)
- `WHISPER_SERVICE_URL`: URL of the Whisper worker service (default: http://whisper-worker:8000)

**Whisper Worker**:
- `WHISPER_MODEL`: Whisper model size (default: medium)
- `PORT`: Worker service port (default: 8000)

### Model Selection

The Whisper worker uses the `medium` model by default. You can change this by setting the `WHISPER_MODEL` environment variable in `docker-compose.yml`. Available models:
- `tiny`: Fastest, least accurate
- `base`: Fast, less accurate
- `small`: Balanced
- `medium`: Good balance (default)
- `large`: Most accurate, slowest

**Note**: Larger models require more memory and processing time. The medium model is recommended for most use cases.

## Resource Requirements

- **Backend**: Minimal resources (~512MB RAM)
- **Whisper Worker**: CPU and memory intensive
  - Recommended: 4+ CPU cores, 8GB+ RAM
  - Minimum: 2 CPU cores, 4GB RAM
  - Model cache: ~2-5GB disk space (for medium model)

## Troubleshooting

### Whisper worker fails to start
- Check Docker logs: `docker-compose logs whisper-worker`
- Ensure sufficient disk space for model download
- Verify Docker has enough memory allocated

### Transcription timeout
- Increase timeout in `transcription.service.ts` (currently 10 minutes)
- Consider using a smaller Whisper model
- Check if audio file is too large

### Connection refused errors
- Verify both services are running: `docker-compose ps`
- Check network connectivity: `docker-compose exec backend ping whisper-worker`
- Verify `WHISPER_SERVICE_URL` environment variable

### Model download issues
- The model is downloaded on first run and cached in a Docker volume
- Check disk space availability
- If needed, manually download model: The model will be downloaded automatically on first use

## API Rate Limiting

Currently, there are no rate limits implemented. For production use, consider adding:
- Request rate limiting
- Queue system for transcription jobs
- Authentication/API keys

## Security Considerations

- Add authentication/authorization for production
- Validate file sizes and types on both services
- Consider adding request rate limiting
- Use HTTPS in production
- Secure internal network communication

## License

MIT

