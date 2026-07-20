# lody.ai 与 agent-box/mobile-terminal-web 对比笔记

- 日期:2026-07-20
- 目的:记录一次对 lody.ai 的调研与架构对比,供本项目日后决策参考。
- 方法与证据强度:官网/文档摘要 + 对 npm 包 `lody@0.70.1`(MIT,19.5MB 解包)的**全程只读静态逆向**(grep/字符串/Read,未运行 daemon、未发起网络请求)。混淆代码 + 无 source map,故凡"未发现证据"的结论**均按"未发现"陈述,不等同于"确证不存在"**;下文对此类结论均显式标注。

## 一句话结论

lody 与本项目在解决同一组痛点(手机上盯/驱动 agent、并行隔离执行、上下文跨设备延续),但架构取舍正交:**lody 是"状态活在云端的实时协同平台",本项目是"数据主权 + 执行环境可迁移的自托管基础设施"**。这是趋同演化,验证了问题的真实性,而非重复造轮子。

## lody 是什么

面向并行 coding agent 的开发平台。核心能力(官网 + 文档):

- 每个任务一个独立 git worktree,多 agent 并行不互扰;支持 Claude Code、Codex(更多 agent 计划中)。
- 原生 iOS/Android App(非仅 PWA):任务完成推送、手机上审阅 diff、批准变更。
- 每轮回复末尾带 in-context diff;GitHub 深度集成(PR 状态、CI 结果、review 评论自动同步);"AI Review Loop"(抓取 PR 评论→逐条判定→修复→推提交→触发下一轮)。
- 团队工作区:共享 Agents、Skills、会话上下文。
- 安装即 `npx lody daemon start`。

### 关于"开源"的实况

lody **没有公开源码仓库**。它以 MIT 许可发布 npm 包,但:代码完全压缩混淆、`package.json` 的 `files` 显式排除 `dist/**/*.map`、发行包内**实际缺失** LICENSE 文件。属于"MIT 许可的闭源分发",不是社区意义上的开源。因此本文所有实现细节来自对分发产物的逆向,非源码阅读。

### 团队背景(已坐实)

npm 维护者 `lz@loro.dev`;作者 "Leon Zhao" 即 GitHub `Leeeon233`(包内嵌 `github.com/Leeeon233/acp-extension-codex` 字样);同步后端直指 loro.dev 商业托管的 streams 服务。**lody 本质是 Loro CRDT 团队自家 CRDT 引擎 + 托管同步服务的旗舰(dogfood)应用**。

## lody 架构要点(逆向所得)

### 依赖与打包
- Node ≥22,ESM,`bin: lody → dist/index.js`。运行时依赖仅 6 个:`better-sqlite3`、`loro-crdt 1.13.6`、`node-pty`、`shell-env`、`tinypool`、`typescript`。
- 构建期依赖揭示真实栈:`@anthropic-ai/claude-agent-sdk 0.3.202`、`@agentclientprotocol/sdk`、`better-auth`(+ api-key + convex 适配)、`convex`、`@loro-dev/{flock-wasm,streams-crdt}`、`loro-mirror`、`loro-repo`、`posthog-node`、内部包 `acp-extension-{claude,codex}`。
- `dist/`:`index.js`(11M,主 CLI+daemon)、`claude-acp.js`(2.3M,内嵌 Claude Agent SDK 的 ACP 适配器)、`codex-acp.js`(瘦壳)、Loro Rust 核心编译 wasm 内联进 `chunks/loro_wasm_bg-*.js`(4.3M)、`zstd.wasm`、若干 worker。`claude`/`codex`/原生模块**均不随包分发**,运行时按平台下载(含 sha256 校验表)。

