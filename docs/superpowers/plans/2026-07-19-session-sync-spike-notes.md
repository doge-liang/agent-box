# Spike 实测记录:cwd 改写 + 异项目落地 + `claude --resume`

> 对应 `docs/superpowers/plans/2026-07-19-session-sync.md` Task 1。
> 执行环境:本机(agent-box 所在容器/主机),`claude --version` = `2.1.215 (Claude Code)`,`node` 可用,`/root/agent-box` 为当前工作目录。
> 执行日期:2026-07-20。

## 结论先行

**核心假设成立(含语义续接验证):** 把他项目的 session `.jsonl` 拷贝进目标项目的 `~/.claude/projects/<slug>/` 目录、并把每条记录的 `cwd` 字段前缀由旧项目根替换为新项目根后,`claude --resume <uuid>` 在新项目目录下**一次成功**,无需任何 fallback(未触发 Step 4 描述的"改写 gitBranch/查 `~/.claude.json`"兜底路径)。

Step 4 起初只用了 brief 里给的 `'reply with exactly: resumed'` 验证"文件被接受"这一层(见下文 Step 4 记录),但这个 prompt 本身不需要任何历史上下文即可回答,不足以证明**语义续接**(模型是否真的看到了历史对话)。为堵住这个漏洞,补做了第二轮验证:重新落地同一供体后,用 `claude -p --resume <uuid> '你在本次对话中最先问了我什么?原文引用。'`(实际用的是等价的英文 prompt,见下文)提问,模型**逐字引用了供体会话真实的第一条用户消息**(`帮我在term 2那台机器上安装claude code codex grok build`),且新追加的 `user` 记录 `parentUuid` 精确指向落地文件里紧邻其前的最后一条记录 uuid——两点合起来证明:落地后 resume 不仅"文件被接受",而且**完整历史对话内容被正确加载进上下文**。

**落地形态:** **append-same-file**,不是 fork。resume 产生的新记录(`assistant`/`last-prompt`/`ai-title`/`mode`/`permission-mode`)直接追加进同一个 `<uuid>.jsonl`,`sessionId` 不变,新增的 `assistant` 记录 `parentUuid` 正常指向对话链上一条,`cwd` 字段等于我们改写后的新值(说明 resume 时是从"落地时的最后一条记录"取 cwd 延续,而不是重新探测当前 shell cwd 或恢复成旧值)。这与计划文档 state schema 里 `landed` 的假设(落地后该文件按目标项目的 cwd 继续写)一致,**无需处理 fork 场景**(但计划里"union 兜两种形态"仍建议保留,因为不同版本/不同触发方式不排除会 fork)。

## 逐步记录

### Step 1: 建测试项目并让 claude 登记它

```bash
mkdir -p /root/spike-session-sync && cd /root/spike-session-sync
claude -p 'reply with exactly: ok'
ls /root/.claude/projects/-root-spike-session-sync/
```

实际输出:
```
ok
```
```
memory/
55566ded-5dae-41c8-94a6-38a62cccae5b.jsonl
```

结论:符合预期。slug 目录 `-root-spike-session-sync` 自动创建,内含一个新 `<uuid>.jsonl`。**额外发现**:目录里还自动出现了一个 `memory/` 子目录(空),之前的实施计划未提及,建议同步工具对 `memory/` 目录的处理与 state schema 里已有的 `memory` 分区保持一致(计划文档已经有 `memory/<name>.md` 相关设计,这里只是确认该子目录在纯 headless `-p` 模式下也会被创建)。

### Step 2: 选一个他项目的小会话作供体

```bash
DONOR=$(ls -S /root/.claude/projects/-root/*.jsonl | tail -1)
echo "$DONOR"
```

实际结果:`ls -S | tail -1` 选中的最小文件是
`/root/.claude/projects/-root/84ece570-6825-4e08-887b-cc0b90032227.jsonl`(15419 字节)。

