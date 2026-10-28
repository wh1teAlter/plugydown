# Plugydown Context

Plugydown Context 为 AI 编码助手提供可路由、可验证、可收敛的仓库知识。正式知识保存在仓库的
`context/` 中，并通过有预算的渐进读取服务普通工程任务。

## 产品入口

| 入口 | 用途 |
|---|---|
| Context Operating Skill | L0–L3 渐进读取、状态处理、角色与事务共用规则 |
| `init` | 首次建立最小完整的 Domain 与 Document 体系 |
| `update` | 同步获得授权范围内的持久工程事实 |
| `prune` | 在保留唯一知识和源码覆盖的前提下收敛知识 |
| `migrate` | 将旧账本显式迁移为不可变确认，保留历史依据和基线 |

产品支持 Claude Code、Codex、Cursor、Antigravity CLI、OpenCode 与 Pi。Investigator 建立工程事实，Reflector 整理可复用的临时反馈，
Recorder 是 transaction candidate 的唯一语义作者；Main Assistant 负责授权边界和最终批准。

## 安装

每次发布把六个平台的完整交付目录原样推送到各自的 release 分支，发布流程见仓库根目录 README。
安装 release 分支即可使用，无需克隆源码、安装 AAPlugin 或手动编译 Runtime。新增分支在维护者发布本次产品后可用。
所有宿主均需要 PATH 上有 Node.js 24 或更高版本，安装完整交付单元，不能只复制一个 Skill。

| 平台 | 构建目录（相对本包） | 发布分支 | 内部角色 |
|---|---|---|---|
| Claude Code | `dist/claude-code/marketplace/` | `release-claude-code` | 原生 Agent |
| Codex | `dist/codex/marketplace/` | `release-codex` | 私有 Markdown，按 Brief inline 执行 |
| Cursor | `dist/cursor/plugin/` | `release-cursor` | 原生 Agent |
| Antigravity CLI | `dist/antigravity/plugin/` | `release-antigravity` | 私有 Markdown，按 Brief inline 执行 |
| OpenCode | `dist/opencode/workspace/` | `release-opencode` | 原生 Subagent |
| Pi | `dist/pi/package/` | `release-pi` | 私有 Markdown，按 Brief inline 执行 |

Claude Code：

```bash
claude plugin marketplace add wh1teAlter/plugydown#release-claude-code
claude plugin install context@context-claude-code
```

Codex：

```bash
codex plugin marketplace add wh1teAlter/plugydown --ref release-codex
codex plugin add context@context-codex
```

升级只在版本号变化时生效：Claude Code 先 `claude plugin marketplace update context-claude-code` 再
`claude plugin update context@context-claude-code`，然后重启会话。

Cursor 本地 Plugin：

```bash
git clone --single-branch --branch release-cursor https://github.com/wh1teAlter/plugydown.git "$HOME/.cursor/plugins/local/context"
```

首次安装需目标目录不存在。重启 Cursor 或运行 **Developer: Reload Window**，在 Customize 中确认已加载。
宿主策略必须允许本地 Plugin；使用真实目录，避免指向外部的符号链接。升级时在该目录执行 `git pull --ff-only`
并重新加载窗口。

Antigravity **CLI**（不包含 App/IDE 的安装契约）：

```bash
git clone --single-branch --branch release-antigravity https://github.com/wh1teAlter/plugydown.git ./context-antigravity
agy plugin install ./context-antigravity
agy plugin list --json
```

通过显式 checkout 选择 Git ref；不假定 CLI 有任意 `URL@ref` 参数。升级先更新 checkout，再按宿主 Plugin
管理流程更新该本地安装，以 `agy plugin list --json` 返回的安装路径确认结果。

OpenCode 交付业务仓库覆盖层，包含 `.opencode/` 与 `schemas/`。先取得分支：

```bash
git clone --single-branch --branch release-opencode https://github.com/wh1teAlter/plugydown.git ./context-opencode
```

新建工作区可直接展开已跟踪的完整产物（含隐藏目录，不包含分支 checkout 的 `.git`）：

```bash
mkdir ./my-repo
git -C ./context-opencode archive HEAD | tar -x -C ./my-repo
cd ./my-repo
git init
opencode
```

已有业务仓库需按正常 Git 文件变更流程合并这两个目录，审阅同名文件冲突后提交；升级也采用同样流程。
不要覆盖已有的 `.opencode/` 或 `opencode.json` 配置。这不是 npm Hook plugin，OpenCode 的 npm loader
不能安装完整 Skill/Agent/Runtime 目录；这里不提供虚构的一条原生 Git-ref 安装命令。