### 手机连接方式(关键)
**不是局域网直连,也不是简单隧道**,而是 daemon 主动外联云端:
- **Convex**(`convex.lody.ai` 鉴权 + 应用数据 + 机器生命周期 API;`backend.lody.ai` Better Auth HTTP actions)。
- **loro.dev CRDT 中继**(`api.streams-api-x.loro.dev` 状态同步 + `presence.*` presence 分片)。手机与桌面 daemon 在云端汇合,靠 CRDT 收敛。同步协议是带游标的 HTTP append-log(本地表 `remote_cursors(stream_url, next_offset, ...)`)。
- 另有**独立的** preview tunnel(`api.lody.ai` / `LODY_PREVIEW_GATEWAY_URL` 中转),把某 session 本地 dev server 暴露成公网预览 URL —— 与主同步通道是两回事。
- 本机仅 loopback 控制面(`127.0.0.1` 的 session/project control socket、`/healthz`、`/state`)供 daemon 内部 IPC;唯一 `0.0.0.0` 绑定是 token 鉴权的 git 凭证转发临时端口。
- 出现在 `claude-acp.js` 内的 `api.anthropic.com`、`platform.claude.com/oauth`、`claude.ai` 等域名**来自内嵌的 Claude Agent SDK 本身**,不是 lody 自有基础设施。

### 会话存储与隐私面(重点)
本地两套独立存储:
1. Claude Code 原生 transcript `~/.claude/projects/<slug>/*.jsonl`(spawn 真实 `claude` 的自然副产物;**lody 自身代码不读它** —— `index.js` 搜 `sessionStore`/`.jsonl` 零命中)。
2. lody 自有:`~/.lody/loro-repo/<workspaceId>/repo.sqlite3`(better-sqlite3)。`docs`/`doc_updates` 以 doc_id(含 `session-<id>`)存 Loro 二进制快照/增量。

Loro `SessionDocument` schema 显示 **完整对话历史(`history`: 每条含 `role`/`items`/`finished`/`modelInfo`)本身就是被 CRDT 同步的字段**,不只是元数据。

**加密检查(证据强度:未发现)**:对整包搜 `chacha/xchacha/libsodium/tweetnacl/sealedbox/age-encryption/deriveKey` 等应用层加密原语 **零命中**;唯一 `aes-256-gcm` 命中是第三方 dotenv 的 `.env.vault` 功能,与会话数据无关。schema 代码显示对话文本以明文 JS 对象流入 CRDT 层。**未发现客户端对会话内容做端到端加密的证据** —— 机密性仅依赖 TLS + Convex/Better-Auth 账号级访问控制,非零知识设计。结论:完整对话内容上云,服务端理论上可读明文。

### 驱动 Claude Code 的方式
内嵌官方 `@anthropic-ai/claude-agent-sdk`,以 ACP(Agent Client Protocol)封装。运行时 `spawn` 真实 `claude` 二进制,参数含 `--output-format stream-json --verbose --input-format stream-json`,并按需 `--continue`/`--resume <id>`/`--fork-session`/`--session-id`/`--permission-prompt-tool stdio`。实时消费 stdout 的 ACP `session/update` 事件写入自己的 Loro 文档 —— 因此不依赖事后解析 `~/.claude/projects`。Codex 走 `codex-acp.js`,逻辑相同。

### Worktree 管理
- 裸仓库 `~/.lody/repos/<repoId>/`;worktree 于 `~/.lody/repos/<repoId>/worktrees/<sessionId>`(按 session UUID 命名)。
- 分支前缀 `lody/`,分支名由 LLM 依 prompt 生成;按仓库文件锁串行化;`git worktree remove`+`prune` 清理,明确保护非 `lody/` 前缀的用户分支不被误删。
- 支持每 worktree 的 setup/cleanup 钩子脚本(类似自动 `npm install`,默认超时 10 分钟)。

### "Sandboxed Execution" 名不副实
lody 自研部分实为 `LinuxCgroupSessionSandbox` —— **仅 Linux 的 cgroup v2 资源限额**(CPU-max/内存-max/pids-max、OOM-score),macOS/Windows 退化为 `NoopSessionSandbox`。是防单个 agent 拖垮宿主机的**资源治理**,不是文件系统/网络层安全隔离。`bwrap`/`seccomp`/Seatbelt 字样仅出现在内嵌 Claude SDK 的设置描述里(Claude Code 自身可选沙盒,其原生 helper 本包内不存在);`index.js` 搜 `sandbox: {` 零命中,即 **lody 自身从不主动开启底层安全沙盒**。

### 团队/共享
`better-auth` 组织插件(RBAC:成员/角色/邀请/按组织的会话管理),托管在 Convex。共享上下文是**服务端中转 + 组织角色访问控制**,非点对点或端到端加密(结合上文"未发现 E2E 加密")。