**偏差与适配(需记录):** 逐行解析该文件发现它**不含任何 `user`/`assistant` 类型记录**,只有 `agent-setting`/`mode`/`permission-mode`/`file-history-snapshot`/`attachment`/`system`/`last-prompt` 这些引导型记录(说明这是一个从未真正产生过对话内容的空会话,`-root` 目录下还躺着一个同名 `*.orphaned-<ts>-<hash>.jsonl` 伴生文件,大小几乎相同,推测是某次异常退出/去重后的残留)。用它做 resume 验证信号很弱(无法证明"续接历史上下文"这件事,只能证明"文件能被识别")。

于是**适配**:改选 `-root` 目录下次小、且含真实对话轮次的文件
`68632d6d-cbbf-4493-a859-a456dabe3332.jsonl`(248515 字节,`type` 分布 `user:15 assistant:39 attachment:20 ...`)作为实际供体,后续 Step 3~6 均基于此文件。

供体元信息(逐行解析取样):
```
cwd = /root
sessionId = 68632d6d-cbbf-4493-a859-a456dabe3332
gitBranch = HEAD
```

补充核查:`/root` 与 `/root/spike-session-sync` 在本机**均不是 git 仓库**(`git rev-parse --is-inside-work-tree` 均报 `fatal: not a git repository`),但供体记录里 `gitBranch` 却是字符串 `"HEAD"`。说明 `gitBranch` 字段并非"真实分支名是否存在"的强校验字段,即使目录当前不是 git 仓库,该字段留着旧值也不影响后续 resume(见 Step 4/Step 6①)。

### Step 3: 前缀改写 cwd 并落入测试项目 slug 目录

用计划里给的 Node 脚本(`oldRoot="/root"`, `newRoot="/root/spike-session-sync"`)逐行处理供体文件,把 `cwd === "/root"` 或以 `"/root/"` 开头的记录替换前缀,原样保留非 cwd 行,写入 `/root/.claude/projects/-root-spike-session-sync/68632d6d-cbbf-4493-a859-a456dabe3332.jsonl`。

实际输出:
```
landed: 68632d6d-cbbf-4493-a859-a456dabe3332
```

校验:落地文件里 `"cwd"` 出现 80 次,`grep -o '"cwd":"[^"]*"' | sort -u` 结果唯一为 `"cwd":"/root/spike-session-sync"`——改写完全生效,无遗漏、无误伤其他字段。

### Step 4: 核心验证——resume 该外来会话

```bash
cd /root/spike-session-sync && claude -p --resume 68632d6d-cbbf-4493-a859-a456dabe3332 'reply with exactly: resumed'
```

实际输出:
```
resumed
```
exit code 0。**一次成功,未触发任何 fallback**(未需要清空 gitBranch,未需要动 `~/.claude.json`)。

这一步只证明"落地文件被 `--resume <uuid>` 正确匹配并接受",还不足以证明模型看到了历史对话内容(见下方"语义续接补充验证")。

#### 语义续接补充验证(自我审查后补做,advisor 建议)

`'reply with exactly: resumed'` 这个 prompt 无需任何历史上下文就能正确回答,不能区分"resume 只是新起一轮对话、恰好 uuid 对上了"与"resume 真的加载了完整历史"。为此重复了一遍 Step 1~3(重新 `mkdir` 测试项目、重新用同一供体改写落地),然后换成需要历史信息才能答对的 prompt:

```bash
cd /root/spike-session-sync && claude -p --resume 68632d6d-cbbf-4493-a859-a456dabe3332 \
  'What was the very first thing I asked you in this conversation? Quote it exactly, in the original language.'
```

实际输出:
```
你在本次对话中最先说的是:

> 帮我在term 2那台机器上安装claude code codex grok build
```

用 Step 2 里独立提取的供体第一条 `user` 消息原文核对,**完全一致**(`帮我在term 2那台机器上安装claude code codex grok build`)。另外核查了落地文件在改写后、resume 前的最后一条记录 uuid 为 `51e82a5f-54d8-4142-a9f4-c86c64c6ee57`(类型 `system`);resume 追加的新 `user` 记录 `parentUuid` 精确等于这个值(`grep` 定位到该记录,`type:"user"`,`content` 为上面的英文提问原文,`cwd:"/root/spike-session-sync"`),证明是接着落地文件的最后一条记录线性续写,不是另起对话链。

