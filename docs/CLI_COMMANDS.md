# Hubolt CLI Commands

Complete reference for all Hubolt CLI commands.

## Getting Started

### Installation

```bash
npm install -g @m-rithik/hubolt
```

### Quick Start

```bash
hubolt setup              # Configure your LLM provider
hubolt review             # Review your current changes
hubolt review --staged    # Review staged changes only
hubolt security           # Run security-focused review
```

---

## Core Commands

### `hubolt setup`

Configure your LLM provider and save credentials.

```bash
hubolt setup

# Interactive prompt guides you through:
# 1. Choose provider: Anthropic Claude, OpenAI, or Google
# 2. Enter API key, or keep an existing key when one is already configured
# 3. Save to .env
```

**Options:**
- `--print` - Print a starter `.hubolt.yml` config instead of saving
- `--use-existing-keys` - Reuse existing provider API keys without prompting when present
- `--rewrite-keys` - Prompt for new provider API keys even when existing keys are present

**Output:**
- Creates/updates `.env` with `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GOOGLE_GENERATIVE_AI_API_KEY`
- Can optionally create `.hubolt.yml` with review settings

---

### `hubolt review [filepath]`

Review code changes with AI analysis and static analyzers.

```bash
# Review current working tree
hubolt review

# Review staged changes only
hubolt review --staged

# Review a specific file
hubolt review src/server/app.ts

# Review commit range
hubolt review --base HEAD~1 --head HEAD

# Skip LLM, analyzers only
hubolt review --no-llm

# Override LLM provider/model
hubolt review --provider openai --model gpt-4

# Enable security mode
hubolt review --security

# Select and save review mode
hubolt review mode

# Output formats
hubolt review --json report.json --md report.md

# CI mode (deterministic, exit code on failures)
hubolt review --ci --fail-on high
```

**Options:**
- `[filepath]` - Review a specific file (optional, default: all changes)
- `--staged` - Review staged changes instead of working tree
- `--base <ref>` - Base git ref for commit-range review (requires --head)
- `--head <ref>` - Head git ref for commit-range review (requires --base)
- `--show-context` - Print context sent to LLM (no model call)
- `--provider <name>` - Override LLM provider: `anthropic`, `openai`, `google`
- `--model <model>` - Override model name (e.g., `gpt-4`, `claude-opus`)
- `--security` - Security-scoped review (security findings only)
- `--no-llm` - Skip LLM, run analyzers only
- `--no-cache` - Disable result caching
- `--ci` - CI mode: deterministic output, exit non-zero if findings meet severity threshold
- `--fail-on <severity>` - Exit non-zero if findings reach this severity: `info`, `low`, `medium`, `high`, `critical`
- `--json <path>` - Write JSON report to file
- `--md <path>` - Write Markdown report to file
- `--config <path>` - Path to `.hubolt.yml` config file

### `hubolt review mode`

Select and save the repository review mode in `.hubolt.yml`.

```bash
hubolt review mode
hubolt review mode --set strict
hubolt review mode --config .hubolt.prod.yml
```

**Modes:**
- `quiet` - Lowest-noise review mode
- `balanced` - Default review mode
- `strict` - More critical review mode
- `security` - Security findings only

**Options:**
- `--set <mode>` - Set mode without prompting
- `--config <path>` - Path to `.hubolt.yml` config file

**Examples:**

```bash
# Security review that fails in CI if high-severity issues found
hubolt review --security --ci --fail-on high

# Review specific file with custom model
hubolt review src/auth.ts --provider openai --model gpt-4-turbo

# Generate both report formats
hubolt review --json analysis.json --md analysis.md
```

---

### `hubolt security [options]`

Run a security-scoped review and fail if findings reach a severity threshold.

Shorthand for: `hubolt review --security --fail-on high` with better defaults.

```bash
hubolt security
hubolt security --fail-on critical
hubolt security --staged --json report.json
hubolt security --ci  # For GitHub Actions / CI
```

**Options:**
- `--fail-on <severity>` - Exit non-zero at this severity (default: `high`)
- `--staged` - Review staged changes only
- `--provider <name>` - Override LLM provider
- `--model <model>` - Override model
- `--no-llm` - Analyzers only
- `--ci` - CI mode
- `--json <path>` - Write JSON report
- `--md <path>` - Write Markdown report
- `--config <path>` - Custom config file

**Severity Levels (in order):**
1. `critical` - Highest severity, immediate action needed
2. `high` - Important issues that should be addressed
3. `medium` - Moderate issues worth fixing
4. `low` - Minor issues for consideration
5. `info` - Informational findings

---

### `hubolt analyze`

Run static analyzers without LLM analysis (no API key needed).

