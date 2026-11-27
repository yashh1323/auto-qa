#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { writeOutput } from './write-output.js';
import { executeTestPlan, closeAllBrowsers, checkFailureContextFreshness } from './executor.js';
import { discoverInteractiveElements, closeAllDiscoverBrowsers } from './discover.js';
import { compilePlanToPlaywright } from './compiler.js';
import { getAllowedEnvPrefixesFromEnv } from './env-utils.js';
import { assertValidHttpUrl, sanitizeMdCell, toRelativeArtifactLink } from './url-utils.js';

const TEST_DIR_NAME = 'auto_qa_tests';
const MCP_DEFAULT_ENV_PREFIXES = ['QA_', 'AUTO_QA_', 'TEST_'];
const stderrLog = (...args) => process.stderr.write(args.map((a) => String(a ?? '')).join(' ') + '\n');

let browserQueue = Promise.resolve();
function enqueueBrowserTask(fn) {
  const next = browserQueue.then(fn, fn);
  browserQueue = next.catch(() => {});
  return next;
}

function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

function ensureDirectory(dir, confinementRoot = null) {
  const safeDir = confinementRoot ? assertInsideDirectory(dir, confinementRoot) : dir;
  if (!fs.existsSync(safeDir)) {
    fs.mkdirSync(safeDir, { recursive: true });
  }
}

/**
 * Asserts that a target file path resides strictly within an allowed root directory.
 * Prevents directory traversal attacks via relative paths (`../`), absolute path overrides,
 * cross-drive jumps, live symlinks/junctions, and dangling symlink/junction ancestors.
 */
export function assertInsideDirectory(targetPath, allowedRoot) {
  const resolvedRoot = path.resolve(allowedRoot);
  const resolvedTarget = path.resolve(resolvedRoot, targetPath);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error(`Security Violation: Path "${targetPath}" escapes allowed directory "${allowedRoot}".`);
  }

  // Component-by-component lstat walk when allowedRoot exists on disk
  if (lstatOrNull(resolvedRoot)) {
    const realRoot = fs.realpathSync(resolvedRoot);
    const segments = relative ? relative.split(path.sep).filter(Boolean) : [];
    let cur = resolvedRoot;

    for (const seg of segments) {
      cur = path.join(cur, seg);
      const st = lstatOrNull(cur);
      if (!st) {
        break;
      }

      if (st.isSymbolicLink()) {
        if (cur === resolvedTarget) {
          throw new Error(
            `Security Violation: Symlink target "${targetPath}" is not permitted inside "${allowedRoot}".`
          );
        }
        let realCur;
        try {
          realCur = fs.realpathSync(cur);
        } catch (_) {
          throw new Error(
            `Security Violation: Dangling symlink/junction in "${targetPath}" is not permitted inside "${allowedRoot}".`
          );
        }
        const curRel = path.relative(realRoot, realCur);
        if (curRel === '..' || curRel.startsWith('..' + path.sep) || path.isAbsolute(curRel)) {
          throw new Error(
            `Security Violation: Symlink ancestor for "${targetPath}" escapes allowed directory "${allowedRoot}".`
          );
        }
      } else {
        const realCur = fs.realpathSync(cur);
        const curRel = path.relative(realRoot, realCur);
        if (curRel === '..' || curRel.startsWith('..' + path.sep) || path.isAbsolute(curRel)) {
          throw new Error(
            `Security Violation: Resolved target "${targetPath}" escapes allowed directory "${allowedRoot}".`
          );
        }
      }
    }
  }

  return resolvedTarget;
}

