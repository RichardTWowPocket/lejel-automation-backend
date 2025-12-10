# Nginx Reverse Proxy and SSL Setup Guide

This guide explains how to set up nginx as a reverse proxy with SSL for the Lejel Automation Backend.

**Important**: The Lejel backend uses the **existing n8n-nginx** service (shared reverse proxy) instead of its own nginx instance. This avoids port conflicts with other services.

## Architecture

The Lejel backend integrates with the existing nginx setup:
- **Backend service**: Runs on `127.0.0.1:3002` (localhost only, no conflict)
- **Nginx reverse proxy**: Uses existing `n8n-nginx` service (ports 80/443)
- **SSL certificates**: Managed by existing `n8n-certbot` service

## Prerequisites

1. Domain DNS configured: `lejel-backend.richardtandean.my.id` should point to your server's IP
2. The `n8n-nginx` and `n8n-certbot` services must be running
3. Ports 80 and 443 should be open and accessible (handled by n8n-nginx)

## Quick Setup

### Step 1: Verify DNS Configuration

Make sure your DNS record is set up correctly:

```bash
dig +short lejel-backend.richardtandean.my.id
```

This should return your server's IP address.

### Step 2: Start Lejel Backend Services

```bash
cd /root/lejel-automation-backend

# Start backend and whisper-worker services
docker-compose up -d --build
```

This will start:
- Backend service (NestJS) on port 3002 (localhost only)
- Whisper worker service (internal only)

### Step 3: Verify Nginx Configuration

The nginx configuration has been added to `/root/n8n-richard/nginx/conf.d/lejel-backend.conf`.

Make sure the nginx service can reload:

```bash
cd /root/n8n-richard
docker-compose exec nginx nginx -t
docker-compose exec nginx nginx -s reload
```

### Step 4: Initialize SSL Certificate

Run the SSL initialization script from the n8n-richard directory:

```bash
cd /root/n8n-richard
./init-letsencrypt-lejel.sh
```

This script will:
1. Check if DNS is properly configured
2. Create a dummy SSL certificate
3. Request a real SSL certificate from Let's Encrypt
4. Reload nginx with the new certificate

### Step 4: Verify Setup

Check that all services are running:

```bash
docker-compose ps
```

Test the API endpoint:

```bash
# Test health endpoint
curl https://lejel-backend.richardtandean.my.id/health

# Test with HTTP (should redirect to HTTPS)
curl -L http://lejel-backend.richardtandean.my.id/health
```

## Service Details

### Nginx Configuration

- **Location**: `/root/n8n-richard/nginx/conf.d/lejel-backend.conf`
- **Backend Port**: `127.0.0.1:3002` (localhost only, to avoid port conflicts)
- **Features**:
  - HTTP to HTTPS redirect
  - SSL/TLS configuration
  - Security headers
  - Large file upload support (100MB for audio files)
  - Extended timeouts for transcription tasks (10 minutes)

### Port Allocation Summary

| Service | Port | Description |
|---------|------|-------------|
| crypto-void-backend | 3001 | Public access |
| monitoring-grafana | 3000 | Localhost only |
| stylek-backend | 3003 | Localhost only |
| stylek-frontend | 3004 | Localhost only |
| **lejel-backend** | **3002** | **Localhost only (NEW)** |
| n8n-nginx | 80, 443 | Main reverse proxy (shared) |

### SSL Certificate Renewal

Certbot runs automatically and renews certificates when they're close to expiry (every 12 hours check, renews when < 30 days remaining).

To manually renew:

```bash
cd /root/n8n-richard
docker-compose run --rm certbot renew
docker-compose exec nginx nginx -s reload
```

### Updating Nginx Configuration

After making changes to nginx configuration files:

```bash
cd /root/n8n-richard

# Test configuration
docker-compose exec nginx nginx -t

# Reload nginx
docker-compose exec nginx nginx -s reload
```

## Troubleshooting

### SSL Certificate Issues

If certificate request fails:

1. **Check DNS**: Ensure domain resolves to your server IP
   ```bash
   dig +short lejel-backend.richardtandean.my.id
   ```

2. **Check nginx logs**:
   ```bash
   docker-compose logs nginx
   ```

3. **Check certbot logs**:
   ```bash
   docker-compose logs certbot
   ```

4. **Verify port 80 is accessible** (required for Let's Encrypt validation):
   ```bash
   curl http://lejel-backend.richardtandean.my.id/.well-known/acme-challenge/test
   ```

### Connection Issues

1. **Check if services are running**:
   ```bash
   # Check lejel services
   cd /root/lejel-automation-backend
   docker-compose ps
   
   # Check nginx service
   cd /root/n8n-richard
   docker-compose ps nginx
   ```

2. **Check backend is accessible from nginx**:
   ```bash
   # Test if backend is listening on localhost:3002
   curl http://127.0.0.1:3002/health
   ```

3. **Check backend logs**:
   ```bash
   cd /root/lejel-automation-backend
   docker-compose logs backend
   ```

4. **Check nginx logs**:
   ```bash
   cd /root/n8n-richard
   docker-compose logs nginx
   ```

### Large File Upload Issues

If you encounter issues with large audio files:

1. Verify `client_max_body_size` in `nginx/nginx.conf` (should be 100M)
2. Check backend timeout settings in `src/transcription/transcription.service.ts`
3. Increase nginx proxy timeouts in `nginx/conf.d/lejel-backend.conf`

## Security Notes

- SSL certificates are automatically renewed by certbot
- Security headers are configured in nginx
- Backend service is not directly exposed (only through nginx)
- Whisper worker is only accessible from the backend service

## Network Architecture

```
Internet → n8n-nginx (Port 80/443, shared) → Backend (127.0.0.1:3002)
                                            → Whisper Worker (Port 8000, internal)
```

- Lejel backend and whisper-worker communicate through the `lejel-network` Docker network
- Backend is accessible to nginx via localhost:3002
- All domains are handled by the shared n8n-nginx service

## Manual SSL Setup (Alternative)

If the automated script doesn't work, you can manually set up SSL:

1. Create dummy certificate:
   ```bash
   docker-compose run --rm --entrypoint "\
     openssl req -x509 -nodes -newkey rsa:4096 -days 1\
       -keyout '/etc/letsencrypt/live/lejel-backend.richardtandean.my.id/privkey.pem' \
       -out '/etc/letsencrypt/live/lejel-backend.richardtandean.my.id/fullchain.pem' \
       -subj '/CN=localhost'" certbot
   ```

2. Start nginx:
   ```bash
   docker-compose up -d nginx
   ```

3. Request real certificate:
   ```bash
   docker-compose run --rm --entrypoint "\
     certbot certonly --webroot -w /var/www/certbot \
       --email admin@richardtandean.my.id \
       -d lejel-backend.richardtandean.my.id \
       --rsa-key-size 4096 \
       --agree-tos \
       --force-renewal" certbot
   ```

4. Reload nginx:
   ```bash
   docker-compose exec nginx nginx -s reload
   ```

