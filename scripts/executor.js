import { writeOutput } from './write-output.js';
import { readGitHead } from './context-freshness.js';
export { checkFailureContextFreshness } from './context-freshness.js';
import { createDomHelpers, evaluateDom } from './browser-dom.js';
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { resolveEnvTemplate, redactSecrets } from './env-utils.js';
import {
  assertSafeResolvedUrl,
  isLoopbackHost,
  stripUrlCredentials,
  attachSsrfRouteGuard
} from './url-utils.js';
import { parseStepIntent, escapeCssString } from './intent-parser.js';

const MODAL_SELECTOR = '[aria-modal="true"], [role="dialog"], [role="alertdialog"], dialog[open], .modal';
const MAX_A11Y_SNAPSHOT_CHARS = 16384;
const MAX_CONSOLE_ERRORS = 100;
const MAX_CONSOLE_ERROR_CHARS = 1000;
const activeBrowsers = new Set();
let shutdownEpoch = 0;

/**
 * Closes all tracked Chromium browser instances (used on MCP server shutdown).
 */
export async function closeAllBrowsers() {
  shutdownEpoch++;
  const closing = Array.from(activeBrowsers).map((b) => b.close().catch(() => {}));
  activeBrowsers.clear();
  await Promise.all(closing);
}

/**
 * Escapes regex special characters to prevent regex injection crashes.
 */
