/**
 * Single source of truth for parsing declarative Auto-QA step intents into a typed IR
 * shared by both the Playwright code compiler (compiler.js) and runtime executor (executor.js).
 */

/**
 * Escapes double quotes, backslashes, and control whitespace for safe CSS attribute selectors.
 */
export function escapeCssString(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n\f\0]+/g, ' ');
}

/**
 * Unescapes backslash-escaped quote and backslash sequences inside a matched literal.
 */
export function unescapeQuoted(str, quoteChar) {
  if (typeof str !== 'string') return '';
  if (quoteChar === '"') {
    return str.replace(/\\(["\\])/g, '$1');
  }
  if (quoteChar === "'") {
    return str.replace(/\\(['\\])/g, '$1');
  }
  return str;
}

/**
 * Strips leading/trailing filler words outside quotes in single-pass O(N) time,
 * then strips one outer quote pair and unescapes matching escaped quotes inside.
 */
export function stripFillerAndQuotes(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw
    .trim()
    .replace(/^(?:(?:on|the|button|link|input|textbox|field|checkbox|dropdown|select)\s+)+/i, '')
    .trim()
    .replace(/(?:\s+(?:button|link|input|textbox|field|checkbox|dropdown))+$/i, '')
    .trim();

  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    const q = s[0];
    s = unescapeQuoted(s.slice(1, -1), q);
  }

  return s.trim();
}

/**
 * Linear O(N) boundary-aware quoted string scanner so apostrophes in contractions
 * ("user's", "isn't") never act as delimiters and adversarial payloads never degrade to O(N^2).
 */
export function findQuotedLiteralSpan(desc) {
  if (typeof desc !== 'string') return null;

  const isOpenBoundary = (idx) => idx === 0 || /[\s(]/.test(desc[idx - 1]);
  const isCloseBoundary = (idx) => idx + 1 === desc.length || /[\s.,;!?)]/.test(desc[idx + 1]);
  const exhausted = { '"': false, "'": false };

  for (let i = 0; i < desc.length; i++) {
    const ch = desc[i];
    if ((ch !== '"' && ch !== "'") || exhausted[ch] || !isOpenBoundary(i)) {
      continue;
    }

    let closedAt = -1;
    for (let j = i + 1; j < desc.length; j++) {
      if (desc[j] === '\\') {
        j++;
        continue;
      }
      if (desc[j] === ch) {
        closedAt = j;
        break;
      }
    }

    if (closedAt === -1) {
      exhausted[ch] = true;
      continue;
    }

    if (isCloseBoundary(closedAt)) {
      return {
        literal: unescapeQuoted(desc.slice(i + 1, closedAt), ch),
        start: i,
        end: closedAt + 1
      };
    }
  }

  return null;
}

/**
 * Convenience wrapper returning only the extracted quoted string literal or null.
 */
export function extractQuotedLiteral(desc) {
  const span = findQuotedLiteralSpan(desc);
  return span ? span.literal : null;
}

/**
 * Extracts a linear-time navigation target token from the remainder of a navigate/go/open step.
 */
function extractNavTargetToken(rest) {
  const trimmed = rest.trim();
  if (!trimmed) return '';

  const firstChar = trimmed[0];
  if (firstChar === '"' || firstChar === "'") {
    for (let j = 1; j < trimmed.length; j++) {
      if (trimmed[j] === '\\') {
        j++;
        continue;
      }
      if (trimmed[j] === firstChar) {
        return unescapeQuoted(trimmed.slice(1, j), firstChar);
      }
    }
    return trimmed.slice(1).split(/\s+/)[0] || '';
  }

  const spaceIdx = trimmed.search(/\s/);
  return spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
}

/**
 * Parses a single plan step object into a normalized IR consumed identically by compiler and executor.
 */
export function parseStepIntent(step) {
  if (!step || typeof step !== 'object' || typeof step.type !== 'string' || typeof step.description !== 'string') {
    throw new Error('Invalid test step: each step must have string "type" and "description" fields.');
  }

  const desc = step.description.trim();
  const type = step.type.trim().toLowerCase();

  if (type === 'action') {
    // 1. Navigation
    const navMatch = desc.match(/^(?:navigate\s+to|go\s+to|open)\s+(.+)$/is);
    if (navMatch) {
      const rawUrl = extractNavTargetToken(navMatch[1]);
      if (/[\x00-\x1f\x7f]/.test(rawUrl)) {
        throw new Error('Navigation blocked: URL contains disallowed control characters.');
      }
      const cleanUrl = rawUrl.trim();
      if (!cleanUrl) {
        throw new Error(`Invalid navigation step "${desc}": missing URL or path.`);
      }
      if (/^[/\\]{2}/.test(cleanUrl) || cleanUrl.startsWith('\\')) {
        throw new Error('Navigation blocked: protocol-relative or backslash URLs are not permitted.');
      }
      const schemeMatch = cleanUrl.match(/^([a-z][a-z0-9+.-]*):/i);
      if (schemeMatch && schemeMatch[1].toLowerCase() !== 'http' && schemeMatch[1].toLowerCase() !== 'https') {
        throw new Error(
          `Navigation blocked: protocol "${schemeMatch[1].toLowerCase()}:" is not permitted. Only http: and https: are allowed.`
        );
      }
      return { kind: 'navigate', rawUrl: cleanUrl };
    }

    // 2. Fill / Type / Enter (supports empty string "" and unquoted values like ${QA_EMAIL})
    if (/^(?:type|enter|fill)\b/i.test(desc)) {
      const quotedFill = desc.match(
        /^(?:type|enter|fill)\s+(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')\s*(?:into|in)?\s*(.*)$/i
      );
      let rawValue;
      let rawTarget;

      if (quotedFill) {
        rawValue = quotedFill[1] !== undefined
          ? unescapeQuoted(quotedFill[1], '"')
          : unescapeQuoted(quotedFill[2], "'");
        rawTarget = (quotedFill[3] || '').trim();
      } else {
        const unquotedFill = desc.match(/^(?:type|enter|fill)\s+([^\s"']+)\s+(?:into|in)\s+(.+)$/i);
        if (!unquotedFill) {
          throw new Error(`Invalid fill step "${desc}": expected format "fill '<value>' into '<target>'".`);
        }
        rawValue = unquotedFill[1];
        rawTarget = unquotedFill[2].trim();
      }

      const target = stripFillerAndQuotes(rawTarget);
      if (!target) {
        throw new Error(`Invalid fill step "${desc}": missing target field name.`);
      }
      return { kind: 'fill', rawValue, target };
    }

    // 3. Select
    if (/^select\b/i.test(desc)) {
      const quotedSelect = desc.match(
        /^select\s+(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')(?:\s*(?:in|from)\s+(.+))?$/i
      );
      let rawValue;
      let rawTarget = '';

      if (quotedSelect) {
        rawValue = quotedSelect[1] !== undefined
          ? unescapeQuoted(quotedSelect[1], '"')
          : unescapeQuoted(quotedSelect[2], "'");
        rawTarget = quotedSelect[3] ? quotedSelect[3].trim() : '';
      } else {
        const unquotedSelect = desc.match(/^select\s+([^\s"']+)(?:\s*(?:in|from)\s+(.+))?$/i);
        if (!unquotedSelect) {
          throw new Error(`Invalid select step "${desc}": expected format "select '<option>' from '<target>'".`);
        }
        rawValue = unquotedSelect[1];
        rawTarget = unquotedSelect[2] ? unquotedSelect[2].trim() : '';
      }

      const target = rawTarget ? stripFillerAndQuotes(rawTarget) : 'select';
      return { kind: 'select', rawValue, target: target || 'select' };
    }

    // 4. Check / Tick
    if (/^(?:check|tick)\b/i.test(desc)) {
      const rawTarget = desc.replace(/^(?:check|tick)\s+/i, '').trim();
      const target = stripFillerAndQuotes(rawTarget);
      if (!target) {
        throw new Error(`Invalid check step "${desc}": missing checkbox target.`);
      }
      return { kind: 'check', target };
    }

    // 5. Click / Press
    if (/^(?:click|press)\b/i.test(desc)) {
      const rawTarget = desc.replace(/^(?:click|press)\s+/i, '').trim();
      const target = stripFillerAndQuotes(rawTarget);
      if (!target) {
        throw new Error(`Invalid click step "${desc}": missing click target.`);
      }
      return { kind: 'click', target };
    }

    throw new Error(
      `Unsupported action step: "${desc}". Supported verbs: navigate/go to/open, fill/type/enter, select, check/tick, click/press.`
    );
  }

  if (type === 'assertion') {
    const quotedSpan = findQuotedLiteralSpan(desc);
    const outsideQuotes = quotedSpan
      ? `${desc.slice(0, quotedSpan.start)} ${desc.slice(quotedSpan.end)}`
      : desc;

    const negative = /\b(?:not\s+(?:visible|displayed|contain|contains|appear|appears|match|matches|equal|equals|present|shown|be)|should\s+not|does\s+not|do\s+not|is\s+not|are\s+not|cannot|can't|isn't|aren't|doesn't|don't|shouldn't|didn't|won't|disappear|disappears|hidden|absent)\b/i.test(
      outsideQuotes
    );

    // 1. Visibility assertions (classified strictly from text outside quotes)
    if (/\b(?:visible|displayed|appears|appear|disappear|disappears|hidden|absent)\b/i.test(outsideQuotes)) {
      const target = quotedSpan !== null
        ? quotedSpan.literal
        : desc
            .replace(/\b(?:verify|assert|check|that|should|be|not|does|do|is|are|can't|isn't|aren't|doesn't|don't|shouldn't|didn't|won't|visible|displayed|appears|appear|disappear|disappears|hidden|absent|present|shown)\b/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
      if (!target) {
        throw new Error(`Invalid visibility assertion "${desc}": missing target.`);
      }
      return { kind: 'assert-visible', negative, target };
    }

    // 2. URL / path assertions (precedes generic contains/text; inspects outsideQuotes only!)
    if (/\b(?:url|path)\b/i.test(outsideQuotes) && !/^(?:verify|assert|check)\s+(?:that\s+)?text\b/i.test(outsideQuotes.trim())) {
      let target = quotedSpan !== null ? quotedSpan.literal : null;
      if (target === null) {
        const trailingMatch = desc.match(/\b(?:contains|contain|is|matches|equals|has)\s+(\S+)$/i);
        target = trailingMatch ? trailingMatch[1] : '';
      }
      if (!target) {
        throw new Error(`Invalid URL assertion "${desc}": missing expected URL fragment.`);
      }
      return { kind: 'assert-url', negative, target };
    }

    // 3. Text / contains assertions
    if (/\b(?:contains|contain|text)\b/i.test(outsideQuotes)) {
      const target = quotedSpan !== null
        ? quotedSpan.literal
        : desc
            .replace(/\b(?:verify|assert|check|that|page|should|not|does|do|contains|contain|text|doesn't|don't|shouldn't)\b/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
      if (!target) {
        throw new Error(`Invalid text assertion "${desc}": missing expected text.`);
      }
      return { kind: 'assert-text', negative, target };
    }

    throw new Error(
      `Unsupported assertion step: "${desc}". Supported assertions: visible/hidden, URL contains, text/contains.`
    );
  }

  throw new Error(`Unsupported step type "${step.type}". Expected "action" or "assertion".`);
}
