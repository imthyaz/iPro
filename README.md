# iPro

Workforce management for Ideassion — people, attendance, leave, hybrid planning, journey timelines and the Ask iPro
assistant (Phase 1), built with Claude Code.

## Getting started

1. The Phase 1 build spec is already in `docs/`. Optionally add the product requirements (see `docs/README.md`).
2. Push this folder to a new private GitHub repository.
3. Open it in Claude Code and follow `prompts/kickoff.md`.
4. Claude Code merges each slice into `main` once all checks pass (decision #44). Admin credentials (AWS, Entra ID, Zoho, Graph) are created by the
   account owner and stored in AWS Secrets Manager — never given to Claude Code for production.

## Running it locally

Needs Node 26 (see `.node-version`), pnpm 10 and Docker Desktop.

```bash
cp .env.example .env
pnpm install
pnpm dev            # Postgres + MinIO in Docker, API on :3000, web on :5173
pnpm db:migrate     # first run only, then after pulling new migrations
pnpm db:seed        # synthetic dev tenant
```

| Command | Does |
| --- | --- |
| `pnpm lint` | ESLint + Prettier check |
| `pnpm typecheck` | TypeScript across all packages |
| `pnpm test` | Unit + integration (integration needs Postgres from `docker compose up -d`) |
| `pnpm test:unit` | Unit tests only, no Docker needed |
| `pnpm test:e2e` | Builds, starts API + web preview, runs Playwright (desktop and mobile) |
| `pnpm --filter @ipro/api db:generate` | New migration from schema changes in `apps/api/src/db/schema.ts` |

CI (`.github/workflows/ci.yml`) runs lint, typecheck, unit, integration and e2e on every PR. To make a failing CI
block merging, turn on branch protection for `main` in GitHub (Settings → Branches → require the three CI checks).

## Layout

| Path | What |
| --- | --- |
| `apps/api` | NestJS API (ESM). `src/db` schema and tenant context, `drizzle/` SQL migrations, `test/` integration tests |
| `apps/web` | React + Vite installable PWA, Playwright tests in `e2e/` |
| `packages/shared` | zod schemas and types shared by API and web |
| `infra` | AWS CDK skeleton for ap-south-1 (synthesised and tested, not deployed) |

## What's here

| File | Purpose |
| --- | --- |
| `CLAUDE.md` | Standing instructions Claude Code reads every session |
| `BUILD_PLAN.md` | Phase 1 in 15 slices, each with "done when" tests |
| `ARCHITECTURE.md` | Modules, request path, data conventions, adapters |
| `docs/decisions.md` | Decisions already made |
| `docs/open-questions.md` | Inputs still needed from Ideassion |
| `.claude/commands/next-slice.md` | `/next-slice` command for Claude Code |
| `prompts/` | Kickoff and per-slice prompts |
| `.env.example` | Every environment variable, no secrets |
