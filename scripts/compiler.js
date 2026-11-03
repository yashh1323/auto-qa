import fs from 'fs';
import path from 'path';

/**
 * Escapes special regex metacharacters including forward slashes to ensure safe RegExp instantiation.
 */
function sanitizeRegexPattern(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
}

/**
 * Escapes double quotes and backslashes for safe interpolation inside CSS attribute selectors.
 */
function escapeCssString(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ');
}

/**
 * Emits a safe new RegExp(...) expression string with JSON-encoded patterns.
 */
function emitSafeRegExp(pattern, flags = 'i') {
  const safePattern = sanitizeRegexPattern(pattern);
  return `new RegExp(${JSON.stringify(safePattern)}, ${JSON.stringify(flags)})`;
}

/**
 * Compiles a declarative intent test plan (plan.json) into an idiomatic,
 * fully parameterized native Playwright TypeScript test file (@playwright/test).
 */
export function compilePlanToPlaywright(plan, options = {}) {
  const {
    targetUrl = plan.targetUrl || 'http://localhost:3000',
    suiteName = plan.name || 'Automated QA Test Suite'
  } = options;

  let code = `import { test, expect } from '@playwright/test';\n\n`;
  code += `test.describe(${JSON.stringify(suiteName)}, () => {\n`;
  code += `  test(${JSON.stringify(plan.name || 'End-to-End User Flow')}, async ({ page }) => {\n`;
  code += `    // Base URL navigation\n`;
  code += `    await page.goto(${JSON.stringify(targetUrl)});\n\n`;

  const steps = Array.isArray(plan.planSteps) ? plan.planSteps : [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const desc = step.description || `Step ${i + 1}`;
    code += `    await test.step(${JSON.stringify(desc)}, async () => {\n`;

    if (step.type === 'action') {
      if (/^(?:navigate to|go to\s+https?:\/\/|go to\s+\/)/i.test(desc) || /^open\s+https?:\/\//i.test(desc)) {
        const urlMatch = desc.match(/https?:\/\/[^\s]+|\/[a-zA-Z0-9_\-\/]*/i);
        if (urlMatch) {
          const rawUrl = urlMatch[0];
          if (rawUrl.startsWith('http')) {
            code += `      await page.goto(${JSON.stringify(rawUrl)});\n`;
          } else {
            code += `      await page.goto(new URL(${JSON.stringify(rawUrl)}, page.url()).toString());\n`;
          }
        } else {
          code += `      await page.goto(${JSON.stringify(targetUrl)});\n`;
        }
      } else if (/^(?:type|enter|fill)\b/i.test(desc)) {
        const valueMatch = desc.match(/["']([^"']+)["']\s*(?:into|in)?\s*(.*)/i)
          || desc.match(/(?:type|enter|fill)\s+([^\s]+)\s+(?:into|in)?\s*(.*)/i);
        const value = valueMatch ? valueMatch[1] : 'QA Input';
        const rawTarget = valueMatch && valueMatch[2] ? valueMatch[2].trim() : desc;
        const target = rawTarget.replace(/^(?:the\s+)?(?:input|textbox|field)?\s*/i, '').replace(/^["']|["']$/g, '');
        
        const safeRegex = emitSafeRegExp(target, 'i');
        const safeCssAttr = escapeCssString(target);
        const cssSelector = `input[name*="${safeCssAttr}" i], textarea[name*="${safeCssAttr}" i]`;
        code += `      const inputEl = page.getByLabel(${safeRegex})\n`;
        code += `        .or(page.getByPlaceholder(${safeRegex}))\n`;
        code += `        .or(page.locator(${JSON.stringify(cssSelector)}));\n`;
        code += `      await inputEl.first().fill(${JSON.stringify(value)});\n`;
      } else if (/^select\b/i.test(desc)) {
        const selMatch = desc.match(/select\s+["']([^"']+)["'](?:\s*(?:in|from)\s*(.*))?/i);
        const optionVal = selMatch ? selMatch[1] : '';
        const target = selMatch && selMatch[2] ? selMatch[2].trim().replace(/^["']|["']$/g, '') : 'select';
        
        const safeRegex = emitSafeRegExp(target, 'i');
        code += `      const selectEl = page.getByRole('combobox', { name: ${safeRegex} }).or(page.locator('select'));\n`;
        code += `      await selectEl.first().selectOption({ label: ${JSON.stringify(optionVal)} });\n`;
      } else if (/^(?:check|tick)\b/i.test(desc)) {
        const target = desc.replace(/^(?:check|tick)\s*(?:the\s+)?(?:checkbox)?\s*/i, '').replace(/^["']|["']$/g, '').trim();
        const safeRegex = emitSafeRegExp(target, 'i');
        code += `      await page.getByRole('checkbox', { name: ${safeRegex} }).first().check();\n`;
      } else if (/^(?:click|press)\b/i.test(desc)) {
        const target = desc.replace(/^(?:click|press)(?:\s+(?:on|the|button|link))?\s*/i, '').replace(/^["']|["']$/g, '').trim();
        const safeRegex = emitSafeRegExp(target, 'i');
        const safeTargetStr = JSON.stringify(target);
        code += `      const clickTarget = page.getByRole('button', { name: ${safeRegex} })\n`;
        code += `        .or(page.getByRole('link', { name: ${safeRegex} }))\n`;
        code += `        .or(page.getByText(${safeTargetStr}));\n`;
        code += `      await clickTarget.first().click();\n`;
      }
    } else if (step.type === 'assertion') {
      const isNegative = /not visible|disappear|hidden/i.test(desc);
      const quoteMatch = desc.match(/["']([^"']+)["']/);
      const target = quoteMatch ? quoteMatch[1] : desc.replace(/verify|assert|check|should be|is visible|displayed|appears|not visible|disappear|hidden/gi, '').trim();
      const safeTargetStr = JSON.stringify(target);

      if (isNegative) {
        code += `      await expect(page.getByText(${safeTargetStr})).not.toBeVisible();\n`;
      } else if (/url|path/i.test(desc)) {
        code += `      await expect(page).toHaveURL(${emitSafeRegExp(target, '')});\n`;
      } else {
        code += `      await expect(page.getByText(${safeTargetStr}).first()).toBeVisible({ timeout: 5000 });\n`;
      }
    }

    code += `    });\n\n`;
  }

  code += `  });\n`;
  code += `});\n`;

  return code;
}
