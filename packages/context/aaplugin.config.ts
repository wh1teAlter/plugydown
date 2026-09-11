import hooks from '@aaplugin/extension-hooks'
import { defineConfig } from '@aaplugin/kit'
import claudeCode from '@aaplugin/platform-claude-code'
import codex from '@aaplugin/platform-codex'
import internalRoles from './extension/internal-roles.js'

export default defineConfig({
  name: 'context',
  version: '0.1.0',
  description: 'Persistent repository knowledge and engineering workflows.',
  displayName: 'Plugydown Context',
  license: 'MIT',
  author: {
    name: 'wh1teAlter',
    url: 'https://github.com/wh1teAlter',
  },
  homepage: 'https://github.com/wh1teAlter/plugydown',
  repository: 'https://github.com/wh1teAlter/plugydown',
  keywords: ['plugydown', 'repository-knowledge', 'ai-workflow'],
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
        developerName: 'wh1teAlter',
        category: 'Developer Tools',
        capabilities: ['Repository knowledge', 'Incremental documentation', 'Context continuation'],
        websiteURL: 'https://github.com/wh1teAlter/plugydown',
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
  ],
  runtime: {
    entries: {
      // Output path is `runtime/context/main.mjs`. The key must never be `agents`:
      // Codex private role resources live at `runtime/agents/`.
      context: { entry: 'cli.ts', kind: 'executable' },
    },
  },
  extensions: [hooks(), internalRoles()],
  public: {
    dir: 'public',
    copy: [
      { from: 'schemas', to: 'schemas' },
    ],
  },
  build: {
    outDir: 'dist',
    strict: true,
  },
})
