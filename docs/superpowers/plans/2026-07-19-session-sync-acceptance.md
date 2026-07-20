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
