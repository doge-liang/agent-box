# 评审报告:ag-box sessions 跨机双向会话同步设计

- 日期:2026-07-19
- 对象:`docs/superpowers/specs/2026-07-19-session-sync-design.md`
- 方法:对抗性评审。全部结论基于本机实测(rclone v1.74.3 只读实验、`~/.claude/projects/` 真实抽样)与仓库代码核对,非推测。
- 结论:**骨架成立,按原文实现必失败——修订后可实现,不必推倒重来。** 修订已作为规范性附录并入 spec(见 spec「评审修订」节),实施计划据修订后 spec 编写。

## 阻断级(照写必死)

### 阻断-1:pull→改写→push 回声,叠加 crypt 无 checksum 恶化为永久全量重传

spec 的 push 是"本机 slug 目录整目录上传",pull 是"他机会话落进同一目录并改写 cwd"。叠加后:

1. B pull 到 A 的会话后,B 的下一次 push 把 A 源会话再传入 B 的命名空间——同一会话在 R2 存 N 份(N=机器数)。
2. A 再 pull 时拉回"自己会话的回声",按 mtime 最后写胜覆盖 A 的原件;改写经 JSON 重序列化,回声每转一圈字节可能漂移一次。
3. crypt remote 不支持 checksum,rclone 只比 size+modtime;落地改写必然改变大小与 mtime → 本地与远端永不相等 → **每次 pull 全量重下**。实测单项目 slug 目录 191MB、单文件最大 17.6MB,不是理论问题。

**修法**(已入修订):state 驱动增量。pull 用 `rclone lsjson -R` + 上次 state 快照求差,只下载新增/变更,先落 cache(保存未改写原件)再改写落地,落地后 `utimes` 回写远端 mtime;push 排除"他机来源且本地未续写"的文件(判据:本地 size/mtime 相对落地记录未变)。

### 阻断-2:`rewriteCwd(jsonlText, newCwd)` 签名错误,且 R2 布局缺源机项目根

实测同一会话文件内 cwd 有多个值(项目根与其子目录,如 `/root/spika-marzban` 与 `/root/spika-marzban/panel` 并存)。"统一设为 newCwd"会把子目录 cwd 拍平到项目根,损坏会话语境。正确做法是前缀替换 oldRoot→newRoot(跨平台还需分隔符转换)——但 R2 布局没有任何地方记录源机项目根,pull 侧拿不到 oldRoot。

另实测记录类型比 spec 假设更杂:`queue-operation`、`ai-title`、`custom-title`、`last-prompt`、`mode` 等均无 cwd(抽样文件 1964 行中仅 1413 行带 cwd)。

**修法**(已入修订):每机命名空间根放 `_manifest.json`(root/slug/sep/platform/hostname/pushedAt);签名改为 `rewriteCwd(text, oldRoot, newRoot, {fromSep, toSep})`,仅前缀命中的 cwd 行重序列化,其余行字节原样透传;不改写历史 tool 输出中嵌的路径(文档标注已知限制)。

### 阻断-3:slug 规则"复用/对齐"指向错误实现

claude 实际规则(本机实证):**所有非字母数字字符 → `-`**(有损;`/root/.claude/…` → `-root--claude-…`)。仓库 `mounts.slugFor` 只替换 `/` 和 `.`。若复用:项目 `/root/my_proj` 的会话落到 `-root-my_proj`,claude 实际读 `-root-my-proj`,resume 完全不可见,验收标准 2 直接失败且症状隐蔽。

**修法**(已入修订):新写 `claudeSlug(p) = p.replace(/[^a-zA-Z0-9]/g, '-')`,禁止复用 `mounts.slugFor`;Windows 规则(推断 `C:\Users\x\proj` → `C--Users-x-proj`)列为 spike 项。

**附带发现的存量 bug(盒功能,另行跟进,不在本 spec 范围)**:`lib/snapshot.js:16`/`lib/runtime.js:24` 用仓库 `slugFor` 定位 claude 会话目录,而 `isValidBoxName` 允许 `_`——名含下划线的盒,其 claude 会话目录从未进过快照。

### 阻断-4:无条件 `loadConfig()` 使个人机整体不可用

