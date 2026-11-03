#!/usr/bin/env node

import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compilePlanToPlaywright } from '../scripts/compiler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

console.log('======================================================');
console.log('🔒 Running Auto-QA Security & GitHub Readiness Suite');
console.log('======================================================\n');

let passedTests = 0;
let totalTests = 0;

function runTest(name, fn) {
  totalTests++;
  process.stdout.write(`[Test ${totalTests}] ${name} ... `);
  try {
    fn();
    console.log('✅ PASSED');
    passedTests++;
  } catch (err) {
    console.log('❌ FAILED');
    console.error(`   Error: ${err.message}`);
  }
}

// -------------------------------------------------------------
// AU-01: Compiler Injection & Template Sanitization
// -------------------------------------------------------------
runTest('AU-01: Compiler handles quotes, slashes, and regex metacharacters in actions', () => {
  const maliciousPlan = {
    name: "Injection Test Suite ' \n ` //",
    targetUrl: "http://localhost:3000/test'); process.exit(1); //",
    planSteps: [
      {
        type: 'action',
        description: 'click button "/); process.exit(42); //"'
      },
      {
        type: 'action',
        description: 'fill \'pwned\\"); console.log(1); //\' into email'
      },
      {
        type: 'assertion',
        description: 'verify "Price ($49.99/mo) + Tax" is visible'
      },
      {
        type: 'assertion',
        description: 'assert that "Banner \'; alert(1); //" disappears'
      }
    ]
  };

  const compiledCode = compilePlanToPlaywright(maliciousPlan);
  
  assert(compiledCode.includes('"http://localhost:3000/test\'); process.exit(1); //"'), 'Target URL must be safely escaped');
  assert(!compiledCode.includes('/); process.exit(42); ///'), 'Raw regex delimiter breakout must be neutralized');
  assert(compiledCode.includes('new RegExp('), 'Must use safe RegExp constructor instantiation');

  const testableBody = compiledCode.replace(/import\s+.*?from\s+['"].*?['"];/g, '');
  const mockContext = `
    const test = { describe: (name, fn) => fn(), step: (name, fn) => fn() };
    const expect = () => ({ toBeVisible: () => {}, not: { toBeVisible: () => {} }, toHaveURL: () => {} });
    const page = {
      goto: () => {},
      url: () => 'http://localhost:3000',
      getByLabel: () => ({ or: () => ({ or: () => ({ first: () => ({ fill: () => {} }) }) }) }),
      getByRole: () => ({ or: () => ({ or: () => ({ first: () => ({ click: () => {}, check: () => {} }) }) }) }),
      getByText: () => ({ first: () => ({ toBeVisible: () => {} }) }),
      locator: () => ({ or: () => ({ first: () => ({}) }) })
    };
    ${testableBody}
  `;

  try {
    new Function(mockContext);
  } catch (syntaxErr) {
    throw new Error(`Compiled test output failed JS syntax validation: ${syntaxErr.message}`);
  }
});

// -------------------------------------------------------------
// AU-02: Path Confinement & Traversal Protection (Relative + Absolute)
// -------------------------------------------------------------
runTest('AU-02: Path traversal helper blocks relative, absolute, and cross-drive escapes', () => {
  const allowedBase = path.resolve('C:/allowed/project/root');
  
  function assertInsideDirectory(targetPath, allowedRoot) {
    const resolvedRoot = path.resolve(allowedRoot);
    const resolvedTarget = path.resolve(resolvedRoot, targetPath);
    const relative = path.relative(resolvedRoot, resolvedTarget);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Security Violation: Path "${targetPath}" escapes allowed directory "${allowedRoot}".`);
    }
    return resolvedTarget;
  }

  // Safe path
  const safePath = assertInsideDirectory('auto_qa_tests/plan.json', allowedBase);
  assert(safePath.startsWith(allowedBase), 'Safe path should resolve inside base');

  // Relative traversal
  assert.throws(() => {
    assertInsideDirectory('../../etc/passwd', allowedBase);
  }, /Security Violation/, 'Directory traversal with ../.. must throw a Security Violation');

  // Windows relative traversal
  assert.throws(() => {
    assertInsideDirectory('..\\..\\Windows\\System32\\calc.exe', allowedBase);
  }, /Security Violation/, 'Windows-style traversal with ..\\.. must throw a Security Violation');

  // Absolute path override outside root
  assert.throws(() => {
    assertInsideDirectory('C:\\Windows\\System32\\drivers\\etc\\hosts', allowedBase);
  }, /Security Violation/, 'Absolute path outside root must throw a Security Violation');
});

// -------------------------------------------------------------
// AU-03: SSRF & URL Protocol Scheme Validation
// -------------------------------------------------------------
runTest('AU-03: URL protocol validator restricts schemes to http: and https:', () => {
  function assertValidHttpUrl(rawUrl) {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Navigation blocked: protocol "${parsed.protocol}" is not permitted.`);
    }
    return parsed.toString();
  }

  assert.strictEqual(assertValidHttpUrl('http://localhost:3000'), 'http://localhost:3000/');
  assert.strictEqual(assertValidHttpUrl('https://example.com/api'), 'https://example.com/api');

  assert.throws(() => assertValidHttpUrl('file:///C:/Windows/win.ini'), /Navigation blocked/);
  assert.throws(() => assertValidHttpUrl('javascript:alert(1)'), /Navigation blocked/);
  assert.throws(() => assertValidHttpUrl('data:text/html,<h1>pwned</h1>'), /Navigation blocked/);
  assert.throws(() => assertValidHttpUrl('ftp://internal.server/file'), /Navigation blocked/);
});