function yamlString(val) {
  return JSON.stringify(String(val ?? '')).replace(
    /[\x7f-\x9f\u2028\u2029]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}

/**
 * Formats discovered interactive UI elements into valid YAML 1.2 mappings.
 */
export function formatCodeSummaryYaml(discoveryResult) {
  const buttons = discoveryResult?.elements?.buttons || [];
  const inputs = discoveryResult?.elements?.inputs || [];
  const links = discoveryResult?.elements?.links || [];

  const lines = [
    '# Auto-QA Discovered Code Summary',
    `url: ${yamlString(discoveryResult?.url || '')}`,
    `title: ${yamlString(discoveryResult?.title || '')}`,
    `scanned_at: ${yamlString(new Date().toISOString())}`,
    buttons.length ? 'buttons:' : 'buttons: []'
  ];

  for (const b of buttons) {
    lines.push(`  - text: ${yamlString(b.text || '')}`);
    lines.push(`    tag: ${yamlString(b.tag || 'button')}`);
    lines.push(`    type: ${yamlString(b.type || 'button')}`);
    if (b.id) lines.push(`    id: ${yamlString(b.id)}`);
    if (b.ariaLabel) lines.push(`    ariaLabel: ${yamlString(b.ariaLabel)}`);
  }

  lines.push(inputs.length ? 'inputs:' : 'inputs: []');
  for (const inp of inputs) {
    lines.push(`  - label: ${yamlString(inp.label || inp.placeholder || inp.name || '')}`);
    lines.push(`    tag: ${yamlString(inp.tag || 'input')}`);
    lines.push(`    type: ${yamlString(inp.type || 'text')}`);
    if (inp.id) lines.push(`    id: ${yamlString(inp.id)}`);
    if (inp.placeholder) lines.push(`    placeholder: ${yamlString(inp.placeholder)}`);
  }

  lines.push(links.length ? 'links:' : 'links: []');
  for (const l of links) {
    lines.push(`  - text: ${yamlString(l.text || '')}`);
    lines.push(`    href: ${yamlString(l.href || '')}`);
  }

  return lines.join('\n');
}

/**
 * Resolves and validates projectPath against an optional operator-pinned AUTO_QA_WORKSPACE_ROOT.
 */
function resolveSafeProjectPath(rawProjectPath) {
  const configuredRoot = process.env.AUTO_QA_WORKSPACE_ROOT
    ? path.resolve(process.env.AUTO_QA_WORKSPACE_ROOT)
    : null;

  if (configuredRoot) {
    const candidate = rawProjectPath ? path.resolve(configuredRoot, rawProjectPath) : configuredRoot;
    return assertInsideDirectory(candidate, configuredRoot);
  }

  return rawProjectPath ? path.resolve(rawProjectPath) : process.cwd();
}

/**
 * Standard Tool Definitions conforming to Auto-QA's declarative QA pipeline
 */
const TOOLS = [
  {
    name: 'auto_qa_check_context_freshness',
    description: 'Check a failure snapshot for source changes or Git HEAD drift before patching',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string' },
        contextFilePath: { type: 'string', description: 'Failure context JSON inside the project' }
      },
      required: ['projectPath', 'contextFilePath']
    }
  },
  {
    name: 'auto_qa_bootstrap',
    description: 'Initializes the Auto-QA test configuration in auto_qa_tests/tmp/config.json with project root and base URL',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Absolute path to project root' },
        baseUrl: { type: 'string', description: 'Base URL under test (e.g. http://localhost:3000)' },
        type: { type: 'string', enum: ['frontend', 'backend'], default: 'frontend' }
      },
      required: ['projectPath']
    }
  },
  {
    name: 'auto_qa_generate_code_summary',
    description: 'Crawls live URL using headless Chromium and writes sanitized interactive buttons, inputs, and links to auto_qa_tests/tmp/code_summary.yaml',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Absolute path to project root' },
        url: { type: 'string', description: 'Target live or local website URL' }
      },
      required: ['projectPath']
    }
  },
  {
    name: 'auto_qa_generate_standardized_prd',
    description: 'Synthesizes functional requirements and user personas into standard_prd.json',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Absolute path to project root' },
        appDescription: { type: 'string', description: 'Summary of the application features or requirements' }
      },
      required: ['projectPath']
    }
  },
  {
    name: 'auto_qa_generate_frontend_test_plan',
    description: 'Generates a declarative frontend test plan (auto_qa_frontend_test_plan.json) from user journeys',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Absolute path to project root' },
        name: { type: 'string', description: 'Name of the test plan' },
        targetUrl: { type: 'string', description: 'Optional target base URL or ${ENV_VAR} placeholder' },
        planSteps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['action', 'assertion'] },
              description: { type: 'string' }
            },
            required: ['type', 'description']
          }
        }
      },
      required: ['projectPath', 'name', 'planSteps']
    }
  },
  {
    name: 'auto_qa_generate_backend_test_plan',
    description: 'Generates a structured API endpoint manifest in auto_qa_backend_test_plan.json',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Absolute path to project root' },
        name: { type: 'string', description: 'Name of the test plan' },
        endpoints: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'] },
              path: { type: 'string' },
              expectedStatus: { type: 'number' }
            },
            required: ['method', 'path', 'expectedStatus']
          }
        }
      },
      required: ['projectPath', 'name', 'endpoints']
    }
  },
  {
    name: 'auto_qa_execute_and_heal',
    description: 'Executes the declarative frontend test plan with hardened modal isolation, captures failure screenshots and failure-step-N-context.json snapshots, and writes auto-qa-test-report.md',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Absolute path to project root' },
        planFile: { type: 'string', description: 'Path to plan JSON file (confined to projectPath)' },
        baseUrl: { type: 'string', description: 'Override target base URL (supports http(s):// or ${ENV_VAR})' },
        headless: { type: 'boolean', default: true }
      },
      required: ['projectPath']
    }
  },
  {
    name: 'auto_qa_compile_to_playwright',
    description: 'Compiles a declarative intent test plan into native @playwright/test TypeScript (.spec.ts) with fail-closed requireEnv() secret lookups',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Optional project root confining both planPath and outputPath' },
        planPath: { type: 'string', description: 'Path to the plan JSON file' },
        outputPath: { type: 'string', description: 'Path to output .spec.ts file inside project root' }
      },
      required: ['planPath']
    }
  }
];

