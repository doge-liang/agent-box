# ag-box sessions 跨机双向会话同步 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 ag-box 新增 `sessions` 子命令,把本地非盒项目的 claude 会话历史经 rclone crypt 加密同步到 R2,按机器命名空间 union,使任一机器的会话能在另一机器 `claude --resume` 续聊。

**Architecture:** 纯 Node(零第三方依赖)+ rclone 外部 CLI。新增五个 lib 模块:`sync-config`(独立配置)、`sync-identity`(项目/机器身份 + claude slug)、`session-rewrite`(cwd 前缀改写,纯函数)、`sync-plan`(增量/回声抑制/冲突判定,纯函数)、`rclone`(crypt 双层 remote env 注入封装),编排在 `sync-cmd`,bin 薄分发。同步为 state 驱动增量:pull 先落 cache 原件再改写落地,push 排除他机来源未续写文件。

**Tech Stack:** Node >= 20(CommonJS)、node:test、rclone(s3+crypt 双层 remote,纯 env 注入)。

**依据:** `../specs/2026-07-19-session-sync-design.md`(含文末"评审修订"规范性附录,冲突处以修订为准)+ `../reviews/2026-07-19-session-sync-review.md`。

## Global Constraints

- Node `>=20`,零第三方依赖(仅 Node 内置模块 + 外部 CLI rclone);CommonJS(`'use strict'` + `require`/`module.exports`)。
- 测试:`node:test` + `node:assert`,文件名 `test/box-<模块>.test.js`,全量运行 `node --test test/`。
- 新代码禁止硬编码 `/root`,路径一律 `os.homedir()` 推导;禁止读写 rclone.conf(remote 全经 `RCLONE_CONFIG_*` env 注入)。
- 口令绝不经 argv(仅 stdin/env);crypt PASSWORD 必须 obscure 形式(运行时 `rclone obscure -` 经 stdin 转换)。
- CLI 输出与错误信息为中文;错误统一由 bin 顶层打成 `box: <message>` 并退出非零。
- 不改变既有盒命令行为(dispatch 改造后现有命令语义零变化)。
- R2 布局 `sessions/<项目UUID>/<agent>/<机器ID>/<相对路径>`,MVP `<agent>` 固定 `claude`;push 只写本机命名空间,pull 只读他机命名空间;`_manifest.json` 与 `*.conflict.md` 永不进入同步文件集。
- mtime 比较容差 2500ms;本地文件 5 分钟活跃窗口内不覆盖。
- 提交信息风格:`feat(sessions): …` / `fix(sessions): …` / `docs(sessions): …` / `test(sessions): …`。

## 文件结构总览

| 文件 | 职责 |
|---|---|
| `lib/sync-config.js` | 独立配置目录(env/machine-id/projects.json/state)读写 |
| `lib/sync-identity.js` | `.agentsync` 项目 UUID、claude slug 规则 |
| `lib/session-rewrite.js` | 纯函数:cwd 前缀改写 |
| `lib/sync-plan.js` | 纯函数:push/pull 增量集、落地与 memory 冲突判定 |
| `lib/rclone.js` | crypt 双层 remote env 组装 + lsf/lsjson/copy/cat/rcat(runner 可注入) |
| `lib/sync-cmd.js` | init/push/pull/sync/list 编排(deps 可注入) |
| `lib/sh.js`(改) | `run` 增加 `maxBuffer` 选项 |
| `bin/ag-box`(改) | `sessions` 分发 + `noBoxConfig` 机制 + USAGE |
| `env.sessions.example` | 个人机配置样例 |

state 文件(`~/.config/agentsync/state/<uuid>.json`)schema:

```json
{
  "version": 1,
  "machines": { "<机器ID>": { "<rel>": { "size": 123, "mtimeMs": 1752900000000 } } },
  "landed":   { "<rel>": { "origin": "<机器ID>", "remoteMtimeMs": 0, "landedSize": 0, "landedMtimeMs": 0 } },
  "memory":   { "memory/<name>.md": { "baseline": "<sha256>", "lastRemote": "<sha256>" } }
}
```

`landed` 的哨兵值 `landedSize: -1, landedMtimeMs: -1` 表示"远端已见但本地未落地(本地更新/本地已改)"——planPush 视为需上传,planPull 在远端再变时才重判。

---

### Task 1: Spike——真机验证 cwd 改写 + 异项目落地 + resume(关键假设)

**Files:**
- Create: `docs/superpowers/plans/2026-07-19-session-sync-spike-notes.md`(记录实测结论)

**Interfaces:**
- Consumes: 无(本任务不写 lib 代码)
- Produces: spike 结论文档。**若核心假设失败,停止后续任务并上报调整设计**。

- [ ] **Step 1: 建测试项目并让 claude 登记它(trust + 项目条目 + slug 目录)**

```bash
mkdir -p /root/spike-session-sync && cd /root/spike-session-sync
claude -p 'reply with exactly: ok'
ls /root/.claude/projects/-root-spike-session-sync/
```

Expected: 输出 `ok`;slug 目录出现且含一个新 `<uuid>.jsonl`。

- [ ] **Step 2: 选一个他项目的小会话作供体并记录其 uuid 与 cwd**

```bash
DONOR=$(ls -S /root/.claude/projects/-root/*.jsonl | tail -1)
echo "$DONOR"
head -c 2000 "$DONOR" | python3 -c 'import sys,json; [print(json.loads(l).get("cwd"), json.loads(l).get("sessionId")) for l in sys.stdin if l.strip() and l.lstrip().startswith("{") and "cwd" in l]' 2>/dev/null | head -3
```

Expected: 打印供体的 cwd(应为 `/root`)与 sessionId。

- [ ] **Step 3: 前缀改写 cwd 并落入测试项目 slug 目录**

```bash
node -e '
const fs = require("fs");
const donor = process.argv[1];
const uuid = require("path").basename(donor, ".jsonl");
const oldRoot = "/root", newRoot = "/root/spike-session-sync";
const out = fs.readFileSync(donor, "utf8").split("\n").map((line) => {
  if (!line.includes("\"cwd\"")) return line;
  let rec; try { rec = JSON.parse(line); } catch { return line; }
  if (typeof rec.cwd !== "string") return line;
  if (rec.cwd !== oldRoot && !rec.cwd.startsWith(oldRoot + "/")) return line;
  rec.cwd = newRoot + rec.cwd.slice(oldRoot.length);
  return JSON.stringify(rec);
}).join("\n");
fs.writeFileSync(`/root/.claude/projects/-root-spike-session-sync/${uuid}.jsonl`, out);
console.log("landed:", uuid);
' "$DONOR"
```

Expected: 打印 `landed: <uuid>`。

- [ ] **Step 4: 核心验证——resume 该外来会话**

```bash
cd /root/spike-session-sync && claude -p --resume <上一步的uuid> 'reply with exactly: resumed'
```

Expected: 输出 `resumed` → **核心假设成立**。若报错(找不到会话/归属校验失败),记录完整报错,尝试:同时改写 `gitBranch` 为空、检查 `~/.claude.json` 中该项目条目差异;仍失败则停止,写明失败形态并上报。

- [ ] **Step 5: 观察 resume 的落盘形态(append 还是 fork)**

```bash
ls -lt /root/.claude/projects/-root-spike-session-sync/ | head -5
```

Expected(二选一,如实记录):供体 `<uuid>.jsonl` 变大(append),或出现新 uuid 文件(fork;此时 `head -1 新文件` 应含 `parentUuid`)。两种形态 union 同步都兜得住,但决定验收 3 的表述。

- [ ] **Step 6: 附带验证并记录**

逐项记录进 notes:① 本目录非 git 仓库而供体记录带 gitBranch,resume 是否受影响(Step 4 已隐式验证);② 交互式 `claude --resume` 列表是否显示该会话(人工肉眼确认一次);③ `subagents/` 子目录暂未同步验证,列为待办;④ Windows/Mac slug 规则本机无法验,列为跨平台收尾项。

- [ ] **Step 7: 写 spike 结论文档并提交**

`docs/superpowers/plans/2026-07-19-session-sync-spike-notes.md` 记录:每步命令、实际输出、结论(假设成立/需调整 + 调整点)。

```bash
cd /root/agent-box
git add docs/superpowers/plans/2026-07-19-session-sync-spike-notes.md
git commit -m "docs(sessions): spike 实测 cwd 改写落地 + resume 假设结论"
```

- [ ] **Step 8: 清理测试项目**

```bash
rm -rf /root/spike-session-sync /root/.claude/projects/-root-spike-session-sync
```

---

### Task 2: lib/sh.js 增加 maxBuffer 选项

**Files:**
- Modify: `lib/sh.js`(`run` 函数,第 5-23 行)
- Test: `test/box-sh.test.js`

**Interfaces:**
- Consumes: 现有 `run(cmd, args, opts)`
- Produces: `run` 新增 `opts.maxBuffer`(默认 `64 * 1024 * 1024`);其余行为不变。后续 `lib/rclone.js` 依赖此项。

- [ ] **Step 1: 写失败测试**

```js
// test/box-sh.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { run } = require('../lib/sh');

test('run: 默认 maxBuffer 允许超过 1MB 的 stdout', () => {
  const r = run(process.execPath, ['-e', 'process.stdout.write("x".repeat(2 * 1024 * 1024))']);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.length, 2 * 1024 * 1024);
});

test('run: maxBuffer 可显式收紧', () => {
  assert.throws(() => run(process.execPath,
    ['-e', 'process.stdout.write("x".repeat(64 * 1024))'], { maxBuffer: 1024 }));
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/box-sh.test.js`
Expected: FAIL(默认 1MB 上限使第一个用例 stdout 被截断/报 ENOBUFS)。

- [ ] **Step 3: 实现**

`lib/sh.js` 的 `run` 中解构处与 spawnSync 调用处各改一行:

```js
const { env, input, check = true, timeoutMs, inherit = false, maxBuffer = 64 * 1024 * 1024 } = opts;
const r = spawnSync(cmd, args, {
  encoding: 'utf8',
  env: env ? { ...process.env, ...env } : process.env,
  input,
  timeout: timeoutMs,
  maxBuffer,
  stdio: inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'],
});
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/box-sh.test.js`
Expected: PASS(2 个用例)。再跑全量 `node --test test/` 确认无回归。

- [ ] **Step 5: Commit**

```bash
git add lib/sh.js test/box-sh.test.js
git commit -m "feat(sessions): sh.run 增加 maxBuffer 选项(默认 64MB)"
```

---

### Task 3: lib/sync-identity.js——claude slug + .agentsync 项目身份

**Files:**
- Create: `lib/sync-identity.js`
- Test: `test/box-sync-identity.test.js`

**Interfaces:**
- Consumes: 无
- Produces: `claudeSlug(p) -> string`;`readProjectId(projectPath) -> string|null`(损坏抛错);`ensureProjectId(projectPath) -> {id, created}`;常量 `MARKER = '.agentsync'`。后续 Task 8-12 依赖。

- [ ] **Step 1: 写失败测试**

