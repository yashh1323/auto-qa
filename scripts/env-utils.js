/**
 * Strict environment variable placeholder parser, compiler, resolver, and redactor.
 * Restricts placeholders exclusively to ${VAR_NAME} matching ^[A-Z_][A-Z0-9_]*$.
 */

export const ENV_VAR_NAME_REGEX = /^[A-Z_][A-Z0-9_]*$/;

/**
 * Parses AUTO_QA_ALLOWED_ENV_PREFIXES from an environment map.
 * Returns `undefined` when explicitly set to `*` (unrestricted) or when unset without defaults.
 */
export function getAllowedEnvPrefixesFromEnv(env = process.env, defaultPrefixes = undefined) {
  if (
    env &&
    typeof env.AUTO_QA_ALLOWED_ENV_PREFIXES === 'string' &&
    env.AUTO_QA_ALLOWED_ENV_PREFIXES.trim().length > 0
  ) {
    const raw = env.AUTO_QA_ALLOWED_ENV_PREFIXES.trim();
    if (raw === '*') {
      return undefined;
    }
    const list = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return list.length > 0 ? list : defaultPrefixes;
  }
  return defaultPrefixes;
}

function normalizeAllowedPrefixes(options) {
  return Array.isArray(options?.allowedEnvPrefixes)
    ? options.allowedEnvPrefixes.filter((p) => typeof p === 'string' && p.length > 0)
    : [];
}

function assertAllowedPrefix(varName, allowedPrefixes) {
  if (allowedPrefixes.length > 0 && !allowedPrefixes.some((prefix) => varName.startsWith(prefix))) {
    throw new Error(
      `Security Violation: Environment variable "${varName}" is not permitted by prefix allowlist (${allowedPrefixes.join(', ')}).`
    );
  }
}

/**
 * Tokenizes a raw string into literal and strict ${ENV_VAR} segments.
 * Throws if an unclosed '${' or non-compliant identifier expression is found.
 */
export function tokenizeEnvTemplate(raw) {
  if (typeof raw !== 'string') {
    return [{ type: 'literal', value: '' }];
  }

  const tokens = [];
  let cursor = 0;

  while (cursor < raw.length) {
    const start = raw.indexOf('${', cursor);
    if (start === -1) {
      const tail = raw.slice(cursor);
      if (tail.length > 0) {
        tokens.push({ type: 'literal', value: tail });
      }
      break;
    }

    if (start > cursor) {
      tokens.push({ type: 'literal', value: raw.slice(cursor, start) });
    }

    const end = raw.indexOf('}', start + 2);
    if (end === -1) {
      throw new Error(
        'Invalid environment variable placeholder: unclosed "${" expression. Only strict ${VAR_NAME} identifiers matching ^[A-Z_][A-Z0-9_]*$ are allowed.'
      );
    }

    const varName = raw.slice(start + 2, end);
    if (!ENV_VAR_NAME_REGEX.test(varName)) {
      throw new Error(
        `Invalid environment variable placeholder "\${${varName}}". Variable names must strictly match ^[A-Z_][A-Z0-9_]*$.`
      );
    }

    tokens.push({ type: 'env', name: varName });
    cursor = end + 1;
  }

  if (tokens.length === 0) {
    tokens.push({ type: 'literal', value: '' });
  }

  return tokens;
}

/**
 * Compiles a string template containing optional ${ENV_VAR} placeholders into
 * safe TypeScript expression code using parameterized requireEnv() lookups.
 */
export function compileEnvTemplate(raw, options = {}) {
  const safeRaw = typeof raw === 'string' ? raw : '';
  const tokens = tokenizeEnvTemplate(safeRaw);
  const allowedPrefixes = normalizeAllowedPrefixes(options);
  const usesEnv = tokens.some((t) => t.type === 'env');

  if (!usesEnv) {
    return {
      code: JSON.stringify(safeRaw),
      usesEnv: false
    };
  }

  const parts = tokens.map((t) => {
    if (t.type === 'literal') {
      return JSON.stringify(t.value);
    }
    assertAllowedPrefix(t.name, allowedPrefixes);
    return `requireEnv(${JSON.stringify(t.name)}, process.env[${JSON.stringify(t.name)}])`;
  });

  return {
    code: parts.join(' + '),
    usesEnv: true
  };
}

/**
 * Resolves ${ENV_VAR} placeholders from `env` at runtime, failing closed if any referenced
 * variable is unset or empty. Optionally enforces allowed prefixes and records secrets for redaction.
 */
export function resolveEnvTemplate(raw, env = process.env, resolvedSecrets = null, options = {}) {
  const tokens = tokenizeEnvTemplate(raw);
  const allowedPrefixes = normalizeAllowedPrefixes(options);
  let resolved = '';

  for (const token of tokens) {
    if (token.type === 'literal') {
      resolved += token.value;
    } else {
      assertAllowedPrefix(token.name, allowedPrefixes);

      const val = env && Object.hasOwn(env, token.name) ? env[token.name] : undefined;
      if (val === undefined || val === '') {
        throw new Error(`Missing required environment variable: ${token.name}`);
      }
      if (resolvedSecrets instanceof Map) {
        resolvedSecrets.set(val, token.name);
      }
      resolved += val;
    }
  }

  return resolved;
}

/**
 * Recursively scrubs resolved secret values (including URL-encoded, URLSearchParams '+' form-encoded,
 * and lowercase percent-hex variants) from strings, arrays, or plain objects without mutating keys.
 * Note: resolved values shorter than 3 characters are intentionally skipped to avoid false-positive corruption.
 */
export function redactSecrets(input, resolvedSecrets) {
  if (!resolvedSecrets || resolvedSecrets.size === 0 || input == null) {
    return input;
  }

  const toLowerHex = (encoded) => encoded.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());

  const variants = [];
  for (const [secretVal, varName] of resolvedSecrets.entries()) {
    if (typeof secretVal !== 'string' || secretVal.length < 3) continue;
    const candidateSet = new Set([secretVal]);

    const addEncoded = (fn) => {
      try {
        const enc = fn(secretVal);
        if (enc && enc.length >= 3) {
          candidateSet.add(enc);
          const lower = toLowerHex(enc);
          if (lower.length >= 3) candidateSet.add(lower);
        }
      } catch (_) {}
    };

    addEncoded((v) => encodeURIComponent(v));
    addEncoded((v) => encodeURI(v));
    addEncoded((v) => new URLSearchParams([['k', v]]).toString().slice(2));

    for (const candidate of candidateSet) {
      variants.push([candidate, varName]);
    }
  }

  variants.sort((a, b) => b[0].length - a[0].length);

  if (variants.length === 0) {
    return input;
  }

  const scrub = (val) => {
    if (typeof val === 'string') {
      let out = val;
      for (const [secretVariant, varName] of variants) {
        if (out.includes(secretVariant)) {
          out = out.split(secretVariant).join(`[REDACTED:${varName}]`);
        }
      }
      return out;
    }
    if (Array.isArray(val)) {
      return val.map(scrub);
    }
    if (Object.prototype.toString.call(val) === '[object Object]') {
      const outObj = {};
      for (const [k, v] of Object.entries(val)) {
        outObj[k] = scrub(v);
      }
      return outObj;
    }
    return val;
  };

  return scrub(input);
}
