# Plugydown Context

为 AI 编码助手提供**持久化仓库知识**与**显式工程工作流**。把"这个仓库是什么、为什么这样、
怎么正确改动"沉淀为可路由、可验证、可收敛的正式知识，并用有界上下文按需提供。

同时交付 Claude Code 与 Codex。

## 能力

| 入口 | 目的 |
|---|---|
| Operating Skill `context` | 按任务渐进读取知识、维护上下文状态、判断任务结束信号 |
| `init` | 首次建立正式知识 |
| `update` | 同步持久工程知识变化 |
| `prune` | 收敛重复、碎片和膨胀 |

内部由三个角色协作：**Investigator**（调查代码事实）、**Reflector**（归纳反馈）、
**Recorder**（正式知识的唯一语义作者）。

## 知识布局

正式知识写入仓库的 `context/` 目录：

```text
context/
├── meta.json
└── <domain>/
    ├── domain.md          # 必需：目的、边界、不变量、术语、导航
    ├── design/            # architecture、decision
    ├── manual/            # guide、reference
    └── reflections/       # 从充分反馈证据晋升的成熟模式
```

临时工作区是 `.scratch/`（调查、反馈、事务候选、报告）。它默认被 Git 忽略、
**可随时删除**而不损坏正式知识的可理解性。

## 重要边界

### 不提供任何迁移能力

Plugydown Context **不读取、不检测、不转换**任何其他工具的知识目录，包括旧版 `llmdoc/`。
仓库中即使同时存在 `llmdoc/`，本产品的行为也与它不存在时完全一致。

如果你需要把既有 `llmdoc/` 数据转为 `context/`，那是一个独立工具的工作，不在本产品范围内。

### Codex 侧的 Internal Roles 没有上下文隔离

这是**平台限制，不是实现缺陷**：Codex 的可安装插件不能注册自定义 Agent。

| | Claude Code | Codex |
|---|---|---|
| 角色交付 | native Agent | 私有 `runtime/agents/*.md` 资源 |
| 角色执行 | Task 派发，**独立上下文** | 主 agent **内联执行，共享上下文** |

两个平台使用同一份角色正文和同一份 task envelope，差异只在"谁执行"。在 Codex 上，
Investigator 的调查过程会占用主上下文。

## 安装

从 GitHub Release 下载对应平台的 marketplace archive：

- Claude Code：`context-claude-code-<version>.zip`
- Codex：`context-codex-<version>.zip`

archive 是构建产物目录的**字节等价压缩包**，解包后即为可安装的 marketplace 目录。

生成产物 `dist/` 不入 Git，因此**不支持** `add marketplace <git-url>` 直接从仓库安装。
这是有意取舍：AAPlugin 是唯一构建器且构建确定性可复现，产物入库只会产生 review 噪音。

## 开发

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm validate      # 完整构建校验，不写 dist
pnpm inspect       # 附带 Package/Asset 详情
pnpm build         # 唯一提交 dist 的命令
```

## License

MIT