`bin/ag-box:242` 对所有命令无条件 `loadConfig()`,在 `/root/.config/box/env` 缺失或缺 `RESTIC_PASSWORD` 时抛错。个人机(spec 核心场景)既无该文件也不该有该口令,且 `ENV_PATH` 硬编码 `/root`(Mac/Win 无此路径)。

**修法**(已入修订):`cmds.sessions.noBoxConfig = true`,dispatch 改为 `handler.noBoxConfig ? null : loadConfig()`;sessions 内部用独立 `loadSessionsConfig()`(基于 `os.homedir()`)。现有命令零改动。

## 重要级

- **重要-5 crypt 口令必须 obscure**(实测实锤):明文经 `RCLONE_CONFIG_*_PASSWORD` 注入报 `base64 decode failed`;更险:明文恰为合法 base64 且解码 ≥16 字节时**静默用错钥**。运行时经 stdin(`rclone obscure -`)现场转换,绝不经 argv(`/proc/*/cmdline` 可见);`PASSWORD2`(盐)推荐启用,启用后不可更换、须与主口令一同离线备份。完整 env 集见 spec 修订。
- **重要-6 安全声明失真**:同桶共享 S3 key 时,个人机凭证泄露者虽解不开 `restic/` 内容,但可**列出、覆盖、删除**同桶全部对象——盒快照的完整性/可用性暴露于最不受控设备。R2 token 只能按桶授权。修法:sessions 独立桶 + 独立 token(默认建议);坚持同桶须在 spec 明示此风险。
- **重要-7 `.conflict.md` 回环**:冲突副本会被 push 再散布,他机再冲突产生 `.conflict.….conflict.md` 套娃。修法:双向排除 `*.conflict.md`,定义为纯本地文件。
- **重要-8 memory 基线首同步未定义**:无基线且两侧不同 → 一律按冲突(保守不覆盖);state 记 lastRemote 哈希防同一冲突反复落盘。MEMORY.md 为索引文件,两机各自追加必然高频冲突——MVP 接受人工合并,行级 union 留后。
- **重要-9 活动会话覆盖 + resume 分叉证据**:claude 存储无锁文件,pull 覆盖可能与正续写的 claude 交错写坏 JSONL——落地前本地 mtime 距今 < 5 分钟则跳过并警告。实测发现 fork 证据(某会话首条 user 记录 parentUuid 指向他文件),续聊/compact 可能派生新 sessionId 文件——union 恰好兜得住,但决定验收 3 的实际形态,必须进 spike。
- **重要-10 spike 清单扩充**:见 spec 修订(resume append 还是 fork、`.claude.json` trust/projects 条目影响、history.jsonl 不同步的影响、subagents jsonl 是否需改写、gitBranch 不匹配、Windows slug、并发写)。

## 建议级(择要)

- `lib/sh.js run` 无 maxBuffer(Node 默认 1MB),`lsjson -R` 大命名空间会超限——加选项。
- 落地后必须 `fs.utimes` 回写远端 mtime,否则最后写胜与回声抑制判定全部失准;FAT/exFAT 2 秒精度加容差。
- `projects.json` 存 `path.resolve()` 结果;win32 比较大小写不敏感。
- Windows 调用链:npm bin shim 或 `node bin\ag-box`;rclone.exe 在 PATH 即可。
- machine-id 随 VM 镜像克隆碰撞——文档提醒,init 检测到同命名空间异 hostname manifest 时警告。
- slug 有损碰撞(`foo.bar`/`foo-bar`/`foo_bar` 同 slug):claude 自身如此,MVP 接受;init 检测到两 UUID 映射同 slug 时警告。
- 验收措辞:AC3 改为"不同 uuid 互不覆盖;同 uuid 最后写胜";AC6 Windows 部分改列 spike 后置。
- pull 补错误分支:uuid 有映射但路径已不存在 → 明确报错要求重新 init。

## 结论

按机器命名空间 union、独立口令 crypt、纯函数组件切分等核心决策全部成立。四个阻断项与 memory/安全语义补全均有明确局部修法,已并入 spec 规范性修订;据此进入实施计划(`docs/superpowers/plans/2026-07-19-session-sync.md`)。
