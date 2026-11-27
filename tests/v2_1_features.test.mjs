#!/usr/bin/env node

import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { executeTestPlan, checkFailureContextFreshness, normalizeDynamicLabel } from '../scripts/executor.js';
import { discoverInteractiveElements } from '../scripts/discover.js';
import { compilePlanToPlaywright } from '../scripts/compiler.js';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const CLI_PATH = path.join(REPO_ROOT, 'scripts', 'cli.js');
const MCP_PATH = path.join(REPO_ROOT, 'scripts', 'mcp-server.js');

console.log('======================================================');
console.log('🧪 Running Auto-QA v2.1.0 Feature & Hardening Suite');
console.log('======================================================\n');

let passedTests = 0;
let totalTests = 0;

async function runAsyncTest(name, fn) {
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

async function withLocalServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function makeTempDir(prefix = 'auto-qa-v21-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// 1. Stale Invisible Modal Portals Mounted Before Active Visible Modal
// ---------------------------------------------------------------------------
await runAsyncTest('V21-01: Skips stale invisible portals (without .hidden) and clicks active visible modal', async () => {
  const html = `<!doctype html><html><body>
    <button id="backdrop-submit" onclick="document.getElementById('status').textContent='Backdrop Clicked'">Submit</button>
    <div id="status">Idle</div>

    <!-- Stale invisible portals WITHOUT .hidden class -->
    <div role="dialog" style="display:none"><button>Submit</button></div>
    <div aria-modal="true" style="visibility:hidden;width:200px;height:120px"><button>Submit</button></div>
    <div class="modal" style="opacity:0;width:200px;height:120px"><button>Submit</button></div>
    <div role="dialog" inert style="width:200px;height:120px"><button>Submit</button></div>

    <!-- Real active visible modal later in DOM -->
    <div role="dialog" aria-modal="true" id="real-portal"
         style="position:fixed;top:40px;left:40px;width:320px;height:200px;background:#fff;z-index:20;">
      <h2>Active Portal</h2>
      <button id="modal-submit" onclick="document.getElementById('status').textContent='Active Modal Submitted';document.getElementById('real-portal').style.display='none';">Submit</button>
    </div>
  </body></html>`;

  const tmpDir = makeTempDir();
  try {
    await withLocalServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    }, async (baseUrl) => {
      const report = await executeTestPlan({
        name: 'Stale Portal Modal Test',
        targetUrl: baseUrl,
        planSteps: [
          { type: 'action', description: 'click "Submit"' },
          { type: 'assertion', description: 'verify "Active Modal Submitted" is visible' }
        ]
      }, { artifactDir: tmpDir });

      assert.strictEqual(report.status, 'passed', `Expected passed, got failed: ${JSON.stringify(report.steps)}`);
    });
  } finally {
    cleanupTempDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// 2. Top-Most Visible Modal Selection (Higher z-index Wins Over Later DOM)
// ---------------------------------------------------------------------------
await runAsyncTest('V21-02: Prefers top-most visible dialog by z-index when multiple visible dialogs exist', async () => {
  const html = `<!doctype html><html><body>
    <div id="status">Waiting</div>
    <div role="dialog" aria-modal="true" id="top-modal"
         style="position:fixed;top:20px;left:20px;width:300px;height:180px;z-index:100;background:#fff;">
      <button onclick="document.getElementById('status').textContent='Topmost Modal Confirmed';document.querySelectorAll('[role=dialog]').forEach(d=>d.style.display='none');">Confirm</button>
    </div>
    <div role="dialog" aria-modal="true" id="lower-modal"
         style="position:fixed;top:20px;left:360px;width:300px;height:180px;z-index:10;background:#eee;">
      <button onclick="document.getElementById('status').textContent='Lower Modal Clicked'">Confirm</button>
    </div>
  </body></html>`;

  const tmpDir = makeTempDir();
  try {
    await withLocalServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    }, async (baseUrl) => {
      const report = await executeTestPlan({
        name: 'Top-Most z-index Modal Test',
        targetUrl: baseUrl,
        planSteps: [
          { type: 'action', description: 'click "Confirm"' },
          { type: 'assertion', description: 'verify "Topmost Modal Confirmed" is visible' }
        ]
      }, { artifactDir: tmpDir });

      assert.strictEqual(report.status, 'passed', `Expected topmost modal to win: ${JSON.stringify(report.steps)}`);
    });
  } finally {
    cleanupTempDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// 3. Compiler ${ENV_VAR} Emit + Fail-Closed Execution of Compiled Helper
// ---------------------------------------------------------------------------
await runAsyncTest('V21-03: Compiled Playwright spec executes requireEnv() & assertSafeHttpUrl() with set & missing env vars', async () => {
  const plan = {
    name: 'Compiled Env Secret Test',
    targetUrl: '${APP_URL}',
    planSteps: [
      { type: 'action', description: 'fill "${QA_EMAIL}" into "Email"' },
      { type: 'action', description: 'fill "${QA_PASSWORD}" into "Password"' },
      { type: 'action', description: 'navigate to /dashboard' },
      { type: 'assertion', description: 'verify "Signed In" is visible' }
    ]
  };

  const tsCode = compilePlanToPlaywright(plan);
  assert(tsCode.includes('requireEnv("APP_URL", process.env["APP_URL"])'));
  assert(tsCode.includes('requireEnv("QA_EMAIL", process.env["QA_EMAIL"])'));
  assert(tsCode.includes('requireEnv("QA_PASSWORD", process.env["QA_PASSWORD"])'));
  assert(tsCode.includes('function assertSafeHttpUrl('));
  assert(!tsCode.includes('.fill("${QA_EMAIL}")'));

  const jsBody = tsCode
    .replace(/import\s+.*?from\s+['"].*?['"];\s*/g, '')
    .replace('function requireEnv(name: string, value: string | undefined): string', 'function requireEnv(name, value)')
    .replace('function assertSafeHttpUrl(rawUrl: string): string', 'function assertSafeHttpUrl(rawUrl)');

  const executeCompiled = async (fakeEnv) => {
    const filled = [];
    const visited = [];
    const testTasks = [];
    const fn = new Function('process', 'test', 'expect', jsBody);

    const makeMockLoc = () => {
      const node = {
        or: () => makeMockLoc(),
        locator: () => makeMockLoc(),
        first: () => makeMockLoc(),
        fill: async (v) => filled.push(v)
      };
      return node;
    };

    const mockPage = {
      goto: async (u) => visited.push(u),
      url: () => 'http://localhost:3000/login',
      getByLabel: () => makeMockLoc(),
      getByPlaceholder: () => makeMockLoc(),
      getByRole: () => makeMockLoc(),
      getByText: () => makeMockLoc(),
      locator: () => makeMockLoc()
    };

    const mockTest = (_name, cb) => {
      testTasks.push(cb({ page: mockPage }));
    };
    mockTest.describe = (_name, cb) => cb();
    mockTest.step = async (_name, cb) => cb();

    const mockExpect = () => ({
      toBeVisible: async () => {},
      toHaveCount: async () => {},
      toHaveURL: async () => {},
      not: { toBeVisible: async () => {}, toHaveCount: async () => {}, toHaveURL: async () => {} }
    });

    fn({ env: fakeEnv }, mockTest, mockExpect);
    await Promise.all(testTasks);
    return { filled, visited };
  };

  const out = await executeCompiled({
    APP_URL: 'http://localhost:3000/login',
    QA_EMAIL: 'compiled@example.test',
    QA_PASSWORD: 'CompiledPass_123!'
  });
  assert.deepStrictEqual(out.visited, ['http://localhost:3000/login', 'http://localhost:3000/dashboard']);
  assert.deepStrictEqual(out.filled, ['compiled@example.test', 'CompiledPass_123!']);

  await assert.rejects(
    () => executeCompiled({ APP_URL: 'http://localhost:3000/login' }),
    /Missing required environment variable: QA_EMAIL/
  );
  await assert.rejects(
    () => executeCompiled({ APP_URL: 'file:///etc/passwd', QA_EMAIL: 'a', QA_PASSWORD: 'b' }),
    /Navigation blocked/
  );
  await assert.rejects(
    () => executeCompiled({ APP_URL: 'http://100.100.100.200/latest/', QA_EMAIL: 'a', QA_PASSWORD: 'b' }),
    /Navigation blocked/
  );
  await assert.rejects(
    () => executeCompiled({ APP_URL: 'http://[fd00:ec2:1::1]/', QA_EMAIL: 'a', QA_PASSWORD: 'b' }),
    /Navigation blocked/
  );
  await assert.rejects(
    () => executeCompiled({ APP_URL: 'http://10.0.0.5/', QA_EMAIL: 'a', QA_PASSWORD: 'b' }),
    /Navigation blocked/
  );
  const privOut = await executeCompiled({
    APP_URL: 'http://10.0.0.5/app',
    QA_EMAIL: 'a',
    QA_PASSWORD: 'b',
    AUTO_QA_ALLOW_PRIVATE_NETWORK: '1'
  });
  assert.strictEqual(privOut.visited[0], 'http://10.0.0.5/app');

  let invalidUrlErr = null;
  try {
    await executeCompiled({ APP_URL: 'not_a_url_TopSecret_4421', QA_EMAIL: 'a', QA_PASSWORD: 'b' });
  } catch (e) {
    invalidUrlErr = e;
  }
  assert(invalidUrlErr && /Invalid URL format/.test(invalidUrlErr.message));
  assert(!invalidUrlErr.message.includes('TopSecret_4421'));
  assert(!('input' in invalidUrlErr && String(invalidUrlErr.input).includes('TopSecret_4421')));
});

// ---------------------------------------------------------------------------
// 4. Executor ${ENV_VAR} Resolution & Zero Secret Leakage in Report or Stdout
// ---------------------------------------------------------------------------
await runAsyncTest('V21-04: Executor resolves ${ENV_VAR} at runtime and never leaks secrets to stdout or JSON report', async () => {
  const html = `<!doctype html><html><body>
    <form onsubmit="event.preventDefault();
      const e = document.getElementById('email').value;
      const p = document.getElementById('password').value;
      document.getElementById('result').textContent =
        (e === 'qa-secret-user@example.test' && p === 'VerySecretValue_7719!') ? 'Authenticated OK' : 'Denied';">
      <label for="email">Email</label>
      <input id="email" name="email" type="text" />
      <label for="password">Password</label>
      <input id="password" name="password" type="password" />
      <button type="submit">Sign In</button>
    </form>
    <script>console.error('x'.repeat(991) + 'VerySecretValue_7719!')</script>
    <div id="result">Pending</div>
  </body></html>`;

  const tmpDir = makeTempDir();
  const prevEmail = process.env.QA_E2E_EMAIL;
  const prevPass = process.env.QA_E2E_PASS;
  process.env.QA_E2E_EMAIL = 'qa-secret-user@example.test';
  process.env.QA_E2E_PASS = 'VerySecretValue_7719!';

  let capturedStdout = '';
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, encoding, cb) => {
    capturedStdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    return origWrite(chunk, encoding, cb);
  };

  try {
    await withLocalServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    }, async (baseUrl) => {
      const report = await executeTestPlan({
        name: 'Env Var Login Test VerySecretValue_7719!',
        targetUrl: baseUrl,
        planSteps: [
          { type: 'action', description: 'fill "${QA_E2E_EMAIL}" into "Email"' },
          { type: 'action', description: 'fill "${QA_E2E_PASS}" into "Password"' },
          { type: 'action', description: 'click "Sign In"' },
          { type: 'assertion', description: 'verify "Authenticated OK" is visible' }
        ]
      }, { artifactDir: tmpDir });

      assert.strictEqual(report.status, 'passed', `Login failed: ${JSON.stringify(report.steps)}`);

      const reportJsonPath = report.artifacts.find((p) => path.basename(p).startsWith('test-report-') && p.endsWith('.json'));
      assert(reportJsonPath && fs.existsSync(reportJsonPath), 'test-report-*.json must exist');
      const reportRaw = fs.readFileSync(reportJsonPath, 'utf8');

      assert(reportRaw.includes('${QA_E2E_EMAIL}'), 'Placeholder ${QA_E2E_EMAIL} should remain in step description');
      assert(reportRaw.includes('${QA_E2E_PASS}'), 'Placeholder ${QA_E2E_PASS} should remain in step description');
      assert(!reportRaw.includes('qa-secret-user@example.test'), 'Resolved email secret must NOT appear in test-report JSON');
      assert(report.consoleErrors[0].startsWith('x'.repeat(991)));
      assert(!reportRaw.includes('VerySecre'), 'Redact before console truncation even before the fill step');
      assert(!reportRaw.includes('VerySecretValue_7719!'), 'Resolved password secret must NOT appear in test-report JSON');
      assert(!capturedStdout.includes('qa-secret-user@example.test'), 'Resolved email secret must NOT appear in stdout');
      assert(!capturedStdout.includes('VerySecretValue_7719!'), 'Resolved password secret must NOT appear in stdout');
    });
  } finally {
    process.stdout.write = origWrite;
    if (prevEmail === undefined) delete process.env.QA_E2E_EMAIL; else process.env.QA_E2E_EMAIL = prevEmail;
    if (prevPass === undefined) delete process.env.QA_E2E_PASS; else process.env.QA_E2E_PASS = prevPass;
    cleanupTempDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// 5. Executor Fail-Closed on Unset Env Var & Injection Rejection
// ---------------------------------------------------------------------------
await runAsyncTest('V21-05: Executor fails closed on missing env var and rejects invalid ${...} expressions', async () => {
  const html = `<!doctype html><html><body><label for="e">Email</label><input id="e" name="email" /></body></html>`;
  const prev = process.env.QA_UNSET_VAR;
  delete process.env.QA_UNSET_VAR;

  const tmpDir1 = makeTempDir();
  const tmpDir2 = makeTempDir();
  try {
    await withLocalServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    }, async (baseUrl) => {
      const reportUnset = await executeTestPlan({
        name: 'Missing Env Fail-Closed Test',
        targetUrl: baseUrl,
        planSteps: [{ type: 'action', description: 'fill "${QA_UNSET_VAR}" into "Email"' }]
      }, { artifactDir: tmpDir1 });

      assert.strictEqual(reportUnset.status, 'failed');
      assert.match(reportUnset.steps[0].error, /Missing required environment variable: QA_UNSET_VAR/);

      const reportInject = await executeTestPlan({
        name: 'Invalid Placeholder Rejection Test',
        targetUrl: baseUrl,
        planSteps: [{ type: 'action', description: 'fill "${process.exit(1)}" into "Email"' }]
      }, { artifactDir: tmpDir2 });

      assert.strictEqual(reportInject.status, 'failed');
      assert.match(reportInject.steps[0].error, /Invalid environment variable placeholder/);
    });
  } finally {
    if (prev !== undefined) process.env.QA_UNSET_VAR = prev;
    cleanupTempDir(tmpDir1);
    cleanupTempDir(tmpDir2);
  }
});

// ---------------------------------------------------------------------------
// 6. Failure-Time Scoped Context Snapshot Inside Open Modal (+ Secret Redaction)
// ---------------------------------------------------------------------------
await runAsyncTest('V21-06: Captures failure-step-2-context.json scoped to active modal & redacts secrets', async () => {
  const html = `<!doctype html><html><head><title>Modal Snapshot Fixture</title></head><body>
    <header><a href="/bg-docs">Background Link</a></header>
    <button>Background Action</button>
    <input type="text" placeholder="Background Input" />

    <div role="dialog" style="display:none"><button>Ghost Button</button></div>

    <div role="dialog" aria-modal="true" id="open-modal"
         style="position:fixed;top:30px;left:30px;width:400px;height:300px;background:#fff;z-index:50;">
      <label for="m-code">Modal Code</label>
      <input id="m-code" type="text" placeholder="Modal Code" />
      <button type="button">Modal Save</button>
      <a href="/modal-docs">Modal Docs</a>
    </div>
  </body></html>`;

  const tmpDir = makeTempDir();
  const prevSecret = process.env.QA_MODAL_SECRET;
  process.env.QA_MODAL_SECRET = 'ModalSecretCode_991!';

  try {
    await withLocalServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    }, async (baseUrl) => {
      const report = await executeTestPlan({
        name: 'Modal Failure Snapshot Test',
        targetUrl: baseUrl,
        planSteps: [
          { type: 'action', description: 'fill "${QA_MODAL_SECRET}" into "Modal Code"' },
          { type: 'action', description: 'click "Nonexistent Checkout Button"' }
        ]
      }, { artifactDir: tmpDir });

      assert.strictEqual(report.status, 'failed');
      const pngPath = report.artifacts.find((p) => p.endsWith('failure-step-2.png'));
      const ctxPath = report.artifacts.find((p) => p.endsWith('failure-step-2-context.json'));
      assert(pngPath && fs.existsSync(pngPath), 'failure-step-2.png must be saved and listed in artifacts');
      assert(ctxPath && fs.existsSync(ctxPath), 'failure-step-2-context.json must be saved and listed in artifacts');

      const ctxRaw = fs.readFileSync(ctxPath, 'utf8');
      assert(!ctxRaw.includes('ModalSecretCode_991!'), 'Typed secret must not appear anywhere inside failure-step-2-context.json');

      const ctx = JSON.parse(ctxRaw);
      assert(ctx.url.startsWith(baseUrl), 'Context URL must match page URL');
      assert.strictEqual(ctx.title, 'Modal Snapshot Fixture');
      assert.strictEqual(ctx.stepIndex, 2);
      assert.strictEqual(ctx.failedStepDescription, 'click "Nonexistent Checkout Button"');
      assert(ctx.error.includes('Nonexistent Checkout Button'));
      assert.strictEqual(ctx.scopedToModal, true, 'Snapshot must be scoped to active visible modal');

      const buttonTexts = ctx.elements.buttons.map((b) => b.text);
      const inputPlaceholders = ctx.elements.inputs.map((i) => i.placeholder);
      const linkTexts = ctx.elements.links.map((l) => l.text);

      assert(buttonTexts.includes('Modal Save'), 'Must include visible modal button');
      assert(!buttonTexts.includes('Background Action'), 'Must exclude background button when modal is open');
      assert(!buttonTexts.includes('Ghost Button'), 'Must exclude stale invisible modal button');

      assert(inputPlaceholders.includes('Modal Code'), 'Must include visible modal input');
      assert(!inputPlaceholders.includes('Background Input'), 'Must exclude background input when modal is open');

      assert(linkTexts.includes('Modal Docs'), 'Must include visible modal link');
      assert(!linkTexts.includes('Background Link'), 'Must exclude background link when modal is open');

      assert(ctx.accessibilitySnapshot !== null && ctx.accessibilitySnapshot !== undefined, 'Accessibility snapshot must be populated');

      const reportJsonPath = report.artifacts.find((p) => path.basename(p).startsWith('test-report-') && p.endsWith('.json'));
      const reportRaw = fs.readFileSync(reportJsonPath, 'utf8');
      assert(!reportRaw.includes('ModalSecretCode_991!'), 'Typed secret must not appear in test-report JSON');
    });
  } finally {
    if (prevSecret === undefined) delete process.env.QA_MODAL_SECRET; else process.env.QA_MODAL_SECRET = prevSecret;
    cleanupTempDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// 7. Failure-Time Page-Scoped Cap Check (50 buttons / 50 inputs / 30 links)
// ---------------------------------------------------------------------------
await runAsyncTest('V21-07: Failure context snapshot without open modal caps elements at 50/50/30', async () => {
  const buttonsHtml = Array.from({ length: 60 }, (_, i) => `<button type="button">Btn ${i + 1}</button>`).join('\n');
  const inputsHtml = Array.from({ length: 60 }, (_, i) => `<input type="text" placeholder="Input ${i + 1}" />`).join('\n');
  const linksHtml = Array.from({ length: 40 }, (_, i) => `<a href="/p/${i + 1}">Link Item ${i + 1}</a>`).join('\n');
  const html = `<!doctype html><html><head><title>Cap Page Fixture</title></head><body>
    <nav>${linksHtml}</nav>
    <div>${buttonsHtml}</div>
    <div>${inputsHtml}</div>
  </body></html>`;

  const tmpDir = makeTempDir();
  try {
    await withLocalServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    }, async (baseUrl) => {
      const report = await executeTestPlan({
        name: 'Cap Verification Plan',
        targetUrl: baseUrl,
        planSteps: [{ type: 'action', description: 'click "Missing Trigger"' }]
      }, { artifactDir: tmpDir });

      assert.strictEqual(report.status, 'failed');
      const ctxPath = report.artifacts.find((p) => p.endsWith('failure-step-1-context.json'));
      assert(ctxPath && fs.existsSync(ctxPath));
      const ctx = JSON.parse(fs.readFileSync(ctxPath, 'utf8'));

      assert.strictEqual(ctx.scopedToModal, false);
      assert.strictEqual(ctx.elements.buttons.length, 50, `Expected 50 buttons cap, got ${ctx.elements.buttons.length}`);
      assert.strictEqual(ctx.elements.inputs.length, 50, `Expected 50 inputs cap, got ${ctx.elements.inputs.length}`);
      assert.strictEqual(ctx.elements.links.length, 30, `Expected 30 links cap, got ${ctx.elements.links.length}`);
    });
  } finally {
    cleanupTempDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// 8. Extended Modal Hardening: transform stacking, nested .modal, Shadow DOM, native <dialog>, blocking assert-visible
// ---------------------------------------------------------------------------
await runAsyncTest('V21-08: Handles transform stacking, nested .modal, native <dialog>, Shadow DOM portals & blocking assert-visible', async () => {
  const html = `<!doctype html><html><head><style>
    .hidden { display: none; }
    .md\\:block { display: block; }
  </style></head><body>
    <div id="status">Init</div>
    <div id="bg-banner">Background Secret Banner</div>

    <!-- Modal A sits inside transform:translateZ(0) stacking context (effective root z:0), even with child z-index:999 -->
    <div style="transform:translateZ(0);position:fixed;inset:0">
      <div role="dialog" aria-modal="true" style="position:relative;z-index:999;width:200px;height:120px;background:#eee">
        <button onclick="document.getElementById('status').textContent='Wrong Transform Child'">Apply</button>
      </div>
    </div>

    <!-- Modal B sits at root z-index:5 > 0 and contains nested .modal + Tailwind hidden md:block button -->
    <div role="dialog" aria-modal="true" style="position:fixed;top:20px;left:20px;z-index:5;width:260px;height:160px;background:#fff">
      <div class="hidden md:block">
        <button onclick="document.getElementById('status').textContent='Stacked Top Clicked';document.querySelectorAll('[role=dialog]').forEach(d=>d.style.display='none');document.getElementById('native-dlg').showModal();">Apply</button>
      </div>
      <div class="modal" style="width:120px;height:40px"><span>Inner Modal Chrome</span></div>
    </div>

    <!-- Native top-layer modal opening a real open Shadow DOM portal -->
    <dialog id="native-dlg">
      <button onclick="document.getElementById('native-dlg').close();window.mountShadowPortal();">Finish</button>
    </dialog>

    <div id="shadow-host"></div>
    <script>
      window.mountShadowPortal = () => {
        const host = document.getElementById('shadow-host');
        const sr = host.attachShadow({ mode: 'open' });
        sr.innerHTML = \`
          <div role="dialog" aria-modal="true" style="position:fixed;top:30px;left:30px;width:300px;height:180px;background:#fff;z-index:20">
            <label for="s-code">Shadow Code</label>
            <input id="s-code" />
            <input aria-label="Shadow A" />
            <input aria-label="Shadow B" />
            <button onclick="document.getElementById('status').textContent='Shadow:' + this.getRootNode().getElementById('s-code').value;document.getElementById('shadow-host').remove();">Shadow Confirm</button>
          </div>
        \`;
      };
    </script>
  </body></html>`;

  const tmpDir = makeTempDir();
  const tmpDirIso = makeTempDir();
  const prevShadow = process.env.QA_SHADOW_CODE;
  process.env.QA_SHADOW_CODE = 'ShadowTok_778!';

  try {
    await withLocalServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    }, async (baseUrl) => {
      const report = await executeTestPlan({
        name: 'Extended Modal Edge Cases',
        targetUrl: baseUrl,
        planSteps: [
          { type: 'action', description: 'click "Apply"' },
          { type: 'action', description: 'click "Finish"' },
          { type: 'action', description: 'fill "${QA_SHADOW_CODE}" into "Shadow Code"' },
          { type: 'action', description: 'click "Shadow Confirm"' },
          { type: 'assertion', description: 'verify "Shadow:ShadowTok_778!" is visible' }
        ]
      }, { artifactDir: tmpDir });

      assert.strictEqual(report.status, 'passed', `Expected transform/nested/native/Shadow DOM modals to pass: ${JSON.stringify(report.steps)}`);

      // Assert blocking modal isolation prevents matching occluded background text in assert-visible
      const isoReport = await executeTestPlan({
        name: 'Blocking Modal Assert Isolation',
        targetUrl: baseUrl,
        planSteps: [
          { type: 'assertion', description: 'verify "Background Secret Banner" is visible' }
        ]
      }, { artifactDir: tmpDirIso });

      assert.strictEqual(isoReport.status, 'failed', 'Blocking modal must isolate assert-visible from background banner');
      const isoCtxPath = isoReport.artifacts.find((p) => p.endsWith('failure-step-1-context.json'));
      const isoCtx = JSON.parse(fs.readFileSync(isoCtxPath, 'utf8'));
      assert.strictEqual(isoCtx.scopedToModal, true);
      assert(isoCtx.elements.buttons.some((b) => b.text === 'Apply'), 'Nested .modal must not drop outer dialog Apply button');
    });
  } finally {
    if (prevShadow === undefined) delete process.env.QA_SHADOW_CODE; else process.env.QA_SHADOW_CODE = prevShadow;
    cleanupTempDir(tmpDir);
    cleanupTempDir(tmpDirIso);
  }
});

// ---------------------------------------------------------------------------
// 9. URL Assertions, Empty-String Fill, Unquoted Env, Pre-Loop Redaction & Percent-Encoded Secrets
// ---------------------------------------------------------------------------
await runAsyncTest('V21-09: Supports verify URL contains, empty fill "", unquoted env, & redacts pre-loop URL-encoded secrets', async () => {
  const htmlDashboard = `<!doctype html><html><body>
    <h1>Member Area</h1>
    <label for="e">Email</label>
    <input id="e" value="prefilled@old.test" />
    <div id="cleared-msg"></div>
    <button onclick="document.getElementById('cleared-msg').textContent='Val=' + document.getElementById('e').value">CheckVal</button>
  </body></html>`;

  const tmpDir1 = makeTempDir();
  const tmpDir2 = makeTempDir();
  const prevEmail = process.env.QA_TEST_MAIL;
  const prevEnc = process.env.QA_ENCODED_PASS;
  process.env.QA_TEST_MAIL = 'unquoted@example.test';
  process.env.QA_ENCODED_PASS = 'My@Pass#1 23';

  try {
    await withLocalServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(htmlDashboard);
    }, async (baseUrl) => {
      const report = await executeTestPlan({
        name: 'URL + Empty Fill + Unquoted Env',
        targetUrl: `${baseUrl}/dashboard`,
        planSteps: [
          { type: 'assertion', description: 'verify URL contains "/dashboard"' },
          { type: 'assertion', description: 'verify URL should not contain "/login"' },
          { type: 'action', description: 'go to "/settings?tab=2"' },
          { type: 'assertion', description: 'verify URL contains "tab=2"' },
          { type: 'action', description: 'fill "" into "Email"' },
          { type: 'action', description: 'click "CheckVal"' },
          { type: 'assertion', description: 'verify "Val=" is visible' },
          { type: 'action', description: 'fill ${QA_TEST_MAIL} into "Email"' },
          { type: 'action', description: 'click "CheckVal"' },
          { type: 'assertion', description: 'verify "Val=unquoted@example.test" is visible' }
        ]
      }, { artifactDir: tmpDir1 });

      assert.strictEqual(report.status, 'passed', `Expected URL/empty-fill/unquoted steps to pass: ${JSON.stringify(report.steps)}`);

      let preLoopErr = '';
      try {
        await executeTestPlan({
          name: 'Pre-loop Secret Leak Check',
          targetUrl: 'http://user:${QA_ENCODED_PASS}@127.0.0.1:9/',
          planSteps: [{ type: 'assertion', description: 'verify "Hi" is visible' }]
        }, { artifactDir: tmpDir2 });
      } catch (e) {
        preLoopErr = e.message;
      }
      assert(preLoopErr.length > 0, 'Connection refused on port 9 should fail');
      assert(!preLoopErr.includes('My@Pass#1 23'), 'Raw secret must not appear in pre-loop error');
      assert(!preLoopErr.includes('My%40Pass%231%2023'), 'Percent-encoded secret must not appear in pre-loop error');
    });
  } finally {
    if (prevEmail === undefined) delete process.env.QA_TEST_MAIL; else process.env.QA_TEST_MAIL = prevEmail;
    if (prevEnc === undefined) delete process.env.QA_ENCODED_PASS; else process.env.QA_ENCODED_PASS = prevEnc;
    cleanupTempDir(tmpDir1);
    cleanupTempDir(tmpDir2);
  }
});

// ---------------------------------------------------------------------------
// 10. Full Realistic New-User CLI Workflow End-to-End
// ---------------------------------------------------------------------------
await runAsyncTest('V21-10: Realistic new-user CLI flow (bootstrap, discover w/ a11y, compile, run happy & failing modal, md report)', async () => {
  const saasHtml = `<!doctype html><html><head><title>SaaS Demo</title><style>
    header { position:fixed;top:0;left:0;right:0;height:48px;background:#111;color:#fff; }
    main { margin-top:64px; }
    .modal-portal { position:fixed;top:70px;left:70px;width:320px;padding:16px;background:#fff;z-index:40; }
  </style></head><body>
    <header><a href="/pricing">Pricing</a><button onclick="document.getElementById('login-dlg').style.display='block'">Sign In</button><button onclick="document.getElementById('set-dlg').style.display='block'">Settings</button></header>
    <main>
      <div id="banner">Guest</div>
      <label for="t-in">Task</label><input id="t-in" />
      <label for="prio">Priority</label><select id="prio"><option value="p0">Critical P0</option><option value="p1">Normal P1</option></select>
      <label><input type="checkbox" id="chk" /> Notify</label>
      <button onclick="const d=document.createElement('div');d.textContent=document.getElementById('t-in').value+':'+document.getElementById('prio').value+':'+document.getElementById('chk').checked;document.body.appendChild(d)">Add Task</button>
    </main>
    <div role="dialog" style="opacity:0;position:fixed;width:100px;height:100px"><button>Sign In</button><button>Stale Portal Button</button></div>
    <div id="login-dlg" role="dialog" aria-modal="true" class="modal-portal" style="display:none">
      <label for="le">Email</label><input id="le" type="email" />
      <label for="lp">Password</label><input id="lp" type="password" />
      <button onclick="if(document.getElementById('le').value==='newuser@demo.test'&&document.getElementById('lp').value==='DemoPass_8821!'){document.getElementById('banner').textContent='Logged in';document.getElementById('login-dlg').style.display='none';window.history.pushState({},'','/dashboard');}">Sign In</button>
    </div>
    <div id="set-dlg" role="dialog" aria-modal="true" class="modal-portal" style="display:none;z-index:60">
      <button>Save Prefs</button><a href="/billing">Billing</a>
    </div>
  </body></html>`;

  const cliWorkDir = makeTempDir('auto-qa-cli-e2e-');
  try {
    await withLocalServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(saasHtml);
    }, async (baseUrl) => {
      await execFileAsync(process.execPath, [CLI_PATH, 'bootstrap', '.', '-u', baseUrl], { cwd: cliWorkDir });
      assert(fs.existsSync(path.join(cliWorkDir, 'auto_qa_tests/tmp/config.json')));

      await execFileAsync(process.execPath, [CLI_PATH, 'discover', baseUrl, '-o', 'auto_qa_tests/tmp/surface.json'], { cwd: cliWorkDir });
      const surface = JSON.parse(fs.readFileSync(path.join(cliWorkDir, 'auto_qa_tests/tmp/surface.json'), 'utf8'));
      assert(surface.accessibilityTree && String(surface.accessibilityTree).length > 0, 'discover must return non-null ariaSnapshot');
      assert(!surface.elements.buttons.some((b) => b.text === 'Stale Portal Button'), 'discover must ignore opacity:0 stale portal buttons');

      const cliEnv = { ...process.env, QA_EMAIL: 'newuser@demo.test', QA_PASSWORD: 'DemoPass_8821!', QA_EMAIL_FIELD: 'Email', QA_PRIORITY_FIELD: 'Priority' };
      const happyPlanPath = path.join(cliWorkDir, 'auto_qa_tests/happy.json');
      fs.writeFileSync(happyPlanPath, JSON.stringify({
        name: 'CLI E2E Flow',
        targetUrl: baseUrl,
        planSteps: [
          { type: 'action', description: 'click "Sign In"' },
          { type: 'action', description: 'fill "${QA_EMAIL}" into "${QA_EMAIL_FIELD}"' },
          { type: 'action', description: 'fill "${QA_PASSWORD}" into "Password"' },
          { type: 'action', description: 'click "Sign In"' },
          { type: 'assertion', description: 'verify URL contains "/dashboard"' },
          { type: 'action', description: 'fill "Audit Check" into "Task"' },
          { type: 'action', description: 'select "Normal P1" from "${QA_PRIORITY_FIELD}"' },
          { type: 'action', description: 'check "Notify"' },
          { type: 'action', description: 'click "Add Task"' },
          { type: 'assertion', description: 'verify "Audit Check:p1:true" is visible' }
        ]
      }));

      const { stdout: happyOut } = await execFileAsync(process.execPath, [CLI_PATH, 'run', happyPlanPath], { cwd: cliWorkDir, env: cliEnv });
      assert(happyOut.includes('PASSED'));
      assert(!happyOut.includes('DemoPass_8821!') && !happyOut.includes('newuser@demo.test'));

      const mdReport = fs.readFileSync(path.join(cliWorkDir, 'auto_qa_tests/auto-qa-test-report.md'), 'utf8');
      assert(!mdReport.includes('DemoPass_8821!') && !mdReport.includes('newuser@demo.test'));

      await execFileAsync(process.execPath, [CLI_PATH, 'compile', happyPlanPath, '-o', path.join(cliWorkDir, 'happy.spec.ts')], { cwd: cliWorkDir });
      assert(fs.readFileSync(path.join(cliWorkDir, 'happy.spec.ts'), 'utf8').includes('function requireEnv('));

      const failPlanPath = path.join(cliWorkDir, 'auto_qa_tests/fail.json');
      fs.writeFileSync(failPlanPath, JSON.stringify({
        name: 'CLI Modal Fail',
        targetUrl: baseUrl,
        planSteps: [
          { type: 'action', description: 'click "Settings"' },
          { type: 'action', description: 'click "Nonexistent Setting"' }
        ]
      }));
      let exitCode = 0;
      try {
        await execFileAsync(process.execPath, [CLI_PATH, 'run', failPlanPath, '-o', './custom_out'], { cwd: cliWorkDir });
      } catch (e) {
        exitCode = e.code;
      }
      assert.strictEqual(exitCode, 1);
      assert(fs.existsSync(path.join(cliWorkDir, 'custom_out/auto-qa-test-report.md')), 'Custom -o report must live inside custom dir');
      const customCtx = JSON.parse(fs.readFileSync(path.join(cliWorkDir, 'custom_out/failure-step-2-context.json'), 'utf8'));
      assert.strictEqual(customCtx.scopedToModal, true);
      assert(customCtx.elements.buttons.some((b) => b.text === 'Save Prefs'));
    });
  } finally {
    cleanupTempDir(cliWorkDir);
  }
});

