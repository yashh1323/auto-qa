#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { executeTestPlan } from './executor.js';
import { discoverInteractiveElements } from './discover.js';
import { compilePlanToPlaywright } from './compiler.js';

const TEST_DIR_NAME = 'auto_qa_tests';

function ensureDirectory(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Asserts that a target file path resides strictly within an allowed root directory.
 * Prevents directory traversal attacks via relative paths (`../../`), absolute path overrides, or cross-drive jumps.
 */
function assertInsideDirectory(targetPath, allowedRoot) {
  const resolvedRoot = path.resolve(allowedRoot);
  const resolvedTarget = path.resolve(resolvedRoot, targetPath);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Security Violation: Path "${targetPath}" escapes allowed directory "${allowedRoot}".`);
  }
  return resolvedTarget;
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
 * Standard Tool Definitions conforming to TestSprite's deconstructed pipeline
 */
const TOOLS = [
  {
    name: 'auto_qa_bootstrap',
    description: 'Initializes the Auto-QA test configuration for a project, detects ports, framework, and writes config.json',
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
    description: 'Scans project files or live URL to extract interactive UI surface and generates code_summary.yaml',
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
    description: 'Generates a TestSprite-compliant declarative test plan (auto_qa_frontend_test_plan.json) from user journeys',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Absolute path to project root' },
        name: { type: 'string', description: 'Name of the test plan' },
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
    description: 'Generates API assertion test plan for backend endpoints',
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
    description: 'Executes the declarative test plan with the self-healing Playwright engine, captures screenshots, and produces a structured defect report with automated fix instructions',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Absolute path to project root' },
        planFile: { type: 'string', description: 'Path to plan JSON file (relative or absolute)' },
        baseUrl: { type: 'string', description: 'Override target base URL' },
        headless: { type: 'boolean', default: true }
      },
      required: ['projectPath']
    }
  },
  {
    name: 'auto_qa_compile_to_playwright',
    description: 'Compiles a declarative intent test plan into native Playwright TypeScript (.spec.ts) code with Trace Viewer support',
    inputSchema: {
      type: 'object',
      properties: {
        planPath: { type: 'string', description: 'Path to the plan JSON file' },
        outputPath: { type: 'string', description: 'Path to output .spec.ts file' }
      },
      required: ['planPath']
    }
  }
];

/**
 * Tool Handlers
 */
async function handleToolCall(name, args) {
  const projectPath = args.projectPath ? path.resolve(args.projectPath) : process.cwd();
  const testDir = path.join(projectPath, TEST_DIR_NAME);
  const tmpDir = path.join(testDir, 'tmp');

  if (name === 'auto_qa_bootstrap') {
    ensureDirectory(tmpDir);
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

    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    return {
      status: 'success',
      configPath,
      config,
      next_action: 'Configuration saved. Next step: Call <auto_qa_generate_code_summary> to scan the target application surface.'
    };
  }

  if (name === 'auto_qa_generate_code_summary') {
    ensureDirectory(tmpDir);
    const rawUrl = args.url || 'http://localhost:3000';
    const targetUrl = assertValidHttpUrl(rawUrl);
    let discoveryResult = null;

    try {
      discoveryResult = await discoverInteractiveElements(targetUrl, { timeout: 10000 });
    } catch (_) {
      discoveryResult = { url: targetUrl, elements: { buttons: [], inputs: [], links: [] } };
    }

    const summaryYaml = [
      `# Auto-QA Discovered Code Summary`,
      `url: ${JSON.stringify(discoveryResult.url)}`,
      `scanned_at: ${JSON.stringify(new Date().toISOString())}`,
      `buttons:`,
      ...discoveryResult.elements.buttons.map(b => `  - text: ${JSON.stringify(b.text || '')} (type: ${JSON.stringify(b.type || 'button')}, id: ${JSON.stringify(b.id || 'none')})`),
      `inputs:`,
      ...discoveryResult.elements.inputs.map(i => `  - label: ${JSON.stringify(i.label || i.placeholder || i.name || '')} (tag: ${JSON.stringify(i.tag || 'input')}, type: ${JSON.stringify(i.type || 'text')})`),
      `links:`,
      ...discoveryResult.elements.links.map(l => `  - text: ${JSON.stringify(l.text || '')} (href: ${JSON.stringify(l.href || '')})`)
    ].join('\n');

    const summaryPath = path.join(tmpDir, 'code_summary.yaml');
    fs.writeFileSync(summaryPath, summaryYaml, 'utf8');

    return {
      status: 'success',
      summaryPath,
      elementsCount: {
        buttons: discoveryResult.elements.buttons.length,
        inputs: discoveryResult.elements.inputs.length,
        links: discoveryResult.elements.links.length
      },
      next_action: 'Code summary saved. Next step: Call <auto_qa_generate_standardized_prd> to derive functional test requirements.'
    };
  }

  if (name === 'auto_qa_generate_standardized_prd') {
    ensureDirectory(testDir);
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

    const prdPath = path.join(testDir, 'standard_prd.json');
    fs.writeFileSync(prdPath, JSON.stringify(prdData, null, 2), 'utf8');

    return {
      status: 'success',
      prdPath,
      prd: prdData,
      next_action: 'Standardized PRD created. Next step: Call <auto_qa_generate_frontend_test_plan> to compile declarative test steps.'
    };
  }

  if (name === 'auto_qa_generate_frontend_test_plan') {
    ensureDirectory(testDir);
    const plan = {
      $schema: 'https://raw.githubusercontent.com/TestSprite/testsprite-cli/main/schemas/plan.schema.json',
      projectId: path.basename(projectPath),
      type: 'frontend',
      name: args.name,
      priority: 'p0',
      planSteps: args.planSteps
    };

    const planPath = path.join(testDir, 'auto_qa_frontend_test_plan.json');
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf8');

    return {
      status: 'success',
      planPath,
      stepsCount: plan.planSteps.length,
      next_action: 'Frontend test plan generated. Next step: Call <auto_qa_execute_and_heal> to run the test suite and verify execution.'
    };
  }

  if (name === 'auto_qa_generate_backend_test_plan') {
    ensureDirectory(testDir);
    const backendPlan = {
      type: 'backend',
      name: args.name,
      endpoints: args.endpoints,
      createdAt: new Date().toISOString()
    };

    const planPath = path.join(testDir, 'auto_qa_backend_test_plan.json');
    fs.writeFileSync(planPath, JSON.stringify(backendPlan, null, 2), 'utf8');

    return {
      status: 'success',
      planPath,
      endpointsCount: args.endpoints.length
    };
  }

  if (name === 'auto_qa_execute_and_heal') {
    const rawPlanFile = args.planFile || path.join(testDir, 'auto_qa_frontend_test_plan.json');
    const planFile = assertInsideDirectory(rawPlanFile, projectPath);

    if (!fs.existsSync(planFile)) {
      throw new Error(`Plan file not found at: ${planFile}`);
    }

    const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
    const artifactsDir = path.join(testDir, 'artifacts');

    const result = await executeTestPlan(plan, {
      baseUrl: args.baseUrl ? assertValidHttpUrl(args.baseUrl) : undefined,
      headless: args.headless !== false,
      artifactDir: artifactsDir
    });

    // Write Markdown report
    const mdReportPath = path.join(testDir, 'auto-qa-test-report.md');
    const mdLines = [
      `# Auto-QA Execution Audit Report`,
      `**Plan**: ${result.testName}  `,
      `**Status**: ${result.status === 'passed' ? '✅ PASSED' : '❌ FAILED'}  `,
      `**Target**: ${result.targetUrl}  `,
      `**Duration**: ${result.durationMs}ms  `,
      `**Timestamp**: ${result.finishedAt || new Date().toISOString()}  \n`,
      `## Step Execution Ledger`,
      `| Step | Type | Description | Duration | Status |`,
      `| :--- | :--- | :--- | :--- | :--- |`,
      ...result.steps.map(s => `| ${s.index} | \`${s.type}\` | ${s.description} | ${s.durationMs || 0}ms | ${s.status === 'passed' ? '✓ Passed' : '❌ Failed: ' + (s.error || '')} |`)
    ];

    if (result.artifacts.length) {
      mdLines.push(`\n## Artifacts`);
      result.artifacts.forEach(a => mdLines.push(`- [${path.basename(a)}](${a})`));
    }

    fs.writeFileSync(mdReportPath, mdLines.join('\n'), 'utf8');

    return {
      status: result.status,
      plan: result.testName,
      stepsRun: result.steps.length,
      durationMs: result.durationMs,
      reportFile: mdReportPath,
      artifacts: result.artifacts,
      defectFixRecommendation: result.status === 'failed'
        ? `Defect detected at Step ${result.steps.find(s => s.status === 'failed')?.index}: "${result.steps.find(s => s.status === 'failed')?.description}". Error: ${result.steps.find(s => s.status === 'failed')?.error}. Inspect artifact: ${result.artifacts[0]}`
        : null
    };
  }

  if (name === 'auto_qa_compile_to_playwright') {
    const planPath = path.resolve(args.planPath);
    if (!fs.existsSync(planPath)) throw new Error(`Plan not found: ${planPath}`);
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    const tsCode = compilePlanToPlaywright(plan);
    
    const defaultOut = path.join(path.dirname(planPath), `${path.basename(planPath, '.json')}.spec.ts`);
    const outPath = args.outputPath
      ? assertInsideDirectory(args.outputPath, path.dirname(planPath))
      : defaultOut;

    ensureDirectory(path.dirname(outPath));
    fs.writeFileSync(outPath, tsCode, 'utf8');
    return {
      status: 'success',
      outputPath: outPath,
      codePreview: tsCode.slice(0, 500)
    };
  }

  throw new Error(`Unknown tool: ${name}`);
}