export function escapeRegex(string) {
  if (typeof string !== 'string') return '';
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function truncateRedactedElements(elements) {
  const capStr = (v, n) => (typeof v === 'string' && v.length > n ? v.slice(0, n) : v);
  return {
    buttons: (elements?.buttons || []).map((b) => ({
      ...b,
      text: capStr(b.text, 150),
      type: capStr(b.type, 50),
      id: capStr(b.id, 150),
      ariaLabel: capStr(b.ariaLabel, 150)
    })),
    inputs: (elements?.inputs || []).map((inp) => ({
      ...inp,
      type: capStr(inp.type, 50),
      name: capStr(inp.name, 150),
      id: capStr(inp.id, 150),
      placeholder: capStr(inp.placeholder, 150),
      label: capStr(inp.label, 150),
      ariaLabel: capStr(inp.ariaLabel, 150)
    })),
    links: (elements?.links || []).map((l) => ({
      ...l,
      text: capStr(l.text, 150),
      href: capStr(l.href, 500)
    }))
  };
}

/**
 * Browser-context helper (self-contained for page.evaluate serialization) that locates the
 * top-most genuinely visible modal across light DOM and open shadow DOM following CSS stacking
 * contexts, ignores inner .modal wrappers inside semantic dialogs, marks the winner with
 * data-auto-qa-active-modal="true", and returns { found, isBlocking }.
 */
const SELECT_ACTIVE_MODAL_FN = ({ queryDeep, getParentOrHost, isVisible }, selector) => {
  for (const marked of queryDeep(document, '[data-auto-qa-active-modal]')) {
    marked.removeAttribute('data-auto-qa-active-modal');
  }
  const nodes = queryDeep(document, selector);

  const getStackingChain = (el) => {
    const chain = [];
    let cur = el;
    while (cur && cur.nodeType === 1) {
      const st = window.getComputedStyle(cur);
      const parent = getParentOrHost(cur);
      const parentDisplay = parent ? window.getComputedStyle(parent).display : '';
      const isFlexOrGridItem =
        parentDisplay.includes('flex') || parentDisplay.includes('grid');

      let pushed = false;
      if (st.zIndex !== 'auto' && (st.position !== 'static' || isFlexOrGridItem)) {
        const parsed = parseInt(st.zIndex, 10);
        if (!Number.isNaN(parsed)) {
          chain.unshift({ node: cur, z: parsed });
          pushed = true;
        }
      }

      if (!pushed) {
        const createsStacking =
          st.position === 'fixed' ||
          st.position === 'sticky' ||
          parseFloat(st.opacity) < 1 ||
          [st.scale, st.rotate, st.translate].some(value => value && value !== 'none') ||
          (st.transform && st.transform !== 'none') ||
          (st.filter && st.filter !== 'none') ||
          (st.backdropFilter && st.backdropFilter !== 'none') ||
          (st.perspective && st.perspective !== 'none') ||
          (st.clipPath && st.clipPath !== 'none') ||
          st.isolation === 'isolate' ||
          (st.mixBlendMode && st.mixBlendMode !== 'normal') ||
          (st.contain && /\b(?:layout|paint|strict|content)\b/.test(st.contain)) ||
          (st.willChange && /\b(?:transform|opacity|filter|backdrop-filter|perspective|clip-path|z-index|isolation)\b/.test(st.willChange));
        if (createsStacking) {
          chain.unshift({ node: cur, z: 0 });
        }
      }

      cur = parent;
    }
    return chain;
  };

  const compareChainsDesc = (a, b) => {
    if (a.topLayer !== b.topLayer) return b.topLayer - a.topLayer;

    const minLen = Math.min(a.chain.length, b.chain.length);
    for (let i = 0; i < minLen; i++) {
      if (a.chain[i].node === b.chain[i].node) continue;
      if (a.chain[i].z !== b.chain[i].z) {
        return b.chain[i].z - a.chain[i].z;
      }
      return b.index - a.index;
    }

    if (a.chain.length !== b.chain.length) {
      if (a.chain.length < b.chain.length) {
        const nextZ = b.chain[a.chain.length].z;
        return nextZ < 0 ? -1 : 1;
      }
      const nextZ = a.chain[b.chain.length].z;
      return nextZ < 0 ? 1 : -1;
    }

    return b.index - a.index;
  };

  const isSemanticDialog = (el) => {
    const role = el.getAttribute('role');
    return (
      el.getAttribute('aria-modal') === 'true' ||
      role === 'dialog' ||
      role === 'alertdialog' ||
      el.tagName === 'DIALOG'
    );
  };

  let visibleCandidates = [];
  nodes.forEach((el, index) => {
    if (isVisible(el)) {
      let topLayer = 0;
      try {
        if (el.matches(':modal')) topLayer = el.matches(':focus-within') ? 2 : 1;
      } catch (_) {}
      visibleCandidates.push({
        el,
        index,
        topLayer,
        chain: getStackingChain(el)
      });
    }
  });

  if (visibleCandidates.length === 0) {
    return { found: false, isBlocking: false };
  }

  // Prevent inner `.modal` wrapper inside a semantic dialog from shadowing the enclosing dialog
  const semanticSet = new Set(visibleCandidates.filter((c) => isSemanticDialog(c.el)).map((c) => c.el));
  visibleCandidates = visibleCandidates.filter((c) => {
    if (isSemanticDialog(c.el)) return true;
    let p = getParentOrHost(c.el);
    while (p && p.nodeType === 1) {
      if (semanticSet.has(p)) return false;
      p = getParentOrHost(p);
    }
    return true;
  });

  visibleCandidates.sort(compareChainsDesc);
  const blocking = visibleCandidates.find(({ el, topLayer }) =>
    topLayer || el.tagName === 'DIALOG' || el.getAttribute('aria-modal') === 'true'
  );
  let winner = visibleCandidates[0].el;
  if (blocking) {
    let ancestor = winner;
    while (ancestor && ancestor !== blocking.el) ancestor = getParentOrHost(ancestor);
    if (!ancestor) winner = blocking.el;
  }
  winner.setAttribute('data-auto-qa-active-modal', 'true');
  return { found: true, isBlocking: Boolean(blocking) };
};

/**
 * Locates the top-most genuinely visible modal/dialog across light & shadow DOM,
 * ignoring stale inert/invisible portals left behind by Radix/Headless UI.
 */
async function findActiveModal(page) {
  if (page.isClosed()) return null;
  const info = await evaluateDom(page, SELECT_ACTIVE_MODAL_FN, MODAL_SELECTOR);
  if (!info.found) return null;

  const candidate = page.locator('[data-auto-qa-active-modal="true"]').first();
  return { locator: candidate, isBlocking: info.isBlocking };
}

/**
 * Captures a scoped failure-time context snapshot (URL, title, visible interactive elements
 * scoped to the active visible modal if open or the full page, plus capped accessibility snapshot)
 * while the failing DOM and session state are still live.
 */
async function captureFailureContext(page, { stepIndex, failedStepDescription, error, redact, projectPath }) {
  const capturedAt = new Date().toISOString();
  const headAtCapture = readGitHead(projectPath);
  if (page.isClosed()) {
    return {
      untrustedPageData: true,
      url: '',
      title: '',
      stepIndex,
      failedStepDescription: redact(failedStepDescription),
      error,
      scopedToModal: false,
      capturedAt,
      gitHead: await headAtCapture,
      elements: { buttons: [], inputs: [], links: [] },
      accessibilitySnapshot: null,
      accessibilitySnapshotTruncated: false
    };
  }

  const activeModal = await findActiveModal(page);
  const hasActiveModal = Boolean(activeModal);

  const url = redact(stripUrlCredentials(page.url()));
  const rawTitle = await page.title().catch(() => '');
  const title = redact(rawTitle).slice(0, 200);

  let evalOutcome = {
    scopedToModal: hasActiveModal,
    elements: { buttons: [], inputs: [], links: [] }
  };

  try {
    evalOutcome = await evaluateDom(page, ({ queryDeep, isVisible }, modalActive) => {
      const activeModalEl = modalActive
        ? queryDeep(document, '[data-auto-qa-active-modal="true"]')[0] || null
        : null;

      if (modalActive && !activeModalEl) throw new Error('Modal detached during capture');
      const root = activeModalEl || document;
      const getCleanText = (el) => (el.innerText || el.textContent || '').trim();

      const resolveLabelledBy = (el) => {
        const ids = (el.getAttribute('aria-labelledby') || '').trim().split(/\s+/).filter(Boolean);
        const ownerRoot = (el.getRootNode && el.getRootNode()) || document;
        return ids
          .map((id) => {
            const ref =
              (typeof ownerRoot.getElementById === 'function' ? ownerRoot.getElementById(id) : null) ||
              document.getElementById(id);
            return ref ? getCleanText(ref) : '';
          })
          .filter(Boolean)
          .join(' ');
      };

      // 1. Buttons and Triggers (deduplicated, capped at 50)
      const seenButtons = new Set();
      const buttons = [];
      for (const b of queryDeep(root, 'button, a[role="button"], input[type="submit"], input[type="button"], [role="button"]')) {
        if (!isVisible(b) || b.disabled) continue;
        const text = (
          getCleanText(b) ||
          b.getAttribute('aria-label') ||
          b.getAttribute('title') ||
          resolveLabelledBy(b) ||
          b.value ||
          ''
        ).trim();
        if (!text) continue;
        const item = {
          text,
          tag: b.tagName.toLowerCase(),
          type: b.getAttribute('type') || 'button',
          id: b.id || undefined,
          ariaLabel: b.getAttribute('aria-label') || undefined
        };
        const dedupeKey = `${item.tag}|${item.text}|${item.id || ''}|${item.ariaLabel || ''}`;
        if (seenButtons.has(dedupeKey)) continue;
        seenButtons.add(dedupeKey);
        buttons.push(item);
        if (buttons.length >= 50) break;
      }

      // 2. Form Inputs, Textareas & Selects (deduplicated including ariaLabel, capped at 50, NEVER reads input.value)
      const seenInputs = new Set();
      const inputs = [];
      for (const inp of queryDeep(root, 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), textarea, select')) {
        if (!isVisible(inp) || inp.disabled) continue;
        let labelText = '';
        if (inp.id) {
          try {
            const escId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(inp.id) : inp.id.replace(/"/g, '\\"');
            const ownerRoot = (inp.getRootNode && inp.getRootNode()) || document;
            const labelEl =
              (typeof ownerRoot.querySelector === 'function' ? ownerRoot.querySelector(`label[for="${escId}"]`) : null) ||
              document.querySelector(`label[for="${escId}"]`);
            if (labelEl) labelText = getCleanText(labelEl);
          } catch (_) {}
        }
        if (!labelText && inp.closest('label')) {
          labelText = getCleanText(inp.closest('label'));
        }
        if (!labelText && inp.getAttribute('aria-labelledby')) {
          labelText = resolveLabelledBy(inp);
        }

        const item = {
          tag: inp.tagName.toLowerCase(),
          type: inp.type || 'text',
          name: inp.name || undefined,
          id: inp.id || undefined,
          placeholder: inp.placeholder || undefined,
          label: labelText || undefined,
          required: !!inp.required,
          ariaLabel: inp.getAttribute('aria-label') || undefined
        };
        const dedupeKey = `${item.tag}|${item.type}|${item.name || ''}|${item.id || ''}|${item.placeholder || ''}|${item.label || ''}|${item.ariaLabel || ''}`;
        if (seenInputs.has(dedupeKey)) continue;
        seenInputs.add(dedupeKey);
        inputs.push(item);
        if (inputs.length >= 50) break;
      }

      // 3. Links (deduplicated, capped at 30)
      const seenLinks = new Set();
      const links = [];
      for (const a of queryDeep(root, 'nav a, header a, a[href]')) {
        if (!isVisible(a)) continue;
        const href = (a.getAttribute('href') || '').trim();
        if (!href || /^(?:javascript|data|vbscript):/i.test(href.replace(/[\x00-\x20]+/g, ''))) continue;
        const text = (
          getCleanText(a) ||
          a.getAttribute('aria-label') ||
          a.getAttribute('title') ||
          ''
        ).trim();
        if (!text) continue;
        const dedupeKey = `${text}|${href}`;
        if (seenLinks.has(dedupeKey)) continue;
        seenLinks.add(dedupeKey);
        links.push({ text, href });
        if (links.length >= 30) break;
      }

      return {
        scopedToModal: Boolean(activeModalEl),
        elements: { buttons, inputs, links }
      };
    }, hasActiveModal);
  } catch (_) {}

  let accessibilitySnapshot = null;
  let accessibilitySnapshotTruncated = false;

  try {
    const ariaRoot = evalOutcome.scopedToModal
      ? page.locator('[data-auto-qa-active-modal="true"]').first()
      : page.locator('body');

    if (typeof ariaRoot.ariaSnapshot === 'function') {
      accessibilitySnapshot = await ariaRoot.ariaSnapshot({ timeout: 3000 });
    } else if (!hasActiveModal && page.accessibility && typeof page.accessibility.snapshot === 'function') {
      accessibilitySnapshot = await page.accessibility.snapshot();
    }
  } catch (_) {}

  // Redact BEFORE enforcing character caps so partial secrets cannot leak across slice boundaries
  let redactedA11y = redact(accessibilitySnapshot);
  if (typeof redactedA11y === 'string' && redactedA11y.length > MAX_A11Y_SNAPSHOT_CHARS) {
    redactedA11y = redactedA11y.slice(0, MAX_A11Y_SNAPSHOT_CHARS) + '\n... [truncated]';
    accessibilitySnapshotTruncated = true;
  } else if (redactedA11y && typeof redactedA11y === 'object') {
    const serialized = JSON.stringify(redactedA11y);
    if (serialized.length > MAX_A11Y_SNAPSHOT_CHARS) {
      redactedA11y = serialized.slice(0, MAX_A11Y_SNAPSHOT_CHARS) + '... [truncated]';
      accessibilitySnapshotTruncated = true;
    }
  }

  const redactedElements = truncateRedactedElements(redact(evalOutcome.elements));

  return {
    untrustedPageData: true,
    url,
    title,
    stepIndex,
    failedStepDescription: redact(failedStepDescription),
    error,
    scopedToModal: evalOutcome.scopedToModal,
    capturedAt,
    gitHead: await headAtCapture,
    elements: redactedElements,
    accessibilitySnapshot: redactedA11y,
    accessibilitySnapshotTruncated
  };
}

const badgeSuffix = /\s*(?:\(\d+\+?\)|\[\d+\+?\]|•\s*\d+\+?)|\s+\d+\+?/u;
const trailingBadge = new RegExp('(?:' + badgeSuffix.source + ')$', 'u');

export function normalizeDynamicLabel(text) {
  return String(text ?? '').trim().replace(/\s+/gu, ' ').replace(trailingBadge, '').trimEnd();
}

function badgeLocators(scope, name, intent) {
  const roles = {
    fill: ['textbox', 'searchbox', 'spinbutton'],
    select: ['combobox', 'listbox'],
    check: ['checkbox', 'switch'],
    click: ['button', 'link'],
    general: ['button', 'link']
  };
  const strategies = roles[intent].map(role => () => scope.getByRole(role, { name }));
  strategies.push(() => scope.getByLabel(name));
  if (intent === 'click' || intent === 'general') strategies.push(() => scope.getByText(name));
  return strategies;
}

/**
 * Intelligent intent-driven selector resolver with action-specific heuristics,
 * hardened modal dialog isolation, exact-before-fuzzy matching, and visibility filtering.
 */
async function resolveElement(page, targetDesc, intent = 'general', displayTarget = targetDesc) {
  const cleanTarget = String(targetDesc ?? '').replace(/^["']|["']$/g, '').trim();
  if (!cleanTarget) {
    throw new Error(`Element matching intent "${intent}" for target "${displayTarget}" could not be resolved.`);
  }

  const safeTarget = escapeRegex(cleanTarget);
  const safeCss = escapeCssString(cleanTarget);

  // 1. Detect active modal FIRST so even direct CSS selectors respect modal isolation
  const activeModal = await findActiveModal(page);
  const scope = activeModal ? activeModal.locator : page;
  const allowPageFallback = Boolean(activeModal && !activeModal.isBlocking);

  // 2. Direct CSS/ID/attribute locator support scoped safely
  const isDirectSelector = cleanTarget.startsWith('#') || cleanTarget.startsWith('.') || cleanTarget.startsWith('[');
  // 3. Action-specialized lookup strategies (exact matches precede partial/substring matches)
  let strategies = [];

  if (intent === 'fill') {
    strategies = [
      () => scope.getByLabel(new RegExp(`^${safeTarget}$`, 'i')),
      () => scope.getByLabel(new RegExp(safeTarget, 'i')),
      () => scope.getByPlaceholder(new RegExp(`^${safeTarget}$`, 'i')),
      () => scope.getByPlaceholder(new RegExp(safeTarget, 'i')),
      () => scope.getByRole('textbox', { name: new RegExp(`^${safeTarget}$`, 'i') }),
      () => scope.getByRole('textbox', { name: new RegExp(safeTarget, 'i') }),
      () => scope.locator(`input[name*="${safeCss}" i], textarea[name*="${safeCss}" i]`),
      () => scope.locator(`input[id*="${safeCss}" i], textarea[id*="${safeCss}" i]`),
      () => scope.locator(`input[type="${safeCss.toLowerCase()}"]`)
    ];
    if (allowPageFallback) {
      strategies.push(
        () => page.getByLabel(new RegExp(safeTarget, 'i')),
        () => page.getByPlaceholder(new RegExp(safeTarget, 'i')),
        () => page.locator(`input[name*="${safeCss}" i], textarea[name*="${safeCss}" i]`),
        () => page.locator(`input[id*="${safeCss}" i], textarea[id*="${safeCss}" i]`)
      );
    }
  } else if (intent === 'click') {
    strategies = [
      () => scope.getByRole('button', { name: new RegExp(`^${safeTarget}$`, 'i') }),
      () => scope.getByRole('button', { name: new RegExp(safeTarget, 'i') }),
      () => scope.locator(`button:has-text("${safeCss}")`),
      () => scope.getByRole('link', { name: new RegExp(`^${safeTarget}$`, 'i') }),
      () => scope.getByRole('link', { name: new RegExp(safeTarget, 'i') }),
      () => scope.locator(`[aria-label*="${safeCss}" i]`),
      () => scope.getByText(new RegExp(`^${safeTarget}$`, 'i'), { exact: true }),
      () => scope.getByText(new RegExp(safeTarget, 'i'), { exact: false })
    ];
    if (allowPageFallback) {
      strategies.push(
        () => page.getByRole('button', { name: new RegExp(`^${safeTarget}$`, 'i') }),
        () => page.getByRole('button', { name: new RegExp(safeTarget, 'i') }),
        () => page.locator(`button:has-text("${safeCss}")`),
        () => page.getByRole('link', { name: new RegExp(safeTarget, 'i') }),
        () => page.getByText(new RegExp(safeTarget, 'i'), { exact: false })
      );
    }
  } else if (intent === 'check') {
    strategies = [
      () => scope.getByRole('checkbox', { name: new RegExp(`^${safeTarget}$`, 'i') }),
      () => scope.getByRole('checkbox', { name: new RegExp(safeTarget, 'i') }),
      () => scope.locator(`input[type="checkbox"][aria-label*="${safeCss}" i]`)
    ];
    if (allowPageFallback) {
      strategies.push(() => page.getByRole('checkbox', { name: new RegExp(safeTarget, 'i') }));
    }
  } else if (intent === 'select') {
    strategies = [
      () => scope.getByRole('combobox', { name: new RegExp(`^${safeTarget}$`, 'i') }),
      () => scope.getByRole('combobox', { name: new RegExp(safeTarget, 'i') }),
      () => scope.locator(`select[name*="${safeCss}" i]`),
      () => scope.locator(`select[id*="${safeCss}" i]`)
    ];
    if (allowPageFallback) {
      strategies.push(
        () => page.getByRole('combobox', { name: new RegExp(safeTarget, 'i') }),
        () => page.locator(`select[name*="${safeCss}" i], select[id*="${safeCss}" i]`)
      );
    }
  } else {
    strategies = [
      () => scope.getByRole('button', { name: new RegExp(`^${safeTarget}$`, 'i') }),
      () => scope.getByRole('button', { name: new RegExp(safeTarget, 'i') }),
      () => scope.getByRole('link', { name: new RegExp(safeTarget, 'i') }),
      () => scope.getByText(new RegExp(`^${safeTarget}$`, 'i')),
      () => scope.getByText(new RegExp(safeTarget, 'i')),
      () => scope.locator(`[aria-label*="${safeCss}" i]`)
    ];
    if (allowPageFallback) {
      strategies.push(() => page.getByText(new RegExp(safeTarget, 'i')));
    }
  }

  if (isDirectSelector) {
    const direct = [() => scope.locator(cleanTarget)];
    if (allowPageFallback) direct.push(() => page.locator(cleanTarget));
    strategies.unshift(...direct);
  }

  const normalized = normalizeDynamicLabel(cleanTarget);
  if (!isDirectSelector && Array.from(normalized).length >= 2 && /\p{L}/u.test(normalized)) {
    const base = escapeRegex(normalized).replace(/ +/g, '\\s+');
    const name = new RegExp('^\\s*' + base + '(?:' + badgeSuffix.source + ')?\\s*$', 'iu');
    strategies.push(...badgeLocators(scope, name, intent));
    if (allowPageFallback) strategies.push(...badgeLocators(page, name, intent));
  }

  const helpers = await page.evaluateHandle(createDomHelpers);
  try {
    for (const getLocator of strategies) {
      try {
        const loc = getLocator().locator('visible=true');
        const index = await loc.evaluateAll((elements, dom) => elements.findIndex(dom.isVisible), helpers);
        if (index !== -1) return loc.nth(index);
      } catch (_) {}
    }
  } finally {
    await helpers.dispose();
  }

  throw new Error(`Element matching intent "${intent}" for target "${displayTarget}" could not be resolved.`);
}

/**
 * Autonomous Playwright Intent Plan Executor
 */
export async function executeTestPlan(plan, options = {}) {
  const {
    baseUrl,
    headless = true,
    artifactDir = './artifacts',
    logger = console.log,
    warnLogger = console.warn,
    errorLogger = console.error,
    maxSteps = 200,
    runTimeoutMs = 300000,
    projectPath = process.cwd(),
    allowedEnvPrefixes
  } = options;

  const resolvedSecrets = new Map();
  const redact = (val) => redactSecrets(val, resolvedSecrets);
  const envOpts = { allowedEnvPrefixes };

  const planSteps = Array.isArray(plan?.planSteps) ? plan.planSteps : [];
  if (planSteps.length > maxSteps) {
    throw new Error(`Plan aborted: step count (${planSteps.length}) exceeds maximum limit of ${maxSteps}.`);
  }

  const rawTargetUrl = baseUrl || plan?.targetUrl || 'http://localhost:3000';
  // Register permitted step secrets before the first log or console truncation. Actual
  // resolution still reports missing or disallowed variables at their original step.
  const templates = [rawTargetUrl, ...planSteps.map(step => step?.description)];
  const references = new Set(templates.flatMap(value => typeof value === 'string'
    ? value.match(/\$\{[A-Z_][A-Z0-9_]*\}/g) || [] : []));
  for (const reference of references) {
    try { resolveEnvTemplate(reference, process.env, resolvedSecrets, envOpts); } catch {}
  }
  let targetUrl;
  try {
    const resolvedTargetUrl = resolveEnvTemplate(rawTargetUrl, process.env, resolvedSecrets, envOpts);
    targetUrl = await assertSafeResolvedUrl(resolvedTargetUrl, { allowLoopback: true });
  } catch (urlErr) {
    throw new Error(redact(urlErr?.message || String(urlErr)));
  }

  const displayTargetUrl = rawTargetUrl.includes('${')
    ? redact(rawTargetUrl)
    : redact(stripUrlCredentials(targetUrl));

  if (!fs.existsSync(artifactDir)) {
    fs.mkdirSync(artifactDir, { recursive: true });
  }

  let browser = null;
  const launchEpoch = shutdownEpoch;

  try {
    browser = await chromium.launch({
      headless,
      args: ['--disable-background-networking', '--disable-sync', '--no-default-browser-check']
    });
    if (shutdownEpoch !== launchEpoch) {
      await browser.close().catch(() => {});
      browser = null;
      throw new Error('Execution aborted: browser shutdown in progress.');
    }
    activeBrowsers.add(browser);

    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 AutoQA/1.0',
      serviceWorkers: 'block'
    });

    const ssrfGuard = await attachSsrfRouteGuard(context, targetUrl);
    const page = await context.newPage();
    await ssrfGuard.attachPage(page);

    // Auto-dismiss dialog popups to prevent execution hangs
    page.on('dialog', dialog => {
      dialog.dismiss().catch(() => {});
    });

    const report = {
      testName: redact(plan?.name || 'Auto-QA Test Plan'),
      projectId: plan?.projectId || 'auto-qa-run',
      targetUrl: displayTargetUrl,
      priority: redact(plan?.priority || 'p0'),
      startedAt: new Date().toISOString(),
      status: 'passed',
      steps: [],
      artifacts: [],
      consoleErrors: [],
      consoleErrorsTruncated: 0
    };

    page.on('console', msg => {
      if (msg.type() === 'error') {
        const cleanMsg = redact(msg.text()).slice(0, MAX_CONSOLE_ERROR_CHARS);
        if (report.consoleErrors.length < MAX_CONSOLE_ERRORS) {
          report.consoleErrors.push(cleanMsg);
        } else {
          report.consoleErrorsTruncated++;
        }
      }
    });

    const runStartedMs = Date.now();

    logger(`\n======================================================`);
    logger(`🤖 Auto-QA Runner: "${report.testName}"`);
    logger(`🎯 Target: ${displayTargetUrl}`);
    logger(`📋 Total Steps: ${planSteps.length}`);
    logger(`======================================================\n`);

    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(600);
    } catch (gotoErr) {
      throw new Error(redact(gotoErr?.message || String(gotoErr)));
    }

    const takeSafeScreenshot = async (screenshotPath) => {
      try {
        const image = await page.screenshot({ timeout: 5000 });
        writeOutput(screenshotPath, image);
        return true;
      } catch (err) {
        warnLogger('Screenshot capture failed:', redact(err?.message || String(err)));
        return false;
      }
    };

    const initialIsLoopback = (() => {
      try {
        return isLoopbackHost(new URL(targetUrl).hostname);
      } catch (_) {
        return false;
      }
    })();

    for (let i = 0; i < planSteps.length; i++) {
      if (Date.now() - runStartedMs > runTimeoutMs) {
        throw new Error(`Execution aborted: run timeout (${runTimeoutMs}ms) exceeded.`);
      }

      const step = planSteps[i];
      const stepIndex = i + 1;
      const stepStart = Date.now();
      let stepResult = {
        index: stepIndex,
        description: redact(step?.description || `Step ${stepIndex}`),
        type: redact(step?.type || 'unknown'),
        status: 'passed'
      };

      logger(`[Step ${stepIndex}/${planSteps.length}] [${String(stepResult.type).toUpperCase()}] ${stepResult.description}`);

      try {
        const intent = parseStepIntent(step);

        if (intent.kind === 'navigate') {
          const resolvedNav = resolveEnvTemplate(intent.rawUrl, process.env, resolvedSecrets, envOpts);
          if (/[\x00-\x1f\x7f]/.test(resolvedNav)) {
            throw new Error('Navigation blocked: URL contains disallowed control characters.');
          }
          const trimmedNav = resolvedNav.trim();
          if (!trimmedNav || /^[/\\]{2}/.test(trimmedNav) || trimmedNav.startsWith('\\')) {
            throw new Error('Navigation blocked: invalid relative or protocol-relative URL.');
          }
          const navUrl = /^https?:\/\//i.test(trimmedNav)
            ? trimmedNav
            : new URL(trimmedNav, page.url()).toString();
          const safeNav = await assertSafeResolvedUrl(navUrl, { allowLoopback: initialIsLoopback });
          await page.goto(safeNav, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForTimeout(400);
        } else if (intent.kind === 'fill') {
          const resolvedValue = resolveEnvTemplate(intent.rawValue, process.env, resolvedSecrets, envOpts);
          const target = resolveEnvTemplate(intent.target, process.env, resolvedSecrets, envOpts);
          const element = await resolveElement(page, target, 'fill', intent.target);
          await element.fill(resolvedValue);
          await page.waitForTimeout(400);
        } else if (intent.kind === 'select') {
          const optionVal = resolveEnvTemplate(intent.rawValue, process.env, resolvedSecrets, envOpts);
          const target = resolveEnvTemplate(intent.target, process.env, resolvedSecrets, envOpts);
          const element = await resolveElement(page, target, 'select', intent.target);
          await element.selectOption({ label: optionVal }).catch(async () => {
            await element.selectOption({ value: optionVal });
          });
          await page.waitForTimeout(400);
        } else if (intent.kind === 'check') {
          const resolvedTarget = resolveEnvTemplate(intent.target, process.env, resolvedSecrets, envOpts);
          const element = await resolveElement(page, resolvedTarget, 'check', intent.target);
          await element.check();
          await page.waitForTimeout(400);
        } else if (intent.kind === 'click') {
          const resolvedTarget = resolveEnvTemplate(intent.target, process.env, resolvedSecrets, envOpts);
          const element = await resolveElement(page, resolvedTarget, 'click', intent.target);
          await element.click();
          await page.waitForTimeout(400);
        } else if (intent.kind === 'assert-visible') {
          const target = resolveEnvTemplate(intent.target, process.env, resolvedSecrets, envOpts);
          if (intent.negative) {
            const loc = await resolveElement(page, target, 'general', intent.target).catch(() => null);
            if (loc) {
              await loc.waitFor({ state: 'hidden', timeout: 1500 }).catch(() => {});
              const stillVis = await loc.isVisible().catch(() => false);
              if (stillVis) {
                throw new Error(`Negative assertion failed: Target "${intent.target}" is still visible.`);
              }
            }
          } else {
            // Respect blocking modal isolation when waiting for dynamically appearing targets
            const loc = await resolveElement(page, target, 'general', intent.target).catch(() => null);
            if (loc) {
              await loc.waitFor({ state: 'visible', timeout: 5000 });
            } else {
              const deadline = Date.now() + 5000;
              let appeared = null;
              while (!appeared && Date.now() < deadline) {
                await page.waitForTimeout(100);
                appeared = await resolveElement(page, target, 'general', intent.target).catch(() => null);
              }
              if (!appeared) throw new Error(`Assertion failed: Target "${intent.target}" is not visible.`);
            }
          }
        } else if (intent.kind === 'assert-url') {
          const expectedPart = resolveEnvTemplate(intent.target, process.env, resolvedSecrets, envOpts);
          const deadline = Date.now() + 5000;
          let matched = page.url().includes(expectedPart);
          while (Date.now() < deadline && matched === intent.negative) {
            await page.waitForTimeout(100);
            matched = page.url().includes(expectedPart);
          }
          if (intent.negative && matched) {
            throw new Error(
              `Negative URL assertion failed: Current URL "${redact(stripUrlCredentials(page.url()))}" still contains "${intent.target}".`
            );
          }
          if (!intent.negative && !matched) {
            throw new Error(
              `Assertion failed: Current URL "${redact(stripUrlCredentials(page.url()))}" does not contain "${intent.target}".`
            );
          }
        } else if (intent.kind === 'assert-text') {
          const expectedText = resolveEnvTemplate(intent.target, process.env, resolvedSecrets, envOpts);
          const matchedText = page.getByText(expectedText).locator('visible=true').first();
          if (intent.negative) {
            await matchedText.waitFor({ state: 'hidden', timeout: 1500 }).catch(() => {});
            const stillVis = (await page.getByText(expectedText).locator('visible=true').count()) > 0;
            if (stillVis) {
              throw new Error(`Negative assertion failed: Unexpected text "${intent.target}" is visible.`);
            }
          } else {
            await matchedText.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {
              throw new Error(`Assertion failed: Expected text "${intent.target}" was not found.`);
            });
          }
        }

        stepResult.durationMs = Date.now() - stepStart;
        report.steps.push(stepResult);
        logger(`  ✓ Passed (${stepResult.durationMs}ms)`);
      } catch (stepErr) {
        const safeError = redact(stepErr?.message || String(stepErr));
        stepResult.status = 'failed';
        stepResult.error = safeError;
        stepResult.durationMs = Date.now() - stepStart;
        report.steps.push(stepResult);
        report.status = 'failed';

        // Read the failing DOM before screenshot capture can wait for fonts or layout.
        let savedContext;
        try {
          const contextPath = path.join(artifactDir, `failure-step-${stepIndex}-context.json`);
          const contextSnapshot = await captureFailureContext(page, {
            stepIndex,
            failedStepDescription: stepResult.description,
            error: safeError,
            redact,
            projectPath
          });
          writeOutput(contextPath, JSON.stringify(contextSnapshot, null, 2));
          savedContext = contextPath;
        } catch (ctxErr) {
          warnLogger('Failure context capture failed:', redact(ctxErr?.message || String(ctxErr)));
        }

        const screenshotPath = path.join(artifactDir, `failure-step-${stepIndex}.png`);
        if (await takeSafeScreenshot(screenshotPath)) report.artifacts.push(screenshotPath);
        if (savedContext) report.artifacts.push(savedContext);
        errorLogger(`  ❌ Failed: ${safeError}`);
        break;
      }
    }

    // Capture final run screenshot
    const finalScreenshotPath = path.join(artifactDir, `run-final-${Date.now()}.png`);
    if (await takeSafeScreenshot(finalScreenshotPath)) {
      report.artifacts.push(finalScreenshotPath);
    }

    report.finishedAt = new Date().toISOString();
    report.durationMs = new Date(report.finishedAt) - new Date(report.startedAt);

    // Final redaction pass before persisting report JSON
    report.testName = redact(report.testName);
    report.projectId = redact(report.projectId);
    report.targetUrl = redact(report.targetUrl);
    report.consoleErrors = redact(report.consoleErrors);
    report.steps = report.steps.map((s) => ({
      ...s,
      description: redact(s.description),
      ...(s.error ? { error: redact(s.error) } : {})
    }));

    // Save JSON test execution report
    const reportPath = path.join(artifactDir, `test-report-${Date.now()}.json`);
    writeOutput(reportPath, JSON.stringify(report, null, 2));
    report.artifacts.push(reportPath);

    return report;
  } finally {
    if (browser) {
      activeBrowsers.delete(browser);
      await browser.close().catch(() => {});
    }
  }
}
