# Local setup

## Prerequisites

| Tool                    | Version  | Notes                                                |
| ----------------------- | -------- | ---------------------------------------------------- |
| Node.js                 | ≥ 22.12  | 24 LTS works                                         |
| pnpm                    | 9.x      | `corepack enable` installs the pinned version        |
| Docker                  | any      | For Postgres (or bring your own Postgres 14+)        |
| ffmpeg                  | optional | Only if `AUDIO_NORMALIZER=ffmpeg`                    |
| A spare WhatsApp number | optional | For the WhatsApp worker; never use a personal number |

## Quick start

```bash
./scripts/dev-setup.sh
```

```bash
pnpm dev
```

That script creates `.env` (with random service tokens), installs dependencies, starts Postgres
on **port 5433**, applies migrations and seeds the _Kampala Crafts_ demo merchant.

Open <http://localhost:3000> (dashboard) and <http://localhost:4000/api/health/ready> (API readiness).
Use **Agent console** in the dashboard to talk to the agent without WhatsApp (needs `AI_API_KEY`).

## Manual setup

```bash
cp .env.example .env            # then edit tokens/keys
pnpm install                    # also generates the Prisma client
pnpm db:up                      # docker compose up -d postgres
pnpm db:migrate                 # dev: create/apply migrations (prisma migrate dev)
pnpm db:seed
pnpm dev                        # API :4000 + web :3000
pnpm dev:whatsapp               # optional, separate terminal
```

Without Docker, point `DATABASE_URL` at any Postgres you control and skip `db:up`.

## Running services individually

| Command             | What                                      |
| ------------------- | ----------------------------------------- |
| `pnpm dev:api`      | Fastify API with reload (`tsx watch`)     |
| `pnpm dev:web`      | Next.js dashboard                         |
| `pnpm dev:whatsapp` | WhatsApp worker; prints a QR on first run |
| `pnpm db:studio`    | Prisma Studio to browse data              |

Production builds: `pnpm build`, then `node apps/api/dist/index.js`,
`pnpm --filter @vca/web start`, `node apps/whatsapp/dist/index.js`.

## Docker Compose

```bash
docker compose up -d postgres                 # database only (typical)
docker compose --profile app up --build       # + API + dashboard
docker compose --profile whatsapp up --build  # + WhatsApp worker (QR in `docker compose logs -f whatsapp`)
```

Containers read `.env`; Compose overrides hostnames (`postgres`, `api`, `whatsapp`). The API
container applies migrations on start.

## Configuration

All apps read the single root `.env` (validated with Zod in `packages/config`). A missing or
invalid variable stops the process with a list of every problem. See `.env.example` for
documentation of each variable. Optional providers (AI, speech, PayPal, WhatsApp gateway) degrade
gracefully: `GET /api/health/ready` shows what is configured.

## Database workflow

- Edit `packages/database/prisma/schema.prisma`
- `pnpm db:migrate` → name the migration → commit the generated SQL
- `pnpm db:generate` regenerates the client (also runs on `pnpm install`)
- `pnpm --filter @vca/database db:reset` drops and re-creates the dev database

## Testing

| Command                 | Scope                                                                   |
| ----------------------- | ----------------------------------------------------------------------- |
| `pnpm test`             | Unit + HTTP tests, no external services (Vitest)                        |
| `pnpm test:integration` | Full demo flow against the Postgres in `DATABASE_URL` (fake PayPal/LLM) |
| `pnpm verify`           | lint → format check → typecheck → unit tests → build                    |

Unit tests are co-located (`*.test.ts`). Test doubles live in `tests/support/fakes.ts`.

## Troubleshooting

| Symptom                                                   | Fix                                                                                                                          |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `Invalid configuration: API_AUTH_TOKEN …`                 | Tokens must be ≥ 16 chars; copy `.env.example` → `.env`                                                                      |
| Dashboard: "Cannot reach the API"                         | Start `pnpm dev:api`; check `API_BASE_URL`                                                                                   |
| Agent replies "AI assistant is not configured"            | Set `AI_API_KEY` (and `AI_BASE_URL`/`AI_MODEL` for non-OpenAI providers)                                                     |
| WhatsApp: `Failed to launch the browser process … dlopen` | Corrupt Puppeteer cache: `pnpm --filter @vca/whatsapp exec puppeteer browsers install chrome`, or set `WHATSAPP_CHROME_PATH` |
| WhatsApp messages get no reply                            | Sender not an operator: check API log `message from unknown sender ignored` → set `SEED_MERCHANT_WHATSAPP_ID` and re-seed    |
| Port 5432 already in use                                  | Compose uses **5433** on the host for this reason                                                                            |
