# Cross-Platform Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a self-hosted, cross-platform ag-box CLI that migrates project files and supported agent sessions, plus a loopback-only local Web management panel.

**Architecture:** Extract platform-neutral metadata, project identity, sync and session collection from Linux sandbox runtime. `ResticProvider` remains the only functional sync provider; a typed `HostedProvider` boundary is present but disabled. `ag-box serve` runs a token-protected loopback HTTP/SSE API serving static UI assets; it invokes only defined core operations.

**Tech Stack:** Node.js 20+ CommonJS, Node built-in `http`/`crypto`/`fs`/`path`, restic CLI, rclone CLI, node:test, HTML/CSS/vanilla JavaScript.

## Global Constraints

- Support Linux, macOS and Windows for CLI, self-hosted sync and panel.
- Keep Node.js >=20 and add no runtime npm dependency.
- Preserve existing `box:<name>` restic tags and restore compatibility.
- Never include agent credentials, global configuration, `.auth-secret`, or self-hosted storage credentials in a project backup, log, or panel response.
- Bind the panel only to `127.0.0.1` and `::1`; require a fresh random bearer token for every API request.
- Linux bwrap/systemd/tmux sandbox behaviour remains supported; Windows/macOS do not expose sandbox commands.
- Supported session adapters: Claude Code, Codex, Grok, OpenCode, Pi, oh-my-pi.
- A project write requires a valid lease; force takeover is explicit and warning-bearing.
- Hosted billing, authentication, tenancy, storage and payment are out of scope; only a provider interface and disabled UI entry are included.

---

### Task 1: Safely upgrade and validate restic before application changes

**Files:**
- Create: `docs/operations/restic-upgrade-2026-08.md`
- Modify: `README.md`

**Interfaces:**
- Produces: documented repeatable command sequence and recorded before/after verification output, with no credentials written to disk.

- [ ] **Step 1: Record the current binary and choose a test snapshot without printing secrets**

Run:
```bash
restic version
restic snapshots --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s); console.log(x.at(-1)?.short_id||"")})'
```

- [ ] **Step 2: Verify the selected historical snapshot can restore to an empty temporary directory**

Run (replace `SNAPSHOT_ID` only in the local shell):
```bash
VERIFY_DIR="$(mktemp -d)"
restic restore SNAPSHOT_ID --target "$VERIFY_DIR"
test -n "$(find "$VERIFY_DIR" -mindepth 1 -print -quit)"
rm -rf "$VERIFY_DIR"
```
Expected: restic exits zero and the target contains restored content.

- [ ] **Step 3: Write the operations record before changing the binary**

Document the exact source of the verified official binary, original version, selected snapshot ID, the restore result, rollback binary location, and the rule that `restic check` is read-only.

- [ ] **Step 4: Install the current signed official restic binary with the prior binary retained**

Run the vendor’s checksum/signature verification procedure, move the existing binary to a versioned sibling path, install the verified binary, and run `restic version`.

- [ ] **Step 5: Re-run integrity and restore verification**

Run:
```bash
restic check
VERIFY_DIR="$(mktemp -d)"
restic restore SNAPSHOT_ID --target "$VERIFY_DIR"
test -n "$(find "$VERIFY_DIR" -mindepth 1 -print -quit)"
rm -rf "$VERIFY_DIR"
```
Expected: both commands exit zero. On failure, restore the retained binary and stop.

- [ ] **Step 6: Document runtime floor and commit**

Add a README requirement for the verified restic version floor and the recovery procedure link.

```bash
git add docs/operations/restic-upgrade-2026-08.md README.md
git commit -m "ops: validate restic upgrade"
```

### Task 2: Add platform paths, local configuration and logical project identity

**Files:**
- Create: `lib/platform.js`
- Create: `lib/project.js`
- Create: `test/box-platform.test.js`
- Create: `test/box-project.test.js`
- Modify: `lib/meta.js`
- Modify: `lib/env.js`

