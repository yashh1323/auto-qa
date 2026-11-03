import { chromium } from 'playwright';

/**
 * Validates that a URL strictly uses http: or https: protocols.
 */
function assertValidHttpUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Navigation blocked: protocol "${parsed.protocol}" is not permitted. Only http: and https: are allowed.`);
    }
    return parsed.toString();
  } catch (err) {
    throw new Error(`Invalid URL "${rawUrl}": ${err.message}`);
  }
}

/**
 * Black-box discovery tool for client websites without source code.
 * Crawls a target URL and extracts all accessible interactive elements,
 * forms, buttons, inputs, links, and modal dialogs.
 */
export async function discoverInteractiveElements(url, options = {}) {
  const { headless = true, timeout = 15000 } = options;
  const safeUrl = assertValidHttpUrl(url);

  let browser = null;

  try {
    browser = await chromium.launch({
      headless,
      args: ['--disable-background-networking', '--disable-sync', '--no-default-browser-check']
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 AutoQA/1.0',
      serviceWorkers: 'block'
    });

    const page = await context.newPage();

    // Auto-dismiss unexpected browser dialogs (alert, confirm, beforeunload)
    page.on('dialog', dialog => {
      dialog.dismiss().catch(() => {});
    });

    console.log(`\n🔍 Crawling target surface: ${safeUrl}`);
    await page.goto(safeUrl, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(1000); // Allow dynamic rendering

    const pageTitle = await page.title();

    // 1. Native W3C Accessibility Snapshot (Clean & Token-Efficient)
    let accessibilitySnapshot = null;
    try {
      accessibilitySnapshot = await page.accessibility.snapshot();
    } catch (_) {}

    // 2. Discover interactive elements via DOM evaluation
    const discovery = await page.evaluate(() => {
      const getCleanText = (el) => (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200);

      // Robust visibility check: handles position: fixed, sticky headers, and modals
      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      };

      // 1. Buttons and Triggers
      const buttons = Array.from(document.querySelectorAll('button, a[role="button"], input[type="submit"], input[type="button"], [role="button"]'))
        .filter(b => isVisible(b) && !b.disabled)
        .map(b => {
          let text = getCleanText(b) || b.getAttribute('aria-label') || b.getAttribute('title') || b.value || '';
          if (!text && b.getAttribute('aria-labelledby')) {
            const labelEl = document.getElementById(b.getAttribute('aria-labelledby'));
            if (labelEl) text = getCleanText(labelEl);
          }
          return {
            text: text ? text.slice(0, 150) : '',
            tag: b.tagName.toLowerCase(),
            type: b.getAttribute('type') || 'button',
            id: b.id || undefined,
            ariaLabel: b.getAttribute('aria-label') || undefined
          };
        })
        .filter(b => b.text && b.text.length > 0)
        .slice(0, 50);

      // 2. Form Inputs & Textareas
      const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]), textarea, select'))
        .filter(i => isVisible(i) && !i.disabled)
        .map(i => {
          let labelText = '';
          if (i.id) {
            const labelEl = document.querySelector(`label[for="${i.id}"]`);
            if (labelEl) labelText = getCleanText(labelEl);
          }
          if (!labelText && i.closest('label')) {
            labelText = getCleanText(i.closest('label'));
          }
          if (!labelText && i.getAttribute('aria-labelledby')) {
            const labelEl = document.getElementById(i.getAttribute('aria-labelledby'));
            if (labelEl) labelText = getCleanText(labelEl);
          }

          return {
            tag: i.tagName.toLowerCase(),
            type: i.type || 'text',
            name: i.name || undefined,
            id: i.id || undefined,
            placeholder: i.placeholder || undefined,
            label: labelText ? labelText.slice(0, 150) : undefined,
            required: !!i.required,
            ariaLabel: i.getAttribute('aria-label') || undefined
          };
        })
        .slice(0, 50);

      // 3. Navigation Links
      const links = Array.from(document.querySelectorAll('nav a, header a, a[href]'))
        .filter(a => isVisible(a) && a.getAttribute('href'))
        .map(a => ({
          text: getCleanText(a).slice(0, 150),
          href: a.getAttribute('href')
        }))
        .filter(a => a.text.length > 1 && !a.href.startsWith('javascript:'))
        .slice(0, 30);

      // 4. Modals / Dialogs
      const modals = Array.from(document.querySelectorAll('[role="dialog"], .modal, [aria-modal="true"]'))
        .map(m => ({
          id: m.id || undefined,
          visible: isVisible(m) && !m.classList.contains('hidden')
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
