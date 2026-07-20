# ag-box sessions —— 跨机双向会话同步 设计文档

- 日期:2026-07-19
- 状态:已通过 brainstorm;已对抗性评审(见 `../reviews/2026-07-19-session-sync-review.md`),评审修订见文末规范性附录;实现计划见 `../plans/2026-07-19-session-sync.md`
- 仓库:agent-box(独立仓 github.com/doge-liang/agent-box)

## 背景与动机

ag-box 现能在服务器节点间迁移 agent 工作**沙盒**,迁移时快照包含盒内 claude/codex/grok 会话历史(见 `snapshotTargets`)。但用户的日常工作还有大量发生在**个人开发机(Windows/Mac/Linux)上、未 track 成盒的本地项目**——这些机器上的 claude 会话历史目前完全在 ag-box 之外,既不备份也无法跨机续聊。

目标:给 ag-box 加一个与"盒"解耦的新能力 `ag-box sessions`,把**本地非盒项目**的 claude(及后续 codex/grok)会话历史**跨机双向同步**,加密存 R2,使得在任一机器上开的会话能在另一机器上 `claude --resume` 续聊。

## 已定决策(brainstorm)

1. **场景**:个人机 + 服务器上、**非盒**本地项目(与沙盒相互独立)。
2. **方向**:**双向**——任一机器开的会话,另一机器能拉下来 resume。
3. **路径**:同一项目在各机路径**不同**(Win `C:\…`、Mac `/Users/…`、服务器 `/root/…`)——故需按项目身份做 cwd/slug 落地映射。
4. **方案**:rclone + 按机器分命名空间的 **union 同步**,作为 ag-box **新子命令**,纯 Node + rclone,**不需要 bwrap/systemd**,跨平台。
5. **会话冲突**:会话文件 UUID 命名、单写者 → 按机器命名空间 union,**零冲突**。
6. **memory 冲突**:多机并发改 `memory/*.md` → **保留 `.conflict` 副本、不覆盖**,人工合。
7. **加密口令**:sessions 用**独立加密口令**,**不复用 RESTIC_PASSWORD**(盒的解密钥只留在服务器节点,不散布到个人机)。
8. **MVP**:先 claude、手动命令;codex/grok、自动同步、删除传播留后。

## 非目标(YAGNI,明确排除)

- **自动/守护进程同步**:MVP 只提供手动 `push/pull/sync` 命令;定时或 on-exit hook 留后。
- **删除传播**:MVP 只做 union 累加,不传播删除(本地删了不会删远端/他机);避免误删历史。
- **同一 session 双机并发续写的智能合并**:极罕见(同一 session ID 同时在两机 resume);MVP 用 mtime 最后写胜,不做 JSONL 级三路合并。
- **codex/grok**:MVP 先 claude;codex/grok 沿用盒的 `collectSessionSlices` cwd 切片手法紧随其后(设计已预留 agent 维度)。

## 架构与数据流

```
机器A (Mac /Users/x/proj)          机器B (服务器 /root/proj)
  ~/.claude/projects/<slugA>/         ~/.claude/projects/<slugB>/
        │ push A                            │ push B
        ▼                                    ▼
   R2  sessions/<项目UUID>/claude/<机器A-ID>/…   ← rclone crypt 加密(名+内容)
                          claude/<机器B-ID>/…
        │ pull(拉他机命名空间)              │ pull
        ▼                                    ▼
  落进 <slugA>/(cwd 改写为 A 路径)     落进 <slugB>/(cwd 改写为 B 路径)
```

每台机**只写自己的机器命名空间**,pull 只读**他机**命名空间 → 同一份 R2 里各机文件互不覆盖(会话零冲突)。

## 身份

### 项目身份

- 项目根放标记文件 **`.agentsync`**(JSON,含 `id`: UUID)。路径各异,靠此 UUID 认"同一项目"。
- `ag-box sessions init [path]` 生成:若 `.agentsync` 不存在则分配新 UUID 写入;已存在则复用。
- **`.agentsync` 必须随项目跨机同在同一 UUID**——推荐**提交进项目 git**(随仓库到各机),或用户手动拷贝。若某机 `init` 时项目已带 `.agentsync`(来自 git),复用其 UUID;若各机各自 `init` 出不同 UUID,会被当作不同项目、同步不到一起(文档明确提醒)。
- **本机路径 ↔ 项目 UUID 映射**:各机 `~/.config/agentsync/projects.json` 记 `{<uuid>: <本机项目绝对路径>}`,pull 时据此把会话落到本机对应 slug 目录。首次 pull 某 UUID 需先在本机 `init`(建立本机路径映射)。

### 机器身份

- `~/.config/agentsync/machine-id`:每机一个 UUID(首次运行生成)。作为 R2 命名空间键,保证跨机文件不撞名。

