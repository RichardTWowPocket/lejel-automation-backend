# Video/Image Combine API Documentation

API untuk menggabungkan gambar atau video dengan audio per section. Sistem akan otomatis memotong durasi video/gambar agar sesuai dengan durasi audio setiap section.

## Endpoint: `/api/combine-media`

### Method: `POST`

### Description
Menggabungkan multiple sections yang terdiri dari audio + gambar/video menjadi satu output video. Setiap section akan:
- Jika input adalah **gambar**: gambar akan di-convert menjadi video dengan durasi sesuai audio
- Jika input adalah **video**: video akan dipotong (trim) sesuai durasi audio

### Request Body

```json
{
  "sections": [
    {
      "audioPath": "./temp/audio-section-1.mp3",
      "mediaPath": "./temp/image-1.jpg",
      "mediaType": "image",
      "startTime": 0.0,
      "endTime": 4.5
    },
    {
      "audioPath": "./temp/audio-section-2.mp3",
      "mediaPath": "./temp/video-1.mp4",
      "mediaType": "video",
      "startTime": 4.5,
      "endTime": 8.2
    }
  ],
  "outputFormat": "mp4",
  "width": 1920,
  "height": 1080
}
```

### Parameters

#### `sections` (required)
Array of section objects. Setiap section memiliki:
- `audioPath` (string, required): Path ke file audio (harus ada di server, bisa dari hasil upload)
- `mediaPath` (string, required): Path ke file gambar atau video (harus ada di server, bisa dari hasil upload)
- `mediaType` (enum, required): `"image"` atau `"video"`
- `startTime` (number, required): Start time dalam detik (dari hasil transcribe)
- `endTime` (number, required): End time dalam detik (dari hasil transcribe)

#### `outputFormat` (optional)
Format output video. Default: `"mp4"`. Supported: `mp4`, `webm`, dll.

#### `width` (optional)
Lebar output video dalam pixel. Default: `1920`

#### `height` (optional)
Tinggi output video dalam pixel. Default: `1080`

### Response

Returns the combined video file as a binary stream with `Content-Type: video/mp4`.

### Example Usage

#### 1. Upload files terlebih dahulu

```bash
# Upload audio
curl -X POST https://lejel-backend.richardtandean.my.id/api/upload-media \
  -F "file=@audio-1.mp3"

# Upload image
curl -X POST https://lejel-backend.richardtandean.my.id/api/upload-media \
  -F "file=@image-1.jpg"

# Upload video
curl -X POST https://lejel-backend.richardtandean.my.id/api/upload-media \
  -F "file=@video-1.mp4"
```

Response dari upload akan memberikan `filePath` yang bisa digunakan di `combine-media`.

#### 2. Combine media

```bash
curl -X POST https://lejel-backend.richardtandean.my.id/api/combine-media \
  -H "Content-Type: application/json" \
  -d '{
    "sections": [
      {
        "audioPath": "./temp/1234567890-audio.mp3",
        "mediaPath": "./temp/1234567891-image.jpg",
        "mediaType": "image",
        "startTime": 0.0,
        "endTime": 4.5
      },
      {
        "audioPath": "./temp/1234567892-audio.mp3",
        "mediaPath": "./temp/1234567893-video.mp4",
        "mediaType": "video",
        "startTime": 4.5,
        "endTime": 8.2
      }
    ],
    "outputFormat": "mp4",
    "width": 1920,
    "height": 1080
  }' \
  --output combined-video.mp4
```

### Endpoint: `/api/upload-media`

### Method: `POST`

### Description
Upload file (audio, image, atau video) ke server untuk digunakan di `combine-media`.

### Request

Multipart form data dengan field `file`.

### Response

```json
{
  "filePath": "./temp/1699123456789-123456789.mp3",
  "fileName": "1699123456789-123456789.mp3",
  "fileSize": 1024000,
  "mimeType": "audio/mpeg",
  "mediaType": "audio"
}
```

### Error Responses

- `400 Bad Request`: File tidak ditemukan, format tidak didukung, atau parameter invalid
- `500 Internal Server Error`: Error saat processing (FFmpeg error, dll)

## Notes

1. **File Path**: File yang di-upload akan disimpan di `./temp` directory. Pastikan file sudah ter-upload sebelum memanggil `combine-media`.

2. **Duration Matching**: 
   - Jika video lebih panjang dari audio section → video akan dipotong sesuai durasi audio
   - Jika video lebih pendek dari audio section → video akan di-loop (tapi dengan `-shortest`, akan berhenti saat audio selesai)
   - Untuk image → selalu dibuat video dengan durasi sesuai audio

3. **Aspect Ratio**: Gambar/video akan di-scale dan di-pad untuk memenuhi dimensi output sambil mempertahankan aspect ratio asli.

4. **File Cleanup**: File output akan dihapus otomatis setelah didownload. File input (uploaded files) tetap ada di server hingga dihapus manual.

## Integration dengan Transcription

Setelah mendapatkan hasil transcription dengan timestamps, kamu bisa:

1. Extract audio per section berdasarkan timestamps
2. Upload audio dan media (image/video) per section
3. Panggil `combine-media` dengan sections yang sudah disiapkan

Contoh flow:
```typescript
// 1. Transcribe audio
const transcript = await transcribeAudio(audioFile);

// 2. Extract sections dari transcript.segments
const sections = transcript.segments.map(segment => ({
  startTime: segment.start,
  endTime: segment.end,
  text: segment.text
}));

// 3. Untuk setiap section:
//    - Extract audio (potong dari original audio)
//    - Upload audio dan media
//    - Buat section object untuk combine-media

// 4. Combine semua sections
const combinedVideo = await combineMedia({ sections });
```

