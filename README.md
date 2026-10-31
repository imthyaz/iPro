# iPro

Workforce management for Ideassion — people, attendance, leave, hybrid planning, journey timelines and the Ask iPro
assistant (Phase 1), built with Claude Code.

## Getting started

1. The Phase 1 build spec is already in `docs/`. Optionally add the product requirements (see `docs/README.md`).
2. Push this folder to a new private GitHub repository.
3. Open it in Claude Code and follow `prompts/kickoff.md`.
4. A person reviews and merges every pull request. Admin credentials (AWS, Entra ID, Zoho, Graph) are created by the
   account owner and stored in AWS Secrets Manager — never given to Claude Code for production.

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
