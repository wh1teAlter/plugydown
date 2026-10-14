import hooks from '@aaplugin/extension-hooks'
import { defineConfig } from '@aaplugin/kit'
import claudeCode from '@aaplugin/platform-claude-code'
import codex from '@aaplugin/platform-codex'
import internalRoles from './extension/internal-roles.js'
import pkg from './package.json' with { type: 'json' }

// `package.json` is the single source of truth for package identity. Only fields with no
// npm equivalent are declared here: the plugin name (npm's is the scoped `@plugydown/context`)
// and the human-facing display name.
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