Pi 可直接安装 Git 分支：

```bash
pi install git:github.com/wh1teAlter/plugydown@release-pi
```

本地验证也可 `pi install ./dist/pi/package`。升级使用 Pi 的 package 更新流程，然后重新加载会话。
Pi 原生支持 npm，但本产品保持私有源码包和 Git release 分支发布，不另行发布 npm 包。生成的 `package.json`
不会自动继承源码包的 `engines`，因此安装环境仍须自行满足 Node 24+。

## Runtime 与角色定位

所有交付的 `SKILL.md` 都从自身所在目录通过 `../../runtime/context/main.mjs` 找到同一份 Runtime；角色调用索引
为 `../../runtime/agents/index.md`。OpenCode 的两者位于业务仓库 `.opencode/runtime/`，其余位于安装单元的
`runtime/`。Skill 先读取索引，再使用宿主支持的原生 Agent 或私有角色文档；作者不需要维护六份 Skill 或角色正文。

| 平台 | agent 如何取得绝对路径 |
|---|---|
| Claude Code | 从加载 Skill 时提供的 base directory 解析 |
| Codex | 从加载 Skill 的源文件路径解析 |
| Cursor | 从 Skill 源目录解析；上述本地安装还明确给出 `~/.cursor/plugins/local/context/` |
| Antigravity CLI | 从 Skill 源目录解析；缺失时运行 `agy plugin list --json`，选择 `context` Plugin 的安装路径 |
| OpenCode | 从实际业务仓库根解析 `.opencode/runtime/context/main.mjs` |
| Pi | 从宿主提供给模型的 Skill 文件路径解析 |

调用 `node "<绝对 Runtime 路径>"` 时保持 cwd 为业务仓库根。不要假定 hooks 中的 `${PLUGIN_ROOT}` 等变量
在普通 Skill 正文或任意 shell 中也会展开。Runtime 的唯一调用协议见随 Skill 交付的 `references/runtime.md`。
SessionStart Hook 是尽力而为的知识发现提示；没有 `context/` 的新仓库需先主动运行 Init。

Cursor 的模型与工具偏好仅作为说明；OpenCode 配置原生工具与权限，但不强制限定候选目录。私有角色模式不创建
独立 Agent，也不隔离模型或工具。各平台的授权、Recorder 与 Investigator 分工和 Main Assistant 最终批准规则相同。

在业务仓库中使用前：

- Node.js 24 或更高版本（Runtime 使用 PATH 中的 `node`）。Runtime 以仓库根为 cwd 运行，请在仓库根启动会话；
- 把 `.scratch/` 加入 `.gitignore`——它保存事务临时态与本地 Feedback，不应入库；
- `context/` 应当入库，它是知识本体；
- 首次运行 `init` 建立知识树，此后在持久工程变化后运行 `update`。

使用边界：

- `code.paths` 只声明受版本控制的源。被 Git 忽略的文件（如构建产物）只存在于生成它的机器上：
  别的 clone 要么没有它（证据损坏），要么字节不同（文档一直待复核）。monorepo 中声明 `packages/foo/src/**`，而不是包根；
- 单次调用最多展开 10,000 个源文件、512 MiB；
- Runtime 只证明字节与批准一致，无法证明复核真的发生——复核由工作流和 Investigator 审查保证；
- `matched` 表示当前完整输入与一次确认一致，不能证明自然语言必然正确；
- Update 不推进 repository 或 convergence baseline；确认不依赖分支、commit ID 或历史可达性。

## 普通 Git 协作与快速检查

0.8.0 使用 `context/.meta/`：入口只保存统一 `format: 1` 与低频基线，按内容身份分文件保存不可变确认。
没有持久 `reviewRequired`、latest 指针或待审队列。不同分支新增的确认可以由普通 Git 共存，不需要
merge driver、hook 或 AI 才能正确判断；不同文档更新不会再争抢同一条当前账本记录。

解决 Markdown 冲突后，调用 `confirmation.check`，不再执行 Repair。如果最终正文、业务元数据和来源
恰好匹配某次确认，直接得到 matched；第三份组合正文得到 unmatched，而非结构损坏。需要核对的文档仍
准确时，Update 通过 `confirmedDocumentIds` 生成新确认，无需为更新 hash 改写文档。确实变化的内容才编辑。

