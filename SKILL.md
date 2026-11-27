---
name: auto-qa
description: Autonomous intent-driven QA testing engine supporting dual-mode operation (Antigravity Agent Skill CLI and Stdio MCP Server). Features self-healing Playwright execution, native .spec.ts compiler, active modal isolation, and black-box surface crawler for client websites or localhost apps. Use whenever the user asks to test web workflows, audit client websites without source code, run automated QA, or generate TestSprite-compliant plans.
---

# Auto-QA: Autonomous Intent-Driven QA Engine

An autonomous web QA testing toolchain that executes end-to-end user journeys against any web application (local dev server or live website) using plain-English human intents, self-healing W3C accessibility heuristics, active modal isolation, and native `@playwright/test` compilation.

---

## 1. Dual-Mode Operation Decision Rule

Before taking any action, inspect your declared tools:

* **MODE 1: MCP Tool Mode**:
  If tools starting with `auto_qa_` (e.g. `auto_qa_execute_and_heal`) are available in your active tool list, call them directly via JSON-RPC.
* **MODE 2: Antigravity Skill CLI Mode (Default & Standalone)**:
  If no `auto_qa_*` MCP tools are declared, execute all QA actions via `run_command` using the unified CLI:
  ```bash
  node "<skillPath>/scripts/cli.js" <command>
  ```
  *(Resolve `<skillPath>` to `~/.gemini/config/skills/auto-qa` or the repository root).*

---

## 2. The 3-Stage Testing Lifecycle

### Stage 1: Surface Discovery (Map Accessible Controls)
Crawl the target URL to extract interactive buttons, inputs, links, and modal dialogs.
* **MCP Mode**: Call `auto_qa_generate_code_summary(projectPath, url)`.
* **Skill CLI Mode**:
  ```bash
  node "<skillPath>/scripts/cli.js" discover http://localhost:3000 -o auto_qa_tests/tmp/surface.json
  ```

### Stage 2: Intent Plan Authoring (`auto_qa_frontend_test_plan.json`)
Author the declarative test plan in `auto_qa_tests/auto_qa_frontend_test_plan.json`.
* **MCP Mode**: Call `auto_qa_generate_frontend_test_plan(projectPath, name, planSteps)`.
* **Skill CLI Mode**: Write the JSON file directly using your file creation tool:

```json
{
  "projectId": "project-name",
  "type": "frontend",
  "name": "User Registration & Login Flow",
  "targetUrl": "http://localhost:3000",
  "priority": "p0",
  "planSteps": [
    { "type": "action", "description": "navigate to http://localhost:3000/login" },
    { "type": "action", "description": "type '${QA_EMAIL}' into 'Email'" },
    { "type": "action", "description": "type '${QA_PASSWORD}' into 'Password'" },
    { "type": "action", "description": "click 'Sign In'" },
    { "type": "assertion", "description": "verify 'Dashboard' is visible" },
    { "type": "assertion", "description": "verify URL contains '/dashboard'" }
  ]
}
```

* **Environment Variable Secrets (`${ENV_VAR}`)**: Prefer `${QA_EMAIL}` / `${QA_PASSWORD}` over hardcoded credentials in `plan.json`. Only strict identifiers matching `^[A-Z_][A-Z0-9_]*$` are allowed (arbitrary expressions are rejected). Export referenced variables in your shell before running `run` or compiled `.spec.ts` files (Bash: `export QA_EMAIL=...`; PowerShell: `$env:QA_EMAIL="..."`). In MCP mode, `AUTO_QA_ALLOWED_ENV_PREFIXES` defaults to `QA_,AUTO_QA_,TEST_` (set `AUTO_QA_ALLOWED_ENV_PREFIXES=*` to widen; optional in CLI). Both `executor.js` and compiled `.spec.ts` files (`requireEnv("VAR", process.env["VAR"])`) fail closed if unset, and raw, percent-encoded, `URLSearchParams` (`+`), and lowercase hex secret values (`>= 3` chars; `< 3` char values are not redacted) are scrubbed before truncation across stdout, stderr errors, `failure-step-N-context.json`, `auto-qa-test-report.md`, and `test-report-*.json`.
* **Network & Private IP Policy**: Non-loopback private RFC1918/CGNAT/ULA targets and cloud metadata IPs are blocked by default; set `AUTO_QA_ALLOW_PRIVATE_NETWORK=1` when testing internal intranet URLs (`localhost`/`127.0.0.1`/`[::1]` are allowed automatically for initial targets, while metadata/link-local IMDS endpoints remain blocked).

