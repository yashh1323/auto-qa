import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';

/**
 * Escapes regex special characters to prevent regex injection crashes
 */
function escapeRegex(string) {
  if (typeof string !== 'string') return '';
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Escapes double quotes and backslashes for safe interpolation inside CSS attribute selectors
 */
function escapeCssString(string) {
  if (typeof string !== 'string') return '';
  return string.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ');
}

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
 * Intelligent intent-driven selector resolver with action-specific heuristics,
 * modal dialog isolation, and self-healing fallbacks.
 */
async function resolveElement(page, targetDesc, intent = 'general') {
  let cleanTarget = targetDesc.replace(/^["']|["']$/g, '').trim();
  const safeTarget = escapeRegex(cleanTarget);
  const safeCss = escapeCssString(cleanTarget);

  // 1. Direct CSS/ID/XPath locator support
  const isDirectSelector = cleanTarget.startsWith('#') || cleanTarget.startsWith('.') || cleanTarget.startsWith('[');
  if (isDirectSelector) {
    try {
      const loc = page.locator(cleanTarget);
      if (await loc.first().isVisible({ timeout: 1500 })) {
        return loc.first();
      }
    } catch (_) {}
  }

  // 2. Modal/Dialog overlay context detection (isolation from backdrop)
  const modalLocator = page.locator('div[role="dialog"]:not(.hidden), .modal:not(.hidden), [aria-modal="true"]:not(.hidden)');
  const hasActiveModal = (await modalLocator.count()) > 0 && (await modalLocator.first().isVisible().catch(() => false));
  const scope = hasActiveModal ? modalLocator.first() : page;

  // 3. Action-specialized lookup strategies
  let strategies = [];

  if (intent === 'fill') {
    strategies = [
      () => scope.getByLabel(new RegExp(`^${safeTarget}$|${safeTarget}`, 'i')),
      () => scope.getByPlaceholder(new RegExp(safeTarget, 'i')),
      () => scope.getByRole('textbox', { name: new RegExp(safeTarget, 'i') }),
      () => scope.locator(`input[name*="${safeCss}" i], textarea[name*="${safeCss}" i]`),
      () => scope.locator(`input[id*="${safeCss}" i], textarea[id*="${safeCss}" i]`),
      () => scope.locator(`input[type="${safeCss.toLowerCase()}"]`),
      // Fallbacks to page root if modal didn't capture it
      () => page.getByLabel(new RegExp(safeTarget, 'i')),
      () => page.getByPlaceholder(new RegExp(safeTarget, 'i')),
      () => page.locator(`input[name*="${safeCss}" i], textarea[name*="${safeCss}" i]`),
      () => page.locator(`input[id*="${safeCss}" i], textarea[id*="${safeCss}" i]`)
    ];
  } else if (intent === 'click') {
    strategies = [
      () => scope.getByRole('button', { name: new RegExp(`^${safeTarget}$|${safeTarget}`, 'i') }),
      () => scope.locator(`button:has-text("${safeCss}")`),
      () => scope.getByRole('link', { name: new RegExp(safeTarget, 'i') }),
      () => scope.locator(`[aria-label*="${safeCss}" i]`),
      () => scope.getByText(new RegExp(`^${safeTarget}$`, 'i'), { exact: true }),
      () => scope.getByText(new RegExp(safeTarget, 'i'), { exact: false }),
      // Fallbacks
      () => page.getByRole('button', { name: new RegExp(`^${safeTarget}$|${safeTarget}`, 'i') }),
      () => page.locator(`button:has-text("${safeCss}")`),
      () => page.getByRole('link', { name: new RegExp(safeTarget, 'i') }),
      () => page.getByText(new RegExp(safeTarget, 'i'), { exact: false })
    ];
  } else if (intent === 'check') {
    strategies = [
      () => scope.getByRole('checkbox', { name: new RegExp(safeTarget, 'i') }),
      () => scope.locator(`input[type="checkbox"][aria-label*="${safeCss}" i]`),
      () => page.getByRole('checkbox', { name: new RegExp(safeTarget, 'i') })
    ];
  } else if (intent === 'select') {
    strategies = [
      () => scope.getByRole('combobox', { name: new RegExp(safeTarget, 'i') }),
      () => scope.locator(`select[name*="${safeCss}" i]`),
      () => scope.locator(`select[id*="${safeCss}" i]`),
      () => scope.locator('select'),
      () => page.locator('select')
    ];
  } else {
    // General fallback strategies
    strategies = [
      () => scope.getByRole('button', { name: new RegExp(safeTarget, 'i') }),
      () => scope.getByRole('link', { name: new RegExp(safeTarget, 'i') }),
      () => scope.getByText(new RegExp(safeTarget, 'i')),
      () => scope.locator(`[aria-label*="${safeCss}" i]`),
      () => page.getByText(new RegExp(safeTarget, 'i'))
    ];
  }

  // Execute lookup pipeline with short fallback deadlines
  for (const getLocator of strategies) {
    try {
      const loc = getLocator();
      if ((await loc.count()) > 0 && (await loc.first().isVisible({ timeout: 1000 }))) {
        return loc.first();
      }
    } catch (_) {}
  }

  throw new Error(`Element matching intent "${intent}" for target "${targetDesc}" could not be resolved.`);
}

/**
 * Autonomous Playwright Intent Plan Executor
 */
export async function executeTestPlan(plan, options = {}) {
  const {
    baseUrl,
    headless = true,
    artifactDir = './artifacts'
  } = options;

  const rawTargetUrl = baseUrl || plan.targetUrl || 'http://localhost:3000';
  const targetUrl = assertValidHttpUrl(rawTargetUrl);

  if (!fs.existsSync(artifactDir)) {
    fs.mkdirSync(artifactDir, { recursive: true });
  }

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

    // Auto-dismiss dialog popups to prevent execution hangs
    page.on('dialog', dialog => {
      dialog.dismiss().catch(() => {});
    });

    const report = {
      testName: plan.name,
      projectId: plan.projectId || 'auto-qa-run',
      targetUrl: targetUrl,
      priority: plan.priority || 'p0',
      startedAt: new Date().toISOString(),
      status: 'passed',
      steps: [],
      artifacts: [],
      consoleErrors: []
    };

    page.on('console', msg => {
      if (msg.type() === 'error') {
        report.consoleErrors.push(msg.text());
      }
    });

    const planSteps = Array.isArray(plan.planSteps) ? plan.planSteps : [];

    console.log(`\n======================================================`);
    console.log(`🤖 Auto-QA Runner: "${plan.name}"`);
    console.log(`🎯 Target: ${targetUrl}`);
    console.log(`📋 Total Steps: ${planSteps.length}`);
    console.log(`======================================================\n`);

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(600);

    const takeSafeScreenshot = async (screenshotPath) => {
      try {
        await page.screenshot({ path: screenshotPath, fullPage: false, timeout: 5000 });
      } catch (_) {
        try {
          await page.screenshot({ path: screenshotPath, timeout: 5000 });
        } catch (err) {
          console.warn('Screenshot capture failed:', err.message);
        }
      }
    };

    for (let i = 0; i < planSteps.length; i++) {
      const step = planSteps[i];
      const stepIndex = i + 1;
      const stepStart = Date.now();
      let stepResult = {
        index: stepIndex,
        description: step.description,
        type: step.type,
        status: 'passed'
      };

      console.log(`[Step ${stepIndex}/${planSteps.length}] [${step.type.toUpperCase()}] ${step.description}`);

      try {
        const desc = step.description;

        if (step.type === 'action') {
          if (/^(?:navigate to|go to\s+https?:\/\/|go to\s+\/)/i.test(desc) || /^open\s+https?:\/\//i.test(desc)) {
            const urlMatch = desc.match(/https?:\/\/[^\s]+|\/[a-zA-Z0-9_\-\/]*/i);
            if (urlMatch) {
              const rawNav = urlMatch[0];
              const navUrl = rawNav.startsWith('http') ? rawNav : new URL(rawNav, page.url()).toString();
              const safeNav = assertValidHttpUrl(navUrl);
              await page.goto(safeNav, { waitUntil: 'domcontentloaded', timeout: 30000 });
            }
          } else if (/^(?:type|enter|fill)\b/i.test(desc)) {
            const valueMatch = desc.match(/["']([^"']+)["']\s*(?:into|in)?\s*(.*)/i)
              || desc.match(/(?:type|enter|fill)\s+([^\s]+)\s+(?:into|in)?\s*(.*)/i);
            const value = valueMatch ? valueMatch[1] : 'QA Input';
            const rawTarget = valueMatch && valueMatch[2] ? valueMatch[2].trim() : desc;
            const target = rawTarget.replace(/^(?:the\s+)?(?:input|textbox|field)?\s*/i, '').replace(/^["']|["']$/g, '');

            const element = await resolveElement(page, target, 'fill');
            await element.fill(value);
          } else if (/^select\b/i.test(desc)) {
            const selMatch = desc.match(/select\s+["']([^"']+)["'](?:\s*(?:in|from)\s*(.*))?/i);
            const optionVal = selMatch ? selMatch[1] : '';
            const target = selMatch && selMatch[2] ? selMatch[2].trim() : 'select';
            const element = await resolveElement(page, target, 'select');
            await element.selectOption({ label: optionVal }).catch(async () => {
              await element.selectOption({ value: optionVal });
            });
          } else if (/^(?:check|tick)\b/i.test(desc)) {
            const target = desc.replace(/^(?:check|tick)\s*(?:the\s+)?(?:checkbox)?\s*/i, '').trim();
            const element = await resolveElement(page, target, 'check');
            await element.check();
          } else if (/^(?:click|press)\b/i.test(desc)) {
            const target = desc.replace(/^(?:click|press)(?:\s+(?:on|the|button|link))?\s*/i, '').trim();
            const element = await resolveElement(page, target, 'click');
            await element.click();
          }
          await page.waitForTimeout(400); // Allow DOM mutations to settle
        } else if (step.type === 'assertion') {
          const isNegative = /not visible|disappear|hidden|should not/i.test(desc);

          if (/visible|displayed|appears|disappear|hidden/i.test(desc)) {
            const quoteMatch = desc.match(/["']([^"']+)["']/);
            const target = quoteMatch ? quoteMatch[1] : desc.replace(/verify|assert|check|should be|is visible|displayed|appears|not visible|disappear|hidden/gi, '').trim();
            
            if (isNegative) {
              const element = await resolveElement(page, target, 'general').catch(() => null);
              const isVis = element ? await element.isVisible({ timeout: 1500 }).catch(() => false) : false;
              if (isVis) throw new Error(`Negative assertion failed: Target "${target}" is still visible.`);
            } else {
              const element = await resolveElement(page, target, 'general');
              const isVis = await element.isVisible({ timeout: 5000 });
              if (!isVis) throw new Error(`Assertion failed: Target "${target}" is not visible.`);
            }
          } else if (/contains|text/i.test(desc)) {
            const textMatch = desc.match(/["']([^"']+)["']/);
            const expectedText = textMatch ? textMatch[1] : desc;
            const hasText = await page.getByText(expectedText).isVisible({ timeout: 5000 });
            if (!hasText) throw new Error(`Assertion failed: Expected text "${expectedText}" was not found.`);
          } else if (/url|path/i.test(desc)) {
            const currentUrl = page.url();
            const expectedPart = desc.match(/["']([^"']+)["']/);
            if (expectedPart && !currentUrl.includes(expectedPart[1])) {
              throw new Error(`Assertion failed: Current URL "${currentUrl}" does not contain "${expectedPart[1]}".`);
            }
          }
        }

        stepResult.durationMs = Date.now() - stepStart;
        report.steps.push(stepResult);
        console.log(`  ✓ Passed (${stepResult.durationMs}ms)`);
      } catch (stepErr) {
        stepResult.status = 'failed';
        stepResult.error = stepErr.message;
        stepResult.durationMs = Date.now() - stepStart;
        report.steps.push(stepResult);
        report.status = 'failed';

        // Snap failure screenshot
        const screenshotPath = path.join(artifactDir, `failure-step-${stepIndex}.png`);
        await takeSafeScreenshot(screenshotPath);
        report.artifacts.push(screenshotPath);

        console.error(`  ❌ Failed: ${stepErr.message}`);
        break;
      }
    }

    // Capture final run screenshot
    const finalScreenshotPath = path.join(artifactDir, `run-final-${Date.now()}.png`);
    await takeSafeScreenshot(finalScreenshotPath);
    report.artifacts.push(finalScreenshotPath);

    report.finishedAt = new Date().toISOString();
    report.durationMs = new Date(report.finishedAt) - new Date(report.startedAt);

    // Save JSON test execution report
    const reportPath = path.join(artifactDir, `test-report-${Date.now()}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
    report.artifacts.push(reportPath);

    return report;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