```bash
hubolt analyze
hubolt analyze --no-cache
hubolt analyze --json output.json
```

**Options:**
- `--no-cache` - Skip cache
- `--json <path>` - Write JSON report

**Analyzers included:**
- TypeScript type checking
- ESLint linting
- Secret scanning (API keys, tokens, etc.)
- Dependency auditing
- Semgrep rules (if installed)

---

## Configuration Commands

### `hubolt config validate`

Validate your Hubolt configuration and check credentials.

```bash
hubolt config validate
```

**Checks:**
- `.hubolt.yml` syntax and schema
- LLM provider credentials (can connect)
- Environment variables
- Cache directory permissions

---

### `hubolt config show`

Display current configuration (with secrets redacted).

```bash
hubolt config show
```

---

## Server Commands

### `hubolt server`

Start the Hubolt middleware server for team review ingestion.

```bash
# Start on default port 3000
hubolt server

# Custom port and host
hubolt server --port 3001 --host 0.0.0.0

# With environment variables
PORT=8080 HOST=localhost hubolt server
```

**Options:**
- `--port <port>` - Listen port (default: 3000, must be 1-65535)
- `--host <host>` - Listen host (default: 127.0.0.1)

**Endpoints:**
- `GET /health` - Server health check
- `GET /ready` - Readiness probe
- `POST /ingest/review` - Ingest review reports
- `GET /history/reviews` - List ingested reviews
- `GET /audit/export` - Export audit logs

**Database:**
Requires PostgreSQL (docker-compose.yml provided)

```bash
docker-compose up -d          # Start PostgreSQL
npx prisma migrate deploy     # Run migrations
hubolt server                 # Start server
```

---

### `hubolt server bootstrap`

Create initial organization, admin user, and API key for server.

```bash
# Interactive setup
hubolt server bootstrap

# Non-interactive (CI/automation)
hubolt server bootstrap \
  --org mycompany \
  --email admin@mycompany.com \
  --save-env \
  --env-file .env.server
```

**Options:**
- `--org <slug>` - Organization slug (e.g., `mycompany`)
- `--email <email>` - Admin email address
- `--name <name>` - Organization display name
- `--key-name <name>` - API key name (default: `local-dev`)
- `--env-file <path>` - Where to save env vars (default: `.env`)
- `--server-url <url>` - Server URL (default: `http://127.0.0.1:3000`)
- `--save-env` - Save credentials to env file (non-interactive)
- `--no-save-env` - Don't save to env file

**Output:**
```
Organization: mycompany
Admin user:   admin@mycompany.com
API key:      hubolt_xxx... (saved to .env)
```

---

## Push Report Command

### `hubolt push-report`

Push local review report to server.

```bash
# Review locally, then push
hubolt review --json report.json
hubolt push-report \
  --report report.json \
  --server http://localhost:3000 \
  --api-key hubolt_xxx

# From GitHub Actions
hubolt push-report \
  --report report.json \
  --server https://hubolt.company.com \
  --api-key $HUBOLT_API_KEY
```

**Options:**
- `--report <path>` - JSON report file (required)
- `--server <url>` - Server URL (default: env.HUBOLT_SERVER_URL)
- `--api-key <key>` - API key (default: env.HUBOLT_API_KEY)
- `--repo-full-name <owner/repo>` - Repo identity (auto-detected from git)
- `--repo-url <url>` - Repository URL

**Environment Variables:**
- `HUBOLT_SERVER_URL` - Server endpoint
- `HUBOLT_API_KEY` - Authentication token
- `GITHUB_REPOSITORY` - Auto-populated in GitHub Actions

---

## Report Commands

### `hubolt report`

Generate or view code review reports.

```bash
hubolt report
```

---

## Cache Commands

### `hubolt cache`

Manage the local analysis cache.

```bash
hubolt cache              # Show cache status
hubolt cache clear        # Clear all cached results
hubolt cache --path       # Show cache directory path
```

**What's cached:**
- Analyzer results (TypeScript, ESLint, etc.)
- LLM responses for identical code
- Review metadata

**Cache location:** `.hubolt/cache` (or custom in config)

**Benefits:**
- Faster re-reviews of unchanged code
- Reduced API costs
- Offline capability (previously cached)

---

## Logs Commands

### `hubolt logs`

View and analyze review event logs.

```bash
# Tail recent events (last 10)
hubolt logs tail

# Show summary of all events
hubolt logs inspect

# Follow live events
hubolt logs tail --follow
```

**Logged Events:**
- `review.started` - Review began
- `review.analyzing` - Static analysis running
- `llm.prompt` - Prompt sent to model
- `llm.response` - Model response received
- `review.completed` - Review finished with results

