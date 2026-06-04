export interface RedactionResult {
  text: string;
  count: number;
}

export interface RedactionOptions {
  placeholder?: string;
}

const PLACEHOLDER = "[REDACTED]";

// Secret-like assignment: a key whose name contains a sensitive word, assigned
// to a quoted literal. Captures name + operator + quote so they are preserved
// and only the value is replaced (keeps the line intact for line numbering).
const ASSIGNMENT =
  /\b(\w*(?:api[_-]?key|secret|token|password|passwd|pwd|access[_-]?key|private[_-]?key|client[_-]?secret|auth|credential)\w*)\b(\s*[:=]\s*)(?:'((?:\\.|[^'\\\n]){4,})'|"((?:\\.|[^"\\\n]){4,})"|`((?:\\.|[^`\\\n]){4,})`)/gi;

// Provider-specific token shapes that are secrets regardless of surrounding code.
interface TokenPattern {
  ruleId: string;
  label: string;
  pattern: RegExp;
}

const TOKEN_PATTERNS: TokenPattern[] = [
  { ruleId: "secret.openai-key", label: "OpenAI API key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { ruleId: "secret.github-pat", label: "GitHub token", pattern: /\bghp_[A-Za-z0-9]{36}\b/g },
  { ruleId: "secret.github-pat", label: "GitHub fine-grained token", pattern: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g },
  { ruleId: "secret.aws-access-key", label: "AWS access key id", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { ruleId: "secret.google-key", label: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { ruleId: "secret.slack-token", label: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  {
    ruleId: "secret.jwt",
    label: "JSON Web Token",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g
  }
];

const PEM_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const PEM_END = /-----END [A-Z ]*PRIVATE KEY-----/;
const PEM_INLINE = /(-----BEGIN [A-Z ]*PRIVATE KEY-----)(.*?)(-----END [A-Z ]*PRIVATE KEY-----)/g;
const PEM_INLINE_ONCE = /(-----BEGIN [A-Z ]*PRIVATE KEY-----)(.*?)(-----END [A-Z ]*PRIVATE KEY-----)/;
const PEM_BEGIN_REST = /(-----BEGIN [A-Z ]*PRIVATE KEY-----)(.*)$/;
const PEM_END_PREFIX = /^(.*?)(-----END [A-Z ]*PRIVATE KEY-----)/;
const ENV_VAR_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const ENV_REFERENCE_FIELD = /(?:env|environment|envvar|variable)$/i;
const REDACTION_METADATA_VALUE = /^(?:\$\{redacted\.count\}|\d+)$/;

/**
 * Redact secrets from source text before it is sent to a model.
 *
 * Operates line by line and only ever replaces within a line, so the total line
 * count is preserved and the line numbers a reviewer reports still match the
 * original file. Covers secret-like assignments, well-known token shapes, and
 * the body of PEM private-key blocks. This is best-effort defense in depth, not
 * a guarantee that every secret is caught.
 */
export function redactSecrets(text: string, options: RedactionOptions = {}): RedactionResult {
  const placeholder = options.placeholder ?? PLACEHOLDER;
  let count = 0;
  let inPem = false;

  const lines = text.split("\n").map((line) => {
    const hasPemBegin = PEM_BEGIN.test(line);
    const hasPemEnd = PEM_END.test(line);

    if (hasPemBegin && hasPemEnd) {
      return line.replace(PEM_INLINE, (_match, begin, body, end) => {
        if (String(body).trim().length === 0) {
          return `${begin}${body}${end}`;
        }
        count += 1;
        return `${begin}${placeholder}${end}`;
      });
    }
    if (hasPemBegin) {
      inPem = true;
      const beginLine = redactPemBeginLine(line, placeholder);
      count += beginLine.count;
      return beginLine.text;
    }
    if (hasPemEnd) {
      if (inPem) {
        const endLine = redactPemEndLine(line, placeholder);
        count += endLine.count;
        inPem = false;
        return endLine.text;
      }
      inPem = false;
      return line;
    }
    if (inPem) {
      if (line.trim().length > 0) {
        count += 1;
        return placeholder;
      }
      return line;
    }

    let redacted = line.replace(ASSIGNMENT, (match, name, op, singleValue, doubleValue, backtickValue) => {
      const value = String(singleValue ?? doubleValue ?? backtickValue ?? "");
      if (isRedactionMetadata(name, value) || isEnvVarReference(name, value)) {
        return match;
      }

      const quote = singleValue !== undefined ? "'" : doubleValue !== undefined ? '"' : "`";
      count += 1;
      return `${name}${op}${quote}${placeholder}${quote}`;
    });

    for (const { pattern } of TOKEN_PATTERNS) {
      redacted = redacted.replace(pattern, () => {
        count += 1;
        return placeholder;
      });
    }

    return redacted;
  });

  return { text: lines.join("\n"), count };
}

function isEnvVarReference(name: string, value: string): boolean {
  return ENV_REFERENCE_FIELD.test(name) && ENV_VAR_NAME.test(value);
}

function isRedactionMetadata(name: string, value: string): boolean {
  return name === "redactedSecrets" && REDACTION_METADATA_VALUE.test(value);
}

function redactPemBeginLine(line: string, placeholder: string): RedactionResult {
  let count = 0;
  const text = line.replace(PEM_BEGIN_REST, (_match, begin, body) => {
    if (String(body).trim().length === 0) {
      return `${begin}${body}`;
    }
    count += 1;
    return `${begin}${placeholder}`;
  });

  return { text, count };
}

function redactPemEndLine(line: string, placeholder: string): RedactionResult {
  let count = 0;
  const text = line.replace(PEM_END_PREFIX, (_match, body, end) => {
    if (String(body).trim().length === 0) {
      return `${body}${end}`;
    }
    count += 1;
    return `${placeholder}${end}`;
  });

  return { text, count };
}

export interface SecretMatch {
  /** 1-based line number where the secret occurs. */
  line: number;
  ruleId: string;
  /** Safe description with no secret value embedded. */
  message: string;
}

/**
 * Locate likely secrets and return their line numbers and a safe description.
 *
 * Shares the same patterns and env-var guard as `redactSecrets`, so a secret the
 * redactor would hide is the same secret this reports. It never returns the
 * secret value itself, only the line and a generic message, so callers can build
 * analyzer signals without leaking credentials into output or logs.
 */
export function scanSecrets(text: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  let inPem = false;

  text.split("\n").forEach((line, index) => {
    const lineNumber = index + 1;
    const hasPemBegin = PEM_BEGIN.test(line);
    const hasPemEnd = PEM_END.test(line);

    if (hasPemBegin && hasPemEnd) {
      const inline = PEM_INLINE_ONCE.exec(line);
      if (inline && String(inline[2]).trim().length > 0) {
        matches.push({ line: lineNumber, ruleId: "secret.private-key", message: "Private key material detected." });
      }
      return;
    }
    if (hasPemBegin) {
      if (pemBeginLineHasMaterial(line)) {
        matches.push({ line: lineNumber, ruleId: "secret.private-key", message: "Private key material detected." });
      }
      inPem = true;
      return;
    }
    if (hasPemEnd) {
      if (inPem && pemEndLineHasMaterial(line)) {
        matches.push({ line: lineNumber, ruleId: "secret.private-key", message: "Private key material detected." });
      }
      inPem = false;
      return;
    }
    if (inPem) {
      if (line.trim().length > 0) {
        matches.push({ line: lineNumber, ruleId: "secret.private-key", message: "Private key material detected." });
      }
      return;
    }

    for (const assignment of line.matchAll(ASSIGNMENT)) {
      const name = String(assignment[1]);
      const value = String(assignment[3] ?? assignment[4] ?? assignment[5] ?? "");
      if (isRedactionMetadata(name, value) || isEnvVarReference(name, value)) {
        continue;
      }
      matches.push({
        line: lineNumber,
        ruleId: "secret.hardcoded-credential",
        message: `Possible hardcoded secret assigned to "${name}".`
      });
    }

    for (const { ruleId, label, pattern } of TOKEN_PATTERNS) {
      for (const _token of line.matchAll(pattern)) {
        void _token;
        matches.push({ line: lineNumber, ruleId, message: `Possible ${label} detected.` });
      }
    }
  });

  return matches;
}

function pemBeginLineHasMaterial(line: string): boolean {
  const match = PEM_BEGIN_REST.exec(line);
  return match ? String(match[2]).trim().length > 0 : false;
}

function pemEndLineHasMaterial(line: string): boolean {
  const match = PEM_END_PREFIX.exec(line);
  return match ? String(match[1]).trim().length > 0 : false;
}
