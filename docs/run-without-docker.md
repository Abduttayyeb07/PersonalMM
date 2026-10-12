# Running without Docker (no domain)

Everything binds to `127.0.0.1`, so the app is only reachable from the machine it runs on. To use it from another device without a domain, use an SSH tunnel (see the end) rather than opening the ports.

## Prerequisites

- Node.js 20+ and npm
- PostgreSQL 16 running locally (Windows installer, or `winget install PostgreSQL.PostgreSQL.16`)

## 1. Database

Create a dedicated, non-superuser role that owns only this database:

```powershell
psql -U postgres -c "CREATE ROLE ziguser LOGIN PASSWORD 'choose-a-strong-password' NOSUPERUSER NOCREATEDB NOCREATEROLE;"
psql -U postgres -c "CREATE DATABASE zigdb OWNER ziguser;"
```

Keep Postgres on `listen_addresses = 'localhost'` (the default).

## 2. Backend

```powershell
cd backend
copy .env.example .env
```

Edit `backend/.env`:

```env
DATABASE_URL="postgresql://ziguser:choose-a-strong-password@127.0.0.1:5432/zigdb"
JWT_SECRET="<32+ random characters>"
ENCRYPTION_KEY="<64 hex chars>"
NODE_ENV=development
COOKIE_SECURE=false
HOST=127.0.0.1
PORT=3069
APP_ORIGIN=http://127.0.0.1:3070
TRADING_ENABLED=false
```

Generate the secrets:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"  # JWT_SECRET
```

Then:

```powershell
npm ci
npx prisma generate
npx prisma migrate deploy
npm run build
npm run start:prod        # node dist/src/main, listening on 127.0.0.1:3069
```

Use `npm run start:dev` instead while developing. `NODE_ENV=production` refuses to start unless `COOKIE_SECURE=true`, which needs HTTPS, so run in `development` mode until a domain with TLS is in place. Leave `TRADING_ENABLED=false` until you have checked connections with a trade-only, IP-bound key.

## 3. Frontend

```powershell
cd frontend
copy .env.example .env.local     # API/WS point at http://127.0.0.1:3069
npm ci
npm run build
npx next start -H 127.0.0.1 -p 3070
```

Open <http://127.0.0.1:3070>. Use `127.0.0.1` consistently (not `localhost`) so the cookie, CORS origin and `APP_ORIGIN` all agree. The frontend (`:3070`) and backend (`:3069`) differ only by port, which counts as the same site for the `SameSite=Strict` session cookie.

Changing `.env.local` requires `npm run build` again, because `NEXT_PUBLIC_*` values are compiled into the bundle.

## 4. Checks

```powershell
Get-NetTCPConnection -State Listen -LocalPort 3069,3070 | Select LocalAddress,LocalPort   # both 127.0.0.1
```

From another machine, `http://<your-ip>:3070` should fail to connect.

## Reaching it from another device without a domain

Do not open the ports. Tunnel instead:

```bash
ssh -L 3070:127.0.0.1:3070 -L 3069:127.0.0.1:3069 user@the-server
```

then browse to `http://127.0.0.1:3070` on your own machine.

## Moving to a domain later

Follow [public-access-setup.md](public-access-setup.md): set `APP_ORIGIN=https://your.domain`, clear the two `NEXT_PUBLIC_*` URLs, rebuild the frontend, set `NODE_ENV=production`, `COOKIE_SECURE=true`, `TRUST_PROXY=1`, and put Caddy or nginx in front.
