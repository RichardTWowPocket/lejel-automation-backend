#!/bin/bash

# Example script to test the transcription API

# Set the API endpoint (use HTTPS domain in production, or localhost for development)
API_URL="${API_URL:-https://lejel-backend.richardtandean.my.id/api/transcribe-audio}"

# Check if audio file path is provided
if [ -z "$1" ]; then
    echo "Usage: $0 <path-to-audio-file> [language] [format]"
    echo "Example: $0 audio.mp3 en verbose_json"
    exit 1
fi

AUDIO_FILE="$1"
LANGUAGE="${2:-}"  # Optional language code
FORMAT="${3:-verbose_json}"  # Default format

# Check if file exists
if [ ! -f "$AUDIO_FILE" ]; then
    echo "Error: Audio file not found: $AUDIO_FILE"
    exit 1
fi

# Build the curl command
CURL_CMD="curl -X POST $API_URL"

# Add audio file
CURL_CMD="$CURL_CMD -F 'audio=@$AUDIO_FILE'"

# Add optional language parameter
if [ ! -z "$LANGUAGE" ]; then
    CURL_CMD="$CURL_CMD -F 'language=$LANGUAGE'"
fi

# Add format parameter
CURL_CMD="$CURL_CMD -F 'format=$FORMAT'"

# Execute the request
echo "Sending transcription request..."
echo "File: $AUDIO_FILE"
if [ ! -z "$LANGUAGE" ]; then
    echo "Language: $LANGUAGE"
fi
echo "Format: $FORMAT"
echo ""

eval $CURL_CMD | jq '.' 2>/dev/null || eval $CURL_CMD

echo ""