/**
 * Tool Handlers
 */
export async function handleToolCall(name, args = {}) {
  const configuredRoot = process.env.AUTO_QA_WORKSPACE_ROOT
    ? path.resolve(process.env.AUTO_QA_WORKSPACE_ROOT)
    : null;
  const allowedEnvPrefixes = getAllowedEnvPrefixesFromEnv(process.env, MCP_DEFAULT_ENV_PREFIXES);

  if (name === 'auto_qa_compile_to_playwright') {
    if (!args.planPath || typeof args.planPath !== 'string') {
      throw new Error('planPath is required.');
    }

    const rawCandidatePlan = path.resolve(args.planPath);
    let allowedRoot;
    if (args.projectPath) {
      allowedRoot = resolveSafeProjectPath(args.projectPath);
    } else if (configuredRoot) {
      allowedRoot = configuredRoot;
    } else if (path.basename(path.dirname(rawCandidatePlan)) === TEST_DIR_NAME) {
      allowedRoot = path.dirname(path.dirname(rawCandidatePlan));
    } else {
      allowedRoot = process.cwd();
    }

    const safePlanPath = assertInsideDirectory(args.planPath, allowedRoot);
    if (!safePlanPath.toLowerCase().endsWith('.json')) {
      throw new Error('Security Violation: planPath must reference a .json test plan file.');
    }
    if (!fs.existsSync(safePlanPath)) {
      throw new Error(`Plan not found: ${safePlanPath}`);
    }

    const plan = JSON.parse(fs.readFileSync(safePlanPath, 'utf8'));
    const tsCode = compilePlanToPlaywright(plan, { allowedEnvPrefixes });

    const defaultOut = path.join(path.dirname(safePlanPath), `${path.basename(safePlanPath, '.json')}.spec.ts`);
    const outPath = args.outputPath
      ? assertInsideDirectory(args.outputPath, allowedRoot)
      : assertInsideDirectory(defaultOut, allowedRoot);

    if (!/\.(?:spec|test)\.(?:ts|js)$/i.test(outPath)) {
      throw new Error('Security Violation: outputPath must end in .spec.ts, .test.ts, .spec.js, or .test.js.');
    }

    ensureDirectory(path.dirname(outPath), allowedRoot);
    writeOutput(outPath, tsCode);
    return {
      status: 'success',
      outputPath: outPath,
      codePreview: tsCode.slice(0, 500)
    };
  }

  const projectPath = resolveSafeProjectPath(args.projectPath);
  if (name === 'auto_qa_check_context_freshness') {
    if (typeof args.contextFilePath !== 'string' || !/^failure-step-\d+-context\.json$/i.test(path.basename(args.contextFilePath))) {
      throw new Error('Expected a failure-step-N-context.json file.');
    }
    const file = assertInsideDirectory(args.contextFilePath, projectPath);
    return checkFailureContextFreshness(file, projectPath);
  }
  const testDir = assertInsideDirectory(TEST_DIR_NAME, projectPath);
  const tmpDir = assertInsideDirectory('tmp', testDir);

  if (name === 'auto_qa_bootstrap') {
    ensureDirectory(tmpDir, projectPath);
    const rawBaseUrl = args.baseUrl || 'http://localhost:3000';
    const baseUrl = assertValidHttpUrl(rawBaseUrl);
    const testType = args.type || 'frontend';

    const config = {
      projectPath,
      baseUrl,
      type: testType,
      scope: 'codebase',
      createdAt: new Date().toISOString()
    };

    const configPath = assertInsideDirectory('config.json', tmpDir);
    writeOutput(configPath, JSON.stringify(config, null, 2));

    return {
      status: 'success',
      configPath,
      config,
      next_action: 'Configuration saved. Next step: Call <auto_qa_generate_code_summary> to scan the target application surface.'
    };
  }

  if (name === 'auto_qa_generate_code_summary') {
    return enqueueBrowserTask(async () => {
      ensureDirectory(tmpDir, projectPath);
      const rawUrl = args.url || 'http://localhost:3000';
      const targetUrl = assertValidHttpUrl(rawUrl);

      const discoveryResult = await discoverInteractiveElements(targetUrl, {
        timeout: 15000,
        logger: stderrLog
      });

      const summaryYaml = formatCodeSummaryYaml(discoveryResult);
      const summaryPath = assertInsideDirectory('code_summary.yaml', tmpDir);
      writeOutput(summaryPath, summaryYaml);

      return {
        status: 'success',
        summaryPath,
        elementsCount: {
          buttons: discoveryResult.elements.buttons.length,
          inputs: discoveryResult.elements.inputs.length,
          links: discoveryResult.elements.links.length,
          modals: discoveryResult.elements.modals.length
        },
        next_action: 'Code summary saved. Next step: Call <auto_qa_generate_standardized_prd> to derive functional test requirements.'
      };
    });
  }

  if (name === 'auto_qa_generate_standardized_prd') {
    ensureDirectory(testDir, projectPath);
    const prdData = {
      $schema: 'https://raw.githubusercontent.com/TestSprite/testsprite-cli/main/schemas/prd.schema.json',
      projectPath,
      title: 'Standardized Functional Requirements Document (PRD)',
      createdAt: new Date().toISOString(),
      description: args.appDescription || 'Automated PRD derived from application surface discovery.',
      functionalModules: [
        {
          module: 'Authentication & Session Flow',
          userStories: ['User can log in with valid credentials', 'User sees validation error on empty credentials']
        },
        {
          module: 'Core Business Workflows',
          userStories: ['User can trigger primary action buttons and observe state changes']
        }
      ]
    };

    const prdPath = assertInsideDirectory('standard_prd.json', testDir);
    writeOutput(prdPath, JSON.stringify(prdData, null, 2));

    return {
      status: 'success',
      prdPath,
      prd: prdData,
      next_action: 'Standardized PRD created. Next step: Call <auto_qa_generate_frontend_test_plan> to compile declarative test steps.'
    };
  }

  if (name === 'auto_qa_generate_frontend_test_plan') {
    if (!Array.isArray(args.planSteps)) {
      throw new Error('Validation error: planSteps must be an array.');
    }
    ensureDirectory(testDir, projectPath);
    const plan = {
      projectId: path.basename(projectPath),
      type: 'frontend',
      name: args.name,
      ...(args.targetUrl ? { targetUrl: args.targetUrl } : {}),
      priority: 'p0',
      planSteps: args.planSteps
    };

    const planPath = assertInsideDirectory('auto_qa_frontend_test_plan.json', testDir);
    writeOutput(planPath, JSON.stringify(plan, null, 2));

    return {
      status: 'success',
      planPath,
      stepsCount: plan.planSteps.length,
      next_action: 'Frontend test plan generated. Next step: Call <auto_qa_execute_and_heal> to run the test suite and verify execution.'
    };
  }

  if (name === 'auto_qa_generate_backend_test_plan') {
    if (!Array.isArray(args.endpoints)) {
      throw new Error('Validation error: endpoints must be an array.');
    }
    ensureDirectory(testDir, projectPath);
    const backendPlan = {
      type: 'backend',
      name: args.name,
      endpoints: args.endpoints,
      createdAt: new Date().toISOString()
    };

    const planPath = assertInsideDirectory('auto_qa_backend_test_plan.json', testDir);
    writeOutput(planPath, JSON.stringify(backendPlan, null, 2));

    return {
      status: 'success',
      planPath,
      endpointsCount: args.endpoints.length
    };
  }

  if (name === 'auto_qa_execute_and_heal') {
    return enqueueBrowserTask(async () => {
      const rawPlanFile = args.planFile || path.join(TEST_DIR_NAME, 'auto_qa_frontend_test_plan.json');
      const planFile = assertInsideDirectory(rawPlanFile, projectPath);

      if (!fs.existsSync(planFile)) {
        throw new Error(`Plan file not found at: ${planFile}`);
      }

      const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
      const artifactsDir = assertInsideDirectory('artifacts', testDir);
      ensureDirectory(artifactsDir, projectPath);

      const result = await executeTestPlan(plan, {
        baseUrl: args.baseUrl,
        headless: args.headless !== false,
        artifactDir: artifactsDir,
        projectPath,
        logger: stderrLog,
        warnLogger: stderrLog,
        errorLogger: stderrLog,
        allowedEnvPrefixes
      });

      // Write sanitized Markdown report inside testDir
      const mdReportPath = assertInsideDirectory('auto-qa-test-report.md', testDir);
      const mdLines = [
        `# Auto-QA Execution Audit Report`,
        `**Plan**: ${sanitizeMdCell(result.testName)}  `,
        `**Status**: ${result.status === 'passed' ? '✅ PASSED' : '❌ FAILED'}  `,
        `**Target**: ${sanitizeMdCell(result.targetUrl)}  `,
        `**Duration**: ${result.durationMs}ms  `,
        `**Timestamp**: ${result.finishedAt || new Date().toISOString()}  \n`,
        `## Step Execution Ledger`,
        `| Step | Type | Description | Duration | Status |`,
        `| :--- | :--- | :--- | :--- | :--- |`,
        ...result.steps.map(
          (s) =>
            `| ${s.index} | \`${sanitizeMdCell(s.type, 40)}\` | ${sanitizeMdCell(s.description)} | ${s.durationMs || 0}ms | ${s.status === 'passed' ? '✓ Passed' : '❌ Failed: ' + sanitizeMdCell(s.error || '')} |`
        )
      ];

      if (result.consoleErrors.length) {
        const totalCe = result.consoleErrors.length + (result.consoleErrorsTruncated || 0);
        mdLines.push(`\n## Console Errors (${totalCe})`);
        result.consoleErrors.slice(0, 20).forEach((ce) => mdLines.push(`- ${sanitizeMdCell(ce, 300)}`));
      }

      if (result.artifacts.length) {
        mdLines.push(`\n## Artifacts`);
        result.artifacts.forEach((a) => mdLines.push(`- [${sanitizeMdCell(path.basename(a), 150)}](${toRelativeArtifactLink(testDir, a)})`));
      }

      writeOutput(mdReportPath, mdLines.join('\n'));

      const failedStep = result.steps.find((s) => s.status === 'failed');
      const contextArtifact = result.artifacts.find((a) => /-context\.json$/i.test(path.basename(a))) || null;
      const failureScreenshot = result.artifacts.find((a) => /^failure-step-\d+\.png$/i.test(path.basename(a))) || result.artifacts[0] || null;

      return {
        status: result.status,
        plan: result.testName,
        stepsRun: result.steps.length,
        durationMs: result.durationMs,
        reportFile: mdReportPath,
        contextFile: contextArtifact,
        artifacts: result.artifacts,
        defectFixRecommendation: failedStep
          ? `Defect detected at Step ${failedStep.index}: "${failedStep.description}". Error: ${failedStep.error}. Check snapshot freshness with auto_qa_check_context_freshness before patching. Inspect scoped context snapshot: ${contextArtifact || 'N/A'} and screenshot: ${failureScreenshot || 'N/A'}`
          : null
      };
    });
  }

  throw new Error(`Unknown tool: ${name}`);
}

