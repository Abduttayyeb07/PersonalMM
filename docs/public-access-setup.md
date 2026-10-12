# Putting the terminal behind a domain

The app is domain-centric: **`APP_ORIGIN` is the only address you change.** Until you have a domain, leave it at `http://127.0.0.1:3070` and nothing is reachable from outside the machine.

## How the pieces are exposed

| Component | Listens on | Reachable from |
|---|---|---|
| Frontend (Next.js) | `127.0.0.1:3070` | this machine / reverse proxy only |
| Backend (NestJS) | `127.0.0.1:3069` | this machine / reverse proxy only |
| Postgres | Docker network only (no `ports:`) or `127.0.0.1:5432` | backend only |
| Reverse proxy (you add it) | `:443` | the internet |

Both app ports are bound to loopback. Docker publishes them as `127.0.0.1:3070:3070` / `127.0.0.1:3069:3069`; outside Docker the backend uses `HOST=127.0.0.1` and the frontend is started with `-H 127.0.0.1`. Only the reverse proxy is public, and it terminates TLS.

## Switching from "no domain" to a domain

1. Point DNS (`A`/`AAAA`) for `your.domain` at the server and get a certificate (Caddy does this automatically).
2. In `.env`:
   ```env
   APP_ORIGIN=https://your.domain
   NEXT_PUBLIC_API_URL=        # empty -> same origin
   NEXT_PUBLIC_WS_URL=         # empty -> same origin
   TRUST_PROXY=1
   COOKIE_SECURE=true
   ```
3. Rebuild the frontend (`NEXT_PUBLIC_*` are compile-time) and recreate the backend:
   ```bash
   docker compose build frontend
   docker compose up -d
   ```
4. Add the proxy routes below. The browser then uses one origin for the page, `/api` and `/socket.io`; the CSP `connect-src` falls back to `'self'` and CORS allows only `APP_ORIGIN`.

## Reverse proxy

### Caddy (automatic HTTPS)

```caddyfile
your.domain {
    handle /api/*       { reverse_proxy 127.0.0.1:3069 }
    handle /socket.io/* { reverse_proxy 127.0.0.1:3069 }
    handle              { reverse_proxy 127.0.0.1:3070 }
}
```

### nginx

```nginx
server {
    listen 443 ssl;
    server_name your.domain;
    # ssl_certificate / ssl_certificate_key ...

    location /api/ {
        proxy_pass http://127.0.0.1:3069;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # The socket client uses WebSocket only, so the Upgrade headers are mandatory.
    location /socket.io/ {
        proxy_pass http://127.0.0.1:3069;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host       $host;
        proxy_read_timeout 3600s;
    }

    location / {
        proxy_pass http://127.0.0.1:3070;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

`TRUST_PROXY=1` makes the backend trust one proxy hop, so audit rows and rate limits see the real client IP instead of `127.0.0.1`. Do not set it when no proxy is in front.

## Verify

```bash
curl -i https://your.domain/api/mexc/trades   # 401 without a session = reaching the backend
curl -I https://your.domain/                  # check Content-Security-Policy carries a nonce
ss -ltn | grep -E ':(3070|3069)'              # must show 127.0.0.1, never 0.0.0.0
```

## Exchange API key IP allowlist

Both exchanges should be told to accept the key only from the server's **public egress IP** (not the domain). Find it with `curl https://api.ipify.org` from the server.