## R2 布局与加密

- rclone **crypt remote** 包裹 R2 桶的 `sessions/` 前缀,文件名与内容均加密。口令 = sessions 专用口令(独立于 RESTIC_PASSWORD)。
- 布局:`sessions/<项目UUID>/<agent>/<机器ID>/<原相对路径>`,其中 `<agent>` ∈ {`claude`,`codex`,`grok`}。claude 源为 `~/.claude/projects/<本机slug>/` 整目录(含 `memory/`)。
- 复用 agent-boxes 桶(与盒数据同桶不同前缀:盒在 `restic/`+`boxes/`,会话在 `sessions/`,互不干扰)。

## 命令(新增 `ag-box sessions <子命令>`)

- `sessions init [path]`:建/复用 `.agentsync` UUID,登记本机路径映射。
- `sessions push [path]`:把本机该项目会话上传到 `<uuid>/claude/<本机ID>/`(rclone copy,只增改)。
- `sessions pull [path]`:下载**他机**(机器ID ≠ 本机)命名空间的会话,落进本地 `~/.claude/projects/<本机slug>/`;会话文件 union,`memory` 冲突留 `.conflict`;落地时改写记录 `cwd` 为本机路径。
- `sessions sync [path]`:push 后 pull。
- `sessions list`:列已登记的同步项目(UUID + 本机路径)。

## 同步语义(核心)

### 会话文件:union

- 会话文件 UUID 命名、单写者;pull 时逐个从他机命名空间取,落进本机 slug 目录。
- 同名(同 session UUID)极罕见双机续写冲突 → 按 mtime 最后写胜(MVP)。

### 落地 cwd 改写(⚠️ 关键假设,需早期 spike 验证)

- claude 按**当前目录**定位可 resume 的会话(会话存于 `~/.claude/projects/<slug(cwd)>/`)。跨机路径不同 → 必须:① 把他机会话文件放进**本机** slug 目录;② 把每条记录里的 `cwd` 字段改写成**本机项目路径**,好让 `claude --resume` 认为该会话属于本机当前项目。
- **假设**:①+② 后 `claude --resume` 能列出/续上该会话。**实现第一步就做 spike 真机验证此假设**;若 claude 另有更严的归属校验(如按 sessionId 内部索引、或校验 gitBranch),据实调整改写字段集或落地策略。

### memory 冲突:保留两份

- `memory/*.md` 多机并发可改(如暗号)。pull 时若本地与远端同名 memory 文件**都相对上次同步基线有改动** → 远端版落为 `<name>.<机器ID>.conflict.md`,不覆盖本地;`sessions list`/pull 输出提示存在待合并冲突。基线用各机 `~/.config/agentsync/state/<uuid>.json` 记录上次同步的文件哈希。

## 配置与安全

- 每机 `~/.config/agentsync/env`:R2 endpoint/bucket、S3 凭证、**SESSIONS_CRYPT_PASSWORD**(独立口令)。
- 会话含对话内容(潜在敏感)→ 全程 rclone crypt 加密,R2 里文件名亦加密。
- **不复用 RESTIC_PASSWORD**:盒解密钥只在服务器节点;个人机只持 sessions 口令,泄露不危及盒快照。
- sessions 口令与盒口令同为"丢失即不可解密"级——需离线备份(与 RESTIC_PASSWORD 同等对待,文档提醒)。
- rclone 固定 remote 配置经 env 注入(`RCLONE_CONFIG_*`),不写全局 rclone.conf,避免与用户既有 rclone 配置冲突。

## 组件(纯逻辑抽出便于跨平台单测)

- `lib/sync-identity.js`:`readProjectId(path)`(读/校验 `.agentsync`)、`machineId()`、`localSlug(path)`(跨平台 slug,复用/对齐 claude 的 slug 规则——⚠️ 需确认 claude 在 Windows 的 slug 规则,spike 一并验)。
- `lib/sync-plan.js`(纯函数):给定本地文件清单 + 远端他机清单 + 上次基线 → 产出 `{toUpload, toDownload, memoryConflicts}`。可完全单测,不碰 rclone/fs。
- `lib/session-rewrite.js`(纯函数):`rewriteCwd(jsonlText, newCwd)` —— 改写会话记录 cwd,返回新文本。单测覆盖多记录类型、缺 cwd、非 JSON 行容错。
- `lib/rclone.js`:crypt remote env 组装 + push/pull 执行(薄封装,交互 mock 测)。
- `bin/ag-box`:`sessions` 子命令分发(复用现有 parseArgs)。

## 错误处理

- `.agentsync` 缺失/损坏:`push`/`pull` 前要求先 `init`,明确报错。
- 本机未登记某 UUID 路径映射:`pull` 报"先在本项目 `sessions init`"。
- rclone 失败(网络/凭证):非零退出、原样透出 stderr 末行,不静默。
- cwd 改写解析失败(非 JSON 行):跳过该行原样保留(宁缺勿错,不损坏文件)。
- memory 冲突:永不覆盖本地,落 `.conflict`,退出码标记有冲突待处理。

