import { compileEnvTemplate } from './env-utils.js';
import { assertValidHttpUrl } from './url-utils.js';
import { parseStepIntent, escapeCssString } from './intent-parser.js';

const WELL_KNOWN_INPUT_TYPES = new Set(['email', 'password', 'search', 'tel', 'url', 'number', 'text']);

/**
 * Escapes special regex metacharacters including forward slashes to ensure safe RegExp instantiation.
 */
function sanitizeRegexPattern(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
}

/**
 * Emits a safe new RegExp(...) expression string with JSON-encoded patterns.
 */
function emitSafeRegExp(pattern, flags = 'i') {
  const safePattern = sanitizeRegexPattern(pattern);
  return `new RegExp(${JSON.stringify(safePattern)}, ${JSON.stringify(flags)})`;
}

/**
 * Emits a dynamic RegExp expression from a compiled string expression containing ${ENV_VAR}.
 */
function emitDynamicRegExpExpr(valueExpr, flags = 'i') {
  return `new RegExp((${valueExpr}).replace(/[.*+?^$()|[\\]\\\\\\/\\{\\}]/g, '\\\\$&'), ${JSON.stringify(flags)})`;
}

function emitCssEscape(varName, escapedName) {
  return `      const ${escapedName} = ${varName}.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"').replace(/[\\r\\n\\f\\0]+/g, ' ');\n`;
}

/**
 * Builds the standalone self-contained assertSafeHttpUrl TypeScript helper emitted when needed.
 */
function emitAssertSafeHttpUrlHelper() {
  return [
    `function assertSafeHttpUrl(rawUrl: string): string {`,
    `  if (typeof rawUrl !== 'string' || /[\\x00-\\x1f\\x7f]/.test(rawUrl)) {`,
    `    throw new Error('Invalid URL format: only valid http: and https: URLs are allowed.');`,
    `  }`,
    `  let parsed;`,
    `  try {`,
    `    parsed = new URL(rawUrl);`,
    `  } catch (_) {`,
    `    throw new Error('Invalid URL format: only valid http: and https: URLs are allowed.');`,
    `  }`,
    `  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {`,
    `    throw new Error(\`Navigation blocked: protocol "\${parsed.protocol}" is not permitted.\`);`,
    `  }`,
    `  const host = parsed.hostname.toLowerCase().replace(/\\.+$/, '').replace(/^\\[|\\]$/g, '').split('%')[0];`,
    `  const isMeta =`,
    `    !host ||`,
    `    host === 'metadata' ||`,
    `    host === 'metadata.goog' ||`,
    `    host === 'metadata.google.internal' ||`,
    `    host.endsWith('.metadata.google.internal') ||`,
    `    host === 'instance-data';`,
    `  if (isMeta) throw new Error(\`Navigation blocked: host "\${host}" is restricted.\`);`,
    `  const parseV4 = (s) => {`,
    `    if (!/^\\d{1,3}(?:\\.\\d{1,3}){3}$/.test(s)) return null;`,
    `    const p = s.split('.'); let o = 0;`,
    `    for (const q of p) { const n = Number(q); if (n < 0 || n > 255) return null; o = ((o << 8) | n) >>> 0; }`,
    `    return o;`,
    `  };`,
    `  const parseV6 = (s) => {`,
    `    if (!s.includes(':')) return null;`,
    `    const di = s.indexOf('::');`,
    `    if (di !== -1 && s.indexOf('::', di + 2) !== -1) return null;`,
    `    const parseList = (str) => {`,
    `      if (!str) return [];`,
    `      const arr = str.split(':'); const out = [];`,
    `      for (let i = 0; i < arr.length; i++) {`,
    `        const part = arr[i]; if (!part) return null;`,
    `        if (part.includes('.')) {`,
    `          if (i !== arr.length - 1) return null;`,
    `          const iv = parseV4(part); if (iv === null) return null;`,
    `          out.push((iv >>> 16) & 0xffff, iv & 0xffff);`,
    `        } else {`,
    `          if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;`,
    `          out.push(parseInt(part, 16));`,
    `        }`,
    `      }`,
    `      return out;`,
    `    };`,
    `    if (di === -1) { const g = parseList(s); return g && g.length === 8 ? g : null; }`,
    `    const l = parseList(s.slice(0, di)); const r = parseList(s.slice(di + 2));`,
    `    if (!l || !r || l.length + r.length > 7) return null;`,
    `    return [...l, ...new Array(8 - l.length - r.length).fill(0), ...r];`,
    `  };`,
    `  const in4 = (ip, a, b, c, d, pfx) => {`,
    `    const base = (((a & 0xff) << 24) | ((b & 0xff) << 16) | ((c & 0xff) << 8) | (d & 0xff)) >>> 0;`,
    `    if (pfx === 32) return ip === base;`,
    `    const mask = (0xffffffff << (32 - pfx)) >>> 0;`,
    `    return (ip & mask) === (base & mask);`,
    `  };`,
    `  let v4 = parseV4(host); let v6 = null;`,
    `  if (v4 === null) {`,
    `    v6 = parseV6(host);`,
    `    if (v6) {`,
    `      const z5 = v6[0] === 0 && v6[1] === 0 && v6[2] === 0 && v6[3] === 0 && v6[4] === 0;`,
    `      if ((z5 && v6[5] === 0xffff) || (z5 && v6[5] === 0 && !(v6[6] === 0 && v6[7] <= 1)) || (v6[0] === 0x0064 && v6[1] === 0xff9b && v6[2] === 0 && v6[3] === 0 && v6[4] === 0 && v6[5] === 0)) {`,
    `        v4 = ((v6[6] << 16) | v6[7]) >>> 0;`,
    `      }`,
    `    }`,
    `  }`,
    `  if (v4 !== null && (in4(v4, 169, 254, 0, 0, 16) || in4(v4, 100, 100, 100, 200, 32) || in4(v4, 168, 63, 129, 16, 32) || in4(v4, 192, 0, 0, 192, 32))) {`,
    `    throw new Error(\`Navigation blocked: host "\${host}" is a restricted metadata/link-local address.\`);`,
    `  }`,
    `  if (v6 && ((v6[0] & 0xffc0) === 0xfe80 || (v6[0] === 0xfd00 && v6[1] === 0x0ec2))) {`,
    `    throw new Error(\`Navigation blocked: host "\${host}" is a restricted metadata/link-local address.\`);`,
    `  }`,
    `  const allowPriv = typeof process !== 'undefined' && process && process.env && process.env['AUTO_QA_ALLOW_PRIVATE_NETWORK'] === '1';`,
    `  const isPriv4 = v4 !== null && (in4(v4, 10, 0, 0, 0, 8) || in4(v4, 172, 16, 0, 0, 12) || in4(v4, 192, 168, 0, 0, 16) || in4(v4, 100, 64, 0, 0, 10));`,
    `  const isPriv6 = Boolean(v6 && (v6[0] & 0xfe00) === 0xfc00);`,
    `  if (!allowPriv && (isPriv4 || isPriv6)) {`,
    `    throw new Error(\`Navigation blocked: private network host "\${host}" is blocked (set AUTO_QA_ALLOW_PRIVATE_NETWORK=1 to allow).\`);`,
    `  }`,
    `  return parsed.toString();`,
    `}`,
    ``
  ].join('\n');
}

