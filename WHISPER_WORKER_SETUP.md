# Whisper Worker Setup Guide

This guide explains how to set up the shared Whisper Worker service when deploying the lejel-automation-backend to a new VPS.

## Overview

The Whisper Worker is a **shared service** that provides audio transcription capabilities. It's deployed separately from the backend and can be used by multiple projects.

## Architecture

```
┌─────────────────────────────────────────┐
│  shared-services-network                │
│  ┌──────────────────────────────────┐  │
│  │  whisper-worker:8000              │  │
│  │  (Shared Transcription Service)   │  │
│  └──────────────────────────────────┘  │
└─────────────────────────────────────────┘
         ▲
         │
┌────────┴────────┐
│  lejel-network  │
│  ┌──────────┐  │
│  │  Backend  │──┼──▶ Uses whisper-worker
│  └──────────┘  │
└─────────────────┘
```

## Prerequisites

- Docker and Docker Compose installed
- At least 4GB RAM available (8GB+ recommended)
- 2-4 CPU cores available
- ~5GB disk space for Whisper model cache

## Step-by-Step Setup

### Step 1: Create Shared Services Directory

```bash
mkdir -p /root/shared/whisper-worker
cd /root/shared/whisper-worker
```

### Step 2: Copy Whisper Worker Files

Copy the following files to `/root/shared/whisper-worker/`:

#### Required Files:
- `Dockerfile`
- `app.py`
- `requirements.txt`
- `docker-compose.yml`

#### Example: If files are in a repository

```bash
# If you have the files in a git repo
git clone <your-repo> /tmp/whisper-worker
cp -r /tmp/whisper-worker/whisper-worker/* /root/shared/whisper-worker/

# Or if you have them locally
cp Dockerfile app.py requirements.txt docker-compose.yml /root/shared/whisper-worker/
```

### Step 3: Create docker-compose.yml

Create `/root/shared/whisper-worker/docker-compose.yml`:

```yaml
version: '3.8'

services:
  whisper-worker:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: whisper-worker
    restart: unless-stopped
    environment:
      - WHISPER_MODEL=medium
      - PORT=8000
      - IDLE_TIMEOUT_MINUTES=30  # Auto-shutdown after 30 min of inactivity
    volumes:
      - whisper-cache:/root/.cache/whisper
      - /tmp/whisper:/tmp/whisper
    networks:
      - shared-services-network
    # Resource limits for Whisper (CPU-intensive)
    deploy:
      resources:
        limits:
          cpus: '4'
          memory: 8G
        reservations:
          cpus: '2'
          memory: 4G

networks:
  shared-services-network:
    driver: bridge
    name: shared-services-network  # External name for project access

volumes:
  whisper-cache:
    driver: local
    name: whisper-cache
```

### Step 4: Create Dockerfile

Create `/root/shared/whisper-worker/Dockerfile`:

```dockerfile
FROM python:3.11-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy requirements first for better caching
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY app.py .

# Create directory for temporary files
RUN mkdir -p /tmp/whisper

# Expose port
EXPOSE 8000

# Set environment variables
ENV WHISPER_MODEL=medium
ENV PORT=8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" || exit 1

# Run the application
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
```

### Step 5: Create requirements.txt

Create `/root/shared/whisper-worker/requirements.txt`:

```
fastapi==0.104.1
uvicorn[standard]==0.24.0
python-multipart==0.0.6
openai-whisper==20231117
torch>=2.0.0
torchaudio>=2.0.0
ffmpeg-python==0.2.0
```

### Step 6: Create app.py

Copy the `app.py` file from the original whisper-worker implementation. This file contains:
- FastAPI application
- Whisper model loading
- Transcription endpoint
- Health check endpoint
- Auto-shutdown functionality

### Step 7: Build and Start Whisper Worker

```bash
cd /root/shared/whisper-worker
docker compose up -d --build
```

**Note**: The first build will take 10-15 minutes as it:
- Downloads the Whisper model (medium size ~1.5GB)
- Installs PyTorch and dependencies
- Builds the container

### Step 8: Verify Whisper Worker is Running

```bash
# Check container status
docker compose ps

# Check logs
docker compose logs -f whisper-worker

# Test health endpoint
docker compose exec whisper-worker curl http://localhost:8000/health
```

Expected health response:
```json
{
  "status": "ok",
  "model_loaded": true,
  "model_size": "medium"
}
```

### Step 9: Configure Backend to Use Shared Service

In your backend's `docker-compose.yml`, add:

```yaml
services:
  backend:
    networks:
      - lejel-network
      - shared-services-network  # Add this

networks:
  lejel-network:
    driver: bridge
    name: lejel-network
  shared-services-network:  # Add this
    external: true
    name: shared-services-network
```

### Step 10: Set Environment Variable

In your backend's `.env` file or `docker-compose.yml`:

```bash
WHISPER_SERVICE_URL=http://whisper-worker:8000
```

### Step 11: Update Container Manager (if using dynamic startup)

If your backend uses a container manager service that starts whisper-worker on demand, update the path in your code:

**File**: `src/transcription/container-manager.service.ts`

```typescript
// Update this line:
execSync(`cd /root/shared/whisper-worker && docker-compose up -d whisper-worker`, {
  stdio: 'pipe',
  timeout: 30000,
});
```

### Step 12: Restart Backend

```bash
cd /root/lejel-automation-backend
docker compose up -d
```

### Step 13: Test Connection