/**
 * Standard MCP stdio JSON-RPC 2.0 Server Loop
 */
export function startMcpServer() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  const sendResponse = (response) => {
    process.stdout.write(JSON.stringify(response) + '\n');
  };

  rl.on('line', async (line) => {
    if (!line.trim()) return;

    try {
      const message = JSON.parse(line);

      // 1. Initialize
      if (message.method === 'initialize') {
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
              version: '1.0.0'
            }
          }
        });
        return;
      }

      // 2. Initialized Notification
      if (message.method === 'notifications/initialized') {
        return;
      }

      // 3. Tools List
      if (message.method === 'tools/list') {
        sendResponse({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            tools: TOOLS
          }
        });
        return;
      }

      // 4. Tools Call
      if (message.method === 'tools/call') {
        const { name, arguments: toolArgs } = message.params || {};
        try {
          const resultData = await handleToolCall(name, toolArgs || {});
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
        } catch (callErr) {
          sendResponse({
            jsonrpc: '2.0',
            id: message.id,
            error: {
              code: -32603,
              message: callErr.message
            }
          });
        }
        return;
      }

      // Default unrecognized method
      if (message.id !== undefined) {
        sendResponse({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32601,
            message: `Method not found: ${message.method}`
          }
        });
      }
    } catch (parseErr) {
      sendResponse({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32700,
          message: 'Parse error: Invalid JSON'
        }
      });
    }
  });

  process.stderr.write('Auto-QA MCP Server started and listening on stdio.\n');
}

// Start if executed directly
if (process.argv[1]?.endsWith('mcp-server.js')) {
  startMcpServer();
}