**Interfaces:**
- Produces: `platformPaths(platform, home)`, `projectId()`, `upgradeMeta(meta)`, and a config object free of Linux-only default paths.
- Consumes: existing `newMeta`, `readMeta`, `writeMeta` callers.

- [ ] **Step 1: Write failing platform path tests**

```js
test('platform paths use XDG, macOS and Windows app-data roots', () => {
  assert.equal(platformPaths('linux', '/home/a').configDir, '/home/a/.config/ag-box');
  assert.equal(platformPaths('darwin', '/Users/a').configDir, '/Users/a/Library/Application Support/ag-box');
  assert.equal(platformPaths('win32', 'C:\\Users\\a').configDir, 'C:\\Users\\a\\AppData\\Roaming\\ag-box');
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `node --test test/box-platform.test.js`
Expected: FAIL because `platformPaths` does not exist.

- [ ] **Step 3: Implement deterministic paths and project IDs**

```js
function projectId() { return crypto.randomUUID(); }
function upgradeMeta(meta) {
  return { ...meta, schema_version: 2, project_id: meta.project_id || projectId(), local_paths: meta.local_paths || {} };
}
```

Use `process.platform`, `process.env.APPDATA`, `XDG_CONFIG_HOME`, and injected test overrides. Store only the local device’s mapping locally; remote metadata contains `project_id` but never another device’s absolute path.

- [ ] **Step 4: Add legacy metadata tests and implement read/write upgrade**

```js
test('upgradeMeta retains legacy name, path and restic fields', () => {
  const m = upgradeMeta({ name: 'a', path: '/root/a', last_snapshot: 'x' });
  assert.equal(m.name, 'a'); assert.equal(m.last_snapshot, 'x');
  assert.match(m.project_id, /^[0-9a-f-]{36}$/);
});
```

- [ ] **Step 5: Run focused and full tests, then commit**

Run: `node --test test/box-platform.test.js test/box-project.test.js && npm test`

```bash
git add lib/platform.js lib/project.js lib/meta.js lib/env.js test/box-platform.test.js test/box-project.test.js
git commit -m "feat: add portable project identity"
```

### Task 3: Define safe sync providers and portable snapshot targets

**Files:**
- Create: `lib/providers.js`
- Modify: `lib/snapshot.js`
- Modify: `exclude.txt`
- Create: `test/box-providers.test.js`
- Modify: `test/box-sessions.test.js`

**Interfaces:**
- Produces: `ResticProvider.backup(meta)`, `ResticProvider.restore(meta, target)`, `HostedProvider` throwing `托管同步尚未启用`, and `snapshotTargets(meta, adapters)`.
- Consumes: config `resticEnv`; provider receives a redacting logger.

- [ ] **Step 1: Write provider command and redaction tests**

```js
test('restic provider retains legacy box tag and does not log secrets', () => {
  const calls = []; const logs = [];
  new ResticProvider(cfg, (c, a) => calls.push([c, a]), (x) => logs.push(x)).backup(meta);
  assert.deepEqual(calls[0][1].slice(0, 3), ['backup', '--tag', 'box:demo']);
  assert.equal(logs.join('').includes('secret-value'), false);
});
test('hosted provider is intentionally disabled', () => assert.throws(() => new HostedProvider().backup({}), /尚未启用/));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/box-providers.test.js`
Expected: FAIL because provider classes do not exist.

- [ ] **Step 3: Implement provider boundary without exposing credentials**

Use the existing `run('restic', ...)` wrapper. Pass credentials only through `env`; provider logs may record operation, project name, exit state and snapshot ID, never environment or command serialization containing secrets.

- [ ] **Step 4: Add portable exclusion and restore-target tests**

```js
test('snapshot targets include a project and adapter slices but not credentials', () => {
  const targets = snapshotTargets(meta, [{ collect: () => ['/x/session.jsonl'] }]);
  assert.deepEqual(targets, ['/work/demo', '/x/session.jsonl']);
  assert.equal(EXCLUDE_FILE.includes('exclude.txt'), true);
});
```

- [ ] **Step 5: Delegate existing backup/restore calls and run all tests**

Keep `backupBox` and `restoreBox` as compatibility wrappers around `ResticProvider`.

Run: `node --test test/box-providers.test.js test/box-sessions.test.js && npm test`

- [ ] **Step 6: Commit**

```bash
git add lib/providers.js lib/snapshot.js exclude.txt test/box-providers.test.js test/box-sessions.test.js
git commit -m "feat: isolate restic sync provider"
```

### Task 4: Implement explicit adapters for all supported agent session formats

**Files:**
- Create: `lib/adapters/index.js`
- Create: `lib/adapters/claude.js`
- Create: `lib/adapters/codex.js`
- Create: `lib/adapters/grok.js`
- Create: `lib/adapters/opencode.js`
- Create: `lib/adapters/pi.js`
- Create: `lib/adapters/oh-my-pi.js`
- Create: `test/box-adapters.test.js`
- Modify: `lib/sessions.js`

**Interfaces:**
- Produces: `{ id, platforms, collect(projectPath, paths), resumeHint(session) }` per adapter and `collectSessions(projectPath, adapters, paths)`.
- Consumes: project-local path and injected filesystem roots; adapters return `{files, skipped}`.

- [ ] **Step 1: Write table-driven adapter tests using temporary fixtures**

```js
for (const [id, fixture] of Object.entries(fixtures)) test(`${id} only returns project sessions`, () => {
  const r = adapterById(id).collect('/work/demo', fixture.paths);
  assert.deepEqual(r.files, fixture.expected);
  assert.equal(r.files.some((p) => /auth|credential/i.test(p)), false);
});
```

- [ ] **Step 2: Run test to verify adapters are absent**

Run: `node --test test/box-adapters.test.js`
Expected: FAIL because `adapterById` does not exist.

- [ ] **Step 3: Move current Codex/Grok discovery into adapters unchanged**

Preserve first-line JSON cwd parsing and URL-decoded Grok directory matching. Return `skipped` rather than throw for unreadable or unrecognized entries.

- [ ] **Step 4: Implement Claude, OpenCode, Pi and oh-my-pi only from documented path/config signals**

Each adapter must accept injected roots for tests, check supported platform, use project association rather than whole-home copying, and reject unknown format. Pi and oh-my-pi read configured session directories where available; neither copies credentials or global settings.

- [ ] **Step 5: Add resume-hint tests and run all tests**

```js
test('resume hints are display-only and contain no credential fields', () => {
  assert.match(adapterById('codex').resumeHint({ id: 'abc' }), /codex/);
  assert.equal(adapterById('codex').resumeHint({ id: 'abc' }).includes('token'), false);
});
```

Run: `node --test test/box-adapters.test.js test/box-sessions.test.js && npm test`

- [ ] **Step 6: Commit**

```bash
git add lib/adapters lib/sessions.js test/box-adapters.test.js test/box-sessions.test.js
git commit -m "feat: add portable agent session adapters"
```

### Task 5: Make CLI operations portable while preserving Linux sandbox commands

**Files:**
- Modify: `bin/ag-box`
- Create: `lib/core.js`
- Create: `lib/linux-runtime.js`
- Modify: `lib/runtime.js`
- Create: `test/box-core.test.js`
- Modify: `README.md`

**Interfaces:**
- Produces: portable `track`, `pull`, `push`, `restore`, `sessions`, `status`; Linux-only `up`, `attach`, `exec`, `park` are guarded by `requireLinuxRuntime()`.
- Consumes: `ResticProvider`, project metadata, adapter registry.

- [ ] **Step 1: Write platform command availability tests**

```js
test('portable commands run on win32 while sandbox commands explain Linux requirement', () => {
  assert.equal(commandSupport('pull', 'win32').ok, true);
  assert.match(commandSupport('attach', 'win32').reason, /Linux/);
});
```

- [ ] **Step 2: Run the new test to verify failure**

Run: `node --test test/box-core.test.js`
Expected: FAIL because `commandSupport` does not exist.

- [ ] **Step 3: Extract core orchestration from `bin/ag-box`**

Move dependency-injected operations into `lib/core.js`; leave argument parsing and output formatting in the CLI. Keep old command aliases on Linux and add unambiguous portable `push`, `pull`, `restore`, and `sessions` commands.

- [ ] **Step 4: Gate sandbox runtime and test legacy behavior**

```js
test('linux attach delegates to runtime', () => { /* inject runtime spy; assert call */ });
test('macOS attach never calls runtime', () => { /* assert explanatory error */ });
```

- [ ] **Step 5: Update help/README and run tests**

Run: `npm test`

- [ ] **Step 6: Commit**

```bash
git add bin/ag-box lib/core.js lib/linux-runtime.js lib/runtime.js test/box-core.test.js README.md
git commit -m "feat: add portable sync CLI"
```

### Task 6: Create a token-protected loopback API and task manager

**Files:**
- Create: `lib/server.js`
- Create: `lib/tasks.js`
- Create: `test/box-server.test.js`
- Modify: `bin/ag-box`

**Interfaces:**
- Produces: `createServer({core, token, host})`, `TaskManager.start(operation)`, `GET /api/projects`, `POST /api/sync`, `GET /api/tasks/:id`, `POST /api/tasks/:id/cancel`, and `GET /api/events` (SSE).
- Consumes: core methods only; no HTTP route can supply an executable or shell argument.

- [ ] **Step 1: Write HTTP security tests**

```js
test('API rejects missing bearer token and non-loopback host configuration', async () => {
  assert.equal((await request(server, '/api/projects')).status, 401);
  assert.throws(() => createServer({ host: '0.0.0.0', token: 'x', core }), /loopback/);
});
test('sync accepts only an allowlisted operation', async () => {
  const r = await request(server, '/api/sync', { operation: 'sh', command: 'id' });
  assert.equal(r.status, 400);
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `node --test test/box-server.test.js`
Expected: FAIL because server module does not exist.

- [ ] **Step 3: Implement loopback server, bearer checks and strict JSON schemas**

Generate the token using `crypto.randomBytes(32).toString('base64url')`. Reject requests whose socket address is not loopback, cap JSON body size, set `Cache-Control: no-store`, and never echo credentials or request authorization in errors.

- [ ] **Step 4: Implement tasks and SSE with cancellation**

Task state is `queued|running|succeeded|failed|cancelled`; errors use safe messages. Cancellation sends a signal only to the tracked provider child process, never to arbitrary PIDs.

- [ ] **Step 5: Add `ag-box serve` lifecycle test and run all tests**

```js
test('serve creates a mode-0600 token file and prints a localhost URL', () => { /* inject temp runtime dir */ });
```

Run: `node --test test/box-server.test.js && npm test`

- [ ] **Step 6: Commit**

```bash
git add lib/server.js lib/tasks.js test/box-server.test.js bin/ag-box
git commit -m "feat: add secured local management API"
```

### Task 7: Build the local Web management panel

**Files:**
- Create: `web/index.html`
- Create: `web/app.js`
- Create: `web/styles.css`
- Create: `test/box-web.test.js`
- Modify: `lib/server.js`

**Interfaces:**
- Produces: static panel served only by `createServer`; UI calls defined API endpoints and renders task/SSE state.
- Consumes: API schemas from Task 6 and token supplied only in the initial localhost URL fragment.

- [ ] **Step 1: Write static-asset and safety tests**

```js
test('panel contains no terminal, shell command endpoint, or secret input value', () => {
  const html = fs.readFileSync('web/index.html', 'utf8');
  assert.equal(html.includes('terminal'), false);
  assert.equal(html.includes('AWS_SECRET_ACCESS_KEY'), false);
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `node --test test/box-web.test.js`
Expected: FAIL because panel assets do not exist.

- [ ] **Step 3: Implement project, synchronization, session and settings views**

Use semantic HTML. `app.js` reads the token from `location.hash`, immediately removes it with `history.replaceState`, and sends it only as an Authorization header. Render project ID, path mapping, lease, snapshots, adapter status, resume hints, progress, safe logs and recovery instructions.

- [ ] **Step 4: Add disabled hosted entry and accessible error states**

The hosted control reads “托管模式（即将推出）”, has no network action, and describes no pricing. Render actionable messages for missing credentials, lease conflict, nonempty restore target and failed task.

- [ ] **Step 5: Serve content with strict headers and test it**

Set a restrictive CSP, `X-Content-Type-Options: nosniff`, and HTML/JS/CSS content types. Ensure `/web/*` traversal attempts return 404.

Run: `node --test test/box-web.test.js test/box-server.test.js && npm test`

- [ ] **Step 6: Commit**

```bash
git add web lib/server.js test/box-web.test.js
git commit -m "feat: add local sync management panel"
```

### Task 8: Add cross-platform installation, end-to-end verification and release documentation

**Files:**
- Create: `scripts/install.ps1`
- Create: `scripts/install.sh`
- Create: `.github/workflows/test.yml`
- Create: `test/e2e/portable-sync.test.js`
- Modify: `README.md`
- Modify: `package.json`

**Interfaces:**
- Produces: supported platform installation checks and a mock-provider end-to-end sync test runnable on Linux, macOS and Windows.

- [ ] **Step 1: Write an end-to-end mock-provider test**

```js
test('two devices round-trip project and session through a provider', async () => {
  const a = fixtureDevice('linux'); const b = fixtureDevice('win32');
  await a.core.track('/work/demo'); await a.core.push('demo');
  await b.core.pull('demo', 'C:\\work\\demo');
  assert.equal(fs.readFileSync(path.join(b.project, 'README.md'), 'utf8'), 'hello');
  assert.deepEqual(b.core.sessions('demo').map((x) => x.agent), ['codex']);
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `node --test test/e2e/portable-sync.test.js`
Expected: FAIL before fixture provider/device helpers exist.

- [ ] **Step 3: Implement installers and diagnostics**

Shell and PowerShell scripts check Node >=20 and restic, print official installation directions without downloading unverified binaries, create local config directories with restrictive permissions where supported, and run `ag-box doctor`.

- [ ] **Step 4: Implement CI matrix and end-to-end fixture helpers**

Run node tests on `ubuntu-latest`, `macos-latest`, and `windows-latest`; use a fake provider for E2E, so CI never needs cloud credentials. Keep Linux sandbox tests on Ubuntu only.

- [ ] **Step 5: Document migration and operator acceptance commands**

README must cover upgrading an existing Linux installation, self-hosted credentials, `serve`, project path mapping, supported agents, explicit lease takeover, unsupported sandbox commands, and a manual Linux/macOS/Windows smoke-test checklist.

- [ ] **Step 6: Run the complete verification set and commit**

Run: `npm test && node bin/ag-box --help`

```bash
git add scripts .github test/e2e README.md package.json
git commit -m "docs: publish cross-platform sync workflow"
```

## Plan self-review

- Spec coverage: Tasks 1–3 cover restic integrity, project identity, providers and exclusions; Task 4 covers all six required agent families; Task 5 preserves Linux runtime while enabling portable CLI; Tasks 6–7 cover secure local API/panel; Task 8 covers installers, platform verification and documentation.
- Placeholder scan: no deferred implementation placeholders are used; the only disabled path is the deliberate, tested `HostedProvider` boundary required by scope.
- Interface consistency: all task references use `ResticProvider`, `HostedProvider`, `project_id`, `createServer`, `TaskManager`, and adapter `{files, skipped}` outputs consistently.