### 跨机器:是"远程可见可控",不是迁移
每个 session 绑定 `machineId`,每轮 RPC 过 `canUseMachine`/`verifyMachineAccess` 鉴权,`dispatchSessionTurn` 把该轮路由到 session 所属机器。**未找到把 session 执行迁移/重指派到他机的代码路径**(搜 `migrat`/`transfer`/`reassign` 无相关命中)。原因:worktree 是某机磁盘上的实体目录,agent 进程只能在创建它的机器上跑。跨机的仅是 CRDT 镜像出的对话状态 —— 他机/手机可*查看*历史、向消息队列(`mq: LoroMovableList`)*排新一轮*,由云端路由回原机执行,但执行环境与文件状态始终钉死在原机器。

### 两个值得警惕的设计
- **daemon 自升级可被云端远程触发**(`DaemonUpgradeIntentSchema` 持久化 intent,经 `POST {convexSite}/api/machine-lifecycle/verify` 校验)—— 一个被授权用户经手机 App 即可命令某台注册机器升级并执行新代码,是不小的攻击面。
- **PostHog 遥测以硬件机器指纹为 distinct_id**(Linux `/etc/machine-id`、macOS `IOPlatformUUID`、Windows `csproduct UUID`),重装仍可关联同机;本构建客户端未见关闭开关(仅有未接线的 SDK `optOut()`) —— 证据强度:未发现,可能存在账号/服务端级开关。

## 与本项目的对比

| 维度 | lody.ai | agent-box / mobile-terminal-web |
|---|---|---|
| 手机上盯/驱动 agent | 原生 App + 云端 CRDT 中继 + 推送 | mobile-terminal-web 真终端 + 面板沙盒控制台 |
| 并行隔离 | worktree per task + Linux cgroup 资源限额 | ag-box:bwrap + Nix 环境隔离;worktree |
| 上下文跨设备 | CRDT 镜像对话状态上云,手机可看/排指令 | ag-box sessions:`~/.claude` 文件层同步 + cwd 改写,原生 `claude --resume` 续聊 |
| 跨机器语义 | 远程可见可控;**执行钉死原机** | 沙盒可跨节点**迁移执行**;会话可在他机**真正续跑** |
| 数据信任模型 | 明文进云,TLS + 账号 RBAC(未见 E2E) | 离机前客户端 crypt 加密(零知识),自持唯一解密钥 |
| 基础设施依赖 | Convex + loro.dev streams(第三方托管) | 自托管 R2 + rclone;零第三方运行时依赖 |
| 协同 | 实时多写 CRDT + presence + 团队 RBAC | 单写者 union,MVP 无实时协同 |
| 分发 | MIT 许可但闭源混淆分发 | 自有仓库,源码可读 |

### 各自更强之处
- **lody 更强**:实时多写 CRDT 收敛(含协作光标/presence)、手机对进行中对话做结构化 steer/cancel、团队工作区与成员权限、原生移动 App、GitHub PR/CI/review 深度自动化。这些都得益于"状态天生活在云端"。
- **本项目更强**:数据离机前即客户端加密(零知识/数据主权)、不依赖第三方基础设施可用性与信任、故障模式更简单、能把**同一会话真正搬到另一台物理机继续执行**(而非仅远程看/发指令)、沙盒执行环境本身可跨节点迁移。

## 可借鉴且与本架构不冲突的点

以下三项适合作为**面板增强**,且无需引入云端 CRDT 依赖:
1. **任务/会话完成推送通知**(lody 的核心体验之一)。
2. **自动 PR 绑定**(会话 ↔ PR 关联,一键建 PR 带实现摘要)。
3. **review 评论同步 / AI Review Loop**(抓 PR 评论→逐条判定→修复→回推)。

## 明确不建议照搬

- 云端 CRDT 中继 + 完整对话明文上云 —— 与本项目"数据主权"取向冲突。
- 硬件指纹遥测、可远程触发的 daemon 自升级 —— 攻击面与隐私成本高。

## 参考

- 官网:https://lody.ai/ ,文档:https://lody.ai/docs/workflow
- 分析对象:npm `lody@0.70.1`(MIT,`Leon Zhao`/`lz@loro.dev`)。
- Loro:https://loro.dev(CRDT 引擎 + 托管 streams,与 lody 同源团队)。