// ---------------------------------------------------------------------------
// 11. Live Stdio MCP JSON-RPC 2.0 E2E, Prefix Allowlist, Zero Stdout Corruption & EOF Drain
// ---------------------------------------------------------------------------
await runAsyncTest('V21-11: Live Stdio MCP executes full workflow, enforces default env prefixes & drains stdin EOF cleanly', async () => {
  const html = `<!doctype html><html><head><title>MCP Demo</title></head><body>
    <button onclick="document.getElementById('m').style.display='block'">Open Modal</button>
    <div id="m" role="dialog" aria-modal="true" style="display:none;position:fixed;top:20px;left:20px;width:300px;height:200px;background:#fff">
      <input placeholder="Secret Note" />
      <button>Modal OK</button>
    </div>
  </body></html>`;

  const mcpWorkDir = makeTempDir('auto-qa-mcp-e2e-');
  const mcpEnv = { ...process.env, QA_MCP_SECRET: 'McpSecretVal_5544!', AWS_SECRET_ACCESS_KEY: 'DisallowedSecret_000' };
  let mcpProc = null;

  try {
    await withLocalServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    }, async (baseUrl) => {
      mcpProc = spawn(process.execPath, [MCP_PATH], { env: mcpEnv, stdio: ['pipe', 'pipe', 'pipe'] });
      const responses = new Map();
      const nonJsonStdoutLines = [];
      let buf = '';

      mcpProc.stdout.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && msg.id !== null) responses.set(msg.id, msg);
          } catch (_) {
            nonJsonStdoutLines.push(line);
          }
        }
      });

      const rpc = (id, method, params = {}) => new Promise((resolve, reject) => {
        mcpProc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        const started = Date.now();
        const iv = setInterval(() => {
          if (responses.has(id)) {
            clearInterval(iv);
            resolve(responses.get(id));
          } else if (Date.now() - started > 25000) {
            clearInterval(iv);
            reject(new Error(`MCP RPC timeout on ${method}`));
          }
        }, 40);
      });

      const initRes = await rpc(1, 'initialize');
      assert.strictEqual(initRes.result.serverInfo.version, '2.1.0');
      const listRes = await rpc(2, 'tools/list');
      assert.strictEqual(listRes.result.tools.length, 8);

      const sumRes = await rpc(3, 'tools/call', { name: 'auto_qa_generate_code_summary', arguments: { projectPath: mcpWorkDir, url: baseUrl } });
      assert(!sumRes.error, `code summary failed: ${JSON.stringify(sumRes.error)}`);

      await rpc(4, 'tools/call', {
        name: 'auto_qa_generate_frontend_test_plan',
        arguments: {
          projectPath: mcpWorkDir,
          name: 'MCP Failure Flow',
          planSteps: [
            { type: 'action', description: 'click "Open Modal"' },
            { type: 'action', description: 'fill "${QA_MCP_SECRET}" into "Secret Note"' },
            { type: 'action', description: 'click "Missing Modal Button"' }
          ]
        }
      });

      const execRes = await rpc(5, 'tools/call', { name: 'auto_qa_execute_and_heal', arguments: { projectPath: mcpWorkDir, baseUrl } });
      const execRaw = execRes.result.content[0].text;
      const execData = JSON.parse(execRaw);
      assert.strictEqual(execData.status, 'failed');
      assert(execData.contextFile && execData.contextFile.endsWith('failure-step-3-context.json'), 'MCP must expose contextFile');
      assert(execData.defectFixRecommendation.includes('failure-step-3-context.json'));
      assert(!execRaw.includes('McpSecretVal_5544!'), 'MCP response must never leak secret value');

      const freshnessArgs = { projectPath: mcpWorkDir, contextFilePath: execData.contextFile };
      const checkSnapshot = async id => {
        const response = await rpc(id, 'tools/call', { name: 'auto_qa_check_context_freshness', arguments: freshnessArgs });
        return JSON.parse(response.result.content[0].text);
      };
      assert.equal((await checkSnapshot(20)).stale, false);
      const edited = path.join(mcpWorkDir, 'app.js');
      fs.writeFileSync(edited, '// app edit');
      const later = new Date(Date.now() + 2000);
      fs.utimesSync(edited, later, later);
      assert.match((await checkSnapshot(21)).warning, /stale failure context/i);

      const compileRes = await rpc(6, 'tools/call', {
        name: 'auto_qa_compile_to_playwright',
        arguments: {
          projectPath: mcpWorkDir,
          planPath: 'auto_qa_tests/auto_qa_frontend_test_plan.json',
          outputPath: 'tests/e2e/flow.spec.ts'
        }
      });
      assert(!compileRes.error, `MCP compile failed: ${JSON.stringify(compileRes.error)}`);
      assert(fs.existsSync(path.join(mcpWorkDir, 'tests/e2e/flow.spec.ts')));

      // Disallowed AWS_SECRET_ACCESS_KEY must be rejected under default MCP prefix policy
      await rpc(7, 'tools/call', {
        name: 'auto_qa_generate_frontend_test_plan',
        arguments: {
          projectPath: mcpWorkDir,
          name: 'Disallowed Env',
          planSteps: [{ type: 'action', description: 'fill "${AWS_SECRET_ACCESS_KEY}" into "Secret Note"' }]
        }
      });
      const evilCompileEnv = await rpc(8, 'tools/call', {
        name: 'auto_qa_compile_to_playwright',
        arguments: { projectPath: mcpWorkDir, planPath: 'auto_qa_tests/auto_qa_frontend_test_plan.json' }
      });
      assert(evilCompileEnv.error && evilCompileEnv.error.message.includes('Security Violation'));

      const evilExecEnv = await rpc(9, 'tools/call', {
        name: 'auto_qa_execute_and_heal',
        arguments: { projectPath: mcpWorkDir, baseUrl }
      });
      assert.strictEqual(JSON.parse(evilExecEnv.result.content[0].text).status, 'failed');
      assert(JSON.parse(evilExecEnv.result.content[0].text).defectFixRecommendation.includes('not permitted by prefix allowlist'));

      const evilRead = await rpc(10, 'tools/call', {
        name: 'auto_qa_compile_to_playwright',
        arguments: { projectPath: mcpWorkDir, planPath: path.join(REPO_ROOT, 'package.json') }
      });
      assert(evilRead.error && evilRead.error.message.includes('Security Violation'));

      const evilWrite = await rpc(11, 'tools/call', {
        name: 'auto_qa_compile_to_playwright',
        arguments: { projectPath: mcpWorkDir, planPath: 'auto_qa_tests/auto_qa_frontend_test_plan.json', outputPath: 'package.json' }
      });
      assert(evilWrite.error && evilWrite.error.message.includes('Security Violation'));

      // Stdin EOF graceful drain: send browser-backed call and immediately close stdin before completion
      const exitPromise = new Promise((resolve) => mcpProc.once('exit', (code) => resolve(code)));
      mcpProc.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 12,
          method: 'tools/call',
          params: { name: 'auto_qa_generate_code_summary', arguments: { projectPath: mcpWorkDir, url: baseUrl } }
        }) + '\n'
      );
      mcpProc.stdin.end();
      const exitCode = await exitPromise;
      assert.strictEqual(exitCode, 0, 'MCP process should exit cleanly with 0 after draining');
      assert(responses.has(12) && !responses.get(12).error, 'In-flight RPC response must flush cleanly before stdin EOF exit');

      assert.strictEqual(
        nonJsonStdoutLines.length,
        0,
        `MCP stdout must contain ZERO non-JSON lines, got: ${nonJsonStdoutLines.slice(0, 3).join(' | ')}`
      );
    });
  } finally {
    if (mcpProc && mcpProc.exitCode === null) mcpProc.kill();
    cleanupTempDir(mcpWorkDir);
  }
});