## 测试

- **纯函数单测(跨平台,node:test)**:`sync-plan`(union/冲突判定各态)、`session-rewrite`(cwd 改写)、`sync-identity`(slug/项目 UUID 解析,含 Windows 路径样例)。
- **rclone 封装**:注入 mock runner 测 argv 组装(crypt env、push/pull 路径)。
- **真机端到端(实现第一步 spike)**:Linux 机 A `init`+`push` → Linux 机 B `init`+`pull` → 机 B `claude --resume` 能续上机 A 的会话(**验关键假设**)。跨平台(Mac/Win)手动验作为收尾。

## 验收标准

1. 机器 A 上某本地项目 `sessions init` + `push`,R2 `sessions/<uuid>/claude/<A-ID>/` 出现加密对象。
2. 机器 B 同项目 `init`(建本机路径映射)+ `pull`,本机 `~/.claude/projects/<B-slug>/` 落入 A 的会话;`claude --resume` 在 B 上能列出并续上 A 的会话。
3. 双向:B 上续聊后 `push`,A `pull` 能拿到 B 的续写(会话 union,不互相覆盖)。
4. memory 冲突:A、B 同时改同名 memory → pull 侧留 `.conflict` 副本、本地不被覆盖、有提示。
5. 安全:R2 中会话对象文件名与内容均加密;个人机只持 sessions 口令,无 RESTIC_PASSWORD。
6. 跨平台:命令在 Linux 跑通(MVP 门槛);Mac/Win 至少手动验 slug/路径映射正确。

## 一期即全部?否——分期明确

一期:claude、手动命令、union + memory `.conflict`、真机 spike 验 cwd 改写假设。
后续(非本 spec):codex/grok 切片同步、自动/守护同步、删除传播、同 session 双写智能合并。

---

## 评审修订(2026-07-19,规范性——与上文冲突处以本节为准)

依据对抗性评审(`../reviews/2026-07-19-session-sync-review.md`,含本机实测证据)作如下修订:

### 修订 1:同步语义改为 state 驱动增量(替代裸 rclone copy)

- crypt remote 不支持 checksum,rclone 只比 size+modtime;而 pull 落地要改写 cwd(大小必变)——裸 copy 会导致每轮全量重传,并产生 pull→push 回声(他机会话被再上传进本机命名空间、多机间乒乓覆盖)。
- **pull**:`rclone lsjson -R` 他机命名空间 → 与 state 中上次快照(path/size/mtime)求差 → 只下载新增/变更,先落本机 cache(`~/.config/agentsync/cache/<uuid>/<机器ID>/`,保存未改写原件)→ 再改写落地进 slug 目录,落地后 `fs.utimes` 回写远端 mtime。
- **push**:排除"他机来源且本地未续写"的文件。判据:state 落地记录(landedSize/landedMtime)与本地当前 stat 一致 → 不上传;本地续写过(大小/mtime 超出)→ 上传到本机命名空间(这正是跨机续写传播的正确语义)。
- **落地防护**:本地同名文件 mtime 距今 < 5 分钟视为正被 claude 续写,跳过并警告,下次 pull 重试(claude 存储无锁文件,实测确认)。
- mtime 比较一律带 2.5 秒容差(FAT/exFAT 2 秒精度)。

### 修订 2:每机命名空间加 `_manifest.json`;rewriteCwd 改为前缀替换

- 实测同一会话文件内 cwd 有多值(项目根及其子目录),且仅 user/assistant/system/attachment 等消息类记录带 cwd。
- push 时在 `sessions/<uuid>/claude/<机器ID>/_manifest.json` 写 `{version, root, slug, sep, platform, hostname, pushedAt}`;pull 先读它取得源机项目根与路径分隔符。
- 签名改为 **`rewriteCwd(text, oldRoot, newRoot, {fromSep, toSep})`**:仅"含 `"cwd"` 且前缀命中"的行重序列化;其余行(控制记录/非 JSON 行)**字节原样透传**。不改写历史 tool 输出中嵌的路径——resume 后模型上下文中会出现他机路径,列为已知限制。
- `_manifest.json` 与 `*.conflict.md` 永不进入同步文件集。

### 修订 3:slug 规则独立实现,禁止复用 mounts.slugFor

- claude 实际规则(本机实证):**所有非字母数字字符 → `-`**(有损)。新写 `claudeSlug(p) = p.replace(/[^a-zA-Z0-9]/g, '-')`;`mounts.slugFor`(仅替换 `/` `.`)是盒挂载专用,勿混用。
- Windows slug 规则(推断 `C:\Users\x\proj` → `C--Users-x-proj`)列 spike 验证。
- slug 有损碰撞(两 UUID 映射同 slug)在 init 时检测并警告。

