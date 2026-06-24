# Testing

Hubolt uses [Vitest](https://vitest.dev). Tests are colocated under `test/`,
mirroring the `src/` paths they cover.

Related: [Development](development.md) | [Database](database.md)

## Test types and locations

```text
test/
  cli/            CLI command tests
  config/         config loading/schema tests
  core/           review pipeline tests
  eval/           evaluation harness tests
  feedback/       feedback import/learning tests
  github/         GitHub posting tests
  integrations/   integration adapter tests
  memory/         memory card tests
  providers/      provider adapter tests
  queue/          queue/worker tests
  report/         report renderer tests
  server/         server route/middleware/service tests
  fixtures/       shared test fixtures
  github-action-utils.test.ts
```

There are 62 test files. Database- and Redis-touching tests (for example
`test/server/db.test.ts`, `test/server/request-queue.test.ts`) use mocks, so no
live Postgres or Redis is required to run the suite.

## Running tests

```bash
npm test                                  # vitest run (whole suite, once)
npx vitest                                # watch mode
npx vitest run test/server/db.test.ts     # a single file
npx vitest run -t "auth"                   # tests whose name matches "auth"
```

## Test environment

- No special environment variables are needed; external services are mocked.
- There is no committed `vitest.config.*`; Vitest runs with its defaults.

## Coverage

Coverage is not configured in this repository - `@vitest/coverage-*` is not a
dependency, so `--coverage` will prompt to install a provider. To measure
coverage locally:

```bash
npm i -D @vitest/coverage-v8
npx vitest run --coverage
```

Needs confirmation: add a coverage provider and threshold if the project wants
enforced coverage.

## Mocks and fixtures

- Mocks use Vitest's `vi.hoisted` / `vi.mock` (see `test/server/db.test.ts` for
  the Prisma/pg mock pattern, `test/server/request-queue.test.ts` for BullMQ).
- Shared inputs live in `test/fixtures/`.

## Common failures

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `Cannot find module '../generated/prisma'` | Prisma client not generated | `npx prisma generate` |
| Type errors during `npm test` build | stale types | `npm run typecheck` to see details |
| A single test hangs | watch mode left open | use `vitest run` (one-shot) in CI |

CI runs the suite plus a migration drift check; see [Deployment](deployment.md).
