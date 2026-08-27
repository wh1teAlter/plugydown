# Plugydown

AI 工作流技能 monorepo。每个子包是一个用 [AAPlugin](https://github.com/wh1teAlter/aaplugin)
构建、同时交付 Claude Code 与 Codex 的插件。

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

要求 Node.js `^20.19.0 || ^22.13.0 || >=23.5.0` 与 pnpm 10。

## 约定

- **AAPlugin 是唯一多平台 builder。** 不存在第二套 renderer、第二条构建路径或构建后
  产物处理。
- AAPlugin 依赖使用**精确版本**，集中在 `pnpm-workspace.yaml` 的 catalog 中。
- 生成产物 `packages/*/dist/` 不入库；安装源是 GitHub Release archive。
- `.scratch/` 是被忽略的临时工作区，可随时删除。

详见 [`AGENTS.md`](./AGENTS.md)。

## License

MIT
