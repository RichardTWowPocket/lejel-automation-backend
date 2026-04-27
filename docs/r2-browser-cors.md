# R2 browser uploads (CORS)

The Generate video page uploads **directly** to your R2 bucket using a **presigned PUT**. Browsers send a **CORS preflight** (`OPTIONS`) to the R2 hostname; if the bucket has no CORS rule for your site, you will see:

`No 'Access-Control-Allow-Origin' header is present on the requested resource`

## Fix (Cloudflare dashboard)

1. **R2** → your bucket (**lejel-project** or whatever you use) → **Settings** → **CORS policy**.
2. Add a rule like this (adjust origins for production + local dev):

```json
[
  {
    "AllowedOrigins": [
      "https://global-ai.richardtandean.my.id",
      "http://localhost:3000"
    ],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag", "x-amz-request-id"],
    "MaxAgeSeconds": 3600
  }
]
```

- **AllowedOrigins**: must include the **exact** frontend origin (scheme + host + port), no trailing slash.
- **AllowedMethods**: **PUT** is required for presigned uploads; **HEAD** helps verification; **GET** if you ever load objects in the browser.
- **AllowedHeaders**: `*` is simplest because the AWS SDK may send `Content-Type`, `x-amz-*`, checksum headers, etc.

After saving, wait a minute and retry the upload (hard refresh optional).

## Alternative (no CORS)

Upload the file **through your Nest API** (multipart to backend, backend `PutObject` to R2). That avoids browser→R2 CORS but uses more server bandwidth and memory; the current design prefers presigned PUT + CORS.
