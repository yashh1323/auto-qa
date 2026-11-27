#!/usr/bin/env node

import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compilePlanToPlaywright } from '../scripts/compiler.js';
import { writeOutput } from '../scripts/write-output.js';
import { escapeRegex } from '../scripts/executor.js';
import { assertInsideDirectory, formatCodeSummaryYaml } from '../scripts/mcp-server.js';
import {
  assertValidHttpUrl,
  assertSafeResolvedUrl,
  isLoopbackHost,
  sanitizeMdCell,
  toRelativeArtifactLink
} from '../scripts/url-utils.js';
import { redactSecrets, tokenizeEnvTemplate } from '../scripts/env-utils.js';
import { parseStepIntent, escapeCssString, extractQuotedLiteral } from '../scripts/intent-parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

console.log('======================================================');
console.log('🔒 Running Auto-QA Security & GitHub Readiness Suite');
console.log('======================================================\n');

let passedTests = 0;
let totalTests = 0;

async function runTest(name, fn) {
  totalTests++;
  process.stdout.write(`[Test ${totalTests}] ${name} ... `);
  try {
    await fn();
    console.log('✅ PASSED');
    passedTests++;
  } catch (err) {
    console.log('❌ FAILED');
    console.error(`   Error: ${err.stack || err.message}`);
  }
}

function makeChainLocatorMock() {
  const obj = {
    or: () => makeChainLocatorMock(),
    locator: () => makeChainLocatorMock(),
    first: () => makeChainLocatorMock(),
    fill: () => {},
    click: () => {},
    check: () => {},
    selectOption: () => {}
  };
  return obj;
}