**核心假设成立,且是语义层面的成立**(模型可见并正确引用了历史对话内容),不只是"文件被识别接受"这层弱验证。验证完成后按 Step 8 再次清理了测试目录,并确认供体源文件 md5 与验证前一致(未被污染)。

### Step 5: 观察 resume 的落盘形态(append 还是 fork)

```bash
ls -lt /root/.claude/projects/-root-spike-session-sync/ | head -5
```

实际输出(节选):
```
-rw-r--r-- 1 root root 263591 Jul 20 08:50 68632d6d-cbbf-4493-a859-a456dabe3332.jsonl
-rw------- 1 root root  39105 Jul 20 08:49 55566ded-5dae-41c8-94a6-38a62cccae5b.jsonl
drwxr-xr-x 2 root root   4096 Jul 20 08:49 memory
```

**没有出现新 uuid 文件**——供体文件本身从 250035 字节长大到 263591 字节。取文件尾部逐条解析确认:
- 新追加的 `assistant` 记录:`sessionId` 仍为 `68632d6d-cbbf-4493-a859-a456dabe3332`(不变),`cwd = /root/spike-session-sync`(等于我们改写后的值,不是恢复成旧的 `/root`),`gitBranch = HEAD`(照旧,无报错),`parentUuid` 指向对话链上一条真实消息 uuid(说明是接着旧历史线性续写,不是另起一条新链)。
- `content` 为 `[{"type":"text","text":"resumed"}]`,与预期回复一致。
- 随后还追加了 `last-prompt`/`ai-title`/`mode`/`permission-mode` 几类引导记录(和 Step 1 新建会话时出现的记录类型一致,是每次交互都会写的元记录,不代表分叉)。

**结论:append-same-file。** 这对同步工具是好消息:落地文件与 resume 续写共用同一 `sessionId`/同一文件名,不需要额外处理"resume 产生了游离的新 session 文件"这种情况;但计划里仍建议保留对 fork 场景的兼容(不同触发路径、未来版本变化不能完全排除)。

### Step 6: 附带验证并记录

① **本目录非 git 仓库,供体记录带 gitBranch,是否影响 resume**:已在 Step 2/4 隐式验证——`/root` 与 `/root/spike-session-sync` 都不是 git 仓库,供体 `gitBranch` 字段值为 `"HEAD"`,resume 全程无报错、无警告,新追加记录 `gitBranch` 依旧原样为 `"HEAD"`。**结论:gitBranch 字段与目标目录是否真的是 git 仓库无强绑定校验,同步/落地时无需专门清空或处理该字段。**

② **交互式 `claude --resume` 列表人工确认**:**待人工确认**(不可脚本化,未执行,避免终端挂起;需要人工在交互终端里跑一次 `claude --resume`,肉眼确认 `-root-spike-session-sync` 项目下能看到该会话条目及标题/摘要是否合理)。

③ **`subagents/` 子目录同步**:本次 spike 未包含子代理场景的落地测试,但顺带在真实项目里核实了其目录结构(供后续任务设计参考):
```
~/.claude/projects/<slug>/<父会话uuid>/subagents/agent-<hash>.jsonl
~/.claude/projects/<slug>/<父会话uuid>/subagents/agent-<hash>.meta.json
```
样例(`-root-spika-marzban` 项目下):
```
/root/.claude/projects/-root-spika-marzban/7d7a66a9-.../subagents/agent-a6b6fc4ffdc4b92d1.jsonl
/root/.claude/projects/-root-spika-marzban/7d7a66a9-.../subagents/agent-a6b6fc4ffdc4b92d1.meta.json
```
子代理 jsonl 首行同样带 `cwd`(取值等于父会话 cwd,即 `/root/spika-marzban-dev`)与 `sessionId`(等于**父会话** uuid,不是子代理自己的 uuid),说明子代理记录也需要同样的 cwd 前缀改写规则,且改写时要按父会话 uuid 归属做目录级搬迁(而不是按文件名)。`.meta.json`(内容形如 `{"agentType":"Explore","description":"...","toolUseId":"...","spawnDepth":1}`)不含 cwd,理论上原样跟随复制即可,无需改写。**列为待办:后续 Task 需专门为 `<uuid>/subagents/*.jsonl` 补一轮改写 + resume 验证(现有 spike 只覆盖了顶层 `<uuid>.jsonl` 这一种落地对象)。**

