# API Key Protection

Your API is now protected with an API key. All endpoints under `/api/*` require authentication.

## Your API Key

**⚠️ Keep this secret!** Do not commit it to version control.

```
dufhtM9us5b2BLkGBe4KLpHVGgeqs99zcXlHSVZbaBI
```

## How to Use

### Option 1: X-API-Key Header (Recommended)

```bash
curl -X POST https://lejel-backend.richardtandean.my.id/api/transcribe-audio \
  -H "X-API-Key: dufhtM9us5b2BLkGBe4KLpHVGgeqs99zcXlHSVZbaBI" \
  -F "audio=@test.mp3" \
  -F "language=en"
```

### Option 2: Authorization Header

```bash
curl -X POST https://lejel-backend.richardtandean.my.id/api/transcribe-audio \
  -H "Authorization: Bearer dufhtM9us5b2BLkGBe4KLpHVGgeqs99zcXlHSVZbaBI" \
  -F "audio=@test.mp3" \
  -F "language=en"
```

Or with `ApiKey` prefix:

```bash
curl -X POST https://lejel-backend.richardtandean.my.id/api/transcribe-audio \
  -H "Authorization: ApiKey dufhtM9us5b2BLkGBe4KLpHVGgeqs99zcXlHSVZbaBI" \
  -F "audio=@test.mp3" \
  -F "language=en"
```

## Protected Endpoints

All endpoints under `/api/*` require the API key:

- ✅ `POST /api/transcribe-audio` - Audio transcription
- ✅ `POST /api/upload-media` - Media upload
- ✅ `POST /api/combine-media` - Media combination

## Public Endpoints

These endpoints do NOT require API key:

- ✅ `GET /health` - Health check (always public)

## JavaScript/TypeScript Example

```typescript
const apiKey = 'dufhtM9us5b2BLkGBe4KLpHVGgeqs99zcXlHSVZbaBI';

// Using fetch
const response = await fetch('https://lejel-backend.richardtandean.my.id/api/transcribe-audio', {
  method: 'POST',
  headers: {
    'X-API-Key': apiKey,
  },
  body: formData,
});

// Using axios
const axios = require('axios');
const response = await axios.post(
  'https://lejel-backend.richardtandean.my.id/api/transcribe-audio',
  formData,
  {
    headers: {
      'X-API-Key': apiKey,
    },
  }
);
```

## Python Example

```python
import requests

api_key = 'dufhtM9us5b2BLkGBe4KLpHVGgeqs99zcXlHSVZbaBI'
url = 'https://lejel-backend.richardtandean.my.id/api/transcribe-audio'

files = {'audio': open('test.mp3', 'rb')}
data = {'language': 'en', 'format': 'verbose_json'}
headers = {'X-API-Key': api_key}

response = requests.post(url, files=files, data=data, headers=headers)
print(response.json())
```

## Error Responses

### Missing API Key

```json
{
  "statusCode": 401,
  "message": "API key is required. Please provide it in X-API-Key header or Authorization header.",
  "error": "Unauthorized"
}
```

### Invalid API Key

```json
{
  "statusCode": 401,
  "message": "Invalid API key",
  "error": "Unauthorized"
}
```

## Changing the API Key

1. Edit `/root/lejel-automation-backend/.env`:
   ```bash
   API_KEY=your-new-secret-key-here
   ```

2. Restart the backend:
   ```bash
   cd /root/lejel-automation-backend
   docker compose restart backend
   ```

## Security Notes

- ✅ API key is stored in `.env` file (not committed to git)
- ✅ All `/api/*` endpoints are protected
- ✅ Health endpoint remains public for monitoring
- ⚠️ If `API_KEY` is not set in `.env`, all requests are allowed (development mode)
- ⚠️ Use HTTPS in production to protect API key in transit
- ⚠️ Rotate API key periodically for better security

## Development Mode

If `API_KEY` is not set in `.env`, the guard will allow all requests. This is useful for development but **should not be used in production**.

