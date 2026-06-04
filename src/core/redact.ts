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
const TOKEN_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9]{20,}\b/g, // OpenAI
  /\bghp_[A-Za-z0-9]{36}\b/g, // GitHub PAT
  /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g, // GitHub fine-grained PAT
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g // JWT
];

const PEM_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const PEM_END = /-----END [A-Z ]*PRIVATE KEY-----/;
const PEM_INLINE = /(-----BEGIN [A-Z ]*PRIVATE KEY-----)(.*?)(-----END [A-Z ]*PRIVATE KEY-----)/g;
const ENV_VAR_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const ENV_REFERENCE_FIELD = /(?:env|environment|envvar|variable)$/i;

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
      return line;
    }
    if (hasPemEnd) {
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
      if (isEnvVarReference(name, value)) {
        return match;
      }

      const quote = singleValue !== undefined ? "'" : doubleValue !== undefined ? '"' : "`";
      count += 1;
      return `${name}${op}${quote}${placeholder}${quote}`;
    });

    for (const pattern of TOKEN_PATTERNS) {
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