④ **Windows/Mac slug 规则**:本机是 Linux,无法在本次 spike 中实测其他平台的路径→slug 转换规则(尤其 Windows 盘符、反斜杠转正斜杠等边界)。**列为跨平台收尾项**,留给后续任务(或专门的跨平台验证 spike)处理。

### 额外发现:`~/.claude.json` 项目注册表与 resume 无关

核查 `~/.claude.json` 的 `projects` 字段(9 个已注册项目),**未发现 `/root/spike-session-sync` 的条目**——即便 Step 1 用 `claude -p` 在该目录跑过一次并生成了 slug 目录和 session 文件。对照之下 `/root` 本身有条目(来自此前的交互式使用),内容主要是 `allowedTools`/`mcpServers`/`hasTrustDialogAccepted`/`lastCost` 等统计与信任状态字段,并不包含 session 索引信息。

**结论:`claude --resume` 的会话定位完全依赖 `~/.claude/projects/<slug>/<uuid>.jsonl` 文件本身(按 slug 目录扫描 + uuid 匹配文件名),不依赖 `~/.claude.json` 里是否存在该项目条目。** 这意味着同步工具**不需要**同时读写 `~/.claude.json` 来完成 resume 场景的落地,只需保证目标 slug 目录下存在正确改写过 cwd 的 `.jsonl` 文件。(`~/.claude.json` 条目会影响 trust dialog、MCP 配置等其他行为,但不在本 spike 验证范围内,如后续任务涉及交互式启动体验,可另行评估。)

## Step 8: 清理

执行:
```bash
rm -rf /root/spike-session-sync /root/.claude/projects/-root-spike-session-sync
```
清理后确认两个路径均不存在;未触碰任何原有(供体来源)`~/.claude/projects/-root/` 下的文件——供体文件全程只读拷贝,未修改、未删除。

## 对后续任务(Task 2+)的影响

1. **cwd 改写策略确认可行**:纯字符串前缀替换(`cwd === oldRoot || cwd.startsWith(oldRoot + "/")` → 替换为 `newRoot + cwd.slice(oldRoot.length)`)足以支撑 resume,不需要更复杂的路径归一化逻辑(至少在 Linux、非 git 目录、单层路径前缀这个最简场景下如此)。
2. **append-same-file 是主形态**:`sync-plan`/state 设计里"落地后该文件会被目标机继续写"的假设成立,可以按此简化实现;fork 场景按计划里说的"union 兜底"保留即可,不必现在特殊优化。
3. **gitBranch 字段可以不特殊处理**:不需要为非 git 目标目录专门清空/改写供体记录里的 `gitBranch`。
4. **不需要联动改写 `~/.claude.json`**:同步工具的写入面可以收窄到 `~/.claude/projects/<slug>/` 目录本身,降低误伤风险。
5. **`memory/` 子目录在纯 headless 场景下也会自动创建**:与计划里已有的 memory 冲突判定设计(`state.memory` 分区)方向一致,无需额外调整,但要注意即使没有任何 memory 文件产生,目录本身也可能存在(空目录同步语义需要确认,例如 rclone 默认不同步空目录,这点计划实现时应留意但不影响本 spike 结论)。
6. **`subagents/` 子目录改写规则待补(见 Step 6③)**:后续需要专门任务/子任务验证"按父会话 uuid 目录搬迁 + 改写子代理记录里的 cwd"这条路径是否同样能被正常 resume/展示,现有 spike 结论**不能**自动外推到该场景。
7. **交互式列表展示(Step 6②)待人工确认**,不阻塞后续任务开工,但建议在 Task 2/3 落地后找个真实窗口人工跑一次确认体验正常。
