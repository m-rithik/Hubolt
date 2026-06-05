# Hubolt Review Action

A GitHub Action that runs Hubolt code review on pull requests and pushes, generating reports and posting findings as comments.

**Note:** This action is currently designed for Hubolt's own CI. It builds Hubolt from source via `npm ci && npm run build`. For external repos, use the published `@m-rithik/hubolt` package or wait for a published composite action.

## Usage

### Basic usage in a workflow

```yaml
name: Hubolt Review
on: [pull_request, push]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: ./.github/actions/review
        with:
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
```

### With all options

```yaml
- uses: ./.github/actions/review
  with:
    openai-api-key: ${{ secrets.OPENAI_API_KEY }}
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    google-api-key: ${{ secrets.GOOGLE_GENERATIVE_AI_API_KEY }}
    node-version: "20"
    cache-enabled: "true"
    post-comment: "true"
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `openai-api-key` | No | - | OpenAI API key for GPT-4 reviews |
| `anthropic-api-key` | No | - | Anthropic API key for Claude reviews |
| `google-api-key` | No | - | Google Generative AI API key for Gemini reviews |
| `node-version` | No | `20` | Node.js version to use |
| `cache-enabled` | No | `true` | Enable cache restore/save for semantic maps and analyzer results |
| `post-comment` | No | `true` | Post the Markdown report as a PR comment |

## Outputs

| Output | Description |
|--------|-------------|
| `exit-code` | Hubolt review exit code (0 = passed, 1 = failed based on severity threshold) |
| `report-json-path` | Path to the generated JSON report |
| `report-md-path` | Path to the generated Markdown report |

## What it does

1. Checks out the repo with full git history
2. Sets up Node.js and builds Hubolt from source (`npm ci && npm run build`)
3. Restores cache from previous runs (semantic maps, analyzer results)
4. Detects whether it's a PR or push and sets the appropriate scope
5. Runs the local Hubolt build with `--json` and `--md` flags
6. Uploads both reports as artifacts (retained for 30 days)
7. Posts the Markdown report as a PR comment (updates existing comment on re-runs)
8. Saves the cache for future runs
9. Exits with status code based on configured severity threshold

## Configuration

### Provider selection

Hubolt uses the configured LLM provider (defaults to OpenAI). The action passes all available API keys as environment variables; Hubolt will use whichever is configured in `.hubolt.yml` or the environment.

To select a specific provider, create a `.hubolt.yml` config file in your repo:

```yaml
providers:
  llm: claude
  model: claude-3-5-sonnet-20241022
failOnSeverity: high
security:
  enabled: false
  failOnSeverity: high
```

### Caching

The action caches:
- Semantic maps (tree-sitter parsed code structure)
- Analyzer results (TypeScript, ESLint, Semgrep, dependencies)
- LLM findings for unchanged code

Cache keys are scoped by branch and commit, with fallback to just the branch or OS.

## Permissions

The action requires:
- `contents: read` — to check out and analyze code
- `pull-requests: write` — to post review comments on PRs

## Security

- API keys are passed as secrets and are never logged
- Code is not stored in reports by default
- Only metadata, findings, and fingerprints are retained
- Reports are uploaded as artifacts and automatically cleaned up after 30 days

## Fork PR limitations

Fork PRs cannot access repository secrets in GitHub (by design for security). This action detects fork PRs and automatically falls back to `--no-llm` (analyzer-only) mode when no LLM secrets are available.

To run full LLM reviews on fork PRs, fork maintainers must configure branch protection rules that require approval before running workflows with secrets.

## Troubleshooting

### "No provider configured"

You must provide at least one API key as a secret:
```yaml
- uses: ./.github/actions/review
  with:
    openai-api-key: ${{ secrets.OPENAI_API_KEY }}
```

### Reports not uploaded

Check that the workflow has permission to write artifacts. Ensure `permissions.contents: read` is set on the job.

### PR comments not posting

Ensure the job has `pull-requests: write` permission and is running on a pull_request event.

### Cache not being used

Cache is scoped by branch and exact commit. If you're seeing fresh installs every time, you may be on a branch that hasn't been seen before, or your commits are new.
