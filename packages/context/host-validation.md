# 宿主验收

先完成 `pnpm build && pnpm validate && pnpm verify:delivery`。以下是真实宿主检查步骤，不能用 Schema、
Node 子进程或模拟 callback 的结果代替。六个平台的完整目录与安装命令见 [README](./README.md#安装)。

## 环境与依据

本产品要求 Node.js 24+；同时记录实际宿主版本。使用支持下列官方文档所述能力的宿主版本：

| 平台 | 需要的能力 | 文档依据 |
|---|---|---|
| Claude Code | Plugin、Skills、Agents、SessionStart | [Plugins](https://code.claude.com/docs/en/plugins) |
| Codex | Plugin marketplace、Skills、SessionStart | [Plugins](https://developers.openai.com/codex/plugins/) |
| Cursor | Plugin 本地导入、Skills、Subagents、sessionStart | [Plugins](https://cursor.com/docs/plugins)、[Skills](https://cursor.com/docs/skills) |
| Antigravity CLI | `agy plugin install/list`、Skills、SessionStart | [CLI Plugins](https://antigravity.google/docs/plugins?app=cli) |
| OpenCode | Workspace Skills/Agents/Plugins 与 system-transform callback | [Skills](https://opencode.ai/docs/skills/)、[Plugins](https://opencode.ai/docs/plugins/)；上游 callback 按 `@opencode-ai/plugin@1.19.3` 核对 |
| Pi | Git/local packages、Skills、`session_start` 与 `sendMessage` | [Packages](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md)、[Extensions](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md) |

不推定 Antigravity App/IDE 与 CLI 相同，不推定工具或模型偏好构成权限沙箱。若机器缺少这些软件，先由维护者
安装；不需要安装软件就能完成上述自动检查。

## 每个平台都检查

1. 按 README 安装完整的本地产物或已发布分支，在一个可丢弃的业务 Git 仓库启动宿主。
2. 确认能发现 Context Skill 与 Init/Update/Prune 工作流。Claude/Cursor/OpenCode 使用原生命令，Codex 使用
   `context-init` 等 Skill，Antigravity 使用 `command-init` 等 Skill，Pi 使用 `init` 等 Prompt。
3. 要求 assistant 加载 Context Skill，给出当前 Skill 的绝对路径与解析出的 Runtime 路径，保持业务仓库 cwd，
   发送 `repository.inspect` 请求。新仓库应返回 `context.state: absent`，不能检查到安装目录的 Context。
4. 检查角色索引链接。Claude/Cursor/OpenCode 分别调用原生 Investigator；Codex/Antigravity/Pi 读取私有
   Investigator 文档并按 Brief inline 执行。确认正文、授权路径与模式符合索引，不凭空声称独立 Agent 隔离。
5. 在可丢弃仓库明确运行 Init，确认 candidate→validate→独立复核→批准→commit 的流程。重启会话，确认
   SessionStart 提示先加载 Skill 并执行 `repository.inspect`；OpenCode 的系统提示不重复，Pi 不主动触发新一轮回答。
6. 对每项记录宿主版本、安装来源、发现结果、实际 Runtime 路径、响应和 Hook 行为。失败项保留实际错误，
   不能因 `aaplugin validate` 通过就标为通过。

本次开发的真实宿主会话验收尚未执行；需维护者准备宿主后按此表补充。
