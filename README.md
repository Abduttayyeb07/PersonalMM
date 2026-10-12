# ZXchange — Multi-Exchange ZIG/USDT Trading Terminal

A self-hosted trading terminal for the ZIG/USDT pair across four exchanges simultaneously: **MEXC**, **Bybit**, **KuCoin**, and **Gate.io**.

---

## Features

- **Live order book, trades feed, and ticker** via WebSocket for all four exchanges
- **Best-price widget** — highlights the cheapest ask across all exchanges in real time
- **Place, cancel, and track orders** from a single UI
- **Secure credential storage** — API keys encrypted at rest with AES-256-GCM
- **Execution log** — every order attempt is recorded with latency and outcome
- **Exchange switcher** — swap the active exchange without leaving the dashboard
- **Docker-first deployment** — one command to bring up the full stack

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | NestJS (Node 20), Socket.IO, Prisma ORM |
| Frontend | Next.js 16, React 19, Zustand, Framer Motion |
| Database | PostgreSQL 16 |
| Auth | JWT (httpOnly cookie) |
| Infra | Docker Compose |

---

## Project Structure

```
ZXchange/
├── backend/                  # NestJS API + WebSocket gateways
│   ├── src/
│   │   ├── auth/             # JWT auth (register, login, /me)
│   │   ├── credentials/      # AES-256-GCM encrypted API key storage
│   │   ├── encryption/       # Encryption service
│   │   ├── exchange/         # Shared: types, precision engine, symbol utils, order state
│   │   ├── execution-log/    # Order attempt audit trail
│   │   ├── mexc/             # MEXC REST + WebSocket adapter
│   │   ├── bybit/            # Bybit REST + WebSocket adapter
│   │   ├── common/           # CSRF, rate-limit tracking, exception scrubbing
│   │   └── prisma/           # PrismaService wrapper
│   └── prisma/
│       ├── schema.prisma
│       └── migrations/
├── frontend/                 # Next.js app
│   ├── app/                  # App router (layout, page)
│   ├── components/           # Dashboard, TradingPanel, OrderBook, TickerTape, ...
│   ├── lib/                  # axios client, socket.io connector
│   └── store/                # Zustand stores (auth, trading)
├── docker-compose.yml
└── .env.example
```

---

## Quick Start (Docker)

### 1. Clone and configure

```bash
git clone https://github.com/Abduttayyeb07/ZXchange.git
cd ZXchange
cp .env.example .env
```

Edit `.env` — the required values:

```env
JWT_SECRET=<random string, min 32 chars>
ENCRYPTION_KEY=<64 hex chars>   # generate below

NEXT_PUBLIC_API_URL=http://127.0.0.1:3069/api
NEXT_PUBLIC_WS_URL=http://127.0.0.1:3069
```

Generate `ENCRYPTION_KEY`:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 2. Build and run

```bash
docker compose up -d --build
```

| Service | URL |
|---------|-----|
| Frontend | http://127.0.0.1:3070 |
| Backend API | http://127.0.0.1:3069/api |
| PostgreSQL | localhost:5432 (internal) |

### 3. Register an account

Open http://127.0.0.1:3070, register, then connect your exchange API keys from the Dashboard.

---

## Local Development (without Docker)

### Prerequisites

- Node 20+
- PostgreSQL 16 running locally

### Backend

```bash
cd backend
cp .env.example .env          # fill in DATABASE_URL, JWT_SECRET, ENCRYPTION_KEY
npm install
npx prisma migrate deploy
npm run start:dev             # http://127.0.0.1:3069
```

### Frontend

```bash
cd frontend
cp .env.local.example .env.local   # or set manually
npm install
npm run dev                        # http://127.0.0.1:3070
```

---

## API Keys Setup (per exchange)

Create **read + spot trading only** API keys — never enable withdrawals.

| Exchange | Key type needed |
|----------|----------------|
| MEXC | API Key + Secret |
| Bybit | API Key + Secret |
| KuCoin | API Key + Secret + **Passphrase** |
| Gate.io | API Key + Secret |

Keys are encrypted with AES-256-GCM before being stored in the database.

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `JWT_SECRET` | Yes | Secret for signing JWTs |
| `ENCRYPTION_KEY` | Yes | 64-char hex key for AES-256-GCM |
| `JWT_EXPIRES_IN` | No | Token expiry (default `7d`) |
| `ALLOWED_ORIGINS` | No | CORS origins (default `http://127.0.0.1:3070`) |
| `PORT` | No | Backend port (default `3069`) |
| `NEXT_PUBLIC_API_URL` | Yes | Backend REST URL seen by browser |
| `NEXT_PUBLIC_WS_URL` | Yes | Backend WebSocket URL seen by browser |
| `POSTGRES_USER` | No | Docker Compose DB user (default `ziguser`) |
| `POSTGRES_PASSWORD` | Yes | Strong Docker Compose DB password; there is no fallback |
| `POSTGRES_DB` | No | Docker Compose DB name (default `zigdb`) |

---

## WebSocket Events

Bybit and MEXC expose authenticated Socket.IO namespaces (`/bybit`, `/mexc`). MEXC upstream frames use the official protobuf wrapper; browsers receive plain JSON only.

| Event (server → client) | Payload |
|--------------------------|---------|
| `ticker` | `{ symbol, price, change, high, low, volume }` |
| `orderbook` | `{ bids, asks, full }` |
| `trades` | `[{ price, qty, time, side }]` |
| `ws_status` | `{ connected: boolean }` |

---

## License

MIT