来源缺失单独报告 unavailable；Update 可直接开始，在候选中修正 `code.paths` 后验证。危险路径、坏记录、
冲突标记和并发修改仍拒绝。计算 hash、解决 Git 冲突和完成语义审查是三件不同的事。

```json
{"protocol":"plugydown.context.runtime","format":1,"capability":"confirmation.check","input":{"scope":{"kind":"repository"},"explain":true}}
```

完整 API、计数、分页、Git evidence、批准和恢复规则见 [Runtime reference](src/skills/context/references/runtime.md)。
只读检查不修改正式文件。全仓 CI 必须消费全部分页并核对范围与计数，不能只看进程退出码或 status=success。
`exact_basis` 要求所有输入 matched；`content_guard` 允许已确认正文的来源单独漂移，但仍拒绝无效来源和
第三正文。具体强度由业务仓库明确选择；本插件升级不自动改业务 CI。

## 从 0.7 及更早版本迁移

新版本使用固定协议名加统一 format；旧 `/v1` 请求明确拒绝。先协调客户端和 CI 配对升级，并处理完旧
Runtime 的活动事务。旧根部 `meta.json` 在 inspect 中显示 legacy，只能通过 Migrate 写入新格式。

Migrate 要求显式选择 `import-trusted` 或 `reconfirm`，支持分页预览和 dry-run。前者原样导入旧元组，排除
旧 `reviewRequired: true` 记录；后者不导入确认。迁移不重算旧摘要来冒充当前批准，不需要恢复已删除源码，
不修改 Markdown 字节/路径/权限和既有基线。候选与旧入口在同一次事务切换中生效或恢复。

新旧入口并存、格式未知和损坏数据都不静默回退。发布新插件前须准备业务检查器，避免自动跟随发行分支的
旧检查器误用新协议。本地源码更新不代表已发布，也不自动迁移任何仓库。

首版按完整文档确认，无自动历史 GC、跨分支撤销系统或语义哈希。发现同字节的旧确认本身错误时，应纠正
文档/来源并重新审查；仅删除本地记录不能保证其他分支不会带回它，不能宣称已完成全局撤销。

## 正式知识

```text
context/
├── .meta/
│   ├── manifest.json
│   └── confirmations/<document-id>/<key>.json
└── <domain>/
    ├── domain.md
    ├── design/
    ├── manual/
    └── reflections/
```

`design/`、`manual/` 和 `reflections/` 仅在有内容时存在。安装后的插件直接使用业务仓库中的统一临时
路径，不感知 Plugydown 源码仓库：

```text
.scratch/
├── evidence/<evidence-id>/
├── feedback/<slug>-<short-identity-hash>.md
├── investigations/<slug>-<short-identity-hash>.md
├── runs/<run-id>/
└── locks/context-write/
```

- `evidence/` 保存宿主收集、Runtime 严格验证的 Git 原始字节；
- `runs/` 临时保存完整 candidate、必要 backup 和恢复 manifest；
- `locks/context-write/` 是每仓库唯一写事务的原子目录锁；
- `investigations/` 只在结果必须跨上下文或 resume 时保存短证据；
- `feedback/` 保存尚未成功晋升或显式丢弃的可复用反馈。

安全终态自动清理对应 evidence、Investigation、run 和 lock；成功晋升或显式丢弃后清理 Feedback。只有
可继续的中断或人工恢复保留现场。产品不删除 `.scratch/`、集合根或其他工具的 sibling。

## Runtime

私有 Runtime 暴露八个 capability：

- `repository.inspect`
- `frontier.query`
- `graph.validate`
- `confirmation.check`
- `delta.compute`
- `growth.measure`
- `feedback.match`
- `transaction`，action 仅为 `begin`、`validate`、`commit`、`resume`

所有正式写入都先形成完整 candidate，经机械验证、语义复核和 fingerprint 绑定批准后，才以目录切换
提交。Runtime 不调用模型，也不派生子进程。

## 开发

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm validate
pnpm inspect
pnpm verify:delivery
```

AAPlugin 是唯一 builder；`dist/` 只由其公共命令产生。

`pnpm verify:delivery` 验证发布目录、角色引用、Runtime 0755 权限、许可证及六份真实 Runtime 的 JSON 响应。
集成测试还覆盖 strict 兼容性、缺失 Contributor、角色冲突、扩展平台前后的旧平台字节和重复构建的字节/权限/报告。
它们均不调用模型。宿主文档依据及本地会话验收步骤见 [宿主验收](./host-validation.md)；自动测试不代表真实宿主会话已通过。

## License

MIT
