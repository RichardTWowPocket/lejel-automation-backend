from fastapi import FastAPI, File, UploadFile, Form, HTTPException
from fastapi.responses import JSONResponse
import whisper
import os
import tempfile
import uvicorn
from typing import Optional
import logging
import threading
import time
import signal
import sys

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Whisper Transcription Worker", version="1.0.0")

# Global model variable - loaded once at startup
model = None

# Auto-shutdown configuration
IDLE_TIMEOUT = int(os.getenv("IDLE_TIMEOUT_MINUTES", "10")) * 60  # Convert minutes to seconds
last_request_time = time.time()
shutdown_timer = None
shutdown_lock = threading.Lock()

def reset_shutdown_timer():
    """Reset the shutdown timer when a request is received"""
    global last_request_time, shutdown_timer
    
    with shutdown_lock:
        last_request_time = time.time()
        if shutdown_timer:
            shutdown_timer.cancel()
        logger.debug(f"Shutdown timer reset. Will shutdown after {IDLE_TIMEOUT/60:.1f} minutes of inactivity")

def schedule_shutdown():
    """Schedule container shutdown after idle timeout"""
    global shutdown_timer
    
    def shutdown():
        idle_minutes = IDLE_TIMEOUT / 60
        logger.info(f"No requests received for {idle_minutes:.1f} minutes. Shutting down container to save resources...")
        # Send SIGTERM to gracefully shutdown
        os.kill(os.getpid(), signal.SIGTERM)
    
    with shutdown_lock:
        if shutdown_timer:
            shutdown_timer.cancel()
        shutdown_timer = threading.Timer(IDLE_TIMEOUT, shutdown)
        shutdown_timer.daemon = True
        shutdown_timer.start()

@app.on_event("startup")
async def load_model():
    """Load Whisper model at startup"""
    global model
    model_size = os.getenv("WHISPER_MODEL", "medium")
    logger.info(f"Loading Whisper model: {model_size}")
    try:
        model = whisper.load_model(model_size)
        logger.info(f"Whisper model {model_size} loaded successfully")
        
        # Start the shutdown timer after model is loaded
        idle_minutes = IDLE_TIMEOUT / 60
        logger.info(f"Auto-shutdown enabled: Container will shutdown after {idle_minutes:.1f} minutes of inactivity")
        schedule_shutdown()
    except Exception as e:
        logger.error(f"Failed to load Whisper model: {str(e)}")
        raise

@app.get("/health")
async def health():
    """Health check endpoint"""
    reset_shutdown_timer()  # Reset timer on health checks too
    return {
        "status": "ok",
        "model_loaded": model is not None,
        "model_size": os.getenv("WHISPER_MODEL", "medium")
    }

@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    language: Optional[str] = Form(None),
    response_format: str = Form("verbose_json"),
):
    """
    Transcribe audio file using Whisper
    
    Args:
        file: Audio file to transcribe
        language: Optional language code (e.g., 'en', 'es', 'fr')
        response_format: Response format - 'json', 'text', 'srt', 'verbose_json', 'vtt'
        model_size: Model size to use (default: medium, should match loaded model)
    
    Returns:
        Transcription result in the specified format
    """
    # Reset shutdown timer when receiving a transcription request
    reset_shutdown_timer()
    
    if model is None:
        raise HTTPException(status_code=503, detail="Whisper model not loaded")
    
    # Validate file type
    allowed_extensions = ['.mp3', '.wav', '.webm', '.ogg', '.flac', '.m4a', '.mp4']
    file_ext = os.path.splitext(file.filename)[1].lower() if file.filename else ''
    
    if file_ext not in allowed_extensions:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid file type. Allowed extensions: {', '.join(allowed_extensions)}"
        )
    
    # Create temporary file to save uploaded audio
    temp_file = None
    try:
        # Save uploaded file to temporary location
        with tempfile.NamedTemporaryFile(delete=False, suffix=file_ext) as temp_file:
            content = await file.read()
            temp_file.write(content)
            temp_file_path = temp_file.name
        
        logger.info(f"Processing audio file: {file.filename} ({len(content)} bytes)")
        
        # Transcribe audio
        transcribe_options = {}
        if language:
            transcribe_options['language'] = language
        
        logger.info(f"Starting transcription with options: {transcribe_options}")
        result = model.transcribe(temp_file_path, **transcribe_options)
        
        # Format response based on requested format
        if response_format == "json":
            return JSONResponse(content={
                "text": result["text"]
            })
        elif response_format == "text":
            return JSONResponse(content={
                "text": result["text"]
            })
        elif response_format == "verbose_json":
            # Return full result with timestamps
            return JSONResponse(content=result)
        elif response_format == "srt":
            # Generate SRT format
            srt_content = generate_srt(result)
            return JSONResponse(content={
                "text": srt_content,
                "format": "srt"
            })
        elif response_format == "vtt":
            # Generate VTT format
            vtt_content = generate_vtt(result)
            return JSONResponse(content={
                "text": vtt_content,
                "format": "vtt"
            })
        else:
            # Default to verbose_json
            return JSONResponse(content=result)
            
    except Exception as e:
        logger.error(f"Transcription error: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Transcription failed: {str(e)}")
    finally:
        # Clean up temporary file
        if temp_file and os.path.exists(temp_file_path):
            try:
                os.unlink(temp_file_path)
            except Exception as e:
                logger.warning(f"Failed to delete temp file: {str(e)}")

def generate_srt(result: dict) -> str:
    """Generate SRT subtitle format from Whisper result"""
    segments = result.get("segments", [])
    srt_lines = []
    
    for i, segment in enumerate(segments, 1):
        start_time = format_timestamp_srt(segment["start"])
        end_time = format_timestamp_srt(segment["end"])
        text = segment["text"].strip()
        
        srt_lines.append(f"{i}")
        srt_lines.append(f"{start_time} --> {end_time}")
        srt_lines.append(text)
        srt_lines.append("")
    
    return "\n".join(srt_lines)

def generate_vtt(result: dict) -> str:
    """Generate VTT subtitle format from Whisper result"""
    segments = result.get("segments", [])
    vtt_lines = ["WEBVTT", ""]
    
    for segment in segments:
        start_time = format_timestamp_vtt(segment["start"])
        end_time = format_timestamp_vtt(segment["end"])
        text = segment["text"].strip()
        
        vtt_lines.append(f"{start_time} --> {end_time}")
        vtt_lines.append(text)
        vtt_lines.append("")
    
    return "\n".join(vtt_lines)

def format_timestamp_srt(seconds: float) -> str:
    """Format timestamp for SRT (HH:MM:SS,mmm)"""
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    millis = int((seconds % 1) * 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"

def format_timestamp_vtt(seconds: float) -> str:
    """Format timestamp for VTT (HH:MM:SS.mmm)"""
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    millis = int((seconds % 1) * 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{millis:03d}"

if __name__ == "__main__":
    port = int(os.getenv("PORT", 8000))
    
    # Handle graceful shutdown on SIGTERM
    def signal_handler(sig, frame):
        logger.info("Received shutdown signal. Gracefully shutting down...")
        sys.exit(0)
    
    signal.signal(signal.SIGTERM, signal_handler)
    signal.signal(signal.SIGINT, signal_handler)
    
    uvicorn.run(app, host="0.0.0.0", port=port)