### 修订 4:dispatch 与配置解耦

- `cmds.sessions.noBoxConfig = true`;dispatch 改为 `handler.noBoxConfig ? null : loadConfig()`——现有盒命令零改动,sessions 不再要求盒配置存在。
- 新 `loadSessionsConfig()`:读 `~/.config/agentsync/env`(`os.homedir()` 推导,禁止硬编码 `/root`);必填 `SYNC_S3_ENDPOINT/SYNC_BUCKET/AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY/SESSIONS_CRYPT_PASSWORD`,可选 `SESSIONS_CRYPT_PASSWORD2`(crypt 盐,启用后不可更换,与主口令一同离线备份)。
- 测试种子(非常规使用):`AGENTSYNC_DIR` 覆盖配置目录、`AGENTSYNC_CLAUDE_DIR` 覆盖 `~/.claude/projects`、`SYNC_BACKEND=local`+`SYNC_LOCAL_ROOT` 用本地目录代替 R2(使端到端测试无需凭证)。

### 修订 5:rclone crypt env 注入完整集(口令必须 obscure,实测实锤)

- `RCLONE_CONFIG_*_PASSWORD` 必须是 `rclone obscure` 形式:明文注入报 base64 decode 错;明文恰为合法 base64 时会静默用错密钥。运行时经 stdin(`rclone obscure -`)现场转换,**绝不经 argv**(进程表可见)。
- env 集:`RCLONE_CONFIG_SESSR2_{TYPE=s3,PROVIDER=Cloudflare,ENDPOINT,ACCESS_KEY_ID,SECRET_ACCESS_KEY,NO_CHECK_BUCKET=true}` + `RCLONE_CONFIG_SESSCRYPT_{TYPE=crypt,REMOTE=SESSR2:<bucket>/sessions,PASSWORD=<obscured>,PASSWORD2=<obscured 盐>}`。文件名加密取默认(standard)。

### 修订 6:安全声明改口 + 独立桶为默认建议

- 同桶共享 S3 key 时,个人机凭证泄露虽不泄盒内容,但可覆盖/删除同桶 `restic/`+`boxes/` 对象(完整性风险;R2 token 只能按桶授权)。**默认建议 sessions 独立桶(如 `agent-sessions`)+ 独立 token**;坚持同桶须明示接受此风险。

### 修订 7:memory 基线语义补全

- 无基线(首同步)且两侧不同 → 一律按冲突处理(保守不覆盖);两侧相同 → 直接记基线。
- state 按 memory 文件记 `baseline`(上次同步一致点哈希)与 `lastRemote`(上次见到的远端哈希);远端相对 lastRemote 无变化 → 跳过,不重复落同一冲突副本。
- MEMORY.md(索引文件)为可预期的高频人工合并点,MVP 接受;行级 union 合并留后。
- 终审补记(2026-07-20):远端内容相对**基线**无变化(remoteHash === baselineHash)→ 同样跳过,纯本地编辑不判冲突;此判定先于 lastRemote 去重检查(对应实现修复 900e613)。

### 修订 8:spike 清单扩充(实现第一步,真机验证)

1. 改写 cwd + 异项目落地后 `claude --resume <id>` 能否续上(核心假设)。
2. resume 续写同 `<uuid>.jsonl` 还是 fork 新 sessionId 文件(实测已见 parentUuid 跨文件证据);缺父文件是否影响续聊。
3. `~/.claude.json` projects 条目 / trust dialog 对 resume 列表的影响(B 机首次进项目)。
4. `~/.claude/history.jsonl` 不同步是否影响 resume 入口。
5. `subagents/*.jsonl` 内 cwd 是否需同样改写(meta.json 实测无 cwd)。
6. gitBranch 不匹配(A 的分支在 B 不存在/非 git 目录)是否影响。
7. Windows slug 规则与盘符;Mac 路径。

### 修订 9:验收标准措辞

- AC3 改为:"不同 uuid 互不覆盖;同 uuid 双机续写按最后写胜"。
- AC6 改为:Linux 跑通 + Mac 手动验为验收项;**Windows 列为 spike 后置**,不卡验收。
- AC1/AC5 用裸 s3 路径 `rclone lsf` 验证"对象存在且文件名不可读"。

### 修订 10:组件清单调整

- 新增 `lib/sync-config.js`(独立配置/machine-id/projects.json/state 读写)与 `lib/sync-cmd.js`(init/push/pull/sync/list 编排),bin 保持薄分发。
- `lib/sh.js` 的 `run` 增加 `maxBuffer` 选项(默认 64MB;Node 默认 1MB 会被大命名空间 `lsjson -R` 撑爆)。
