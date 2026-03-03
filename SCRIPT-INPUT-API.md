# Script-Input API (frontend integration)

Backend untuk website input script + daftar video request. Dipakai oleh frontend Next.js (auth + video-requests).

## Endpoints

- **POST /api/auth/register** — Body: `{ email, password, name }` → `{ accessToken, user }`
- **POST /api/auth/login** — Body: `{ email, password }` → `{ accessToken, user }`
- **GET /api/auth/me** — Header: `Authorization: Bearer <token>` → `{ user }`

- **POST /api/video-requests** — Header: `Authorization: Bearer <token>`. Body: `{ fullScript, segmentedScripts: string[] }` → creates request (status `pending`), triggers n8n webhook if `N8N_WEBHOOK_URL` set. Returns `{ id, fullScript, segmentedScripts, status, createdAt, submittedAt }`.
- **GET /api/video-requests** — Query: `?status=pending|processing|completed|failed`. Returns list (own requests only).
- **GET /api/video-requests/:id** — Detail one request.
- **PATCH /api/video-requests/:id** — Update draft only (body: `fullScript`, `segmentedScripts`).
- **POST /api/video-requests/:id/callback** — For n8n. Header: `X-Callback-Secret: <CALLBACK_SECRET>`. Body: `{ status, resultUrl?, errorMessage? }`. No JWT.

## Env (.env)

- `JWT_SECRET` — untuk sign token (wajib production).
- **Database:** PostgreSQL only. Set `DATABASE_URL` (e.g. dari Docker Compose) atau `POSTGRES_HOST` + optional `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT`. Docker Compose menyediakan `lejel-postgres` dan set `DATABASE_URL` untuk backend.
- `N8N_WEBHOOK_URL` — URL webhook n8n; kalau kosong, request tetap dibuat tapi pipeline tidak di-trigger.
- `CALLBACK_SECRET` — Secret untuk callback n8n (header `X-Callback-Secret`).
- `BASE_URL` — URL backend (untuk callback URL), e.g. `http://localhost:3001`.
- `CORS_ORIGIN` — Origin frontend, e.g. `http://localhost:3000`.

## Menjalankan

- Frontend biasanya di port 3000. Jalankan backend di port lain, e.g. `PORT=3001 npm run start:dev`.
- Set `NEXT_PUBLIC_API_URL=http://localhost:3001` di frontend.
- Set `BASE_URL=http://localhost:3001` dan `CORS_ORIGIN=http://localhost:3000` di backend.

## Tes callback (manual)

```bash
# Set CALLBACK_SECRET di .env lalu:
curl -X POST http://localhost:3001/api/video-requests/<REQUEST_ID>/callback \
  -H "Content-Type: application/json" \
  -H "X-Callback-Secret: your-callback-secret" \
  -d '{"status":"completed","resultUrl":"https://example.com/video.mp4"}'
```