```js
// test/box-sync-identity.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { claudeSlug, readProjectId, ensureProjectId } = require('../lib/sync-identity');

test('claudeSlug: 所有非字母数字 → -(与 claude 实际规则一致,非 mounts.slugFor)', () => {
  assert.strictEqual(claudeSlug('/root/mobile-terminal-web'), '-root-mobile-terminal-web');
  assert.strictEqual(claudeSlug('/root/.claude/jobs/b42329e0/tmp'), '-root--claude-jobs-b42329e0-tmp');
  assert.strictEqual(claudeSlug('/root/my_proj'), '-root-my-proj');          // 下划线也替换
  assert.strictEqual(claudeSlug('C:\\Users\\x\\proj'), 'C--Users-x-proj');   // Windows 推断规则,spike 待验
});

test('readProjectId: 缺文件返回 null;损坏抛错;合法返回 id', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'si-'));
  assert.strictEqual(readProjectId(tmp), null);
  fs.writeFileSync(path.join(tmp, '.agentsync'), 'not json');
  assert.throws(() => readProjectId(tmp), /损坏/);
  fs.writeFileSync(path.join(tmp, '.agentsync'), JSON.stringify({ id: 'zzz' }));
  assert.throws(() => readProjectId(tmp), /损坏/);
  const id = '11111111-2222-3333-4444-555555555555';
  fs.writeFileSync(path.join(tmp, '.agentsync'), JSON.stringify({ id }));
  assert.strictEqual(readProjectId(tmp), id);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('ensureProjectId: 无则建 uuid,有则复用', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'si-'));
  const first = ensureProjectId(tmp);
  assert.strictEqual(first.created, true);
  assert.match(first.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  const again = ensureProjectId(tmp);
  assert.deepStrictEqual(again, { id: first.id, created: false });
  fs.rmSync(tmp, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/box-sync-identity.test.js`
Expected: FAIL with "Cannot find module '../lib/sync-identity'"。

- [ ] **Step 3: 实现**

```js
// lib/sync-identity.js
'use strict';
// 项目/机器身份。claudeSlug 是 claude 的真实目录编码规则(所有非字母数字 → '-',有损);
// 与 mounts.slugFor(仅替换 / 和 .,盒挂载专用)不同,勿混用。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MARKER = '.agentsync';
const claudeSlug = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function readProjectId(projectPath) {
  const p = path.join(projectPath, MARKER);
  if (!fs.existsSync(p)) return null;
  let data;
  try { data = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { throw new Error(`${p} 损坏:非合法 JSON`); }
  if (!data || typeof data.id !== 'string' || !UUID_RE.test(data.id)) throw new Error(`${p} 损坏:缺少合法 id`);
  return data.id;
}

function ensureProjectId(projectPath) {
  const existing = readProjectId(projectPath);
  if (existing) return { id: existing, created: false };
  const id = crypto.randomUUID();
  fs.writeFileSync(path.join(projectPath, MARKER), JSON.stringify({ id }, null, 2) + '\n');
  return { id, created: true };
}

module.exports = { MARKER, claudeSlug, readProjectId, ensureProjectId };
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/box-sync-identity.test.js`
Expected: PASS(3 个用例)。

- [ ] **Step 5: Commit**

```bash
git add lib/sync-identity.js test/box-sync-identity.test.js
git commit -m "feat(sessions): 项目/机器身份——claudeSlug 真实规则 + .agentsync UUID"
```

---

### Task 4: lib/session-rewrite.js——cwd 前缀改写(纯函数)

**Files:**
- Create: `lib/session-rewrite.js`
- Test: `test/box-session-rewrite.test.js`

**Interfaces:**
- Consumes: 无
- Produces: `rewriteCwd(text, oldRoot, newRoot, opts?) -> string`(opts: `{fromSep='/', toSep='/'}`);`mapPath(value, oldRoot, newRoot, fromSep, toSep) -> string|null`。Task 10 落地时调用。

- [ ] **Step 1: 写失败测试**

```js
// test/box-session-rewrite.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { rewriteCwd, mapPath } = require('../lib/session-rewrite');

test('mapPath: 前缀命中才替换;子目录保留;非命中/非字符串返回 null', () => {
  assert.strictEqual(mapPath('/a/p', '/a/p', '/b/q', '/', '/'), '/b/q');
  assert.strictEqual(mapPath('/a/p/sub', '/a/p', '/b/q', '/', '/'), '/b/q/sub');
  assert.strictEqual(mapPath('/a/pp', '/a/p', '/b/q', '/', '/'), null);   // /a/pp 不是 /a/p 的子路径
  assert.strictEqual(mapPath('/other', '/a/p', '/b/q', '/', '/'), null);
  assert.strictEqual(mapPath(undefined, '/a/p', '/b/q', '/', '/'), null);
});

test('mapPath: 跨平台分隔符转换(win → linux 与反向)', () => {
  assert.strictEqual(mapPath('C:\\U\\p\\sub\\d', 'C:\\U\\p', '/root/p', '\\', '/'), '/root/p/sub/d');
  assert.strictEqual(mapPath('/root/p/sub', '/root/p', 'C:\\U\\p', '/', '\\'), 'C:\\U\\p\\sub');
});

test('rewriteCwd: 只重写含 cwd 且命中的行;控制行/非 JSON 行/未命中行字节原样', () => {
  const lines = [
    JSON.stringify({ type: 'user', cwd: '/a/p', sessionId: 's1', gitBranch: 'main' }),
    JSON.stringify({ type: 'assistant', cwd: '/a/p/sub', sessionId: 's1' }),
    '{"type":"mode","mode":"default"}',                       // 无 cwd 控制行
    'not json at all',                                        // 非 JSON 行容错
    JSON.stringify({ type: 'system', cwd: '/elsewhere' }),    // cwd 未命中
    '',                                                       // 空行
  ];
  const out = rewriteCwd(lines.join('\n'), '/a/p', '/b/q').split('\n');
  assert.strictEqual(JSON.parse(out[0]).cwd, '/b/q');
  assert.strictEqual(JSON.parse(out[0]).gitBranch, 'main');   // 其余字段不动
  assert.strictEqual(JSON.parse(out[1]).cwd, '/b/q/sub');
  assert.strictEqual(out[2], lines[2]);                       // 字节原样
  assert.strictEqual(out[3], lines[3]);
  assert.strictEqual(out[4], lines[4]);
  assert.strictEqual(out[5], '');
});

test('rewriteCwd: cwd 出现在字符串值里但记录无顶层 cwd 字段 → 原样', () => {
  const line = JSON.stringify({ type: 'user', message: 'set \"cwd\" please' });
  assert.strictEqual(rewriteCwd(line, '/a', '/b'), line);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/box-session-rewrite.test.js`
Expected: FAIL with "Cannot find module '../lib/session-rewrite'"。

- [ ] **Step 3: 实现**

```js
// lib/session-rewrite.js
'use strict';
// 会话 JSONL 落地改写:把源机项目根前缀替换为本机项目根(仅顶层 cwd 字段)。
// 只重写"含 cwd 且前缀命中"的行;其余行字节原样透传,最小化 JSON 重序列化漂移面。
// 不改写历史 tool 输出中嵌的路径(已知限制:resume 后上下文中会出现他机路径)。
function mapPath(value, oldRoot, newRoot, fromSep, toSep) {
  if (typeof value !== 'string') return null;
  if (value !== oldRoot && !value.startsWith(oldRoot + fromSep)) return null;
  const rest = value.slice(oldRoot.length);
  return newRoot + (fromSep === toSep ? rest : rest.split(fromSep).join(toSep));
}

function rewriteCwd(text, oldRoot, newRoot, opts = {}) {
  const fromSep = opts.fromSep || '/';
  const toSep = opts.toSep || '/';
  return text.split('\n').map((line) => {
    if (!line.includes('"cwd"')) return line;
    let rec;
    try { rec = JSON.parse(line); } catch { return line; }
    if (!rec || typeof rec !== 'object') return line;
    const mapped = mapPath(rec.cwd, oldRoot, newRoot, fromSep, toSep);
    if (mapped === null) return line;
    rec.cwd = mapped;
    return JSON.stringify(rec);
  }).join('\n');
}

module.exports = { rewriteCwd, mapPath };
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/box-session-rewrite.test.js`
Expected: PASS(4 个用例)。

- [ ] **Step 5: Commit**

```bash
git add lib/session-rewrite.js test/box-session-rewrite.test.js
git commit -m "feat(sessions): rewriteCwd 前缀改写(命中行重写,余行字节透传)"
```

---

### Task 5: lib/sync-config.js——独立配置 + env.sessions.example

**Files:**
- Create: `lib/sync-config.js`
- Create: `env.sessions.example`
- Test: `test/box-sync-config.test.js`

**Interfaces:**
- Consumes: `lib/env.js` 的 `parseEnvFile(text)`(已存在,纯函数)
- Produces: `configDir()`、`claudeProjectsDir()`、`loadSessionsConfig() -> {backend, endpoint, bucket, localRoot, cryptPassword, cryptPassword2, accessKey, secretKey}`、`machineId() -> string`、`readProjects() -> {uuid: path}`、`writeProjects(map)`、`readState(uuid) -> state`、`writeState(uuid, state)`。`AGENTSYNC_DIR`/`AGENTSYNC_CLAUDE_DIR` 为测试种子。

- [ ] **Step 1: 写失败测试**

```js
// test/box-sync-config.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cfgMod = require('../lib/sync-config');

function withTmpDir(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-'));
  const prev = process.env.AGENTSYNC_DIR;
  process.env.AGENTSYNC_DIR = tmp;
  try { fn(tmp); } finally {
    if (prev === undefined) delete process.env.AGENTSYNC_DIR; else process.env.AGENTSYNC_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('loadSessionsConfig: 缺文件/缺键报错;s3 与 local 两种后端', () => {
  withTmpDir((tmp) => {
    assert.throws(() => cfgMod.loadSessionsConfig(), /缺少配置/);
    fs.writeFileSync(path.join(tmp, 'env'), 'SYNC_S3_ENDPOINT=https://x.r2.dev\n');
    assert.throws(() => cfgMod.loadSessionsConfig(), /配置缺少 SYNC_BUCKET/);
    fs.writeFileSync(path.join(tmp, 'env'), [
      'SYNC_S3_ENDPOINT=https://x.r2.dev', 'SYNC_BUCKET=agent-sessions',
      'AWS_ACCESS_KEY_ID=k', 'AWS_SECRET_ACCESS_KEY=s', 'SESSIONS_CRYPT_PASSWORD=pw',
    ].join('\n'));
    const cfg = cfgMod.loadSessionsConfig();
    assert.strictEqual(cfg.backend, 's3');
    assert.strictEqual(cfg.bucket, 'agent-sessions');
    assert.strictEqual(cfg.cryptPassword, 'pw');
    fs.writeFileSync(path.join(tmp, 'env'),
      'SYNC_BACKEND=local\nSYNC_LOCAL_ROOT=/tmp/store\nSESSIONS_CRYPT_PASSWORD=pw\n');
    assert.strictEqual(cfgMod.loadSessionsConfig().backend, 'local');
  });
});

test('machineId: 首次生成并持久化,再次读取同值', () => {
  withTmpDir(() => {
    const a = cfgMod.machineId();
    assert.match(a, /^[0-9a-f-]{36}$/);
    assert.strictEqual(cfgMod.machineId(), a);
  });
});

test('projects/state: 读写往返;缺失时给空默认', () => {
  withTmpDir(() => {
    assert.deepStrictEqual(cfgMod.readProjects(), {});
    cfgMod.writeProjects({ u1: '/a/b' });
    assert.deepStrictEqual(cfgMod.readProjects(), { u1: '/a/b' });
    const empty = cfgMod.readState('u1');
    assert.deepStrictEqual(empty, { version: 1, machines: {}, landed: {}, memory: {} });
    empty.machines.m1 = { 'x.jsonl': { size: 1, mtimeMs: 2 } };
    cfgMod.writeState('u1', empty);
    assert.deepStrictEqual(cfgMod.readState('u1').machines.m1['x.jsonl'], { size: 1, mtimeMs: 2 });
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/box-sync-config.test.js`
Expected: FAIL with "Cannot find module '../lib/sync-config'"。

- [ ] **Step 3: 实现**

