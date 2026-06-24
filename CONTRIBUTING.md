# Contributing to Hubolt

Thanks for helping improve Hubolt. This is a quick, practical guide. For deeper
detail see [docs/development.md](docs/development.md).

## Local setup

```bash
git clone https://github.com/m-rithik/hubolt.git
cd hubolt
npm install
npm run typecheck
npm test
```

To work on the server, also start Postgres + Redis and migrate - see
[docs/getting-started.md](docs/getting-started.md).

## Project rules

These come from the repository's agent rules and apply to all contributions:

1. No emojis in code, docs, comments, commit messages, CLI output, or UI copy.
2. Keep changes modular: small contracts, narrow modules, explicit boundaries.
3. Do not break unrelated behavior: preserve existing contracts; avoid drive-by
   rewrites.
4. Build securely: validate external input, redact secrets, treat reviewed code as
   untrusted, avoid unsafe defaults.

## Code style

- TypeScript, ESM (`"type": "module"`). Use the `.js` extension on relative
  imports (e.g. `import { x } from "./y.js"`), as the existing code does.
- One CLI command group per file in `src/cli/commands/` (registered in
  `src/cli/index.ts`); one route group per file in `src/server/routes/`
  (registered in `src/server/app.ts`).
- Do not edit generated code in `src/generated/`.
- Match the style of surrounding code.

## Testing expectations

- Add or update tests under `test/` mirroring the `src/` path you changed.
- Run `npm run typecheck && npm test` before pushing - both must pass.
- If you change `prisma/schema.prisma`, create a migration
  (`npx prisma migrate dev --name <change>`) so `npm run db:check-drift` passes.

## Branches and pull requests

- Default branch: `main`. Branch off it for your work
  (e.g. `feat/...`, `fix/...`, `docs/...`).
- CI (`.github/workflows/ci.yml`) runs typecheck, tests, and a migration drift
  check on every PR; a Hubolt self-review (`.github/workflows/hubolt.yml`) also
  runs.
- Keep PRs focused. Describe what changed and why, and note any follow-ups.
- End commit messages with a sign-off line if your workflow requires one.

## Good first contribution areas

LLM providers, analyzer providers, source-control providers, report renderers,
evaluation fixtures, prompt/ranking improvements, and documentation.