/**
 * Standard MCP stdio JSON-RPC 2.0 Server Loop
 */
export function startMcpServer() {
  // Prevent any library console output from corrupting stdio JSON-RPC framing
  console.log = stderrLog;
  console.info = stderrLog;
  console.debug = stderrLog;
  console.dir = (obj) => stderrLog(typeof obj === 'string' ? obj : JSON.stringify(obj));
  console.table = (tbl) => stderrLog(JSON.stringify(tbl));

  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false
  });

  const sendResponse = (response) => {
    process.stdout.write(JSON.stringify(response) + '\n');
  };

  const inFlightRequests = new Set();
  let shuttingDown = false;

  const immediateShutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await Promise.all([closeAllBrowsers(), closeAllDiscoverBrowsers()]).catch(() => {});
    process.exit(0);
  };

  const drainAndShutdown = async () => {
    if (shuttingDown) return;
    await Promise.allSettled(Array.from(inFlightRequests));
    await browserQueue.catch(() => {});
    await immediateShutdown();
  };

  rl.on('close', drainAndShutdown);
  process.on('SIGINT', immediateShutdown);
  process.on('SIGTERM', immediateShutdown);

  rl.on('line', (line) => {
    if (!line.trim()) return;

    const task = (async () => {
      let message;
      try {
        message = JSON.parse(line);
      } catch (_) {
        sendResponse({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32700,
            message: 'Parse error: Invalid JSON'
          }
        });
        return;
      }

      if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.method !== 'string') {
        const respId =
          message && typeof message === 'object' && !Array.isArray(message) && message.id !== undefined
            ? message.id
            : null;
        sendResponse({
          jsonrpc: '2.0',
          id: respId,
          error: {
            code: -32600,
            message: 'Invalid Request'
          }
        });
        return;
      }

      const hasId = message.id !== undefined;

      if (message.method === 'initialize') {
        if (hasId) {
          sendResponse({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: {
                tools: {}
              },
              serverInfo: {
                name: 'auto-qa-mcp',
                version: '2.1.0'
              }
            }
          });
        }
        return;
      }

      if (message.method === 'notifications/initialized') {
        return;
      }

      if (message.method === 'tools/list') {
        if (hasId) {
          sendResponse({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              tools: TOOLS
            }
          });
        }
        return;
      }

      if (message.method === 'tools/call') {
        const { name, arguments: toolArgs } = message.params || {};
        try {
          const resultData = await handleToolCall(name, toolArgs || {});
          if (hasId) {
            sendResponse({
              jsonrpc: '2.0',
              id: message.id,
              result: {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify(resultData, null, 2)
                  }
                ]
              }
            });
          }
        } catch (callErr) {
          if (hasId) {
            sendResponse({
              jsonrpc: '2.0',
              id: message.id,
              error: {
                code: -32603,
                message: callErr.message
              }
            });
          }
        }
        return;
      }

      if (hasId) {
        sendResponse({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32601,
            message: `Method not found: ${message.method}`
          }
        });
      }
    })();

    inFlightRequests.add(task);
    task.finally(() => inFlightRequests.delete(task));
  });

  process.stderr.write('Auto-QA MCP Server started and listening on stdio.\n');
}

// Start if executed directly
if (process.argv[1]?.endsWith('mcp-server.js')) {
  startMcpServer();
}