/**
 * Compiles a declarative intent test plan (plan.json) into an idiomatic,
 * fully parameterized native Playwright TypeScript test file (@playwright/test).
 */
export function compilePlanToPlaywright(plan, options = {}) {
  const {
    targetUrl = plan.targetUrl || 'http://localhost:3000',
    suiteName = plan.name || 'Automated QA Test Suite',
    maxSteps = 200,
    allowedEnvPrefixes
  } = options;

  const envOpts = { allowedEnvPrefixes };
  let usesEnvHelper = false;
  let usesUrlHelper = false;

  const emitValueExpr = (rawVal) => {
    const compiled = compileEnvTemplate(rawVal, envOpts);
    if (compiled.usesEnv) usesEnvHelper = true;
    return compiled.code;
  };

  if (typeof targetUrl === 'string' && !targetUrl.includes('${')) {
    assertValidHttpUrl(targetUrl);
  } else {
    usesUrlHelper = true;
  }

  const steps = Array.isArray(plan.planSteps) ? plan.planSteps : [];
  if (steps.length > maxSteps) {
    throw new Error(`Compilation aborted: step count (${steps.length}) exceeds maximum limit of ${maxSteps}.`);
  }

  let body = `test.describe(${JSON.stringify(suiteName)}, () => {\n`;
  body += `  test(${JSON.stringify(plan.name || 'End-to-End User Flow')}, async ({ page }) => {\n`;
  body += `    // Base URL navigation\n`;
  if (typeof targetUrl === 'string' && targetUrl.includes('${')) {
    body += `    await page.goto(assertSafeHttpUrl(${emitValueExpr(targetUrl)}));\n\n`;
  } else {
    body += `    await page.goto(${emitValueExpr(targetUrl)});\n\n`;
  }

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const intent = parseStepIntent(step);
    const desc = step.description;

    body += `    await test.step(${JSON.stringify(desc)}, async () => {\n`;

    if (intent.kind === 'navigate') {
      const rawUrl = intent.rawUrl;
      if (rawUrl.includes('${')) {
        usesUrlHelper = true;
        const urlExpr = emitValueExpr(rawUrl);
        body += `      const navTarget = ${urlExpr};\n`;
        body += `      if (/[\\x00-\\x1f\\x7f]/.test(navTarget)) {\n`;
        body += `        throw new Error('Navigation blocked: URL contains disallowed control characters.');\n`;
        body += `      }\n`;
        body += `      const trimmedNav = navTarget.trim();\n`;
        body += `      if (!trimmedNav || /^[/\\\\]{2}/.test(trimmedNav) || /^\\\\/.test(trimmedNav)) {\n`;
        body += `        throw new Error('Navigation blocked: invalid relative or protocol-relative URL.');\n`;
        body += `      }\n`;
        body += `      const resolvedNav = /^https?:\\/\\//i.test(trimmedNav)\n`;
        body += `        ? assertSafeHttpUrl(trimmedNav)\n`;
        body += `        : assertSafeHttpUrl(new URL(trimmedNav, page.url()).toString());\n`;
        body += `      await page.goto(resolvedNav);\n`;
      } else if (/^[a-z][a-z0-9+.-]*:/i.test(rawUrl)) {
        assertValidHttpUrl(rawUrl);
        body += `      await page.goto(${JSON.stringify(rawUrl)});\n`;
      } else {
        if (/[\x00-\x1f\x7f]/.test(rawUrl) || /^[/\\]{2}/.test(rawUrl) || rawUrl.startsWith('\\')) {
          throw new Error('Navigation blocked: invalid relative or control-character URL.');
        }
        usesUrlHelper = true;
        body += `      await page.goto(assertSafeHttpUrl(new URL(${JSON.stringify(rawUrl)}, page.url()).toString()));\n`;
      }
    } else if (intent.kind === 'fill' || intent.kind === 'select') {
      const dynamic = intent.target.includes('${');
      if (dynamic) {
        body += `      const field = ${emitValueExpr(intent.target)};\n`;
        body += emitCssEscape('field', 'fieldCss');
      }
      const safeRegex = dynamic ? emitDynamicRegExpExpr('field') : emitSafeRegExp(intent.target, 'i');
      const cssValue = dynamic ? '${fieldCss}' : escapeCssString(intent.target);
      const fill = intent.kind === 'fill';
      const tags = fill ? ['input', 'textarea'] : ['select'];
      const selectors = tags.flatMap(tag =>
        ['name', 'id'].map(attr => `${tag}[${attr}*="${cssValue}" i]`)
      );
      if (fill && (dynamic || WELL_KNOWN_INPUT_TYPES.has(intent.target.toLowerCase()))) {
        selectors.push(`input[type="${cssValue}" i]`);
      }
      const css = selectors.join(', ');
      const selectorExpr = dynamic ? '`' + css + '`' : JSON.stringify(css);
      if (fill) {
        body += `      const fieldEl = page.getByLabel(${safeRegex})\n`;
        body += `        .or(page.getByPlaceholder(${safeRegex}))\n`;
        body += `        .or(page.getByRole('textbox', { name: ${safeRegex} }))\n`;
      } else {
        body += `      const fieldEl = page.getByRole('combobox', { name: ${safeRegex} })\n`;
      }
      body += `        .or(page.locator(${selectorExpr}));\n`;
      body += `      await fieldEl.first().${fill ? 'fill' : 'selectOption'}(${emitValueExpr(intent.rawValue)});\n`;
    } else if (intent.kind === 'check') {
      const compiledTarget = compileEnvTemplate(intent.target, envOpts);
      if (compiledTarget.usesEnv) {
        usesEnvHelper = true;
        body += `      const checkTargetRe = ${emitDynamicRegExpExpr(compiledTarget.code, 'i')};\n`;
        body += `      await page.getByRole('checkbox', { name: checkTargetRe }).first().check();\n`;
      } else {
        const safeRegex = emitSafeRegExp(intent.target, 'i');
        body += `      await page.getByRole('checkbox', { name: ${safeRegex} }).first().check();\n`;
      }
    } else if (intent.kind === 'click') {
      const compiledTarget = compileEnvTemplate(intent.target, envOpts);
      if (compiledTarget.usesEnv) {
        usesEnvHelper = true;
        body += `      const clickTargetLabel = ${compiledTarget.code};\n`;
        body += `      const clickTargetRe = ${emitDynamicRegExpExpr('clickTargetLabel', 'i')};\n`;
        body += `      const clickTarget = page.getByRole('button', { name: clickTargetRe })\n`;
        body += `        .or(page.getByRole('link', { name: clickTargetRe }))\n`;
        body += `        .or(page.getByText(clickTargetLabel));\n`;
        body += `      await clickTarget.first().click();\n`;
      } else {
        const safeRegex = emitSafeRegExp(intent.target, 'i');
        const safeTargetStr = JSON.stringify(intent.target);
        body += `      const clickTarget = page.getByRole('button', { name: ${safeRegex} })\n`;
        body += `        .or(page.getByRole('link', { name: ${safeRegex} }))\n`;
        body += `        .or(page.getByText(${safeTargetStr}));\n`;
        body += `      await clickTarget.first().click();\n`;
      }
    } else if (intent.kind === 'assert-visible') {
      const compiledTarget = compileEnvTemplate(intent.target, envOpts);
      if (compiledTarget.usesEnv) {
        usesEnvHelper = true;
        body += `      const visTargetLabel = ${compiledTarget.code};\n`;
        body += `      const visTargetRe = ${emitDynamicRegExpExpr('visTargetLabel', 'i')};\n`;
        body += emitCssEscape('visTargetLabel', 'visCssEsc');
        body += `      const visibleTarget = page.getByRole('button', { name: visTargetRe })\n`;
        body += `        .or(page.getByRole('link', { name: visTargetRe }))\n`;
        body += `        .or(page.getByText(visTargetLabel))\n`;
        body += `        .or(page.locator(\`[aria-label*="\${visCssEsc}" i]\`))\n`;
        body += `        .locator('visible=true');\n`;
      } else {
        const safeRegex = emitSafeRegExp(intent.target, 'i');
        const safeCssAttr = escapeCssString(intent.target);
        body += `      const visibleTarget = page.getByRole('button', { name: ${safeRegex} })\n`;
        body += `        .or(page.getByRole('link', { name: ${safeRegex} }))\n`;
        body += `        .or(page.getByText(${JSON.stringify(intent.target)}))\n`;
        body += `        .or(page.locator(${JSON.stringify(`[aria-label*="${safeCssAttr}" i]`)}))\n`;
        body += `        .locator('visible=true');\n`;
      }
      if (intent.negative) {
        body += `      await expect(visibleTarget).toHaveCount(0, { timeout: 5000 });\n`;
      } else {
        body += `      await expect(visibleTarget.first()).toBeVisible({ timeout: 5000 });\n`;
      }
    } else if (intent.kind === 'assert-text') {
      const targetExpr = emitValueExpr(intent.target);
      body += `      const textTarget = page.getByText(${targetExpr}).locator('visible=true');\n`;
      if (intent.negative) {
        body += `      await expect(textTarget).toHaveCount(0, { timeout: 5000 });\n`;
      } else {
        body += `      await expect(textTarget.first()).toBeVisible({ timeout: 5000 });\n`;
      }
    } else if (intent.kind === 'assert-url') {
      const assertionMethod = intent.negative ? 'not.toHaveURL' : 'toHaveURL';
      if (intent.target.includes('${')) {
        const urlExpr = emitValueExpr(intent.target);
        body += `      await expect(page).${assertionMethod}(${emitDynamicRegExpExpr(urlExpr, '')});\n`;
      } else {
        body += `      await expect(page).${assertionMethod}(${emitSafeRegExp(intent.target, '')});\n`;
      }
    }

    body += `    });\n\n`;
  }

  body += `  });\n`;
  body += `});\n`;

  let header = `import { test, expect } from '@playwright/test';\n\n`;
  if (usesEnvHelper) {
    header += `function requireEnv(name: string, value: string | undefined): string {\n`;
    header += `  if (value === undefined || value === '') {\n`;
    header += `    throw new Error(\`Missing required environment variable: \${name}\`);\n`;
    header += `  }\n`;
    header += `  return value;\n`;
    header += `}\n\n`;
  }
  if (usesUrlHelper) {
    header += emitAssertSafeHttpUrlHelper();
  }

  return header + body;
}