```js
// lib/sync-config.js
'use strict';
// sessions 独立配置(~/.config/agentsync):与盒配置(BOX_ENV)完全解耦——
// 个人机只需本目录,不需要也不应持有 RESTIC_PASSWORD。
// AGENTSYNC_DIR / AGENTSYNC_CLAUDE_DIR 仅作测试与特殊部署的种子,常规使用勿设。
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { parseEnvFile } = require('./env');

const configDir = () => process.env.AGENTSYNC_DIR || path.join(os.homedir(), '.config', 'agentsync');
const claudeProjectsDir = () => process.env.AGENTSYNC_CLAUDE_DIR || path.join(os.homedir(), '.claude', 'projects');

const REQUIRED_S3 = ['SYNC_S3_ENDPOINT', 'SYNC_BUCKET', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'SESSIONS_CRYPT_PASSWORD'];
const REQUIRED_LOCAL = ['SYNC_LOCAL_ROOT', 'SESSIONS_CRYPT_PASSWORD'];

function loadSessionsConfig() {
  const p = path.join(configDir(), 'env');
  if (!fs.existsSync(p)) throw new Error(`缺少配置 ${p}(参考仓库 env.sessions.example,chmod 600)`);
  const kv = parseEnvFile(fs.readFileSync(p, 'utf8'));
  const backend = kv.SYNC_BACKEND || 's3';
  for (const k of (backend === 'local' ? REQUIRED_LOCAL : REQUIRED_S3)) {
    if (!kv[k]) throw new Error(`配置缺少 ${k}(${p})`);
  }
  return {
    backend,
    endpoint: kv.SYNC_S3_ENDPOINT || '',
    bucket: kv.SYNC_BUCKET || '',
    localRoot: kv.SYNC_LOCAL_ROOT || '',
    cryptPassword: kv.SESSIONS_CRYPT_PASSWORD,
    cryptPassword2: kv.SESSIONS_CRYPT_PASSWORD2 || '',
    accessKey: kv.AWS_ACCESS_KEY_ID || '',
    secretKey: kv.AWS_SECRET_ACCESS_KEY || '',
  };
}

function machineId() {
  const p = path.join(configDir(), 'machine-id');
  if (fs.existsSync(p)) {
    const id = fs.readFileSync(p, 'utf8').trim();
    if (id) return id;
  }
  const id = crypto.randomUUID();
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(p, id + '\n');
  return id;
}

function readProjects() {
  const p = path.join(configDir(), 'projects.json');
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeProjects(map) {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(path.join(configDir(), 'projects.json'), JSON.stringify(map, null, 2) + '\n');
}

const emptyState = () => ({ version: 1, machines: {}, landed: {}, memory: {} });

function readState(uuid) {
  const p = path.join(configDir(), 'state', `${uuid}.json`);
  if (!fs.existsSync(p)) return emptyState();
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return emptyState(); }
}

function writeState(uuid, state) {
  const dir = path.join(configDir(), 'state');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${uuid}.json`), JSON.stringify(state, null, 2) + '\n');
}

module.exports = { configDir, claudeProjectsDir, loadSessionsConfig, machineId, readProjects, writeProjects, readState, writeState };
```

`env.sessions.example`(仓库根):

```
# ~/.config/agentsync/env —— 复制后填实值,chmod 600
# sessions 跨机会话同步专用配置,与盒配置(/root/.config/box/env)相互独立;个人机只需本文件。
# SESSIONS_CRYPT_PASSWORD 丢失即不可解密 —— 与 RESTIC_PASSWORD 同等对待,务必离线备份。
# 安全建议:用独立桶 + 独立 R2 token(R2 只能按桶授权;与盒同桶时凭证泄露会暴露盒对象的完整性)。
SYNC_S3_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com
SYNC_BUCKET=agent-sessions
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
SESSIONS_CRYPT_PASSWORD=
# 可选:crypt 盐。启用后不可更换,须与主口令一同离线备份。
#SESSIONS_CRYPT_PASSWORD2=
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/box-sync-config.test.js`
Expected: PASS(3 个用例)。

- [ ] **Step 5: Commit**

```bash
git add lib/sync-config.js test/box-sync-config.test.js env.sessions.example
git commit -m "feat(sessions): 独立配置 ~/.config/agentsync(env/machine-id/projects/state)"
```

---

### Task 6: lib/rclone.js——crypt 双层 remote 封装(runner 可注入)

**Files:**
- Create: `lib/rclone.js`
- Test: `test/box-rclone.test.js`

**Interfaces:**
- Consumes: `lib/sh.js` 的 `run`(默认 runner);Task 5 的 cfg 对象形状
- Produces: `obscure(plain, runner?)`、`sessionEnv(cfg, runner?) -> env对象`、`remote(rel) -> 'SESSCRYPT:<rel>'`、`lsDirs(cfg, relDir, runner?) -> string[]`、`lsFiles(cfg, relDir, runner?) -> [{rel,size,mtimeMs}]`、`copyFiles(cfg, src, dst, rels, runner?)`、`catFile(cfg, relPath, runner?) -> string|null`、`rcatFile(cfg, relPath, content, runner?)`。runner 签名同 `run(cmd, args, opts)`。

- [ ] **Step 1: 写失败测试**

```js
// test/box-rclone.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const rcl = require('../lib/rclone');

// mock runner:记录调用,按 cmd/args 返回预置结果
function mockRunner(replies) {
  const calls = [];
  const fn = (cmd, args, opts = {}) => {
    calls.push({ cmd, args, opts });
    for (const [match, result] of replies) if (args.includes(match)) return result;
    return { status: 0, stdout: '', stderr: '' };
  };
  fn.calls = calls;
  return fn;
}

const S3CFG = { backend: 's3', endpoint: 'https://x.r2.dev', bucket: 'agent-sessions',
  cryptPassword: 'pw', cryptPassword2: '', accessKey: 'k', secretKey: 's', localRoot: '' };

test('obscure: 经 stdin 传口令,绝不经 argv', () => {
  const r = mockRunner([['obscure', { status: 0, stdout: 'OBS\n', stderr: '' }]]);
  assert.strictEqual(rcl.obscure('pw', r), 'OBS');
  assert.deepStrictEqual(r.calls[0].args, ['obscure', '-']);
  assert.strictEqual(r.calls[0].opts.input, 'pw');
  assert.ok(!r.calls[0].args.includes('pw'));
});

test('sessionEnv: s3 后端组装双层 remote;口令为 obscure 形式', () => {
  const r = mockRunner([['obscure', { status: 0, stdout: 'OBS\n', stderr: '' }]]);
  const env = rcl.sessionEnv(S3CFG, r);
  assert.strictEqual(env.RCLONE_CONFIG_SESSR2_TYPE, 's3');
  assert.strictEqual(env.RCLONE_CONFIG_SESSR2_PROVIDER, 'Cloudflare');
  assert.strictEqual(env.RCLONE_CONFIG_SESSCRYPT_TYPE, 'crypt');
  assert.strictEqual(env.RCLONE_CONFIG_SESSCRYPT_REMOTE, 'SESSR2:agent-sessions/sessions');
  assert.strictEqual(env.RCLONE_CONFIG_SESSCRYPT_PASSWORD, 'OBS');
  assert.strictEqual(env.RCLONE_CONFIG_SESSCRYPT_PASSWORD2, undefined);  // 未配盐则不注入
});

test('sessionEnv: local 后端 REMOTE 指向本地目录(无 s3 层)', () => {
  const r = mockRunner([['obscure', { status: 0, stdout: 'OBS\n', stderr: '' }]]);
  const env = rcl.sessionEnv({ ...S3CFG, backend: 'local', localRoot: '/tmp/store' }, r);
  assert.strictEqual(env.RCLONE_CONFIG_SESSR2_TYPE, undefined);
  assert.ok(env.RCLONE_CONFIG_SESSCRYPT_REMOTE.endsWith('sessions'));
});

test('lsFiles: 解析 lsjson;directory not found → [];其他错误抛出', () => {
  const ok = mockRunner([
    ['obscure', { status: 0, stdout: 'OBS\n', stderr: '' }],
    ['lsjson', { status: 0, stdout: JSON.stringify([
      { Path: 'a.jsonl', Size: 10, ModTime: '2026-07-19T00:00:00Z', IsDir: false }]), stderr: '' }],
  ]);
  assert.deepStrictEqual(rcl.lsFiles(S3CFG, 'u1/claude/m1', ok),
    [{ rel: 'a.jsonl', size: 10, mtimeMs: Date.parse('2026-07-19T00:00:00Z') }]);
  const missing = mockRunner([
    ['obscure', { status: 0, stdout: 'OBS\n', stderr: '' }],
    ['lsjson', { status: 3, stdout: '', stderr: 'error: directory not found' }],
  ]);
  assert.deepStrictEqual(rcl.lsFiles(S3CFG, 'u1/claude/m1', missing), []);
  const broken = mockRunner([
    ['obscure', { status: 0, stdout: 'OBS\n', stderr: '' }],
    ['lsjson', { status: 1, stdout: '', stderr: 'connection refused' }],
  ]);
  assert.throws(() => rcl.lsFiles(S3CFG, 'u1/claude/m1', broken), /connection refused/);
});

