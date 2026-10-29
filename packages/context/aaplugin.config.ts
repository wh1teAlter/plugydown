import hooks from '@aaplugin/extension-hooks'
import { defineConfig } from '@aaplugin/kit'
import antigravity from '@aaplugin/platform-antigravity'
import claudeCode from '@aaplugin/platform-claude-code'
import codex from '@aaplugin/platform-codex'
import cursor from '@aaplugin/platform-cursor'
import openCode from '@aaplugin/platform-opencode'
import pi from '@aaplugin/platform-pi'
import internalRoles from './extension/internal-roles.js'
import pkg from './package.json' with { type: 'json' }

// package.json 是包身份的唯一来源；此处只声明没有 npm 对应字段的插件名和展示名。
export default defineConfig({
  name: 'context',
  version: pkg.version,
  description: pkg.description,
  displayName: 'Plugydown Context',
  license: pkg.license,
  author: pkg.author,
  homepage: pkg.homepage,
  repository: pkg.repository,
  keywords: pkg.keywords,
  platforms: [
    claudeCode({
      marketplace: {
        name: 'context-claude-code',
        category: 'Developer Tools',
        tags: ['documentation', 'developer-tools', 'ai-workflow'],
      },
    }),
    codex({
      interface: {
        shortDescription: 'Persistent repository knowledge for coding agents.',
        longDescription: 'Route, validate, and maintain durable repository knowledge with bounded context and explicit workflows.',
        developerName: pkg.author.name,
        category: 'Developer Tools',
        capabilities: ['Repository knowledge', 'Incremental documentation', 'Context continuation'],
        websiteURL: pkg.homepage,
        defaultPrompt: [
          'Use Plugydown Context to understand this repository before making changes.',
          'Initialize Plugydown Context for this repository.',
          'Update Plugydown Context after this engineering task.',
        ],
      },
      marketplace: {
        name: 'context-codex',
        displayName: 'Plugydown Context for Codex',
        category: 'Developer Tools',
        policy: {
          installation: 'AVAILABLE',
        },
      },
    }),
    cursor(),
    antigravity(),
    openCode(),
    pi(),
  ],
  runtime: {
    entries: {
      // 显式声明唯一可执行入口，其他 Runtime 顶层文件均为辅助模块。
      // agents 名称保留给 Extension 的调用索引与私有角色资源。
      context: { entry: 'cli.ts', kind: 'executable' },
    },
  },
  extensions: [hooks(), internalRoles()],
  public: {
    dir: 'public',
    copy: [
      { from: 'schemas', to: 'schemas' },
      // 与宿主平台无关的仓库 CI 适配器，所有交付单元使用同一份资源。
      { from: 'integrations', to: 'integrations' },
    ],
  },
  build: {
    outDir: 'dist',
    strict: true,
  },
})
