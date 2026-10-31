Find the first slice in BUILD_PLAN.md that is not marked [x].

1. Read CLAUDE.md, docs/decisions.md and the spec sections the slice lists in docs/phase1-build-spec.md.
2. Restate the slice's scope and "done when" list, and list any questions. If a question blocks the slice, stop and
   ask; otherwise record it in docs/open-questions.md and use the spec's proposed default as configuration.
3. Propose a short plan (sub-steps that each fit one small PR) and wait for my approval.
4. For each sub-step: write tests from the acceptance criteria first, then the code; run
   `pnpm lint && pnpm typecheck && pnpm test` (and e2e for touched flows) until green.
5. Mark the slice [~] while in progress and [x] when every "done when" item passes. Summarise what changed, how it
   was tested, and anything I need to check by hand.

$ARGUMENTS