test('copyFiles: --files-from 列表文件包含全部 rel;空列表不调用 rclone', () => {
  const r = mockRunner([['obscure', { status: 0, stdout: 'OBS\n', stderr: '' }]]);
  let captured = null;
  const capturing = (cmd, args, opts) => {
    if (args[0] === 'copy') captured = fs.readFileSync(args[args.indexOf('--files-from') + 1], 'utf8');
    return r(cmd, args, opts);
  };
  capturing.calls = r.calls;
  rcl.copyFiles(S3CFG, '/src', 'SESSCRYPT:u1/claude/m1', ['a.jsonl', 'memory/x.md'], capturing);
  assert.strictEqual(captured, 'a.jsonl\nmemory/x.md\n');
  const before = r.calls.length;
  rcl.copyFiles(S3CFG, '/src', 'SESSCRYPT:u1/claude/m1', [], capturing);
  assert.strictEqual(r.calls.length, before);  // 空列表零调用
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/box-rclone.test.js`
Expected: FAIL with "Cannot find module '../lib/rclone'"。

- [ ] **Step 3: 实现**

```js
// lib/rclone.js
'use strict';
// sessions 专用 rclone 封装:crypt(SESSCRYPT)套 s3/local 双层 remote,
// 全部经 RCLONE_CONFIG_* 环境变量注入,不读写 rclone.conf。
// crypt 的 PASSWORD 必须是 obscure 形式:明文注入报 base64 decode 错,
// 明文恰为合法 base64 时更会静默用错密钥 —— 故运行时经 stdin 现场 obscure,
// 绝不经 argv 传口令(/proc/*/cmdline 可见)。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run } = require('./sh');

function obscure(plain, runner = run) {
  return runner('rclone', ['obscure', '-'], { input: plain }).stdout.trim();
}

function sessionEnv(cfg, runner = run) {
  const env = {
    RCLONE_CONFIG_SESSCRYPT_TYPE: 'crypt',
    RCLONE_CONFIG_SESSCRYPT_PASSWORD: obscure(cfg.cryptPassword, runner),
  };
  if (cfg.cryptPassword2) env.RCLONE_CONFIG_SESSCRYPT_PASSWORD2 = obscure(cfg.cryptPassword2, runner);
  if (cfg.backend === 'local') {
    env.RCLONE_CONFIG_SESSCRYPT_REMOTE = path.join(cfg.localRoot, 'sessions');
  } else {
    env.RCLONE_CONFIG_SESSR2_TYPE = 's3';
    env.RCLONE_CONFIG_SESSR2_PROVIDER = 'Cloudflare';
    env.RCLONE_CONFIG_SESSR2_ENDPOINT = cfg.endpoint;
    env.RCLONE_CONFIG_SESSR2_ACCESS_KEY_ID = cfg.accessKey;
    env.RCLONE_CONFIG_SESSR2_SECRET_ACCESS_KEY = cfg.secretKey;
    env.RCLONE_CONFIG_SESSR2_NO_CHECK_BUCKET = 'true';
    env.RCLONE_CONFIG_SESSCRYPT_REMOTE = `SESSR2:${cfg.bucket}/sessions`;
  }
  return env;
}

const remote = (rel) => `SESSCRYPT:${rel}`;

function rcloneError(op, r) {
  const tail = (r.stderr || '').trim().split('\n').pop() || `退出码 ${r.status}`;
  const e = new Error(`rclone ${op} 失败: ${tail}`);
  e.status = r.status;
  return e;
}

function lsDirs(cfg, relDir, runner = run) {
  const r = runner('rclone', ['lsf', '--dirs-only', remote(relDir)], { env: sessionEnv(cfg, runner), check: false });
  if (r.status !== 0) {
    if (/directory not found/i.test(r.stderr)) return [];
    throw rcloneError('lsf', r);
  }
  return r.stdout.split('\n').filter(Boolean).map((l) => l.replace(/\/$/, ''));
}

function lsFiles(cfg, relDir, runner = run) {
  const r = runner('rclone', ['lsjson', '-R', '--files-only', remote(relDir)], { env: sessionEnv(cfg, runner), check: false });
  if (r.status !== 0) {
    if (/directory not found/i.test(r.stderr)) return [];
    throw rcloneError('lsjson', r);
  }
  return JSON.parse(r.stdout || '[]').map((o) => ({ rel: o.Path, size: o.Size, mtimeMs: Date.parse(o.ModTime) }));
}

function copyFiles(cfg, src, dst, rels, runner = run) {
  if (!rels.length) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsync-'));
  const list = path.join(dir, 'files.txt');
  fs.writeFileSync(list, rels.join('\n') + '\n');
  try {
    runner('rclone', ['copy', src, dst, '--files-from', list], { env: sessionEnv(cfg, runner) });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function catFile(cfg, relPath, runner = run) {
  const r = runner('rclone', ['cat', remote(relPath)], { env: sessionEnv(cfg, runner), check: false });
  return r.status === 0 && r.stdout ? r.stdout : null;
}

function rcatFile(cfg, relPath, content, runner = run) {
  runner('rclone', ['rcat', remote(relPath)], { env: sessionEnv(cfg, runner), input: content });
}

module.exports = { obscure, sessionEnv, remote, lsDirs, lsFiles, copyFiles, catFile, rcatFile };
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/box-rclone.test.js`
Expected: PASS(5 个用例)。

- [ ] **Step 5: Commit**

```bash
git add lib/rclone.js test/box-rclone.test.js
git commit -m "feat(sessions): rclone crypt 双层 remote 封装(env 注入 + stdin obscure + runner 可注入)"
```

---

### Task 7: lib/sync-plan.js——增量/回声抑制/冲突判定(纯函数)

**Files:**
- Create: `lib/sync-plan.js`
- Test: `test/box-sync-plan.test.js`

**Interfaces:**
- Consumes: 无(纯函数,输入均为 plain object)
- Produces: `planPush({localFiles, landed}) -> string[]`;`planPull({remoteFiles, seen, landed}) -> {toDownload, toLand}`;`planSessionLanding({remote, local, nowMs, activeWindowMs?}) -> {action, reason?}`(action ∈ write/skip);`planMemoryLanding({localHash, remoteHash, baselineHash, lastRemoteHash}) -> {action, reason?}`(action ∈ write/skip/conflict/baseline);`isMemoryRel(rel)`、`isConflictFile(rel)`、常量 `MTIME_TOLERANCE_MS=2500`、`ACTIVE_WINDOW_MS=300000`。文件形状:`{rel, size, mtimeMs}`;landed 记录形状见文件结构总览。

- [ ] **Step 1: 写失败测试**

```js
// test/box-sync-plan.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const P = require('../lib/sync-plan');

const f = (rel, size, mtimeMs) => ({ rel, size, mtimeMs });

test('planPush: 本机原创全上传;他机来源未续写排除(回声抑制);续写过上传;排除 conflict/manifest', () => {
  const landed = {
    'foreign.jsonl': { origin: 'mB', remoteMtimeMs: 1000, landedSize: 50, landedMtimeMs: 1000 },
    'grown.jsonl': { origin: 'mB', remoteMtimeMs: 1000, landedSize: 50, landedMtimeMs: 1000 },
    'sentinel.jsonl': { origin: 'mB', remoteMtimeMs: 1000, landedSize: -1, landedMtimeMs: -1 },
  };
  const out = P.planPush({ localFiles: [
    f('mine.jsonl', 10, 5000),               // 无 landed → 本机原创 → 上传
    f('foreign.jsonl', 50, 1000),            // 与落地记录一致 → 回声,排除
    f('grown.jsonl', 80, 9000),              // 本机续写 → 上传
    f('sentinel.jsonl', 42, 800),            // 哨兵(本地更新未落地)→ 上传
    f('memory/a.mB.conflict.md', 5, 1),      // 冲突副本 → 永不上传
    f('_manifest.json', 5, 1),               // manifest → 排除
  ], landed });
  assert.deepStrictEqual(out, ['mine.jsonl', 'grown.jsonl', 'sentinel.jsonl']);
});

test('planPull: 首次全下载;size/mtime 有变才重下;toLand 按 landed.remoteMtimeMs 判', () => {
  const remoteFiles = [f('a.jsonl', 10, 1000), f('b.jsonl', 20, 2000), f('_manifest.json', 5, 1)];
  const first = P.planPull({ remoteFiles, seen: {}, landed: {} });
  assert.deepStrictEqual(first.toDownload, ['a.jsonl', 'b.jsonl']);
  assert.deepStrictEqual(first.toLand, ['a.jsonl', 'b.jsonl']);
  const second = P.planPull({ remoteFiles,
    seen: { 'a.jsonl': { size: 10, mtimeMs: 1000 }, 'b.jsonl': { size: 15, mtimeMs: 1500 } },
    landed: { 'a.jsonl': { origin: 'mB', remoteMtimeMs: 1000, landedSize: 10, landedMtimeMs: 1000 } } });
  assert.deepStrictEqual(second.toDownload, ['b.jsonl']);   // a 未变不重下
  assert.deepStrictEqual(second.toLand, ['b.jsonl']);       // a 已落地且远端未更新
});

test('planSessionLanding: 本地无→写;活跃窗口→跳;远端新→写;本地新→跳', () => {
  const now = 10 * 60 * 1000;
  assert.deepStrictEqual(P.planSessionLanding({ remote: f('x', 1, 1000), local: null, nowMs: now }),
    { action: 'write' });
  assert.deepStrictEqual(P.planSessionLanding({ remote: f('x', 1, 999999), local: { size: 1, mtimeMs: now - 1000 }, nowMs: now }),
    { action: 'skip', reason: 'active' });
  assert.deepStrictEqual(P.planSessionLanding({ remote: { size: 9, mtimeMs: 8000 }, local: { size: 1, mtimeMs: 1000 }, nowMs: now }),
    { action: 'write' });
  assert.deepStrictEqual(P.planSessionLanding({ remote: { size: 9, mtimeMs: 1000 }, local: { size: 1, mtimeMs: 8000 }, nowMs: now }),
    { action: 'skip', reason: 'older' });
});

test('planMemoryLanding: 全状态矩阵', () => {
  const H = { a: 'ha', b: 'hb', base: 'hbase' };
  // 两侧一致 → 记基线
  assert.deepStrictEqual(P.planMemoryLanding({ localHash: H.a, remoteHash: H.a }), { action: 'baseline' });
  // 本地不存在 → 落地
  assert.deepStrictEqual(P.planMemoryLanding({ localHash: null, remoteHash: H.a }), { action: 'write' });
  // 只有远端改(本地==基线)→ 覆盖
  assert.deepStrictEqual(P.planMemoryLanding({ localHash: H.base, remoteHash: H.a, baselineHash: H.base }), { action: 'write' });
  // 只有本地改(远端==lastRemote)→ 跳过,本地版留待 push
  assert.deepStrictEqual(P.planMemoryLanding({ localHash: H.a, remoteHash: H.base, baselineHash: H.base, lastRemoteHash: H.base }),
    { action: 'skip', reason: 'stale-remote' });
  // 双方都改 → 冲突
  assert.deepStrictEqual(P.planMemoryLanding({ localHash: H.a, remoteHash: H.b, baselineHash: H.base, lastRemoteHash: H.base }),
    { action: 'conflict' });
  // 无基线且两侧不同 → 保守按冲突
  assert.deepStrictEqual(P.planMemoryLanding({ localHash: H.a, remoteHash: H.b }), { action: 'conflict' });
  // 冲突已见过同一远端版本(lastRemote 未变)→ 不重复落盘
  assert.deepStrictEqual(P.planMemoryLanding({ localHash: H.a, remoteHash: H.b, lastRemoteHash: H.b }),
    { action: 'skip', reason: 'stale-remote' });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/box-sync-plan.test.js`
Expected: FAIL with "Cannot find module '../lib/sync-plan'"。

- [ ] **Step 3: 实现**

```js
// lib/sync-plan.js
'use strict';
// 同步计划(纯函数,不碰 fs/rclone):回声抑制 + union 增量 + memory 三态判定。
// 不变量:push 只上传本机原创或本机续写过的文件;pull 只处理相对 state 有变化的
// 他机文件 —— 否则 pull→改写→push 会把他机会话回传成回声,且 crypt 无 checksum
// (rclone 只比 size+modtime、改写必变大小)会恶化为每轮全量重传。
const MTIME_TOLERANCE_MS = 2500;        // FAT/exFAT 2s mtime 精度 + rclone 往返容差
const ACTIVE_WINDOW_MS = 5 * 60 * 1000; // 本地文件五分钟内有写入 → 视为正被 claude 续写

const isConflictFile = (rel) => /\.conflict\.md$/.test(rel);
const isMemoryRel = (rel) => rel.startsWith('memory/') && rel.endsWith('.md');
const isManifest = (rel) => rel === '_manifest.json';
const excluded = (rel) => isConflictFile(rel) || isManifest(rel);

function planPush({ localFiles, landed }) {
  const toUpload = [];
  for (const f of localFiles) {
    if (excluded(f.rel)) continue;
    const l = landed[f.rel];
    if (!l) { toUpload.push(f.rel); continue; }
    if (f.size !== l.landedSize || f.mtimeMs > l.landedMtimeMs + MTIME_TOLERANCE_MS) toUpload.push(f.rel);
  }
  return toUpload;
}

function planPull({ remoteFiles, seen, landed }) {
  const toDownload = [];
  const toLand = [];
  for (const f of remoteFiles) {
    if (excluded(f.rel)) continue;
    const s = seen[f.rel];
    if (!s || s.size !== f.size || Math.abs(s.mtimeMs - f.mtimeMs) > MTIME_TOLERANCE_MS) toDownload.push(f.rel);
    const l = landed[f.rel];
    if (!l || f.mtimeMs > l.remoteMtimeMs + MTIME_TOLERANCE_MS) toLand.push(f.rel);
  }
  return { toDownload, toLand };
}

function planSessionLanding({ remote, local, nowMs, activeWindowMs = ACTIVE_WINDOW_MS }) {
  if (!local) return { action: 'write' };
  if (nowMs - local.mtimeMs < activeWindowMs) return { action: 'skip', reason: 'active' };
  if (remote.mtimeMs > local.mtimeMs + MTIME_TOLERANCE_MS) return { action: 'write' };
  return { action: 'skip', reason: 'older' };
}

function planMemoryLanding({ localHash, remoteHash, baselineHash, lastRemoteHash }) {
  if (localHash === remoteHash) return { action: 'baseline' };
  if (localHash === null) return { action: 'write' };
  if (baselineHash && localHash === baselineHash) return { action: 'write' };
  if (remoteHash === lastRemoteHash) return { action: 'skip', reason: 'stale-remote' };
  return { action: 'conflict' };
}

module.exports = {
  planPush, planPull, planSessionLanding, planMemoryLanding,
  isMemoryRel, isConflictFile, MTIME_TOLERANCE_MS, ACTIVE_WINDOW_MS,
};
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/box-sync-plan.test.js`
Expected: PASS(4 个用例)。

- [ ] **Step 5: Commit**

```bash
git add lib/sync-plan.js test/box-sync-plan.test.js
git commit -m "feat(sessions): 同步计划纯函数(增量/回声抑制/memory 三态判定)"
```

---

### Task 8: sessions init/list + bin 分发(noBoxConfig)

**Files:**
- Create: `lib/sync-cmd.js`(本任务实现 init/list 与内部辅助;push/pull/sync 在 Task 9-11 补)
- Modify: `bin/ag-box`(`cmds` 表加 `sessions`、dispatch 改 `noBoxConfig`、`USAGE` 追加)
- Test: `test/box-sync-cmd.test.js`、`test/box-bin-dispatch.test.js`

**Interfaces:**
- Consumes: Task 3 `sync-identity`、Task 5 `sync-config`
- Produces: `lib/sync-cmd.js` 导出 `init(pathArg, deps?)`、`list(deps?)`(deps: `{log}`);`bin/ag-box` 的 `cmds.sessions`(二级动词分发)+ `cmds.sessions.noBoxConfig = true` + dispatch 行改为 `handler.noBoxConfig ? null : loadConfig()`。

- [ ] **Step 1: 写失败测试(sync-cmd)**

```js
// test/box-sync-cmd.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function withEnv(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scm-'));
  const saved = { AGENTSYNC_DIR: process.env.AGENTSYNC_DIR, AGENTSYNC_CLAUDE_DIR: process.env.AGENTSYNC_CLAUDE_DIR };
  process.env.AGENTSYNC_DIR = path.join(tmp, 'cfg');
  process.env.AGENTSYNC_CLAUDE_DIR = path.join(tmp, 'claude');
  fs.mkdirSync(process.env.AGENTSYNC_DIR, { recursive: true });
  try { fn(tmp); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('init: 建 .agentsync + 登记映射;重复 init 复用;git 带来的 .agentsync 直接采纳', () => {
  withEnv((tmp) => {
    const cmd = require('../lib/sync-cmd');
    const cfgMod = require('../lib/sync-config');
    const proj = path.join(tmp, 'proj');
    fs.mkdirSync(proj);
    const logs = [];
    assert.strictEqual(cmd.init(proj, { log: (m) => logs.push(m) }), 0);
    const marker = JSON.parse(fs.readFileSync(path.join(proj, '.agentsync'), 'utf8'));
    assert.deepStrictEqual(cfgMod.readProjects(), { [marker.id]: proj });
    cmd.init(proj, { log: (m) => logs.push(m) });                       // 幂等
    assert.deepStrictEqual(Object.keys(cfgMod.readProjects()), [marker.id]);
    const proj2 = path.join(tmp, 'proj2');
    fs.mkdirSync(proj2);
    fs.writeFileSync(path.join(proj2, '.agentsync'),
      JSON.stringify({ id: '99999999-8888-7777-6666-555555555555' }));  // 模拟随 git 到位
    cmd.init(proj2, { log: (m) => logs.push(m) });
    assert.strictEqual(cfgMod.readProjects()['99999999-8888-7777-6666-555555555555'], proj2);
  });
});

test('init: 目录不存在报错;slug 碰撞警告', () => {
  withEnv((tmp) => {
    const cmd = require('../lib/sync-cmd');
    assert.throws(() => cmd.init(path.join(tmp, 'nope'), { log: () => {} }), /目录不存在/);
    const a = path.join(tmp, 'x.y');
    const b = path.join(tmp, 'x-y');   // claudeSlug 相同(有损碰撞)
    fs.mkdirSync(a); fs.mkdirSync(b);
    const logs = [];
    cmd.init(a, { log: (m) => logs.push(m) });
    cmd.init(b, { log: (m) => logs.push(m) });
    assert.ok(logs.some((m) => m.includes('slug 相同')));
  });
});

test('list: 空提示;有项目则列出 uuid+路径+冲突数', () => {
  withEnv((tmp) => {
    const cmd = require('../lib/sync-cmd');
    const { claudeSlug } = require('../lib/sync-identity');
    let logs = [];
    cmd.list({ log: (m) => logs.push(m) });
    assert.ok(logs[0].includes('尚无同步项目'));
    const proj = path.join(tmp, 'proj');
    fs.mkdirSync(proj);
    cmd.init(proj, { log: () => {} });
    const memDir = path.join(process.env.AGENTSYNC_CLAUDE_DIR, claudeSlug(proj), 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, 'a.mB.conflict.md'), 'x');
    logs = [];
    cmd.list({ log: (m) => logs.push(m) });
    assert.ok(logs.some((m) => m.includes(proj) && m.includes('1 个 memory 冲突')));
  });
});
```

- [ ] **Step 2: 写失败测试(bin 分发)**

```js
// test/box-bin-dispatch.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin', 'ag-box');

function runBin(cliArgs, envExtra) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...cliArgs],
      { encoding: 'utf8', env: { ...process.env, ...envExtra } });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    return { status: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

test('sessions 不要求盒配置;盒命令仍要求', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-'));
  const env = {
    BOX_ENV: path.join(tmp, 'no-such-box-env'),          // 盒配置缺失
    AGENTSYNC_DIR: path.join(tmp, 'agentsync'),
    AGENTSYNC_CLAUDE_DIR: path.join(tmp, 'claude'),
  };
  fs.mkdirSync(env.AGENTSYNC_DIR, { recursive: true });
  const s = runBin(['sessions', 'list'], env);
  assert.strictEqual(s.status, 0);                        // sessions 可用
  assert.ok(s.stdout.includes('尚无同步项目'));
  const box = runBin(['ls'], env);
  assert.notStrictEqual(box.status, 0);                   // 盒命令行为不变:仍报缺配置
  const usage = runBin(['sessions', 'bogus'], env);
  assert.notStrictEqual(usage.status, 0);
  assert.ok(usage.stderr.includes('用法: ag-box sessions'));
  fs.rmSync(tmp, { recursive: true, force: true });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `node --test test/box-sync-cmd.test.js test/box-bin-dispatch.test.js`
Expected: FAIL("Cannot find module '../lib/sync-cmd'";bin 用例因 sessions 未挂载打 USAGE 退出)。

- [ ] **Step 4: 实现 lib/sync-cmd.js(init/list + 后续任务复用的辅助)**

```js
// lib/sync-cmd.js
'use strict';
// sessions 子命令编排。纯逻辑在 sync-plan/session-rewrite;本文件做 fs/rclone 粘合,
// deps 可注入(rclone/cfg/nowMs/log)便于单测。
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cfgMod = require('./sync-config');
const { claudeSlug, readProjectId, ensureProjectId } = require('./sync-identity');
const { rewriteCwd } = require('./session-rewrite');
const plan = require('./sync-plan');
const rcloneMod = require('./rclone');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const toFsPath = (base, rel) => path.join(base, ...rel.split('/'));

function* walkFiles(dir, base = dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* walkFiles(p, base);
    else if (ent.isFile()) yield path.relative(base, p).split(path.sep).join('/');
  }
}

function listLocalFiles(slugDir) {
  if (!fs.existsSync(slugDir)) return [];
  const out = [];
  for (const rel of walkFiles(slugDir)) {
    const st = fs.statSync(toFsPath(slugDir, rel));
    out.push({ rel, size: st.size, mtimeMs: st.mtimeMs });
  }
  return out;
}

function resolveProject(pathArg) {
  const projectPath = path.resolve(pathArg || process.cwd());
  const id = readProjectId(projectPath);
  if (!id) throw new Error(`${projectPath} 未初始化:先执行 ag-box sessions init`);
  if (cfgMod.readProjects()[id] !== projectPath) {
    throw new Error(`项目 ${id} 未在本机登记(或路径已变):先执行 ag-box sessions init`);
  }
  const slug = claudeSlug(projectPath);
  return { projectPath, id, slug, slugDir: path.join(cfgMod.claudeProjectsDir(), slug) };
}

function init(pathArg, deps = {}) {
  const log = deps.log || console.log;
  const projectPath = path.resolve(pathArg || process.cwd());
  if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
    throw new Error(`目录不存在: ${projectPath}`);
  }
  const { id, created } = ensureProjectId(projectPath);
  const map = cfgMod.readProjects();
  const slug = claudeSlug(projectPath);
  for (const [otherId, otherPath] of Object.entries(map)) {
    if (otherId !== id && claudeSlug(otherPath) === slug) {
      log(`警告: ${otherPath} 与本项目 slug 相同(claude 目录有损编码),两项目会话与 memory 会混居同一目录`);
    }
  }
  if (map[id] && map[id] !== projectPath) log(`提示: 项目路径由 ${map[id]} 更新为 ${projectPath}`);
  map[id] = projectPath;
  cfgMod.writeProjects(map);
  cfgMod.machineId();
  log(`${created ? '已创建' : '复用'} .agentsync,项目 ${id}`);
  log(`slug: ${slug}`);
  log('建议把 .agentsync 提交进项目 git,保证各机同一 UUID(各机各自 init 出不同 UUID 会被当作不同项目)');
  return 0;
}

function list(deps = {}) {
  const log = deps.log || console.log;
  const entries = Object.entries(cfgMod.readProjects());
  if (!entries.length) { log('尚无同步项目(用 ag-box sessions init 登记)'); return 0; }
  for (const [id, p] of entries) {
    const memDir = path.join(cfgMod.claudeProjectsDir(), claudeSlug(p), 'memory');
    const conflicts = fs.existsSync(memDir)
      ? fs.readdirSync(memDir).filter((f) => f.endsWith('.conflict.md')).length : 0;
    log(`${id}  ${p}${conflicts ? `  [${conflicts} 个 memory 冲突待合并]` : ''}`);
  }
  return 0;
}

module.exports = { init, list, resolveProject, listLocalFiles, sha256, toFsPath };
```

- [ ] **Step 5: 实现 bin/ag-box 改动**

顶部 require 区追加:

```js
const sessionsCmd = require('../lib/sync-cmd');
```

`USAGE` 追加一行(在现有命令列表末尾):

```
  sessions <init|push|pull|sync|list> [path]  跨机会话同步(非盒项目;独立配置 ~/.config/agentsync/env)
```

`cmds` 表追加(仿 `globals` 的二级动词范式):

```js
sessions: (cfg, args) => {
  const sub = args._[0];
  const pathArg = args._[1];
  const subs = {
    init: () => sessionsCmd.init(pathArg),
    list: () => sessionsCmd.list(),
    push: () => sessionsCmd.push(pathArg),
    pull: () => sessionsCmd.pull(pathArg),
    sync: () => sessionsCmd.sync(pathArg),
  };
  if (!subs[sub]) throw new Error('用法: ag-box sessions <init|push|pull|sync|list> [path]');
  return subs[sub]();
},
```

`cmds` 字面量之后、dispatch 之前加一行:

```js
cmds.sessions.noBoxConfig = true; // sessions 用独立配置,不要求盒 env 存在
```

dispatch 行(原 `process.exitCode = cmds[cmd](loadConfig(), parseArgs(rest)) || 0;`)改为:

```js
const handler = cmds[cmd];
process.exitCode = handler(handler.noBoxConfig ? null : loadConfig(), parseArgs(rest)) || 0;
```

注意:Task 9-11 完成前,`push/pull/sync` 在 `sync-cmd` 尚未导出,调用会以 `subs[sub] is not a function` 形式报错——本任务的测试只覆盖 init/list/用法错误,可接受;若希望报错友好,临时写成 `push: () => { throw new Error('push: 尚未实现'); }`,Task 9-11 再替换。

- [ ] **Step 6: 运行确认通过**

Run: `node --test test/box-sync-cmd.test.js test/box-bin-dispatch.test.js`
Expected: PASS。再跑全量 `node --test test/` 确认盒命令用例无回归。

- [ ] **Step 7: Commit**

```bash
git add lib/sync-cmd.js bin/ag-box test/box-sync-cmd.test.js test/box-bin-dispatch.test.js
git commit -m "feat(sessions): init/list 子命令 + bin 分发解耦盒配置(noBoxConfig)"
```

---

### Task 9: sessions push

**Files:**
- Modify: `lib/sync-cmd.js`(新增 `push`)
- Test: `test/box-sync-cmd.test.js`(追加用例)

**Interfaces:**
- Consumes: Task 5-8 全部;`plan.planPush`;`rclone` 的 `rcatFile/copyFiles/remote`
- Produces: `push(pathArg, deps?) -> 0`(deps: `{log, rclone, cfg}`)。R2 侧效果:`<uuid>/claude/<本机ID>/_manifest.json` + 增量文件。

- [ ] **Step 1: 追加失败测试**

```js
// 追加到 test/box-sync-cmd.test.js
function fakeRclone() {
  const calls = { rcat: [], copy: [] };
  return {
    calls,
    remote: (rel) => `SESSCRYPT:${rel}`,
    rcatFile: (cfg, relPath, content) => calls.rcat.push({ relPath, content }),
    copyFiles: (cfg, src, dst, rels) => calls.copy.push({ src, dst, rels }),
    lsDirs: () => [], lsFiles: () => [], catFile: () => null,
  };
}
const FAKE_CFG = { backend: 'local', localRoot: '/unused', cryptPassword: 'pw', cryptPassword2: '' };

test('push: 写 manifest + 增量上传;排除他机来源未续写与 conflict 文件', () => {
  withEnv((tmp) => {
    const cmd = require('../lib/sync-cmd');
    const cfgMod = require('../lib/sync-config');
    const { claudeSlug } = require('../lib/sync-identity');
    const proj = path.join(tmp, 'proj');
    fs.mkdirSync(proj);
    cmd.init(proj, { log: () => {} });
    const id = JSON.parse(fs.readFileSync(path.join(proj, '.agentsync'), 'utf8')).id;
    const slugDir = path.join(process.env.AGENTSYNC_CLAUDE_DIR, claudeSlug(proj));
    fs.mkdirSync(path.join(slugDir, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(slugDir, 'mine.jsonl'), 'x'.repeat(10));
    fs.writeFileSync(path.join(slugDir, 'foreign.jsonl'), 'y'.repeat(50));
    fs.writeFileSync(path.join(slugDir, 'memory', 'a.mB.conflict.md'), 'z');
    // 预置 state:foreign.jsonl 为他机来源且与落地记录一致(回声必须被抑制)
    const st = fs.statSync(path.join(slugDir, 'foreign.jsonl'));
    const state = cfgMod.readState(id);
    state.landed['foreign.jsonl'] = { origin: 'mB', remoteMtimeMs: 1, landedSize: st.size, landedMtimeMs: st.mtimeMs };
    cfgMod.writeState(id, state);
    const rcl = fakeRclone();
    assert.strictEqual(cmd.push(proj, { log: () => {}, rclone: rcl, cfg: FAKE_CFG }), 0);
    const mid = cfgMod.machineId();
    assert.strictEqual(rcl.calls.rcat.length, 1);
    assert.strictEqual(rcl.calls.rcat[0].relPath, `${id}/claude/${mid}/_manifest.json`);
    const manifest = JSON.parse(rcl.calls.rcat[0].content);
    assert.strictEqual(manifest.root, proj);
    assert.strictEqual(manifest.sep, path.sep);
    assert.deepStrictEqual(rcl.calls.copy[0].rels, ['mine.jsonl']);   // 只传本机原创
    assert.strictEqual(rcl.calls.copy[0].dst, `SESSCRYPT:${id}/claude/${mid}`);
  });
});

test('push: 未 init 报错', () => {
  withEnv((tmp) => {
    const cmd = require('../lib/sync-cmd');
    const proj = path.join(tmp, 'raw');
    fs.mkdirSync(proj);
    assert.throws(() => cmd.push(proj, { log: () => {}, rclone: fakeRclone(), cfg: FAKE_CFG }), /先执行 ag-box sessions init/);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/box-sync-cmd.test.js`
Expected: FAIL("cmd.push is not a function" 或 Task 8 的占位报错)。

- [ ] **Step 3: 实现 push(加入 lib/sync-cmd.js,并更新 module.exports)**

```js
function push(pathArg, deps = {}) {
  const log = deps.log || console.log;
  const rcl = deps.rclone || rcloneMod;
  const cfg = deps.cfg || cfgMod.loadSessionsConfig();
  const { projectPath, id, slug, slugDir } = resolveProject(pathArg);
  const mid = cfgMod.machineId();
  const state = cfgMod.readState(id);
  const localFiles = listLocalFiles(slugDir);
  const toUpload = plan.planPush({ localFiles, landed: state.landed });
  const ns = `${id}/claude/${mid}`;
  rcl.rcatFile(cfg, `${ns}/_manifest.json`, JSON.stringify({
    version: 1, root: projectPath, slug, sep: path.sep,
    platform: process.platform, hostname: os.hostname(), pushedAt: new Date().toISOString(),
  }) + '\n');
  rcl.copyFiles(cfg, slugDir, rcl.remote(ns), toUpload);
  log(`push 完成: 上传 ${toUpload.length} 个文件(本地共 ${localFiles.length} 个)`);
  return 0;
}

module.exports = { init, list, push, resolveProject, listLocalFiles, sha256, toFsPath };
```

同时把 Task 8 中 bin 的 `push` 占位(若采用)替换为 `push: () => sessionsCmd.push(pathArg)`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/box-sync-cmd.test.js`
Expected: PASS(含新增 2 用例)。

- [ ] **Step 5: Commit**

```bash
git add lib/sync-cmd.js bin/ag-box test/box-sync-cmd.test.js
git commit -m "feat(sessions): push——manifest + planPush 增量上传(回声抑制)"
```

---

### Task 10: sessions pull(落地/改写/冲突/state)

**Files:**
- Modify: `lib/sync-cmd.js`(新增 `pull` 与 `landOne`/`recordLanded`/`recordSentinel` 内部函数)
- Test: `test/box-sync-cmd.test.js`(追加用例)

**Interfaces:**
- Consumes: 全部前置任务;`plan.planPull/planSessionLanding/planMemoryLanding`;`rewriteCwd`
- Produces: `pull(pathArg, deps?) -> 0|3`(3 = 有 memory 冲突待人工合并;deps 另支持 `nowMs`)。本地效果:他机会话落进 slug 目录(cwd 已改写、mtime 回写),memory 冲突落 `<name>.<机器ID前8>.conflict.md`,state 更新。cache 目录 `<configDir>/cache/<uuid>/<机器ID>/` 保存未改写原件。

- [ ] **Step 1: 追加失败测试**

```js
// 追加到 test/box-sync-cmd.test.js
// fakeRclone 扩展:catFile 返回 manifest,lsDirs/lsFiles 返回预置清单,
// copyFiles(pull 方向)把 fixtures 写进 cacheDir 模拟下载。
function fakePullRclone({ origin, manifest, files, fixtures }) {
  const calls = { copy: [] };
  return {
    calls,
    remote: (rel) => `SESSCRYPT:${rel}`,
    rcatFile: () => {},
    lsDirs: () => [origin],
    catFile: (cfg, relPath) => relPath.endsWith('_manifest.json') ? JSON.stringify(manifest) : null,
    lsFiles: () => files,
    copyFiles: (cfg, src, dstDir, rels) => {
      if (!rels.length) return;              // 与真实实现一致:空列表零调用(否则二次 pull 的零下载断言失效)
      calls.copy.push({ src, dstDir, rels });
      for (const rel of rels) {
        const p = path.join(dstDir, ...rel.split('/'));
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, fixtures[rel].content);
        fs.utimesSync(p, new Date(fixtures[rel].mtimeMs), new Date(fixtures[rel].mtimeMs));
      }
    },
  };
}

test('pull: 落地他机会话(cwd 改写 + mtime 回写)、memory 冲突落 .conflict、state 更新、退出码 3', () => {
  withEnv((tmp) => {
    const cmd = require('../lib/sync-cmd');
    const cfgMod = require('../lib/sync-config');
    const { claudeSlug } = require('../lib/sync-identity');
    const proj = path.join(tmp, 'proj');
    fs.mkdirSync(proj);
    cmd.init(proj, { log: () => {} });
    const id = JSON.parse(fs.readFileSync(path.join(proj, '.agentsync'), 'utf8')).id;
    const slugDir = path.join(process.env.AGENTSYNC_CLAUDE_DIR, claudeSlug(proj));
    fs.mkdirSync(path.join(slugDir, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(slugDir, 'memory', 'MEMORY.md'), '# local edit\n'); // 本地已有且与远端不同,无基线 → 冲突
    const macRoot = '/Users/x/proj';
    const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const sessionLine = JSON.stringify({ type: 'user', cwd: macRoot + '/sub', sessionId: uuid });
    const T = Date.parse('2026-07-19T00:00:00Z');
    const rcl = fakePullRclone({
      origin: 'mac-1111',
      manifest: { version: 1, root: macRoot, slug: 'x', sep: '/', platform: 'darwin' },
      files: [
        { rel: `${uuid}.jsonl`, size: sessionLine.length + 1, mtimeMs: T },
        { rel: 'memory/MEMORY.md', size: 9, mtimeMs: T },
        { rel: '_manifest.json', size: 5, mtimeMs: T },
      ],
      fixtures: {
        [`${uuid}.jsonl`]: { content: sessionLine + '\n', mtimeMs: T },
        'memory/MEMORY.md': { content: '# remote\n', mtimeMs: T },
      },
    });
    const logs = [];
    const code = cmd.pull(proj, { log: (m) => logs.push(m), rclone: rcl, cfg: FAKE_CFG, nowMs: () => T + 60 * 60 * 1000 });
    assert.strictEqual(code, 3);                                             // 有冲突
    const landed = fs.readFileSync(path.join(slugDir, `${uuid}.jsonl`), 'utf8');
    assert.strictEqual(JSON.parse(landed.trim()).cwd, path.join(proj, 'sub')); // cwd 前缀改写 + 分隔符转换
    assert.strictEqual(fs.statSync(path.join(slugDir, `${uuid}.jsonl`)).mtimeMs, T); // mtime 回写
    assert.strictEqual(fs.readFileSync(path.join(slugDir, 'memory', 'MEMORY.md'), 'utf8'), '# local edit\n'); // 本地不被覆盖
    assert.ok(fs.existsSync(path.join(slugDir, 'memory', 'MEMORY.mac-1111.conflict.md')));
    const state = cfgMod.readState(id);
    assert.ok(state.machines['mac-1111'][`${uuid}.jsonl`]);
    assert.strictEqual(state.landed[`${uuid}.jsonl`].origin, 'mac-1111');
    // 再次 pull:远端无变化 → 零下载、不重复落冲突
    const before = rcl.calls.copy.length;
    assert.strictEqual(cmd.pull(proj, { log: () => {}, rclone: rcl, cfg: FAKE_CFG, nowMs: () => T + 2 * 60 * 60 * 1000 }), 0);
    assert.strictEqual(rcl.calls.copy.length, before);
    assert.strictEqual(fs.readdirSync(path.join(slugDir, 'memory')).filter((f) => f.includes('conflict')).length, 1);
  });
});

test('pull: 活跃窗口内的本地文件跳过覆盖', () => {
  withEnv((tmp) => {
    const cmd = require('../lib/sync-cmd');
    const { claudeSlug } = require('../lib/sync-identity');
    const proj = path.join(tmp, 'proj');
    fs.mkdirSync(proj);
    cmd.init(proj, { log: () => {} });
    const slugDir = path.join(process.env.AGENTSYNC_CLAUDE_DIR, claudeSlug(proj));
    fs.mkdirSync(slugDir, { recursive: true });
    const T = Date.parse('2026-07-19T00:00:00Z');
    fs.writeFileSync(path.join(slugDir, 'active.jsonl'), 'local\n');
    fs.utimesSync(path.join(slugDir, 'active.jsonl'), new Date(T), new Date(T));  // 本地 mtime = T(nowMs 附近 → 活跃)
    const rcl = fakePullRclone({
      origin: 'mB',
      manifest: { version: 1, root: '/other', sep: '/' },
      files: [{ rel: 'active.jsonl', size: 7, mtimeMs: T + 100000 }],
      fixtures: { 'active.jsonl': { content: 'remote\n', mtimeMs: T + 100000 } },
    });
    const logs = [];
    cmd.pull(proj, { log: (m) => logs.push(m), rclone: rcl, cfg: FAKE_CFG, nowMs: () => T + 1000 });
    assert.strictEqual(fs.readFileSync(path.join(slugDir, 'active.jsonl'), 'utf8'), 'local\n'); // 未覆盖
    assert.ok(logs.some((m) => m.includes('跳过')));
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/box-sync-cmd.test.js`
Expected: FAIL("cmd.pull is not a function" 或占位报错)。

- [ ] **Step 3: 实现 pull(加入 lib/sync-cmd.js,并更新 module.exports)**

```js
function activeWindowMs() {
  // AGENTSYNC_ACTIVE_WINDOW_MS 仅供测试收窄/关闭活跃窗口
  const v = process.env.AGENTSYNC_ACTIVE_WINDOW_MS;
  return v === undefined ? plan.ACTIVE_WINDOW_MS : Number(v);
}

function recordLanded(state, rel, f, origin, dstPath) {
  const st = fs.statSync(dstPath);
  state.landed[rel] = { origin, remoteMtimeMs: f.mtimeMs, landedSize: st.size, landedMtimeMs: st.mtimeMs };
}

// 哨兵:远端此版本已评估但本地未落地(本地更新/本地已改)——planPush 视为需上传,
// planPull 在远端再变前不再重判。
function recordSentinel(state, rel, f, origin) {
  state.landed[rel] = { origin, remoteMtimeMs: f.mtimeMs, landedSize: -1, landedMtimeMs: -1 };
}

function landOne({ rel, f, cachePath, dstPath, origin, manifest, projectPath, state, nowMs, log }) {
  fs.mkdirSync(path.dirname(dstPath), { recursive: true });
  if (plan.isMemoryRel(rel)) {
    const remoteBuf = fs.readFileSync(cachePath);
    const remoteHash = sha256(remoteBuf);
    const localHash = fs.existsSync(dstPath) ? sha256(fs.readFileSync(dstPath)) : null;
    const mem = state.memory[rel] || (state.memory[rel] = {});
    const d = plan.planMemoryLanding({ localHash, remoteHash, baselineHash: mem.baseline, lastRemoteHash: mem.lastRemote });
    mem.lastRemote = remoteHash;
    if (d.action === 'conflict') {
      const base = rel.slice('memory/'.length, -'.md'.length);
      const conflictPath = path.join(path.dirname(dstPath), `${base}.${origin.slice(0, 8)}.conflict.md`);
      fs.writeFileSync(conflictPath, remoteBuf);
      recordSentinel(state, rel, f, origin);
      log(`memory 冲突: ${rel} → 远端版已存为 ${path.basename(conflictPath)},本地未覆盖,请人工合并`);
      return 1;
    }
    if (d.action === 'write') { fs.writeFileSync(dstPath, remoteBuf); mem.baseline = remoteHash; recordLanded(state, rel, f, origin, dstPath); }
    else if (d.action === 'baseline') { mem.baseline = remoteHash; recordLanded(state, rel, f, origin, dstPath); }
    else recordSentinel(state, rel, f, origin); // skip: 本地更新,留待 push
    return 0;
  }
  const localSt = fs.existsSync(dstPath) ? fs.statSync(dstPath) : null;
  const d = plan.planSessionLanding({
    remote: { size: f.size, mtimeMs: f.mtimeMs },
    local: localSt && { size: localSt.size, mtimeMs: localSt.mtimeMs },
    nowMs: nowMs(), activeWindowMs: activeWindowMs(),
  });
  if (d.action === 'skip') {
    if (d.reason === 'active') log(`跳过 ${rel}: 本地五分钟内有写入(可能正被续写),下次 pull 重试`);
    else recordSentinel(state, rel, f, origin);  // 本地更新:远端此版本不再重判
    return 0;
  }
  if (rel.endsWith('.jsonl')) {
    const text = fs.readFileSync(cachePath, 'utf8');
    fs.writeFileSync(dstPath, rewriteCwd(text, manifest.root, projectPath, { fromSep: manifest.sep || '/', toSep: path.sep }));
  } else {
    fs.copyFileSync(cachePath, dstPath);
  }
  fs.utimesSync(dstPath, new Date(f.mtimeMs), new Date(f.mtimeMs));
  recordLanded(state, rel, f, origin, dstPath);
  return 0;
}

function pull(pathArg, deps = {}) {
  const log = deps.log || console.log;
  const rcl = deps.rclone || rcloneMod;
  const cfg = deps.cfg || cfgMod.loadSessionsConfig();
  const nowMs = deps.nowMs || Date.now;
  const { projectPath, id, slugDir } = resolveProject(pathArg);
  const mid = cfgMod.machineId();
  const state = cfgMod.readState(id);
  const origins = rcl.lsDirs(cfg, `${id}/claude`).filter((m) => m !== mid);
  if (!origins.length) { log('pull: 远端暂无他机数据'); return 0; }
  let conflicts = 0;
  try {
    for (const origin of origins) {
      const ns = `${id}/claude/${origin}`;
      const manifestText = rcl.catFile(cfg, `${ns}/_manifest.json`);
      if (!manifestText) { log(`跳过 ${origin}: 无 _manifest.json(对端未完成 push)`); continue; }
      let manifest;
      try { manifest = JSON.parse(manifestText); } catch { log(`跳过 ${origin}: _manifest.json 损坏`); continue; }
      const remoteFiles = rcl.lsFiles(cfg, ns);
      const seen = state.machines[origin] || (state.machines[origin] = {});
      const { toDownload, toLand } = plan.planPull({ remoteFiles, seen, landed: state.landed });
      const cacheDir = path.join(cfgMod.configDir(), 'cache', id, origin);
      fs.mkdirSync(cacheDir, { recursive: true });
      const missingFromCache = toLand.filter((rel) => !toDownload.includes(rel) && !fs.existsSync(toFsPath(cacheDir, rel)));
      const downloads = [...new Set([...toDownload, ...missingFromCache])];
      rcl.copyFiles(cfg, rcl.remote(ns), cacheDir, downloads);
      const byRel = new Map(remoteFiles.map((x) => [x.rel, x]));
      for (const rel of downloads) {
        const x = byRel.get(rel);
        if (x) seen[rel] = { size: x.size, mtimeMs: x.mtimeMs };
      }
      for (const rel of toLand) {
        const x = byRel.get(rel);
        const cachePath = toFsPath(cacheDir, rel);
        if (!x || !fs.existsSync(cachePath)) continue;
        conflicts += landOne({
          rel, f: x, cachePath, dstPath: toFsPath(slugDir, rel),
          origin, manifest, projectPath, state, nowMs, log,
        });
      }
    }
  } finally {
    cfgMod.writeState(id, state);   // 中断也持久化已完成部分;seen 滞后只会多下一次,不丢数据
  }
  if (conflicts) { log(`pull 完成,但有 ${conflicts} 个 memory 冲突待人工合并(*.conflict.md)`); return 3; }
  log('pull 完成');
  return 0;
}

module.exports = { init, list, push, pull, resolveProject, listLocalFiles, sha256, toFsPath };
```

同时替换 bin 的 `pull` 占位(若采用)。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/box-sync-cmd.test.js`
Expected: PASS(含新增 2 用例)。

- [ ] **Step 5: Commit**

```bash
git add lib/sync-cmd.js bin/ag-box test/box-sync-cmd.test.js
git commit -m "feat(sessions): pull——cache 增量下载 + cwd 改写落地 + memory 冲突 + state"
```

---

### Task 11: sessions sync + 退出码贯通

**Files:**
- Modify: `lib/sync-cmd.js`(新增 `sync`)
- Test: `test/box-sync-cmd.test.js`(追加用例)

**Interfaces:**
- Consumes: Task 9-10 的 `push`/`pull`
- Produces: `sync(pathArg, deps?) -> 0|3`(push 后 pull,返回二者最大退出码)。bin 的 `cmds[cmd](...) || 0` 原样把 3 传为进程退出码。

- [ ] **Step 1: 追加失败测试**

```js
// 追加到 test/box-sync-cmd.test.js
test('sync: push 后 pull;pull 冲突码透传', () => {
  withEnv((tmp) => {
    const cmd = require('../lib/sync-cmd');
    const proj = path.join(tmp, 'proj');
    fs.mkdirSync(proj);
    cmd.init(proj, { log: () => {} });
    const order = [];
    const deps = {
      log: () => {}, cfg: FAKE_CFG,
      rclone: {
        remote: (rel) => `SESSCRYPT:${rel}`,
        rcatFile: () => order.push('push-manifest'),
        copyFiles: () => order.push('copy'),
        lsDirs: () => { order.push('pull-ls'); return []; },
        lsFiles: () => [], catFile: () => null,
      },
    };
    assert.strictEqual(cmd.sync(proj, deps), 0);
    assert.deepStrictEqual(order, ['push-manifest', 'copy', 'pull-ls']);
  });
});
```

注意:fake 的 `copyFiles` 无条件记 `'copy'`——真实实现里空列表不调用 rclone,但 `sync-cmd.push` 总会调用 `rcl.copyFiles`(由 rclone 层决定是否真正 spawn),故顺序断言成立。

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/box-sync-cmd.test.js`
Expected: FAIL("cmd.sync is not a function")。

- [ ] **Step 3: 实现**

```js
function sync(pathArg, deps = {}) {
  const a = push(pathArg, deps);
  const b = pull(pathArg, deps);
  return Math.max(a, b);
}

module.exports = { init, list, push, pull, sync, resolveProject, listLocalFiles, sha256, toFsPath };
```

同时替换 bin 的 `sync` 占位(若采用)。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/box-sync-cmd.test.js`,然后全量 `node --test test/`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/sync-cmd.js bin/ag-box test/box-sync-cmd.test.js
git commit -m "feat(sessions): sync 子命令(push 后 pull,冲突码透传)"
```

---

### Task 12: 端到端测试(local 后端,双机模拟,真 rclone)

**Files:**
- Test: `test/box-sessions-e2e.test.js`

**Interfaces:**
- Consumes: 完整 CLI(`bin/ag-box sessions …`)+ 真实 rclone 二进制 + `SYNC_BACKEND=local`
- Produces: 无新代码;验证全链路(crypt 加密、manifest、cwd 改写、回声抑制、双向续写、memory 冲突、退出码)。

- [ ] **Step 1: 写测试**

```js
// test/box-sessions-e2e.test.js
'use strict';
// 端到端:同一台机器上用 AGENTSYNC_DIR/AGENTSYNC_CLAUDE_DIR 模拟 A/B 两台机器,
// SYNC_BACKEND=local 用本地目录代替 R2(crypt 层照常加密)。需要 rclone 二进制。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { claudeSlug } = require('../lib/sync-identity');

let hasRclone = true;
try { execFileSync('rclone', ['version'], { stdio: 'ignore' }); } catch { hasRclone = false; }

const BIN = path.join(__dirname, '..', 'bin', 'ag-box');

function countStoreObjects(store) {
  let n = 0;
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (ent.isDirectory()) walk(path.join(d, ent.name)); else n++;
    }
  };
  walk(store);
  return n;
}

test('sessions 双机端到端', { skip: !hasRclone && 'rclone 不可用' }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-e2e-'));
  const store = path.join(tmp, 'store');
  const mkMachine = (name) => {
    const dir = path.join(tmp, name);
    const cfgDir = path.join(dir, 'agentsync');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'env'),
      `SYNC_BACKEND=local\nSYNC_LOCAL_ROOT=${store}\nSESSIONS_CRYPT_PASSWORD=e2e-secret\n`);
    return {
      proj: path.join(dir, 'proj'),
      claude: path.join(dir, 'claude-projects'),
      env: {
        ...process.env,
        AGENTSYNC_DIR: cfgDir,
        AGENTSYNC_CLAUDE_DIR: path.join(dir, 'claude-projects'),
        AGENTSYNC_ACTIVE_WINDOW_MS: '0',                 // e2e 文件都是刚写的,关闭活跃窗口
        BOX_ENV: path.join(dir, 'no-box-env'),           // 证明不需要盒配置
      },
    };
  };
  const ag = (m, ...cliArgs) => {
    try {
      return { status: 0, out: execFileSync(process.execPath, [BIN, 'sessions', ...cliArgs], { env: m.env, cwd: m.proj, encoding: 'utf8' }) };
    } catch (e) { return { status: e.status, out: (e.stdout || '') + (e.stderr || '') }; }
  };
  const A = mkMachine('A'), B = mkMachine('B');
  fs.mkdirSync(A.proj, { recursive: true }); fs.mkdirSync(B.proj, { recursive: true });

  // init 两机;.agentsync 随"git"到 B
  assert.strictEqual(ag(A, 'init').status, 0);
  fs.copyFileSync(path.join(A.proj, '.agentsync'), path.join(B.proj, '.agentsync'));
  assert.strictEqual(ag(B, 'init').status, 0);

  // A 机造会话 + memory
  const aSlug = path.join(A.claude, claudeSlug(A.proj));
  fs.mkdirSync(path.join(aSlug, 'memory'), { recursive: true });
  const uuid = '11111111-2222-3333-4444-555555555555';
  fs.writeFileSync(path.join(aSlug, `${uuid}.jsonl`),
    JSON.stringify({ type: 'user', cwd: A.proj, sessionId: uuid }) + '\n' + '{"type":"mode","mode":"x"}\n');
  // 回拨 A 会话文件 mtime:后续"B 续写 → A pull 最后写胜"的判定带 2.5s 容差,
  // 测试全程在数秒内跑完,不回拨会导致远端不比本地"新",落地被误跳过。
  const OLD = Date.now() - 3600 * 1000;
  fs.utimesSync(path.join(aSlug, `${uuid}.jsonl`), new Date(OLD), new Date(OLD));
  fs.writeFileSync(path.join(aSlug, 'memory', 'MEMORY.md'), '# from A\n');
  assert.strictEqual(ag(A, 'push').status, 0);
  assert.ok(countStoreObjects(store) >= 3);              // manifest + 会话 + memory(密文对象)

  // B pull:落地 + cwd 改写 + 控制行原样
  assert.strictEqual(ag(B, 'pull').status, 0);
  const bSlug = path.join(B.claude, claudeSlug(B.proj));
  const landed = fs.readFileSync(path.join(bSlug, `${uuid}.jsonl`), 'utf8');
  assert.strictEqual(JSON.parse(landed.split('\n')[0]).cwd, B.proj);
  assert.strictEqual(landed.split('\n')[1], '{"type":"mode","mode":"x"}');
  assert.strictEqual(fs.readFileSync(path.join(bSlug, 'memory', 'MEMORY.md'), 'utf8'), '# from A\n');

  // 回声抑制:B push 不应把 A 的会话再传进 B 命名空间(对象数只多 B 的 manifest)
  const before = countStoreObjects(store);
  assert.strictEqual(ag(B, 'push').status, 0);
  assert.strictEqual(countStoreObjects(store), before + 1);

  // B 续写 → push;A pull 拿到续写(双向)
  fs.appendFileSync(path.join(bSlug, `${uuid}.jsonl`),
    JSON.stringify({ type: 'assistant', cwd: B.proj, sessionId: uuid }) + '\n');
  assert.strictEqual(ag(B, 'push').status, 0);
  assert.strictEqual(ag(A, 'pull').status, 0);
  const back = fs.readFileSync(path.join(aSlug, `${uuid}.jsonl`), 'utf8').trim().split('\n');
  assert.strictEqual(back.length, 3);
  assert.strictEqual(JSON.parse(back[2]).cwd, A.proj);   // B 的续写行 cwd 已改回 A 路径

  // memory 双改 → 冲突:退出码 3、本地不覆盖、.conflict 落盘
  fs.writeFileSync(path.join(aSlug, 'memory', 'MEMORY.md'), '# from A v2\n');
  fs.writeFileSync(path.join(bSlug, 'memory', 'MEMORY.md'), '# from B v2\n');
  assert.strictEqual(ag(A, 'push').status, 0);
  const r = ag(B, 'pull');
  assert.strictEqual(r.status, 3);
  assert.strictEqual(fs.readFileSync(path.join(bSlug, 'memory', 'MEMORY.md'), 'utf8'), '# from B v2\n');
  assert.strictEqual(fs.readdirSync(path.join(bSlug, 'memory')).filter((f) => f.endsWith('.conflict.md')).length, 1);

  // 加密可见性:store 里不应出现明文文件名
  const names = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); names.push(e.name); if (e.isDirectory()) walk(p); } };
  walk(store);
  assert.ok(!names.some((n) => n.includes(uuid) || n.includes('MEMORY') || n === '_manifest.json'));

  fs.rmSync(tmp, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行**

Run: `node --test test/box-sessions-e2e.test.js`
Expected: PASS(本机已装 rclone v1.74.3;无 rclone 环境自动 skip)。若失败,按 superpowers:systematic-debugging 排查——常见点:crypt REMOTE 路径、obscure、`--files-from` 相对路径、utimes 时机。

- [ ] **Step 3: 全量回归**

Run: `node --test test/`
Expected: 全部 PASS。

- [ ] **Step 4: Commit**

```bash
git add test/box-sessions-e2e.test.js
git commit -m "test(sessions): local 后端双机端到端(加密/改写/回声抑制/双向/冲突)"
```

---

### Task 13: 文档 + 真机 R2 验收清单

**Files:**
- Modify: `README.md`(新增 "sessions——跨机会话同步" 章节)
- Create: `docs/superpowers/plans/2026-07-19-session-sync-acceptance.md`(真机验收清单)

**Interfaces:**
- Consumes: 全部已实现功能
- Produces: 用户可依文档独立完成两机配置与验收。

- [ ] **Step 1: README 章节**

在 README 现有命令文档之后新增章节,内容必须包含:

```markdown
## sessions——跨机会话同步(非盒项目)

把个人机/服务器上**未 track 成盒**的本地项目的 claude 会话历史,加密同步到 R2,
任一机器开的会话可在另一机器 `claude --resume` 续聊。与盒功能相互独立:
不需要 bwrap/systemd,不需要盒配置,跨平台(Linux/Mac 验证,Windows 实验性)。

### 配置(每台机器一次)

1. 安装 rclone(个人机唯一外部依赖)。
2. `cp env.sessions.example ~/.config/agentsync/env && chmod 600 ~/.config/agentsync/env`,填入
   R2 endpoint、桶名、S3 凭证与 `SESSIONS_CRYPT_PASSWORD`。
   - **强烈建议独立桶 + 独立 token**(R2 只能按桶授权;与盒同桶时,该凭证可覆盖/删除盒对象)。
   - **SESSIONS_CRYPT_PASSWORD 丢失即全部不可解密,务必离线备份**(与 RESTIC_PASSWORD 同等对待)。

### 使用

    ag-box sessions init [path]   # 项目根建 .agentsync(UUID)+ 登记本机路径;建议把 .agentsync 提交进项目 git
    ag-box sessions push [path]   # 本机该项目会话上传到本机命名空间
    ag-box sessions pull [path]   # 拉他机命名空间会话,改写 cwd 落进本机 ~/.claude/projects/<slug>/
    ag-box sessions sync [path]   # push 后 pull
    ag-box sessions list          # 已登记项目 + 待合并冲突数

### 已知限制(MVP)

- 只同步 claude(codex/grok 留后);手动命令,无守护进程。
- 无删除传播:本地删除的会话不会删远端/他机。
- 同一 session 双机并发续写:最后写胜(极罕见)。
- memory 双机并发修改:远端版落 `<name>.<机器ID>.conflict.md`,人工合并;MEMORY.md 属高频冲突点。
- 落地只改写记录的 cwd 字段;历史 tool 输出里的他机路径原样保留。
- pull 不覆盖 5 分钟内有写入的本地会话文件(防与正在续写的 claude 交错),下次 pull 重试。
- machine-id 随 VM 镜像克隆会碰撞(两机互认同一命名空间),克隆后删 `~/.config/agentsync/machine-id` 重新生成。
- Windows:slug 规则未实测,列为实验性;`node bin\ag-box` 或 npm shim 方式运行。
```

- [ ] **Step 2: 真机验收清单**

`docs/superpowers/plans/2026-07-19-session-sync-acceptance.md`,内容:

```markdown
# sessions 真机 R2 验收清单(对应 spec 验收标准,修订版措辞)

前置:R2 建独立桶 `agent-sessions` + 独立 token;两台机器按 README 配置。

- [ ] AC1 机器 A 某项目 `sessions init && sessions push` 后,用裸 s3 凭证
      `rclone lsf :s3,provider=Cloudflare,endpoint=…,access_key_id=…,secret_access_key=…:agent-sessions/sessions -R`
      能看到对象存在且**文件名不可读**(密文)。
- [ ] AC2 机器 B 同项目(`.agentsync` 随 git 到位)`init && pull` 后,
      `~/.claude/projects/<B-slug>/` 出现 A 的会话;B 上 `claude --resume` 能列出并续上。
- [ ] AC3 B 续聊后 `push`,A `pull` 拿到 B 的续写;不同 uuid 互不覆盖,同 uuid 按最后写胜。
- [ ] AC4 A、B 同时改同名 memory 文件 → pull 侧落 `<name>.<机器ID>.conflict.md`、
      本地不被覆盖、命令退出码 3 且有提示。
- [ ] AC5 个人机配置目录无 RESTIC_PASSWORD;sessions 凭证访问不了盒桶(独立桶时天然成立)。
- [ ] AC6 Linux ↔ Linux 跑通(MVP 门槛);Mac 手动验 slug/路径映射;Windows 后置(spike 项)。
```

- [ ] **Step 3: Commit**

```bash
git add README.md docs/superpowers/plans/2026-07-19-session-sync-acceptance.md
git commit -m "docs(sessions): README 使用文档 + 真机 R2 验收清单"
```

- [ ] **Step 4: 收尾**

全量测试最后一遍 `node --test test/`,然后按 superpowers:finishing-a-development-branch 处理分支(push `feat/session-sync`、开 PR)。

---

## 自审记录(writing-plans Self-Review)

1. **Spec 覆盖**:命令五件套(Task 8-11)、身份(Task 3/5)、R2 布局与加密(Task 6)、同步语义修订版(Task 7/9/10)、错误处理(各任务错误分支 + 退出码)、测试(每任务 TDD + Task 12 e2e)、验收(Task 13 清单)、spike(Task 1,列为第一步,符合 spec"实现第一步就做 spike")。`<agent>` 布局层以 `claude` 字面固定在路径模板中,codex/grok 留后——与分期一致。
2. **占位符扫描**:无 TBD/TODO;所有代码步骤给出完整代码;Task 8 的 push/pull/sync 占位有明确的替换任务(Task 9-11)并在各任务 Step 3 中显式提及。
3. **类型/签名一致性**:`{rel, size, mtimeMs}` 文件形状、state schema、`landed` 哨兵 `-1`、`rewriteCwd(text, oldRoot, newRoot, {fromSep, toSep})`、deps 注入形状 `{log, rclone, cfg, nowMs}` 在 Task 7/9/10/11/12 间已交叉核对一致;`rcl.remote` 经注入对象调用(fake 亦提供),不依赖真模块。