**Log location:** `.hubolt/events.jsonl`

---

## Providers Commands

### `hubolt providers`

Manage and list LLM providers.

```bash
hubolt providers list           # List configured providers
hubolt providers list --verbose # Show API key status
```

**Supported Providers:**
- **Anthropic Claude** (default)
  - Models: `claude-opus-4-1`, `claude-sonnet-4`, `claude-haiku-3`
  - Key: `ANTHROPIC_API_KEY`

- **OpenAI**
  - Models: `gpt-4-turbo`, `gpt-4`, `gpt-3.5-turbo`
  - Key: `OPENAI_API_KEY`

- **Google**
  - Models: `gemini-2.0-flash`, `gemini-1.5-pro`
  - Key: `GOOGLE_API_KEY`

---

## Eval Commands

### `hubolt eval`

Run evaluation harness on review findings.

```bash
hubolt eval              # Run all evals
hubolt eval --suite cwe # Run specific evaluation suite
```

**Evaluation Suites:**
- `cwe` - CWE weakness coverage
- `cvss` - CVSS severity accuracy
- `redaction` - Secret redaction effectiveness

---

## Global Options

Available on all commands:

```bash
hubolt --help          # Show command help
hubolt --version       # Show version
```

---

## Configuration File

### `.hubolt.yml`

Main configuration file (auto-created by `hubolt setup`).

```yaml
mode: standard                    # standard or security
failOnSeverity: critical          # Exit code for CI
severityThreshold: low            # Minimum severity to report

llm:
  provider: anthropic             # anthropic, openai, google
  model: claude-opus-4-1          # Model to use
  timeout: 30                     # Seconds

security:
  enabled: false                  # Override with --security
  failOnSeverity: high
  categories:
    - injection
    - authentication
    - cryptography

analyzers:
  typescript: true                # Enable TypeScript checker
  eslint: true                    # Enable ESLint
  semgrep: false                  # Run Semgrep (if installed)
  secretScan: true                # Scan for secrets
  dependencyAudit: true           # Check dependencies

cache:
  enabled: true                   # Cache results
  dir: .hubolt/cache              # Cache directory
  ttl: 604800                     # Time-to-live (seconds)

ignorePatterns:
  - node_modules/
  - dist/
  - .git/
```

---

## Common Workflows

### Local Development

```bash
# 1. One-time setup
hubolt setup

# 2. Review changes before commit
hubolt review

# 3. View detailed report
hubolt review --md report.md

# 4. Check what analyzers find
hubolt analyze --no-llm
```

### Team Server

```bash
# 1. Start server
docker-compose up -d
npx prisma migrate deploy
hubolt server

# 2. Create org and API key
hubolt server bootstrap --org myteam --email admin@team.com

# 3. In CI: push reviews
hubolt review --json report.json
hubolt push-report \
  --report report.json \
  --server https://hubolt.company.com \
  --api-key $API_KEY
```

### GitHub Actions

```yaml
name: Code Review
on: [pull_request]

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - run: npm install -g @m-rithik/hubolt

      - run: hubolt setup --provider anthropic
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}

      - run: hubolt review --json report.json

      - name: Push to server
        if: env.HUBOLT_SERVER_URL != ''
        run: hubolt push-report --report report.json
        env:
          HUBOLT_SERVER_URL: ${{ secrets.HUBOLT_SERVER_URL }}
          HUBOLT_API_KEY: ${{ secrets.HUBOLT_API_KEY }}
```

### CI/CD Gates

```bash
# Fail if high-severity issues found
hubolt security --ci --fail-on high

# In GitHub Actions, exit code will fail the workflow
# Exit code 1 = findings met threshold
# Exit code 0 = no findings, or below threshold
```

---

## Troubleshooting

### Command Not Found

```bash
# Ensure global installation
npm install -g @m-rithik/hubolt

# Or use locally
npx @m-rithik/hubolt review
```

### No API Key

```bash
# Run setup to configure
hubolt setup

# Or set env vars directly
export ANTHROPIC_API_KEY=sk-ant-...
hubolt review
```

### Cache Issues

```bash
# Clear cache
hubolt cache clear

# Disable cache for this run
hubolt review --no-cache
```

### Server Connection Issues

```bash
# Check server is running
curl http://localhost:3000/health

# Check API key
hubolt push-report --report r.json --server http://localhost:3000 --api-key your_key

# View server logs
hubolt server --port 3000
```

---

## Version Info

```bash
hubolt --version

# Output: 0.2.0
```

---

## More Information

- GitHub: https://github.com/m-rithik/hubolt
- Issues: https://github.com/m-rithik/hubolt/issues
- Docs: https://github.com/m-rithik/hubolt#readme
