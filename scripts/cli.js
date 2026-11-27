#!/usr/bin/env node

import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { executeTestPlan, checkFailureContextFreshness } from './executor.js';
import { discoverInteractiveElements } from './discover.js';
import { compilePlanToPlaywright } from './compiler.js';
import { startMcpServer } from './mcp-server.js';
import { getAllowedEnvPrefixesFromEnv } from './env-utils.js';
import { assertValidHttpUrl, sanitizeMdCell, toRelativeArtifactLink } from './url-utils.js';
import { writeOutput } from './write-output.js';

const program = new Command();

program
  .name('auto-qa')
  .description('Autonomous Intent-Driven QA Engine & MCP Server for Claude Code, Cursor, and Antigravity')
  .version('2.1.0');

program
  .command('mcp')
  .description('Start the Model Context Protocol (MCP) JSON-RPC stdio server')
  .action(() => {
    startMcpServer();
  });

program
  .command('discover <url>')
  .description('Crawl any client website and discover interactive forms, buttons, and inputs')
  .option('-o, --output <file>', 'Save discovered UI map to JSON file')
  .action(async (url, options) => {
    try {
      const data = await discoverInteractiveElements(url);
      if (options.output) {
        const outPath = path.resolve(process.cwd(), options.output);
        const parentDir = path.dirname(outPath);
        if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
        writeOutput(outPath, JSON.stringify(data, null, 2));
        console.log(`\n✅ Discovery map saved to: ${options.output}`);
      } else {
        console.log('\n--- Discovered Interactive Surface ---');
        console.log(`URL: ${data.url}`);
        console.log(`Title: ${data.title}`);
        console.log(`Buttons Found: ${data.elements.buttons.length}`);
        console.log(`Inputs Found: ${data.elements.inputs.length}`);
        console.log(`Links Found: ${data.elements.links.length}`);
        console.log(`Modals Found: ${data.elements.modals.length}`);
      }
    } catch (err) {
      console.error(`Discovery failed: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('run <planFile>')
  .description('Execute an intent test plan against a target website')
  .option('-u, --url <url>', 'Override base target URL')
  .option('-p, --project <dir>', 'Application project root used to capture Git HEAD', '.')
  .option('--no-headless', 'Run in visible browser window for live demo')
  .option('-o, --output <dir>', 'Artifacts output directory', './auto_qa_tests/artifacts')
  .action(async (planFile, options) => {
    try {
      const fullPath = path.resolve(process.cwd(), planFile);
      if (!fs.existsSync(fullPath)) {
        console.error(`Error: Plan file not found: ${fullPath}`);
        process.exit(1);
      }
      const raw = fs.readFileSync(fullPath, 'utf8');
      const plan = JSON.parse(raw);

      const artifactDir = path.resolve(process.cwd(), options.output);
      if (!fs.existsSync(artifactDir)) fs.mkdirSync(artifactDir, { recursive: true });

      const allowedEnvPrefixes = getAllowedEnvPrefixesFromEnv();

      const result = await executeTestPlan(plan, {
        baseUrl: options.url,
        headless: options.headless,
        artifactDir,
        projectPath: path.resolve(options.project),
        allowedEnvPrefixes
      });

      // Keep default ./auto_qa_tests/auto-qa-test-report.md layout while confining custom -o dirs inside themselves
      const reportDir = artifactDir === path.resolve('auto_qa_tests/artifacts')
        ? path.dirname(artifactDir)
        : artifactDir;
      const mdReportPath = path.join(reportDir, 'auto-qa-test-report.md');
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
        result.artifacts.forEach((a) =>
          mdLines.push(`- [${sanitizeMdCell(path.basename(a), 150)}](${toRelativeArtifactLink(reportDir, a)})`)
        );
      }

      writeOutput(mdReportPath, mdLines.join('\n'));

      console.log('\n--- Test Run Summary ---');
      console.log(`Plan: ${result.testName}`);
      console.log(`Status: ${result.status === 'passed' ? '✅ PASSED' : '❌ FAILED'}`);
      console.log(`Steps Run: ${result.steps.length}`);
      console.log(`Duration: ${result.durationMs}ms`);
      console.log(`Report Written: ${mdReportPath}`);
      if (result.artifacts.length) {
        console.log(`Artifacts Saved:\n  - ${result.artifacts.join('\n  - ')}`);
      }

      process.exit(result.status === 'passed' ? 0 : 1);
    } catch (err) {
      console.error(`Execution failed: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('check-context-freshness <contextFile>')
  .description('Check whether project files or Git HEAD changed after a failure snapshot')
  .option('-p, --project <dir>', 'Project root for relative context paths and source timestamps', '.')
  .action(async (contextFile, options) => {
    try {
      const result = await checkFailureContextFreshness(contextFile, options.project);
      console.log(JSON.stringify(result, null, 2));
      if (result.warning) console.warn(result.warning);
    } catch (err) {
      console.error(err.message);
      process.exitCode = 1;
    }
  });

program
  .command('compile <planFile>')
  .description('Compile a declarative plan.json into native Playwright TypeScript code')
  .option('-o, --output <file>', 'Output .spec.ts file path')
  .action((planFile, options) => {
    try {
      const fullPath = path.resolve(process.cwd(), planFile);
      if (!fs.existsSync(fullPath)) {
        console.error(`Error: Plan file not found: ${fullPath}`);
        process.exit(1);
      }
      const plan = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      const allowedEnvPrefixes = getAllowedEnvPrefixesFromEnv();
      const code = compilePlanToPlaywright(plan, { allowedEnvPrefixes });
      const outPath = options.output
        ? path.resolve(options.output)
        : path.join(path.dirname(fullPath), `${path.basename(fullPath, '.json')}.spec.ts`);

      const parentDir = path.dirname(outPath);
      if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
      writeOutput(outPath, code);
      console.log(`✅ Compiled to native Playwright test: ${outPath}`);
    } catch (err) {
      console.error(`Compilation failed: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('bootstrap [projectPath]')
  .description('Initialize Auto-QA configuration in project directory')
  .option('-u, --url <url>', 'Base URL', 'http://localhost:3000')
  .action((projectPath = '.', options) => {
    try {
      const safeUrl = assertValidHttpUrl(options.url);
      const targetDir = path.resolve(process.cwd(), projectPath, 'auto_qa_tests', 'tmp');
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      const config = {
        projectPath: path.resolve(process.cwd(), projectPath),
        baseUrl: safeUrl,
        type: 'frontend',
        createdAt: new Date().toISOString()
      };
      const outPath = path.join(targetDir, 'config.json');
      writeOutput(outPath, JSON.stringify(config, null, 2));
      console.log(`✅ Project initialized. Configuration written to: ${outPath}`);
    } catch (err) {
      console.error(`Bootstrap failed: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('doctor')
  .description('Verify Playwright and browser readiness')
  .action(async () => {
    console.log('Auto-QA Agent Readiness Check:');
    console.log('  [OK] Node.js runtime:', process.version);
    let chromiumReady = false;
    try {
      const browserPath = chromium.executablePath();
      chromiumReady = Boolean(browserPath && fs.existsSync(browserPath));
      if (chromiumReady) {
        console.log('  [OK] Playwright Chromium binary: available at', browserPath);
      } else {
        console.log('  [WARN] Playwright Chromium binary not installed on disk. Run: npx playwright install chromium');
      }
    } catch (_) {
      console.log('  [WARN] Chromium binary check failed. Run: npx playwright install chromium');
    }
    console.log('  [OK] Model Context Protocol (MCP) server module: loaded');
    console.log('  [OK] Intent parser & native Playwright compiler: active');
  });

program.parse(process.argv);
