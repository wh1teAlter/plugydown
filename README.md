# Plugydown

AI 工作流技能 monorepo。每个子包是一个用 [AAPlugin](https://github.com/wh1teAlter/aaplugin)
构建、交付 Claude Code、Codex、Cursor、Antigravity CLI、OpenCode 与 Pi 的产品。

## 子包

| 包 | 目录 | 说明 |
|---|---|---|
| Plugydown Context | [`packages/context`](./packages/context) | 持久化仓库知识与工程工作流 |

## 开发

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

要求 Node.js 24 或更高版本与 pnpm 10。开发与插件 Runtime 使用同一要求，CI 在 Node 24 上验证。

## 约定

- **AAPlugin 是唯一多平台 builder。** 不存在第二套 renderer、第二条构建路径或构建后
  产物处理。
- AAPlugin 依赖使用**精确版本**，集中在 `pnpm-workspace.yaml` 的 catalog 中。
- 生成产物 `packages/*/dist/` 不入库。发布时各平台产物原样推送到 `release-<platform>` 分支作为安装源（安装方式
  见 [`packages/context`](./packages/context#安装)）。`packages/context/delivery.json` 统一选择 marketplace、
  plugin、workspace 或 package；OpenCode 是业务仓库覆盖层，Pi 可直接安装 Git ref。
- `.scratch/` 是被忽略的临时工作区；保留可恢复事务和未晋升 Feedback，按工作流清理自己拥有的叶子。

详见 [`AGENTS.md`](./AGENTS.md)。

## 发布

CI（`ci.yml`）只做检查，从不发布。发布由 `release.yml` 完成，只能手动运行：

1. 在 `packages/context/package.json` 中提升版本号并合并到 `main`。同一版本只能发布一次——已安装的插件只在版本号
   变化时才会更新。
2. 在 GitHub 的 Actions 页面选择 **release**，基于 `main` 点击 **Run workflow**。可先勾选 `dry_run`，只构建并报告
   将要发布的内容。
3. 工作流在该提交上重跑全部检查，把六个交付单元分别推送到 `release-claude-code`、`release-codex`、
   `release-cursor`、`release-antigravity`、`release-opencode`、`release-pi`，最后创建
   `context--v<版本>` tag 与 GitHub Release（说明由合并的 PR 自动生成）。

中途失败时 tag 尚未创建，修复后直接重新运行即可；已包含同一构建的分支会被跳过。
发布保持产物字节和权限，不添加第二套 builder 或产物补丁。Pi 使用 Git 分支发布，无需引入 npm 发布流水线。

## License

MIT