// ---------------------------------------------------------------------------
// 12. Large-DOM Accessibility Snapshot Size Cap (16 KB)
// ---------------------------------------------------------------------------
await runAsyncTest('V21-12: Caps huge failure accessibilitySnapshot to <= 16KB + truncated flag', async () => {
  const bigButtons = Array.from(
    { length: 400 },
    (_, i) => `<button type="button">Action Row Control Item Number ${i + 1} For Enterprise Grid View</button>`
  ).join('\n');
  const html = `<!doctype html><html><head><title>Large DOM</title></head><body>${bigButtons}</body></html>`;

  const tmpDir = makeTempDir();
  try {
    await withLocalServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    }, async (baseUrl) => {
      const report = await executeTestPlan({
        name: 'Large DOM Cap Test',
        targetUrl: baseUrl,
        planSteps: [{ type: 'action', description: 'click "Nonexistent Button"' }]
      }, { artifactDir: tmpDir });

      assert.strictEqual(report.status, 'failed');
      const ctxPath = report.artifacts.find((p) => p.endsWith('failure-step-1-context.json'));
      const ctx = JSON.parse(fs.readFileSync(ctxPath, 'utf8'));

      assert.strictEqual(ctx.accessibilitySnapshotTruncated, true, 'Large a11y snapshot must be truncated');
      assert(
        typeof ctx.accessibilitySnapshot === 'string' && ctx.accessibilitySnapshot.length <= 16450,
        `Expected truncated snapshot <= 16450 chars, got ${ctx.accessibilitySnapshot?.length}`
      );
    });
  } finally {
    cleanupTempDir(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// 13. Live Multi-Hop HTTP 3xx & WebSocket SSRF Blocking, Pre-Redaction Truncation & Console Cap
// ---------------------------------------------------------------------------
await runAsyncTest('V21-13: Blocks multi-hop 3xx IMDS redirects & ws:// IMDS, prevents pre-redaction leak & caps console errors', async () => {
  const secretToken = 'BoundarySecret_774411!';
  const padTitle = 'T'.repeat(195) + secretToken;
  const padHref = '/cb?pad=' + 'p'.repeat(492) + '&tok=' + secretToken;
  const html = `<!doctype html><html><head><title>${padTitle}</title></head><body>
    <a href="${padHref}">Boundary Link</a>
    <label for="s">Token</label><input id="s" />
    <div id="ws-state">init</div>
    <script>
      for (let i = 0; i < 150; i++) console.error('ERR_SPAM_' + i + '_' + ${JSON.stringify(secretToken)});
      try {
        const ws = new WebSocket('ws://169.254.169.254:80/');
        ws.onclose = () => { document.getElementById('ws-state').textContent = 'WS_BLOCKED'; };
        ws.onerror = () => { document.getElementById('ws-state').textContent = 'WS_BLOCKED'; };
      } catch (_) {}
    </script>
  </body></html>`;

  const tmpDir1 = makeTempDir();
  const tmpDir2 = makeTempDir();
  const prevSec = process.env.QA_BOUNDARY_SEC;
  process.env.QA_BOUNDARY_SEC = secretToken;

  try {
    await withLocalServer((req, res) => {
      if (req.url === '/hop1') {
        res.writeHead(302, { Location: '/hop2' });
        res.end();
      } else if (req.url === '/hop2') {
        res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
      }
    }, async (baseUrl) => {
      // Part A: pre-redaction truncation safety, WS IMDS close, & console error cap
      const report = await executeTestPlan({
        name: 'Boundary Redaction + Console Cap',
        targetUrl: baseUrl,
        planSteps: [
          { type: 'action', description: 'fill "${QA_BOUNDARY_SEC}" into "Token"' },
          { type: 'assertion', description: 'verify "WS_BLOCKED" is visible' },
          { type: 'action', description: 'click "Missing After WS"' }
        ]
      }, { artifactDir: tmpDir1 });

      assert.strictEqual(report.status, 'failed');
      assert.strictEqual(report.consoleErrors.length, 100, 'Console errors must be capped at 100');
      assert.strictEqual(report.consoleErrorsTruncated, 50, 'Truncated console error count must equal 50');

      const ctxPath = report.artifacts.find((p) => p.endsWith('failure-step-3-context.json'));
      const ctxRaw = fs.readFileSync(ctxPath, 'utf8');
      assert(!ctxRaw.includes('BoundarySecret'), 'Not even truncated prefix of BoundarySecret may leak in context JSON');
      assert(!ctxRaw.includes(secretToken), 'Full secret must not appear in context JSON');

      // Part B: 2-hop HTTP 302 -> HTTP 302 -> http://169.254.169.254/ must be blocked mid-chain
      const redirReport = await executeTestPlan({
        name: 'Multi-Hop IMDS Redirect Block',
        targetUrl: baseUrl,
        planSteps: [{ type: 'action', description: 'navigate to /hop1' }]
      }, { artifactDir: tmpDir2 });

      assert.strictEqual(redirReport.status, 'failed', 'Multi-hop redirect to 169.254.169.254 must be blocked');
      assert.match(redirReport.steps[0].error, /ERR_BLOCKED_BY_CLIENT|blocked/i);
    });
  } finally {
    if (prevSec === undefined) delete process.env.QA_BOUNDARY_SEC; else process.env.QA_BOUNDARY_SEC = prevSec;
    cleanupTempDir(tmpDir1);
    cleanupTempDir(tmpDir2);
  }
});

await runAsyncTest('V21-14: Discovery, modal selection and failure capture agree on rendered controls', async () => {
  const dir = makeTempDir();
  try {
    await withLocalServer((req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!doctype html><body>
        ${req.url === '/legacy' ? '<script>delete Element.prototype.checkVisibility</script>' : ''}
        <button>Background</button>
        <div id="host" role="dialog" aria-modal="true" style="display:contents"></div>
        <section style="position:absolute;top:100000px;content-visibility:auto;contain-intrinsic-size:300px">
          <div role="dialog" id="far"><button>Far away</button></div>
        </section>
        <div role="dialog" id="empty" style="display:contents"><button style="opacity:0">Transparent</button></div>
        <script>
          const root = host.attachShadow({mode:'open'});
          root.innerHTML = '<div style="display:contents"><button style="position:fixed">Fixed</button></div>' +
            '<div inert id="inertHost"></div><div aria-hidden="true" id="ariaHost"></div>' +
            '<section style="position:absolute;top:90000px;content-visibility:auto;contain-intrinsic-size:300px"><button>Deferred control</button></section>' +
            '<section style="display:none"><button>Unmounted</button></section>';
          for (const id of ['inertHost','ariaHost']) root.getElementById(id).attachShadow({mode:'open'}).innerHTML =
            '<button>' + id + '</button>';
        </script>`);
    }, async url => {
      for (const route of ['/', '/legacy']) {
        const surface = await discoverInteractiveElements(url + route);
        const buttons = surface.elements.buttons.map(b => b.text);
        assert(buttons.includes('Fixed'));
        for (const hidden of ['inertHost', 'ariaHost', 'Transparent', 'Unmounted']) assert(!buttons.includes(hidden), hidden);
        const modals = Object.fromEntries(surface.elements.modals.map(m => [m.id, m.visible]));
        assert.equal(modals.host, true);
        assert.equal(modals.empty, false);
        if (route === '/') {
          assert.equal(modals.far, false);
          assert(!buttons.includes('Far away'));
          assert(!buttons.includes('Deferred control'));
        }
      }
      const report = await executeTestPlan({
        targetUrl: url, planSteps: [
          { type: 'action', description: 'click "Fixed"' },
          { type: 'action', description: 'click "Background"' }
        ]
      }, { artifactDir: dir, projectPath: dir });
      assert.deepEqual(report.steps.map(s => s.status), ['passed', 'failed']);
      const snapshot = JSON.parse(fs.readFileSync(path.join(dir, 'failure-step-2-context.json')));
      assert.equal(snapshot.scopedToModal, true);
      assert.equal(snapshot.gitHead, null);
      assert.deepEqual(snapshot.elements.buttons.map(b => b.text), ['Fixed']);
    });
  } finally { cleanupTempDir(dir); }
});

await runAsyncTest('V21-15: Freshness ignores generated files and reports source and Git changes', async () => {
  const dir = makeTempDir();
  try {
    const stamp = new Date('2025-04-01T12:00:00Z');
    const newer = new Date(stamp.getTime() + 10000);
    const source = path.join(dir, 'app.ts');
    fs.writeFileSync(source, '// source');
    fs.utimesSync(source, stamp, stamp);
    const context = path.join(dir, 'failure-step-2-context.json');
    fs.writeFileSync(context, JSON.stringify({ capturedAt: stamp.toISOString() }));
    for (const folder of ['.git', 'nested/node_modules', 'testsprite_tests', 'auto_qa_tests', 'artifacts']) {
      fs.mkdirSync(path.join(dir, folder), { recursive: true });
      fs.writeFileSync(path.join(dir, folder, 'recent.json'), '{}');
    }
    for (const name of ['run-final-123.png', 'test-report-123.json', 'auto-qa-test-report.md']) {
      fs.writeFileSync(path.join(dir, name), '');
    }
    assert.deepEqual(await checkFailureContextFreshness(context, dir), {
      stale: false, reason: null, warning: null, capturedAt: stamp.toISOString(),
      latestSourceChangeAt: stamp.toISOString(), gitHeadChanged: false
    });
    fs.utimesSync(source, newer, newer);
    const stale = await checkFailureContextFreshness(context, dir);
    assert.equal(stale.stale, true);
    assert.equal(stale.latestSourceChangeAt, newer.toISOString());
    assert.match(stale.warning, /rerun/i);
    const cli = await execFileAsync(process.execPath, [CLI_PATH, 'check-context-freshness', path.basename(context), '-p', dir]);
    assert.deepEqual(JSON.parse(cli.stdout), stale);
    assert(cli.stderr.includes(stale.warning));

    // Check SHA drift even when every project file predates capture, if this checkout has Git metadata.
    let head;
    try { head = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT })).stdout.trim(); } catch {}
    if (head) {
      const capturedAt = '2099-01-01T00:00:00Z';
      fs.writeFileSync(context, JSON.stringify({ capturedAt, gitHead: head }));
      assert.equal((await checkFailureContextFreshness(context, REPO_ROOT)).stale, false);
      fs.writeFileSync(context, JSON.stringify({ capturedAt, gitHead: '0'.repeat(40) }));
      const drift = await checkFailureContextFreshness(context, REPO_ROOT);
      assert.equal(drift.gitHeadChanged, true);
      assert.match(drift.warning, /Git HEAD changed/);
    }
    fs.writeFileSync(context, '{}');
    await assert.rejects(checkFailureContextFreshness(context, dir), /capturedAt/);
  } finally { cleanupTempDir(dir); }
});

await runAsyncTest('V21-16: Normalizes only trailing counters and preserves non-counter text', () => {
  for (const [input, expected] of [
    ['Cart (1)', 'Cart'], ['Inbox 12', 'Inbox'], ['Updates [12]', 'Updates'],
    ['Notifications (99+)', 'Notifications'], ['通知 • 4', '通知'], ['  My  Inbox  4 ', 'My Inbox'],
    ['H2', 'H2'], ['1', '1'], ['Version 2 notes', 'Version 2 notes'], ['Cart (old)', 'Cart (old)']
  ]) assert.equal(normalizeDynamicLabel(input), expected);
});

await runAsyncTest('V21-17: Badge fallback clicks changed labels within a blocking modal and preserves exact and substring precedence', async () => {
  const dir = makeTempDir();
  try {
    await withLocalServer((req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<button>Outside (7)</button><div role="dialog" aria-modal="true">
        <div aria-hidden="true"><button>Cart (6)</button></div>
        <button onclick="this.textContent='Cart passed'">Cart (2)</button>
        <span id="notice">Notifications (14)</span><button aria-labelledby="notice" onclick="notice.textContent='Notice passed'"></button>
        <button>Orders (5)</button><button onclick="this.textContent='Exact passed'">Orders (4)</button>
        <button>Tasks (5)</button><button onclick="this.textContent='Partial passed'">Open Tasks (4) now</button>
        <button>7 (2)</button><button>X (2)</button><button>2</button></div>`);
    }, async url => {
      const steps = [
        ['action', 'click "Cart (1)"'], ['assertion', 'verify "Cart passed" is visible'],
        ['action', 'click "Notifications (4)"'], ['assertion', 'verify "Notice passed" is visible'],
        ['action', 'click "Orders (4)"'], ['assertion', 'verify "Exact passed" is visible'],
        ['action', 'click "Tasks (4)"'], ['assertion', 'verify "Partial passed" is visible'],
        ['assertion', 'verify "Outside (9)" is not visible'],
        ['assertion', 'verify "7 (99)" is not visible'], ['assertion', 'verify "X (5)" is not visible'],
        ['action', 'click "1"']
      ];
      const report = await executeTestPlan({
        targetUrl: url, planSteps: steps.map(([type, description]) => ({ type, description }))
      }, { artifactDir: dir });
      assert.equal(report.steps.length, steps.length, JSON.stringify(report.steps));
      assert(report.steps.slice(0, -1).every(s => s.status === 'passed'));
      assert.match(report.steps.at(-1).error, /could not be resolved/);
    });
  } finally { cleanupTempDir(dir); }
});

console.log('\n======================================================');
console.log(`v2.1.0 Feature Summary: ${passedTests}/${totalTests} Tests Passed`);
console.log('======================================================\n');

if (passedTests !== totalTests) {
  process.exit(1);
}
