import antfu from '@antfu/eslint-config'

/** 统一仓库的 ESLint 与格式规则，排除生成产物和非代码资源。 */
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
