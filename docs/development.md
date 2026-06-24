# Development

Local development workflow, scripts, and debugging.

Related: [Getting Started](getting-started.md) | [Testing](testing.md) |
[Project Structure](project-structure.md) | [Contributing](../CONTRIBUTING.md)

## Scripts

All from `package.json`. Run with `npm run <name>`.

| Script | Command | What it does |
|--------|---------|--------------|
| `dev` | `tsx src/cli/index.ts` | Run the CLI from source. Pass args after `--`. |
| `dev:server` | `tsx src/server/index.ts` | Run the server from source. |
| `server` | `node dist/server/index.js` | Run the built server (requires `build` first). |
| `build` | `tsc -p tsconfig.build.json` | Compile to `dist/`. Runs `prebuild` (clean + `prisma generate`) and `postbuild`. |
| `clean` | removes `dist/` | Delete build output. |
| `typecheck` | `tsc --noEmit` | Type-check without emitting. Runs `prisma generate` first. |
| `lint` | `tsc --noEmit` | Same as typecheck; there is no separate ESLint config in the repo. |
| `test` | `vitest run` | Run the full test suite once. |
| `db:start` | `docker-compose up -d` | Start Postgres + Redis containers. |
| `db:stop` | `docker-compose down` | Stop them. |
| `db:migrate` | `prisma migrate deploy` | Apply migrations. |
| `db:reset` | `prisma migrate reset --force` | Drop, recreate, re-migrate (destroys data). |
| `db:check-drift` | `prisma migrate diff ... --exit-code` | Fail if `schema.prisma` is not reproduced by migrations. |
| `db:studio` | `prisma studio` | Open Prisma Studio DB browser. |

There is no `format` script (no Prettier config committed). "Linting" is type
checking.

## Running the CLI in development

```bash
npm run dev -- review --staged
npm run dev -- providers list
npm run dev -- server bootstrap --org local --email you@example.com --no-save-env
```

Everything after `--` is passed to the `hubolt` CLI.

## Running the dev server

```bash
npm run db:start        # or native Postgres/Redis (see Getting Started)
npm run db:migrate
npm run dev:server      # http://127.0.0.1:3000
```

Hot reload: `tsx` runs TypeScript directly but does not watch by default. To
auto-restart on changes, run `npx tsx watch src/server/index.ts` (or
`watch src/cli/index.ts`). Needs confirmation as a supported workflow; it is not
wired into an npm script.

## Type checking and tests

```bash
npm run typecheck       # tsc --noEmit (run before pushing)
npm test                # vitest run (tests are mocked; no DB needed)
```

See [Testing](testing.md) for details, coverage notes, and how to run a single
test.

## Debugging

- Increase server logging: `LOG_LEVEL=debug npm run dev:server`.
- Inspect the local review event log: `npm run dev -- logs tail` and
  `npm run dev -- logs inspect`.
- Inspect the result cache: `npm run dev -- cache status`.
- Validate config and credentials: `npm run dev -- config validate`.
- Node inspector: `node --inspect-brk node_modules/.bin/tsx src/server/index.ts`
  then attach a debugger.
- Database browser: `npm run db:studio`.

## Branching and contribution workflow

- The default branch is `main`.
- CI (`.github/workflows/ci.yml`) runs typecheck, tests, and a migration drift
  check on every pull request and on pushes to `main`/`master`.
- A self-review workflow (`.github/workflows/hubolt.yml`) runs Hubolt on PRs.

Before opening a PR, run `npm run typecheck && npm test`. See
[Contributing](../CONTRIBUTING.md) for branch naming and PR expectations.