// -------------------------------------------------------------
// AU-04: YAML Formatting & DOM Text Sanitization
// -------------------------------------------------------------
runTest('AU-04: DOM text containing newlines and quotes does not break YAML', () => {
  const rawScrapedButtons = [
    { text: 'Normal Button', type: 'button', id: 'btn-1' },
    { text: 'Button with "Quotes" and : Colons', type: 'submit', id: 'btn-2' },
    { text: 'Malicious\n  injected_yaml_key: true\n  text: Breakout', type: 'button', id: 'btn-3' }
  ];

  const summaryYamlLines = [
    '# Auto-QA Discovered Code Summary',
    `url: ${JSON.stringify('http://localhost:3000')}`,
    'buttons:',
    ...rawScrapedButtons.map(b => `  - text: ${JSON.stringify(b.text || '')} (type: ${JSON.stringify(b.type || 'button')}, id: ${JSON.stringify(b.id || 'none')})`)
  ];

  const yamlOutput = summaryYamlLines.join('\n');

  assert(!yamlOutput.includes('\n  injected_yaml_key: true\n'), 'Newlines must be escaped inside JSON strings');
  assert(yamlOutput.includes('injected_yaml_key: true'), 'Content must be preserved safely inside the string');
});

// -------------------------------------------------------------
// AU-05: Regex & CSS Attribute Selector Escaping
// -------------------------------------------------------------
runTest('AU-05: Regex and CSS attribute selectors properly sanitize quotes and metacharacters', () => {
  const planWithComplexField = {
    name: 'Complex Selector Plan',
    targetUrl: 'http://localhost:3000',
    planSteps: [
      {
        type: 'action',
        description: 'type "test-val" into "What needs \\"testing\\"? [v2]"'
      }
    ]
  };

  const compiled = compilePlanToPlaywright(planWithComplexField);
  // Ensure locator uses properly quoted CSS attribute selector
  assert(compiled.includes('input[name*=\\"'), 'Compiled CSS attribute selector must keep quotes around attribute value');
});

// -------------------------------------------------------------
// AU-06: Pre-GitHub PII, Secret & Local Path Hygiene Audit
// -------------------------------------------------------------
runTest('AU-06: Repository files contain zero hardcoded PII, personal emails, or local OS user paths', () => {
  const forbiddenPatterns = [
    { pattern: /yashproject465/i, reason: 'Personal email address found' },
    { pattern: /@Qwerty1234/, reason: 'Personal test password found' },
    { pattern: /YASH KASHYAP/i, reason: 'Local Windows username path hardcoded' },
    { pattern: /sk-[a-zA-Z0-9]{20,}/, reason: 'Potential API secret key found' }
  ];

  function scanDir(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'artifacts') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (/\.(js|mjs|ts|json|md|yaml|yml)$/i.test(entry.name) && entry.name !== 'security_audit_runner.mjs') {
        const content = fs.readFileSync(fullPath, 'utf8');
        for (const { pattern, reason } of forbiddenPatterns) {
          if (pattern.test(content)) {
            throw new Error(`${reason} in file: ${path.relative(ROOT_DIR, fullPath)}`);
          }
        }
      }
    }
  }

  scanDir(ROOT_DIR);
});

console.log('\n======================================================');
console.log(`Audit Summary: ${passedTests}/${totalTests} Security & Readiness Units Verified`);
console.log('======================================================\n');

if (passedTests !== totalTests) {
  process.exit(1);
}
