# Plugydown 工程规范

## 项目定位

Plugydown 是 AI 工作流技能 monorepo。每个子包用 AAPlugin 构建为同时交付 Claude Code 与
Codex 的插件。子包是**产品**，不是框架；框架能力属于上游 AAPlugin。

## 技术与工具约束

- Node.js `^20.19.0 || ^22.13.0 || >=23.5.0`，ESM-only；
- pnpm workspace + catalog，不使用 npm/yarn，**不引入 Turborepo**；
- **不引入 Changesets**（当前无 npm 发布流水线可驱动）；
- `@antfu/eslint-config` 负责 lint 与格式；
- Vitest 负责测试；
- `tsc` 只用于 `--noEmit` 类型检查，**不产出任何交付字节**；
- 构建只有 `aaplugin build` 一条路径。

## 依赖策略

AAPlugin 依赖**必须使用精确版本**，集中在 `pnpm-workspace.yaml` 的 catalog。

理由：`@aaplugin/*` 处于 beta，range 会在下一个 beta 发布时静默替换构建器，而构建器变更
直接改变产物字节 —— 字节等价是产品验收项。升级构建器必须是显式动作。

最终产品依赖**不得**使用 `file:`、指向仓库外的 `workspace:`、或 Git SHA/URL。

## 所有权边界

| 层 | 所有者 | 本仓库的权利 |
|---|---|---|
| 构建生命周期、诊断、事务 | AAPlugin Core | 只提供输入 |
| Command / Skill 发现与转换 | Core + Platform | 提供 canonical 源文件 |
| Runtime 编译与交付 | Core | 提供 `src/runtime/` 与 entry 声明 |
| Claude/Codex manifest、路径、命名 | 各 Platform | **不得直接写入** |
| Hook wire 与 Handler 打包 | 官方 Hooks Extension | 提供 `src/hooks/<id>/hook.ts` |

## 禁止事项

1. 构建后处理 `dist`（rename / copy / patch / 删除）。
2. 直接写 Platform-owned manifest。
3. 创建第二套 renderer 或第二个 builder。
4. 逐文件复制 TypeScript 或自建 Runtime 编译器。
5. 建立旧 ACPlugin API 兼容层。
6. 为子包专属逻辑修改 AAPlugin。
7. 用 Public copy 交付平台专属资源（Public 会复制到所有平台）。
8. 用缺少 fixture 的大面积 skip 代替验证。

## AAPlugin 能力缺口处理

1. 先证明项目侧无法干净解决（穷尽 Extension / Contributor / Public / Runtime 组合）；
2. 记录为独立 framework investigation，写入 `.scratch/investigations/`；
3. **不在子包中打补丁伪装解决**（禁止 monkey-patch、产物后处理、私有 fork）；
4. 只有当缺口通用且有意义时才提 AAPlugin upstream issue；
5. 缺口解决前若无法交付某能力，必须显式降级声明，不得静默省略。

## 测试

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm validate
pnpm inspect
```

新增功能必须按风险补充测试。高风险点必须覆盖：事务失败路径与故障注入、恢复的三种结局、
并发检查、路径安全拒绝、预算超限返回 cursor。

常规 CI **离线、不调用任何模型**。测试不依赖时间、随机数、机器路径或环境变量。

## 输出确定性

生成文件与报告中不得出现时间戳、绝对路径、临时路径、环境值或凭据。
连续两次构建的产物字节与报告必须一致。

## Git 与改动安全

- commit message 使用 Conventional Commits；
- 保留用户已有 staged/unstaged 修改，**不使用 `reset` / `checkout` / `clean` 覆盖**；
- `.scratch/` 与 `packages/*/dist/` 不入库。
