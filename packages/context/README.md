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

产品同时交付 Claude Code 与 Codex。Investigator 建立工程事实，Reflector 整理可复用的临时反馈，
Recorder 是 transaction candidate 的唯一语义作者；Main Assistant 负责授权边界和最终批准。

## 安装

每次发布都把两个平台的构建产物原样推送到各自的 release 分支，发布流程见仓库根目录 README。

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
- 长期未处理的待复核 Document 会让 repository baseline 停住，定期运行 repository 范围的 `update` 即可；
- squash 合并可能让 baseline 所在的分支提交从历史中消失。待复核队列只看指纹，不受影响；
  只是在下一次 repository 范围的 `update` 前移 baseline 之前，新增的未被引用路径只能看到工作区里的部分。

## 正式知识

```text
context/
├── meta.json
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

私有 Runtime 只暴露七个 capability：

- `repository.inspect`
- `frontier.query`
- `graph.validate`
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
```

AAPlugin 是唯一 builder；`dist/` 只由其公共命令产生。

## License

MIT
