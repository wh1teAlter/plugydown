import antfu from '@antfu/eslint-config'

export default antfu({
  formatters: false,
  ignores: [
    '.scratch/**',
    '**/*.md',
    '**/*.toml',
    '**/*.yaml',
    '**/*.yml',
    '**/dist/**',
    'node_modules/**',
  ],
  stylistic: {
    quotes: 'single',
    semi: false,
  },
})
