# Port Configuration Summary

This document explains the port configuration for the Lejel Automation Backend to avoid conflicts with existing services.

## Port Allocation

| Service | Port | Access | Status |
|---------|------|--------|--------|
| **lejel-backend** | **3002** | **localhost only** | **✅ NEW** |
| crypto-void-backend | 3001 | Public (0.0.0.0) | ✅ Existing |
| monitoring-grafana | 3000 | localhost only | ✅ Existing |
| stylek-backend | 3003 | localhost only | ✅ Existing |
| stylek-frontend | 3004 | localhost only | ✅ Existing |
| n8n-nginx | 80, 443 | Public (shared) | ✅ Existing |

## Why Port 3002?

- ✅ **Port 3000**: Used by Grafana (monitoring)
- ✅ **Port 3001**: Used by crypto-void-backend
- ✅ **Port 3002**: **Available - Used by lejel-backend**
- ✅ **Port 3003**: Used by stylek-backend
- ✅ **Port 3004**: Used by stylek-frontend

## Architecture

The Lejel backend uses the **shared nginx reverse proxy** (`n8n-nginx`) instead of running its own nginx instance:

```
Internet
   ↓
n8n-nginx (Ports 80/443 - shared by all services)
   ↓
lejel-backend (127.0.0.1:3002 - localhost only)
   ↓
whisper-worker (Port 8000 - internal Docker network)
```

## Benefits

1. **No Port Conflicts**: Backend runs on port 3002 (localhost), doesn't conflict with any service
2. **Shared Infrastructure**: Uses existing nginx and certbot services
3. **Consistent Setup**: Follows the same pattern as other services (stylek, crypto-void)
4. **Easy Management**: All nginx configs in one place (`/root/n8n-richard/nginx/conf.d/`)

## Configuration Files

- **Backend Docker Compose**: `/root/lejel-automation-backend/docker-compose.yml`
- **Nginx Config**: `/root/n8n-richard/nginx/conf.d/lejel-backend.conf`
- **SSL Script**: `/root/n8n-richard/init-letsencrypt-lejel.sh`

## Verification

To verify the port is correctly configured:

```bash
# Check if backend is listening on port 3002
curl http://127.0.0.1:3002/health

# Check nginx configuration
cd /root/n8n-richard
docker-compose exec nginx nginx -t

# Check running containers
docker ps | grep lejel
```