// -------------------------------------------------------------
// AU-01: Compiler Injection & Template Sanitization
// -------------------------------------------------------------
await runTest('AU-01: Compiler handles quotes, slashes, and regex metacharacters in actions', () => {
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
    const test = (name, fn) => fn({ page });
    test.describe = (name, fn) => fn();
    test.step = (name, fn) => fn();
    const expect = () => ({
      toBeVisible: () => {},
      toHaveCount: () => {},
      toHaveURL: () => {},
      not: { toBeVisible: () => {}, toHaveCount: () => {}, toHaveURL: () => {} }
    });
    const mkLoc = ${makeChainLocatorMock.toString()};
    const page = {
      goto: () => {},
      url: () => 'http://localhost:3000',
      getByLabel: () => mkLoc(),
      getByPlaceholder: () => mkLoc(),
      getByRole: () => mkLoc(),
      getByText: () => mkLoc(),
      locator: () => mkLoc()
    };
    ${testableBody}
  `;

  try {
    new Function(mockContext)();
  } catch (syntaxErr) {
    throw new Error(`Compiled test output failed JS syntax/exec validation: ${syntaxErr.message}`);
  }
});

// -------------------------------------------------------------
// AU-02: Real Production Path Confinement & Symlink/Dangling Junction Protection
// -------------------------------------------------------------
await runTest('AU-02: Real mcp-server assertInsideDirectory blocks traversals, absolutes, live & dangling symlinks/junctions', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-qa-au02-'));
  const allowedBase = path.join(tempRoot, 'workspace');
  const outsideDir = path.join(tempRoot, 'outside-secret');
  const nonexistentOutsideDir = path.join(tempRoot, 'nonexistent-outside-target');
  fs.mkdirSync(allowedBase, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(path.join(outsideDir, 'secret.json'), '{"leak":true}', 'utf8');

  try {
    const safePath = assertInsideDirectory('auto_qa_tests/plan.json', allowedBase);
    assert(safePath.startsWith(allowedBase), 'Safe path should resolve inside base');
    const dotPrefixed = assertInsideDirectory('..plan.json', allowedBase);
    assert(dotPrefixed.endsWith('..plan.json'), 'Legitimate ..plan.json inside root must be allowed');
    const original = path.join(allowedBase, 'previous.json');
    const report = path.join(allowedBase, 'failure-step-1-context.json');
    fs.writeFileSync(original, 'previous');
    fs.linkSync(original, report);
    writeOutput(report, 'current');
    assert.equal(fs.readFileSync(original, 'utf8'), 'previous');
    assert.equal(fs.readFileSync(report, 'utf8'), 'current');

    assert.throws(() => assertInsideDirectory('../../etc/passwd', allowedBase), /Security Violation/);
    assert.throws(() => assertInsideDirectory('..\\..\\Windows\\System32\\calc.exe', allowedBase), /Security Violation/);
    assert.throws(() => assertInsideDirectory('C:\\Windows\\System32\\drivers\\etc\\hosts', allowedBase), /Security Violation/);

    // Live symlink / NTFS directory junction escape inside allowedBase
    const linkInside = path.join(allowedBase, 'escaped-link');
    fs.symlinkSync(outsideDir, linkInside, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(
      () => assertInsideDirectory('escaped-link/secret.json', allowedBase),
      /Security Violation/,
      'Live symlink/junction pointing outside workspace must be blocked'
    );

    // Dangling directory symlink / junction pointing to non-existent outside directory
    const danglingLink = path.join(allowedBase, 'dangling-link');
    fs.symlinkSync(nonexistentOutsideDir, danglingLink, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(
      () => assertInsideDirectory('dangling-link/out.spec.ts', allowedBase),
      /Security Violation/,
      'Dangling symlink/junction ancestor must be blocked'
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// AU-03: Real Production SSRF, IPv6 Canonicalization & DNS Resolution Guard
// -------------------------------------------------------------
await runTest('AU-03: Real url-utils blocks IMDS/private CIDRs, IPv6 embedded forms, DNS rebinds & raw secret echo', async () => {
  assert.strictEqual(assertValidHttpUrl('http://localhost:3000'), 'http://localhost:3000/');
  assert.strictEqual(assertValidHttpUrl('https://example.com/api'), 'https://example.com/api');
  for (const lookupFn of [async () => [], async () => { throw new Error('unavailable'); }]) {
    await assert.rejects(assertSafeResolvedUrl('https://example.test/', { lookupFn }), /DNS/);
  }

  // Disallowed schemes
  assert.throws(() => assertValidHttpUrl('file:///C:/Windows/win.ini'), /Navigation blocked/);
  assert.throws(() => assertValidHttpUrl('javascript:alert(1)'), /Navigation blocked/);
  assert.throws(() => assertValidHttpUrl('data:text/html,<h1>pwned</h1>'), /Navigation blocked/);
  assert.throws(() => assertValidHttpUrl('ftp://internal.server/file'), /Navigation blocked/);
  assert.throws(() => assertValidHttpUrl('http://localhost:3000/\nnext'), /Invalid URL format/);

  // Cloud metadata (AWS, GCP, Alibaba, Azure WireServer, Oracle, integer & IPv6 link-local/mapped/compatible)
  const imdsUrls = [
    'http://169.254.169.254/latest/meta-data/',
    'http://2852039166/latest/meta-data/',
    'http://100.100.100.200/latest/meta-data/',
    'http://168.63.129.16/machine',
    'http://192.0.0.192/latest/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://sub.metadata.google.internal./',
    'http://[fe80::1]/',
    'http://[fe80::1%25eth0]/',
    'http://[fd00:ec2::254]/',
    'http://[::ffff:169.254.169.254]/',
    'http://[::169.254.169.254]/'
  ];
  for (const u of imdsUrls) {
    assert.throws(() => assertValidHttpUrl(u), /Navigation blocked|Invalid URL format/, `IMDS URL must be blocked: ${u}`);
    // IMDS remains blocked even when intranet private network opt-in is active
    assert.throws(
      () => assertValidHttpUrl(u, { allowPrivateNetwork: true }),
      /Navigation blocked|Invalid URL format/,
      `IMDS URL must remain blocked under allowPrivateNetwork: ${u}`
    );
  }

  // Loopback IPv6 forms
  assert(isLoopbackHost('[::7f00:1]'), 'IPv4-compatible loopback [::127.0.0.1] must be loopback');
  assert(isLoopbackHost('[::ffff:127.0.0.1]'), 'IPv4-mapped loopback must be loopback');
  assert(isLoopbackHost('[::ffff:0.0.0.0]'), 'IPv4-mapped 0.0.0.0 must be loopback');
  assert(isLoopbackHost('[::]'), 'IPv6 unspecified :: must be loopback');

  // RFC1918 / CGNAT / ULA blocked by default, opt-in via allowPrivateNetwork
  const privateUrls = [
    'http://10.0.0.1/',
    'http://172.16.0.5/',
    'http://192.168.1.5/',
    'http://100.64.0.1/',
    'http://[fc00::1]/'
  ];
  for (const u of privateUrls) {
    assert.throws(() => assertValidHttpUrl(u), /Navigation blocked/, `Private IP must be blocked by default: ${u}`);
    assertValidHttpUrl(u, { allowPrivateNetwork: true });
  }

  // DNS resolution validation (e.g. nip.io / localtest.me / rebinding A records)
  await assert.rejects(
    () =>
      assertSafeResolvedUrl('http://169.254.169.254.nip.io/', {
        lookupFn: async () => [{ address: '169.254.169.254', family: 4 }]
      }),
    /resolves to restricted metadata/
  );
  await assert.rejects(
    () =>
      assertSafeResolvedUrl('http://intranet.internal.test/', {
        lookupFn: async () => [{ address: '10.0.0.12', family: 4 }]
      }),
    /resolves to private network/
  );
  await assert.rejects(
    () =>
      assertSafeResolvedUrl('http://localtest.me/', {
        allowLoopback: false,
        lookupFn: async () => [{ address: '127.0.0.1', family: 4 }]
      }),
    /resolves to loopback/
  );

  // Must not echo raw malformed string if a secret failed URL parsing
  let parseErrMsg = '';
  try {
    assertValidHttpUrl('not_a_url_TopSecretToken_9988');
  } catch (e) {
    parseErrMsg = e.message;
  }
  assert(parseErrMsg.includes('Invalid URL format') && !parseErrMsg.includes('TopSecretToken_9988'));
});

// -------------------------------------------------------------
// AU-04: Real MCP YAML Formatting & C1 Control Char Escaping
// -------------------------------------------------------------
await runTest('AU-04: Real formatCodeSummaryYaml produces YAML 1.2 safe against newlines, quotes, & C1 controls', () => {
  const discoveryMock = {
    url: 'http://localhost:3000',
    title: 'App\ninjected_key: true\x7f\x85\x9b\u2028',
    elements: {
      buttons: [
        { text: 'Normal Button', tag: 'button', type: 'button', id: 'btn-1' },
        { text: 'Button with "Quotes" and : Colons', tag: 'button', type: 'submit', id: 'btn-2' },
        { text: 'Malicious\n  injected_yaml_key: true\n  text: Breakout', tag: 'button', type: 'button', id: 'btn-3' }
      ],
      inputs: [{ label: 'Email', tag: 'input', type: 'email', id: 'email' }],
      links: [{ text: 'Docs', href: 'https://example.com/docs' }]
    }
  };

  const yamlOutput = formatCodeSummaryYaml(discoveryMock);
  assert(!yamlOutput.includes('\n  injected_yaml_key: true\n'), 'Newlines must be escaped inside YAML strings');
  assert(!yamlOutput.includes('\x7f') && !yamlOutput.includes('\x85') && !yamlOutput.includes('\x9b'), 'C1 controls must be escaped');
  assert(yamlOutput.includes('\\u0085') && yamlOutput.includes('\\u009b'), 'C1 controls must emit \\u00XX');
  assert(yamlOutput.includes('    type: "submit"'), 'Must emit standard indented YAML mapping keys');
});

// -------------------------------------------------------------
// AU-05: Direct Regex & CSS Attribute Selector Escaping
// -------------------------------------------------------------
await runTest('AU-05: escapeRegex(), escapeCssString(), and compiler sanitize quotes, newlines & metacharacters', () => {
  const escapedRe = escapeRegex('Price ($49.99)? [v2]+/a\\b');
  assert.strictEqual(escapedRe, 'Price \\(\\$49\\.99\\)\\? \\[v2\\]\\+/a\\\\b');
  assert.strictEqual(escapeCssString('a"b\\c\n\r\0d'), 'a\\"b\\\\c d');

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
  assert(compiled.includes('input[name*=\\"'), 'Compiled CSS attribute selector must keep quotes around attribute value');
});

// -------------------------------------------------------------
// AU-06: Pre-GitHub PII, Secret & Local OS Path Hygiene Audit
// -------------------------------------------------------------
await runTest('AU-06: Repository files contain zero hardcoded secrets, tokens, or local OS user paths', () => {
  const forbiddenPatterns = [
    { pattern: new RegExp('[A-Z]:\\\\Users\\\\[^\\\\\\r\\n"\\x27`]+\\\\', 'i'), reason: 'Hardcoded Windows user path found' },
    { pattern: new RegExp('/' + 'Users/[^/\\s]+/'), reason: 'Hardcoded macOS user path found' },
    { pattern: new RegExp('sk-' + '[a-zA-Z0-9]{20,}'), reason: 'Potential API secret key found' },
    { pattern: new RegExp('ghp_' + '[a-zA-Z0-9]{20,}'), reason: 'GitHub PAT found' },
    { pattern: new RegExp('github_pat_' + '[a-zA-Z0-9_]{20,}'), reason: 'GitHub fine-grained PAT found' },
    { pattern: new RegExp('AKIA' + '[0-9A-Z]{16}'), reason: 'AWS Access Key ID found' },
    { pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, reason: 'Private key block found' }
  ];

  function scanDir(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'artifacts') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (/\.(js|mjs|ts|json|md|yaml|yml)$/i.test(entry.name)) {
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

// -------------------------------------------------------------
// AU-07: Strict ${ENV_VAR}, Relative/Control-Char SSRF, maxSteps & Env Prefix Allowlist
// -------------------------------------------------------------
await runTest('AU-07: Compiler enforces requireEnv(), control-char/relative nav guard, maxSteps & allowedEnvPrefixes', () => {
  for (const description of ['fill "sample" into "${field}"', 'select "sample" from "${field}"']) {
    assert.throws(() => compilePlanToPlaywright({ planSteps: [{ type: 'action', description }] }), /Invalid environment variable placeholder/);
    const valid = description.replace('${field}', '${QA_FIELD}');
    assert(compilePlanToPlaywright({ planSteps: [{ type: 'action', description: valid }] }).includes('requireEnv("QA_FIELD", process.env["QA_FIELD"])'));
  }
  const validEnvPlan = {
    name: 'Env Var Login Flow',
    targetUrl: 'http://localhost:3000',
    planSteps: [
      { type: 'action', description: 'fill "${QA_EMAIL}" into "Email"' },
      { type: 'action', description: 'fill "${QA_PASSWORD}" into "Password"' },
      { type: 'action', description: 'type "Bearer ${API_TOKEN}" into "Auth Header"' },
      { type: 'action', description: 'navigate to settings' },
      { type: 'assertion', description: 'verify "Price ($49.99/mo)" is visible' }
    ]
  };

  const compiled = compilePlanToPlaywright(validEnvPlan);
  assert(compiled.includes('function requireEnv('), 'Compiled output must include fail-closed requireEnv helper');
  assert(compiled.includes('function assertSafeHttpUrl('), 'Relative navigate must include assertSafeHttpUrl guard');
  assert(compiled.includes('assertSafeHttpUrl(new URL("settings", page.url()).toString())'), 'Relative navigate without leading / must wrap assertSafeHttpUrl');
  assert(compiled.includes('requireEnv("QA_EMAIL", process.env["QA_EMAIL"])'));
  assert(compiled.includes('"Bearer " + requireEnv("API_TOKEN", process.env["API_TOKEN"])'));
  assert(!compiled.includes('.fill("${QA_EMAIL}")'));

  const badExpressions = [
    '${process.exit(1)}',
    "${QA_EMAIL || 'fallback'}",
    '${lowercase_var}',
    '${1LEADING_DIGIT}',
    '${}',
    '${UNCLOSED',
    '${${QA_EMAIL}}'
  ];

  for (const badExpr of badExpressions) {
    assert.throws(() => {
      compilePlanToPlaywright({
        name: 'Bad Env Plan',
        targetUrl: 'http://localhost:3000',
        planSteps: [{ type: 'action', description: `fill "${badExpr}" into "Email"` }]
      });
    }, /Invalid environment variable placeholder/);
  }

  // Control-character & backslash protocol-relative nav smuggling blocked at parse/compile time
  for (const evilNav of [
    'navigate to file:///etc/passwd',
    'navigate to //169.254.169.254/latest',
    'navigate to " //169.254.169.254/"',
    'navigate to " file:///etc/passwd"',
    'navigate to "/\n/169.254.169.254/"',
    'navigate to "/\t/169.254.169.254/"',
    'navigate to "/\r/169.254.169.254/"',
    'navigate to "/\\169.254.169.254/"'
  ]) {
    assert.throws(() => {
      compilePlanToPlaywright({
        name: 'Bad Nav',
        targetUrl: 'http://localhost:3000',
        planSteps: [{ type: 'action', description: evilNav }]
      });
    }, /Navigation blocked/);
  }

  // allowedEnvPrefixes rejection in compiler
  assert.throws(() => {
    compilePlanToPlaywright(
      {
        name: 'Disallowed Env',
        targetUrl: 'http://localhost:3000',
        planSteps: [{ type: 'action', description: 'fill "${AWS_SECRET_ACCESS_KEY}" into "Key"' }]
      },
      { allowedEnvPrefixes: ['QA_', 'AUTO_QA_'] }
    );
  }, /Security Violation: Environment variable "AWS_SECRET_ACCESS_KEY" is not permitted/);

  // maxSteps enforcement in compiler
  assert.throws(() => {
    compilePlanToPlaywright(
      {
        name: 'Too Many Steps',
        targetUrl: 'http://localhost:3000',
        planSteps: [
          { type: 'action', description: 'click "One"' },
          { type: 'action', description: 'click "Two"' },
          { type: 'action', description: 'click "Three"' }
        ]
      },
      { maxSteps: 2 }
    );
  }, /exceeds maximum limit of 2/);
});

// -------------------------------------------------------------
// AU-08: Percent/Form-Encoded & Lowercase Hex Redaction + Linear O(N) Scanner Performance
// -------------------------------------------------------------
await runTest('AU-08: redactSecrets catches encodeURIComponent, URLSearchParams (+), lowercase hex & scanner stays O(N)', () => {
  const secretRaw = 'My/Pass#1 23';
  const secrets = new Map([[secretRaw, 'QA_PASS']]);
  const urlEncoded = `u1=${encodeURIComponent(secretRaw)}`;
  const lowerEncoded = `u2=${encodeURIComponent(secretRaw).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase())}`;
  const formEncoded = `u3=${new URLSearchParams([['k', secretRaw]]).toString().slice(2)}`;
  const rawUri = `u4=${encodeURI(secretRaw)}`;

  const scrubbed = redactSecrets(`${urlEncoded}&${lowerEncoded}&${formEncoded}&${rawUri}`, secrets);
  assert(!scrubbed.includes('My%2FPass%231%2023'), 'encodeURIComponent must be redacted');
  assert(!scrubbed.includes('My%2fPass%231%2023'), 'Lowercase hex variant must be redacted');
  assert(!scrubbed.includes('My%2FPass%231+23'), 'URLSearchParams + form encoding must be redacted');
  assert(!scrubbed.includes('My/Pass#1%2023'), 'encodeURI must be redacted');

  const t0 = Date.now();
  const payload = 'navigate to ' + '${'.repeat(25000);
  const parsed = parseStepIntent({ type: 'action', description: payload });
  assert.throws(() => tokenizeEnvTemplate(parsed.rawUrl), /Invalid environment variable placeholder/);
  const redosPayload = `verify ${' "a'.repeat(20000)} is visible`;
  extractQuotedLiteral(redosPayload);
  assert(Date.now() - t0 < 250, `Expected linear-time parsing, took ${Date.now() - t0}ms`);
});

// -------------------------------------------------------------
// AU-09: Intent Parser Contractions, Quoted-Literal Isolation & Markdown Link Escaping
// -------------------------------------------------------------
await runTest('AU-09: Unified parser handles contractions, quoted keywords, URL/empty/unquoted steps & MD escaping', () => {
  assert.deepStrictEqual(
    parseStepIntent({ type: 'assertion', description: 'verify URL contains "/dashboard"' }),
    { kind: 'assert-url', negative: false, target: '/dashboard' }
  );
  assert.deepStrictEqual(
    parseStepIntent({ type: 'assertion', description: 'verify "Invalid URL" is visible' }),
    { kind: 'assert-visible', negative: false, target: 'Invalid URL' }
  );
  assert.deepStrictEqual(
    parseStepIntent({ type: 'assertion', description: 'assert page contains "Invalid path"' }),
    { kind: 'assert-text', negative: false, target: 'Invalid path' }
  );
  assert.deepStrictEqual(
    parseStepIntent({ type: 'assertion', description: 'verify page contains "hidden gem"' }),
    { kind: 'assert-text', negative: false, target: 'hidden gem' }
  );
  assert.deepStrictEqual(
    parseStepIntent({ type: 'assertion', description: 'verify page contains "Invalid URL"' }),
    { kind: 'assert-text', negative: false, target: 'Invalid URL' }
  );
  assert.deepStrictEqual(
    parseStepIntent({ type: 'assertion', description: 'verify user\'s "Name" isn\'t visible' }),
    { kind: 'assert-visible', negative: true, target: 'Name' }
  );
  assert.deepStrictEqual(
    parseStepIntent({ type: 'action', description: 'fill ${QA_EMAIL} into "Email"' }),
    { kind: 'fill', rawValue: '${QA_EMAIL}', target: 'Email' }
  );
  assert.deepStrictEqual(
    parseStepIntent({ type: 'action', description: 'fill "" into "Email"' }),
    { kind: 'fill', rawValue: '', target: 'Email' }
  );
  assert.deepStrictEqual(
    parseStepIntent({ type: 'action', description: 'click on the "Sign In" button' }),
    { kind: 'click', target: 'Sign In' }
  );
  assert.throws(
    () => parseStepIntent({ type: 'action', description: 'frobnicate "Widget"' }),
    /Unsupported action step/
  );

  const cell = sanitizeMdCell('err |\n![pixel](https://evil.test/track)<script>alert(1)</script>');
  assert(!cell.includes('\n'));
  assert(!cell.includes('<script>'));
  assert(cell.includes('\\|') && cell.includes('!\\['));

  const safeLink = toRelativeArtifactLink('/tmp/out', '/tmp/out/run (1)#2.png');
  assert.strictEqual(safeLink, 'run%20%281%29%232.png');
});

console.log('\n======================================================');
console.log(`Audit Summary: ${passedTests}/${totalTests} Security & Readiness Units Verified`);
console.log('======================================================\n');

if (passedTests !== totalTests) {
  process.exit(1);
}