```bash
# From backend container
docker compose exec backend curl http://whisper-worker:8000/health

# Should return:
# {"status":"ok","model_loaded":true,"model_size":"medium"}
```

## Configuration Options

### Whisper Model Size

Edit `docker-compose.yml` to change model size:

```yaml
environment:
  - WHISPER_MODEL=medium  # Options: tiny, base, small, medium, large
```

**Model Comparison**:
- `tiny`: Fastest, least accurate (~75MB)
- `base`: Fast, less accurate (~150MB)
- `small`: Balanced (~500MB)
- `medium`: Good balance, recommended (~1.5GB) ⭐
- `large`: Most accurate, slowest (~3GB)

### Idle Timeout

Control auto-shutdown behavior:

```yaml
environment:
  - IDLE_TIMEOUT_MINUTES=30  # Shutdown after 30 min of inactivity
```

Set to `0` to disable auto-shutdown (always running).

### Resource Limits

Adjust CPU and memory limits:

```yaml
deploy:
  resources:
    limits:
      cpus: '4'      # Maximum CPU cores
      memory: 8G     # Maximum memory
    reservations:
      cpus: '2'      # Reserved CPU cores
      memory: 4G     # Reserved memory
```

## Troubleshooting

### Whisper Worker Won't Start

1. **Check logs**:
   ```bash
   docker compose logs whisper-worker
   ```

2. **Verify disk space**:
   ```bash
   df -h
   ```
   Need at least 5GB free for model download.

3. **Check memory**:
   ```bash
   free -h
   ```
   Need at least 4GB available.

### Model Download Fails

1. **Check internet connection**
2. **Increase timeout** in Dockerfile if needed
3. **Manually download model** (advanced):
   ```bash
   docker compose exec whisper-worker python -c "import whisper; whisper.load_model('medium')"
   ```

### Backend Can't Connect to Whisper Worker

1. **Verify network exists**:
   ```bash
   docker network ls | grep shared-services-network
   ```

2. **Check if both services are on the network**:
   ```bash
   docker network inspect shared-services-network
   ```

3. **Test connectivity**:
   ```bash
   docker compose exec backend ping whisper-worker
   ```

4. **Verify service name**:
   - Container name must be: `whisper-worker`
   - Service URL: `http://whisper-worker:8000`

### Container Keeps Shutting Down

1. **Check idle timeout**:
   ```bash
   docker compose exec whisper-worker env | grep IDLE_TIMEOUT
   ```

2. **Disable auto-shutdown** (set to 0):
   ```yaml
   environment:
     - IDLE_TIMEOUT_MINUTES=0
   ```

3. **Check logs for errors**:
   ```bash
   docker compose logs whisper-worker
   ```

## Maintenance

### View Logs

```bash
cd /root/shared/whisper-worker
docker compose logs -f
```

### Restart Service

```bash
docker compose restart whisper-worker
```

### Rebuild Service

```bash
docker compose up -d --build
```

### Update Whisper Model

1. Stop the service:
   ```bash
   docker compose down
   ```

2. Remove model cache (optional, to force re-download):
   ```bash
   docker volume rm whisper-cache
   ```

3. Update `WHISPER_MODEL` in `docker-compose.yml`

4. Rebuild and start:
   ```bash
   docker compose up -d --build
   ```

### Check Resource Usage

```bash
docker stats whisper-worker
```

## Quick Reference

### File Structure

```
/root/shared/whisper-worker/
├── docker-compose.yml
├── Dockerfile
├── app.py
├── requirements.txt
└── README.md
```

### Key Commands

```bash
# Start service
cd /root/shared/whisper-worker && docker compose up -d

# View logs
docker compose logs -f

# Restart
docker compose restart

# Stop
docker compose down

# Rebuild
docker compose up -d --build
```

### Network Configuration

- **Network Name**: `shared-services-network`
- **Service Name**: `whisper-worker`
- **Port**: `8000` (internal only)
- **Health Endpoint**: `http://whisper-worker:8000/health`

### Environment Variables

- `WHISPER_MODEL`: Model size (tiny, base, small, medium, large)
- `PORT`: Service port (default: 8000)
- `IDLE_TIMEOUT_MINUTES`: Auto-shutdown timeout (0 = disabled)

## Integration with Other Projects

To use whisper-worker in other projects:

1. **Add network to project's docker-compose.yml**:
   ```yaml
   networks:
     shared-services-network:
       external: true
       name: shared-services-network
   ```

2. **Connect service to network**:
   ```yaml
   services:
     your-service:
       networks:
         - your-network
         - shared-services-network
   ```

3. **Set environment variable**:
   ```bash
   WHISPER_SERVICE_URL=http://whisper-worker:8000
   ```

4. **Use in code**:
   ```bash
   curl -X POST http://whisper-worker:8000/transcribe \
     -F "file=@audio.mp3" \
     -F "language=en" \
     -F "response_format=verbose_json"
   ```

## Security Notes

- ✅ Whisper worker is **not exposed** to the internet (internal network only)
- ✅ Accessible only via Docker networks
- ✅ No authentication required (add if needed for production)
- ⚠️ Consider adding rate limiting for production use
- ⚠️ Monitor resource usage to prevent abuse

## Support

For issues or questions:
1. Check logs: `docker compose logs whisper-worker`
2. Verify network: `docker network inspect shared-services-network`
3. Test health: `curl http://whisper-worker:8000/health`
4. Review this guide for common troubleshooting steps

