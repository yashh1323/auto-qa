import { evaluateDom } from './browser-dom.js';
import { chromium } from 'playwright';
import { assertSafeResolvedUrl, attachSsrfRouteGuard } from './url-utils.js';

const MAX_A11Y_SNAPSHOT_CHARS = 16384;
const activeDiscoverBrowsers = new Set();
let shutdownEpoch = 0;

/**
 * Closes any active Playwright browsers launched by discoverInteractiveElements.
 */
export async function closeAllDiscoverBrowsers() {
  shutdownEpoch++;
  const closing = Array.from(activeDiscoverBrowsers).map((b) => b.close().catch(() => {}));
  activeDiscoverBrowsers.clear();
  await Promise.all(closing);
}

/**
 * Black-box discovery tool for client websites without source code.
 * Crawls a target URL and extracts accessible interactive elements,
 * forms, buttons, inputs, links, modal dialogs, and accessibility snapshot.
 */
export async function discoverInteractiveElements(url, options = {}) {
  const { headless = true, timeout = 15000, logger = console.log } = options;
  const safeUrl = await assertSafeResolvedUrl(url, { allowLoopback: true });

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
      throw new Error('Discovery aborted: browser shutdown in progress.');
    }
    activeDiscoverBrowsers.add(browser);

    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 AutoQA/1.0',
      serviceWorkers: 'block'
    });

    const ssrfGuard = await attachSsrfRouteGuard(context, safeUrl);
    const page = await context.newPage();
    await ssrfGuard.attachPage(page);

    // Auto-dismiss unexpected browser dialogs (alert, confirm, beforeunload)
    page.on('dialog', dialog => {
      dialog.dismiss().catch(() => {});
    });

    logger(`\n🔍 Crawling target surface: ${safeUrl}`);
    await page.goto(safeUrl, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(1000); // Allow dynamic rendering

    const pageTitle = (await page.title().catch(() => '')).slice(0, 200);

    // 1. Native Accessibility Snapshot (prefers ariaSnapshot on Playwright >= 1.49 / 1.64+)
    let accessibilitySnapshot = null;
    try {
      const bodyLoc = page.locator('body');
      if (typeof bodyLoc.ariaSnapshot === 'function') {
        accessibilitySnapshot = await bodyLoc.ariaSnapshot({ timeout: 5000 });
      } else if (page.accessibility && typeof page.accessibility.snapshot === 'function') {
        accessibilitySnapshot = await page.accessibility.snapshot();
      }
    } catch (_) {}

    if (typeof accessibilitySnapshot === 'string' && accessibilitySnapshot.length > MAX_A11Y_SNAPSHOT_CHARS) {
      accessibilitySnapshot = accessibilitySnapshot.slice(0, MAX_A11Y_SNAPSHOT_CHARS) + '\n... [truncated]';
    } else if (accessibilitySnapshot && typeof accessibilitySnapshot === 'object') {
      const serialized = JSON.stringify(accessibilitySnapshot);
      if (serialized.length > MAX_A11Y_SNAPSHOT_CHARS) {
        accessibilitySnapshot = serialized.slice(0, MAX_A11Y_SNAPSHOT_CHARS) + '... [truncated]';
      }
    }

    // 2. Discover interactive elements across light & open shadow DOM
    const discovery = await evaluateDom(page, ({ isVisible, queryDeep }) => {
      const getCleanText = (el) => (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200);
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

      // 1. Buttons and Triggers
      const buttons = queryDeep(document, 'button, a[role="button"], input[type="submit"], input[type="button"], [role="button"]')
        .filter(b => isVisible(b) && !b.disabled)
        .map(b => {
          const text = (
            getCleanText(b) ||
            b.getAttribute('aria-label') ||
            b.getAttribute('title') ||
            resolveLabelledBy(b) ||
            b.value ||
            ''
          ).trim();
          return {
            text: text ? text.slice(0, 150) : '',
            tag: b.tagName.toLowerCase(),
            type: (b.getAttribute('type') || 'button').slice(0, 50),
            id: b.id ? b.id.slice(0, 150) : undefined,
            ariaLabel: b.getAttribute('aria-label') ? b.getAttribute('aria-label').slice(0, 150) : undefined
          };
        })
        .filter(b => b.text && b.text.length > 0)
        .slice(0, 50);

      // 2. Form Inputs & Textareas (excludes submit/button/reset)
      const inputs = queryDeep(document, 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), textarea, select')
        .filter(i => isVisible(i) && !i.disabled)
        .map(i => {
          let labelText = '';
          if (i.id) {
            try {
              const escId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(i.id) : i.id.replace(/"/g, '\\"');
              const ownerRoot = (i.getRootNode && i.getRootNode()) || document;
              const labelEl =
                (typeof ownerRoot.querySelector === 'function' ? ownerRoot.querySelector(`label[for="${escId}"]`) : null) ||
                document.querySelector(`label[for="${escId}"]`);
              if (labelEl) labelText = getCleanText(labelEl);
            } catch (_) {}
          }
          if (!labelText && i.closest('label')) {
            labelText = getCleanText(i.closest('label'));
          }
          if (!labelText && i.getAttribute('aria-labelledby')) {
            labelText = resolveLabelledBy(i);
          }

          return {
            tag: i.tagName.toLowerCase(),
            type: (i.type || 'text').slice(0, 50),
            name: i.name ? i.name.slice(0, 150) : undefined,
            id: i.id ? i.id.slice(0, 150) : undefined,
            placeholder: i.placeholder ? i.placeholder.slice(0, 150) : undefined,
            label: labelText ? labelText.slice(0, 150) : undefined,
            required: !!i.required,
            ariaLabel: i.getAttribute('aria-label') ? i.getAttribute('aria-label').slice(0, 150) : undefined
          };
        })
        .slice(0, 50);

      // 3. Navigation Links
      const links = queryDeep(document, 'nav a, header a, a[href]')
        .filter(a => {
          if (!isVisible(a)) return false;
          const href = (a.getAttribute('href') || '').trim();
          return Boolean(href) && !/^(?:javascript|data|vbscript):/i.test(href.replace(/[\x00-\x20]+/g, ''));
        })
        .map(a => ({
          text: (getCleanText(a) || a.getAttribute('aria-label') || a.getAttribute('title') || '').trim().slice(0, 150),
          href: (a.getAttribute('href') || '').trim().slice(0, 500)
        }))
        .filter(a => a.text.length > 0)
        .slice(0, 30);

      // 4. Modals / Dialogs (capped at 50)
      const modals = queryDeep(document, '[role="dialog"], [role="alertdialog"], dialog[open], .modal, [aria-modal="true"]')
        .slice(0, 50)
        .map(m => ({
          id: m.id ? m.id.slice(0, 150) : undefined,
          visible: isVisible(m)
        }));

      return { buttons, inputs, links, modals };
    });

    return {
      url: safeUrl,
      title: pageTitle,
      timestamp: new Date().toISOString(),
      elements: discovery,
      accessibilityTree: accessibilitySnapshot
    };
  } finally {
    if (browser) {
      activeDiscoverBrowsers.delete(browser);
      await browser.close().catch(() => {});
    }
  }
}

// Direct CLI invocation
if (process.argv[1]?.endsWith('discover.js')) {
  const targetUrl = process.argv[2] || 'http://localhost:3000';
  discoverInteractiveElements(targetUrl).then(res => {
    console.log(JSON.stringify(res, null, 2));
  }).catch(err => {
    console.error('Discovery error:', err.message);
    process.exit(1);
  });
}
