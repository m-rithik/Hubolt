import safeRegex from "safe-regex2";

const DEFAULT_TIMEOUT_MS = 100;
const DEFAULT_MAX_INPUT_CHARS = 200_000;
const SAFE_REGEX_REPETITION_LIMIT = 25;

export class PatternMatcher {
  constructor(
    private timeoutMs: number = DEFAULT_TIMEOUT_MS,
    private maxInputChars: number = DEFAULT_MAX_INPUT_CHARS
  ) {}

  private testWithTimeout(regex: RegExp, text: string): boolean {
    if (!this.canRun(regex, text)) {
      return false;
    }

    const start = Date.now();
    let match;

    try {
      match = regex.test(text);
      if (Date.now() - start > this.timeoutMs) {
        console.warn(
          `Regex test exceeded timeout (${this.timeoutMs}ms): ${regex.source.substring(0, 50)}...`
        );
      }
      return match;
    } catch (error) {
      console.warn(`Regex error (likely ReDoS): ${regex.source.substring(0, 50)}...`);
      return false;
    }
  }

  private execWithTimeout(regex: RegExp, text: string): RegExpExecArray | null {
    const start = Date.now();
    let result;

    try {
      result = regex.exec(text);
      if (Date.now() - start > this.timeoutMs) {
        console.warn(
          `Regex exec exceeded timeout (${this.timeoutMs}ms): ${regex.source.substring(0, 50)}...`
        );
      }
      return result;
    } catch (error) {
      console.warn(`Regex error (likely ReDoS): ${regex.source.substring(0, 50)}...`);
      return null;
    }
  }

  findAllMatches(regex: RegExp, text: string): string[] {
    const matches: string[] = [];
    if (!this.canRun(regex, text)) {
      return matches;
    }

    const source = regex.source;
    const flags = regex.flags;
    const globalRegex = new RegExp(source, flags.includes("g") ? flags : flags + "g");

    let match;
    let iterations = 0;
    const maxIterations = 10000;

    while ((match = this.execWithTimeout(globalRegex, text)) !== null && iterations < maxIterations) {
      matches.push(match[0]);
      if (match[0] === "") {
        globalRegex.lastIndex++;
      }
      iterations++;
    }

    return matches;
  }

  private canRun(regex: RegExp, text: string): boolean {
    if (text.length > this.maxInputChars) {
      console.warn(`Regex input exceeded limit (${this.maxInputChars} chars): ${regex.source.substring(0, 50)}...`);
      return false;
    }

    if (!this.isSafe(regex)) {
      console.warn(`Unsafe regex rejected before execution: ${regex.source.substring(0, 50)}...`);
      return false;
    }

    return true;
  }

  private isSafe(regex: RegExp): boolean {
    try {
      return safeRegex(regex, { limit: SAFE_REGEX_REPETITION_LIMIT });
    } catch {
      return false;
    }
  }
}

export const SecretPatterns = {
  API_KEY_ASSIGNMENT: createAPIKeyAssignmentRegex(),
  JWT: createJWTRegex(),
  ENV_VAR_ASSIGNMENT: createEnvVarAssignmentRegex(),
  AWS_KEY: /\bAKIA[0-9A-Z]{16}\b/g,
  GITHUB_TOKEN: /ghp_[A-Za-z0-9_]{36,255}/g,
  SLACK_TOKEN: /xox[baprs]-[0-9]{12}-[0-9]{12}-[A-Za-z0-9_]{32,34}/g,
  STRIPE_KEY: /sk_(?:test|live)_[0-9a-zA-Z]{20,}/g,
  FIREBASE_API_KEY: /AIza[0-9A-Za-z\-_]{35}/g
};

function createAPIKeyAssignmentRegex(): RegExp {
  const keynames =
    "api[_-]?key|apikey|api[_-]?secret|apisecret|access[_-]?key|" +
    "accesskey|private[_-]?key|privatekey|auth[_-]?token|authtoken|" +
    "credentials?|creds?|bearer[_-]?token";

  const stringPatterns =
    "(?:'((?:\\\\.|[^'\\\\\n]){4,})'|" +
    '"((?:\\\\.|[^"\\\\\n]){4,})"|' +
    "`((?:\\\\.|[^`\\\\\n]){4,})`)" +
    "|" +
    "(\\S{20,})";

  return new RegExp(`\\b(\\w*(?:${keynames})\\w*)\\b(\\s*[:=]\\s*)${stringPatterns}`, "gi");
}

function createJWTRegex(): RegExp {
  return new RegExp(
    /\b([A-Za-z0-9_\-]{10,})\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g
  );
}

function createEnvVarAssignmentRegex(): RegExp {
  return new RegExp(
    /\b(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*["'`]([^"'`\n]{4,})["'`]/g
  );
}

export function normalizeBoundaryToken(token: string): string | null {
  return token.length === 18 && /^[a-f0-9]{18}$/.test(token) ? token : null;
}

export function validateBoundaryToken(token: string): boolean {
  return token.length === 18 && /^[a-f0-9]{18}$/.test(token);
}