#### Supported Intent Verbs (Case-Insensitive, Single or Double Quotes):
* **Actions**:
  * `navigate to <http(s)://url>` / `go to </path or http(s)://url>`
  * `type '<text>' into '<target>'` / `fill '<text>' into '<target>'`
  * `click '<target>'` / `press '<target>'`
  * `select '<option>' from '<target>'`
  * `check '<target>'` / `tick '<target>'`
* **Assertions**:
  * `verify '<target>' is visible` / `appears`
  * `verify '<target>' is not visible` / `disappears`
  * `verify text '<text>'` / `contains '<text>'`
  * `verify URL contains '<path>'`

### Stage 3: Execution, Self-Healing & Code Compilation
Execute the declarative test plan with hardened active modal isolation (ignoring stale Radix/Headless UI portals via real computed visibility and preferring the top-most visible dialog), capture failure screenshots and scoped snapshots, and export native code. Discovery and execution use native visibility checks, rendered children of `display: contents` wrappers, and hidden/inert/ARIA checks across open shadow hosts. After exact and substring matches fail, the runner can match a changed badge such as `Cart (2)` for `Cart (1)` inside the active scope. Numeric-only targets keep their original lookup behavior.
* **MCP Mode**:
  * Run: `auto_qa_execute_and_heal(projectPath, planFile, baseUrl)`
  * Before patching from a saved snapshot, call `auto_qa_check_context_freshness(projectPath, contextFilePath)`. Review its warning when project files are newer than `capturedAt` or Git HEAD differs. Git metadata, dependencies, QA artifacts, and common build outputs are excluded from the timestamp scan.
  * Export: `auto_qa_compile_to_playwright(planPath, outputPath, projectPath)`
* **Skill CLI Mode**:
  * **Execute Test**:
    ```bash
    node "<skillPath>/scripts/cli.js" run auto_qa_tests/auto_qa_frontend_test_plan.json -u http://localhost:3000
    ```
    *(Note: Exit code 1 indicates an assertion failure under test. Inspect `auto_qa_tests/artifacts/` for `failure-step-N.png`, `failure-step-N-context.json` — a capped DOM + accessibility snapshot scoped to any open modal before browser teardown — and `auto_qa_tests/auto-qa-test-report.md` for step timings and error traces).*
  * **Compile to Native Playwright TypeScript**:
    ```bash
    node "<skillPath>/scripts/cli.js" compile auto_qa_tests/auto_qa_frontend_test_plan.json -o tests/e2e/flow.spec.ts
    ```
    *(Running compiled `.spec.ts` files standalone requires `@playwright/test` — plus `@types/node` for TypeScript `process.env` — installed in your target project, with any referenced `${ENV_VAR}` exported before execution).*

---

## 3. CLI Subcommand Summary

| Subcommand | Purpose | Default Output |
| :--- | :--- | :--- |
| `doctor` | Preflight check for Node, Playwright, and Chromium binary. | Terminal status |
| `discover <url> [-o <file>]` | Crawls website and extracts buttons, inputs, links, modals, and `ariaSnapshot()` accessibility tree. | Summary counts (or JSON surface map with `-o <file>`) |
| `run <planFile> [-u <url>] [-p <project>] [-o <dir>]` | Executes intent plan with hardened modal isolation and failure-time context capture. | `auto_qa_tests/artifacts/` (`failure-step-N.png` + `failure-step-N-context.json`) + `auto-qa-test-report.md` |
| `check-context-freshness <contextFile> [-p <project>]` | Compares the snapshot to the application. Use the same project root as `run --project`. | JSON result and a non-blocking stale warning on stderr |
| `compile <planFile> [-o <file>]` | Compiles declarative plan into native `@playwright/test` `.spec.ts`. | `<planFileStem>.spec.ts` |
| `bootstrap [dir] [-u <url>]` | Initializes `auto_qa_tests/tmp/config.json`. | `config.json` |
| `mcp` | Starts the stdio JSON-RPC 2.0 MCP server. | stdio stream |

---

## 4. The 5-Layer Verification Strategy

When asked to *"Test everything"* or audit an unfamiliar web application:
1. **Layer 1: Navigation & Routes**: Crawl navbar and footer links; assert no 404 responses.
2. **Layer 2: Interactive Controls**: Test dropdowns, accordions, theme toggles, and filter buttons.
3. **Layer 3: Form Validation Funnels**:
   - **Happy Path**: Submit valid inputs → assert success banner or state update.
   - **Error Path**: Submit empty required fields → assert inline validation alerts.
4. **Layer 4: Authentication Lifecycle**: Valid login, invalid credentials rejection, session persistence, and logout.
5. **Layer 5: Core CRUD Workflows**: Create item → assert listed; modify item → assert updated; delete item → assert removed.
