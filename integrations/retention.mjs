import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

// 此文件是 CI 宿主适配器；正式 Context 写入仍全部交给独立 Runtime 事务。
const protocol = 'plugydown.context.runtime'
// 宿主只接受固定对象身份，避免把移动分支名当成批准依据。
const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
// 仅这一类普通记录允许出现在集中维护的删除写集中。
const confirmationPath = /^context\/\.meta\/confirmations\/[a-z0-9]+(?:[.-][a-z0-9]+)*\/[a-f0-9]{64}\.json$/

/** 可直接公开的宿主诊断，排除底层 IO 错误中的机器路径和凭据。 */
class MaintenanceFault extends Error {}

/** 用固定参数执行 Git，不执行仓库钩子，不公开可能含凭据的 stderr。 */
function git(root, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, env, maxBuffer: 32 * 1024 * 1024 })
  if (result.error || result.status !== 0)
    throw new MaintenanceFault(`Git ${args[0]} failed; the maintenance result must not be published.`)
  return result.stdout
}

/** 校验 Git 对象参数，后续命令不接受任意 option 或移动 ref。 */
function requireObject(value) {
  if (typeof value !== 'string' || !objectId.test(value))
    throw new MaintenanceFault('Supply a fixed full Git object ID.')
  return value
}

/**
 * 调用完整发行包的唯一 Runtime，非零退出和非法 JSON 不当作产品成功。
 * @param root 业务仓库根目录。
 * @param runtime 已核对来源的普通 Runtime 文件路径。
 * @param capability 协议能力名。
 * @param input 当前能力输入。
 * @param action 可选事务动作。
 * @param cursor 可选分页游标。
 * @returns 原始产品响应，调用方还须检查阶段与数据；传输失败抛错并保留现场。
 * @remarks CI 宿主调用阶段，不在此函数中推导确认或 Git 发布权限。
 */
export function requestRuntime(root, runtime, capability, input = {}, action, cursor) {
  root = path.resolve(root)
  runtime = path.resolve(root, runtime)
  if (Number(process.versions.node.split('.')[0]) < 24)
    throw new MaintenanceFault('Context maintenance requires Node 24 or newer.')
  const info = lstatSync(runtime)
  if (!info.isFile() || info.isSymbolicLink())
    throw new MaintenanceFault('The supplied Runtime must be a regular installed file.')
  const request = { protocol, format: 1, capability, input, ...(action === undefined ? {} : { action }), ...(cursor === undefined ? {} : { cursor }) }
  const result = spawnSync(process.execPath, [runtime], { cwd: root, input: JSON.stringify(request), encoding: 'utf8', timeout: 120_000, maxBuffer: 2 * 1024 * 1024 })
  if (result.error || result.status !== 0)
    throw new MaintenanceFault('Context Runtime transport failed; preserve any active run.')
  let response
  try {
    response = JSON.parse(result.stdout)
  }
  catch {
    throw new MaintenanceFault('Context Runtime returned invalid transport data.')
  }
  if (response.protocol !== protocol || response.format !== 1 || response.capability !== capability
    || !['success', 'incomplete', 'failed', 'no_change', 'dry_run'].includes(response.status)) {
    throw new MaintenanceFault('Context Runtime response does not match the requested contract.')
  }
  return response
}

/** 只接受当前阶段预期的成功，错误和恢复需要不能获得自动批准。 */
function requireOutcome(response, outcome) {
  if (response.status !== 'success' || response.data?.outcome !== outcome
    || response.diagnostics?.some(item => item.severity === 'error')) {
    throw new MaintenanceFault(`Context maintenance did not reach ${outcome}; inspect its active run and diagnostics.`)
  }
  return response.data
}

/** 确认宿主仍处于同一干净提交，不把本地证据当作远端分支锁。 */
function requireCleanBase(root, base) {
  requireObject(base)
  if (git(root, ['rev-parse', '--verify', 'HEAD']).toString().trim() !== base
    || git(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all']).length !== 0) {
    throw new MaintenanceFault('Maintenance requires the fixed, clean mainline checkout.')
  }
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-merge', 'rebase-apply']) {
    const location = git(root, ['rev-parse', '--git-path', marker]).toString().trim()
    if (existsSync(path.resolve(root, location)))
      throw new MaintenanceFault('Finish the active Git operation before maintenance.')
  }
}

/** 创建本宿主拥有的直接 evidence 叶子，拒绝借用链接目录。 */
function evidenceLeaf(root, prefix) {
  for (const relative of ['.scratch', '.scratch/evidence']) {
    const directory = path.join(root, relative)
    if (!existsSync(directory))
      mkdirSync(directory)
    const info = lstatSync(directory)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new MaintenanceFault('Maintenance evidence parents must be ordinary directories.')
  }
  const relative = `.scratch/evidence/${prefix}-${randomUUID()}`
  mkdirSync(path.join(root, relative))
  return relative
}

/** 解析 --no-renames 的 NUL 原始差异，包含权限变化，不按行解析路径。 */
function changes(root, revisionArgs) {
  const fields = git(root, ['diff', '--raw', '-z', '--no-renames', ...revisionArgs]).toString('utf8').split('\0')
  const result = []
  for (let index = 0; index < fields.length - 1; index += 2) {
    const header = /^:(\d{6}) (\d{6}) [a-f0-9]+ [a-f0-9]+ ([AMDT])$/.exec(fields[index])
    if (!header || !fields[index + 1])
      throw new MaintenanceFault('Git returned an unsupported maintenance diff.')
    result.push({ beforeMode: header[1], afterMode: header[2], status: header[3], path: fields[index + 1] })
  }
  return result
}

/**
 * 检查普通 PR 对确认只做追加；使用贡献分支 merge-base 而非落后工作树对最新主线的差异。
 * @param options 固定 base/head 对象及业务仓库 root。
 * @param options.root 业务仓库根目录。
 * @param options.base 已固定的主线对象身份。
 * @param options.head 已固定的贡献分支对象身份。
 * @returns 新增确认数量；修改、删除、移动或权限变化会抛错。
 * @remarks 调用阶段：只读 PR 检查，不授予维护删除权限。
 */
export function auditContribution({ root, base, head }) {
  root = path.resolve(root)
  const ancestor = git(root, ['merge-base', requireObject(base), requireObject(head)]).toString().trim()
  const records = changes(root, [ancestor, head, '--', 'context/.meta/confirmations'])
  if (records.some(item => item.status !== 'A' || item.afterMode !== '100644' || !confirmationPath.test(item.path)))
    throw new MaintenanceFault('Ordinary contributions may only add canonical confirmation files; use the single mainline maintenance authority for deletion.')
  return { status: 'success', addedCount: records.length }
}

/**
 * 在固定干净 checkout 通过官方事务生成删除变更，不提交、推送或开 PR。
 * @param options root/runtime/base 为明确宿主输入，force 仅绕过批量调度阈值；invoke 供离线测试注入同一协议。
 * @param options.root 业务仓库根目录。
 * @param options.runtime 官方 Runtime 路径。
 * @param options.base 本次维护冻结的主线提交。
 * @param options.force 是否显式忽略批量触发阈值。
 * @param options.invoke 同一 Runtime 请求适配器，测试可注入。
 * @returns 无变化或可发布的删除摘要；失败保留已进入提交阶段的事务现场。
 * @remarks 调用阶段：仓库已授权的唯一维护流程，发布及远端拒旧由宿主执行。
 */
export async function prepareRetention({ root, runtime, base, force = false, invoke = requestRuntime }) {
  // 临时 worktree 会改变子进程 cwd，先固定调用方的路径身份。
  root = path.resolve(root)
  runtime = path.resolve(root, runtime)
  requireCleanBase(root, base)
  const preview = await invoke(root, runtime, 'confirmation.retention')
  if (preview.status !== 'success' || typeof preview.data?.retention?.triggered !== 'boolean')
    throw new MaintenanceFault('Retention preview failed; use a compatible maintenance Runtime and valid current sources.')
  if (!force && !preview.data.retention.triggered)
    return { status: 'no_change', base, retention: preview.data.retention }
  const evidence = evidenceLeaf(root, 'retention')
  let runId
  let beginAttempted = false
  let commitAttempted = false
  try {
    // 证据必须被仓库忽略；创建叶子后再次检查，避免纳入未暂存文件。
    requireCleanBase(root, base)
    writeFileSync(path.join(root, evidence, 'head.txt'), `${base}\n`)
    writeFileSync(path.join(root, evidence, 'mid-operation.json'), '{"active":false}\n')
    writeFileSync(path.join(root, evidence, 'status.bin'), git(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']))
    beginAttempted = true
    const begun = requireOutcome(await invoke(root, runtime, 'transaction', {
      command: 'compact',
      mode: 'deep',
      dryRun: false,
      scope: { kind: 'repository' },
      gitEvidencePath: evidence,
      evidencePaths: [],
    }, 'begin'), 'staged')
    runId = begun.runId
    const validation = await invoke(root, runtime, 'transaction', { runId }, 'validate')
    if (validation.status === 'no_change')
      return { status: 'no_change', base, retention: preview.data.retention }
    const validated = requireOutcome(validation, 'ready_for_review')
    if (validated.nextAction !== 'retention_review' || validated.retention?.planFingerprint !== preview.data.retention.planFingerprint)
      throw new MaintenanceFault('The validated plan does not match the mechanical retention preview.')
    requireCleanBase(root, base)
    commitAttempted = true
    const committed = requireOutcome(await invoke(root, runtime, 'transaction', {
      runId,
      approval: { approved: true, candidateFingerprint: validated.candidateFingerprint, sourceEvidenceFingerprint: validated.sourceEvidenceFingerprint, summary: 'Authorized centralized retention; existing bytes and current confirmation facts verified by Runtime.' },
    }, 'commit'), 'committed')
    if (git(root, ['rev-parse', 'HEAD']).toString().trim() !== base)
      throw new MaintenanceFault('The checkout moved after retention; do not publish this result.')
    const diff = changes(root, [base, '--'])
    if (diff.length !== validated.retention.removedCount || diff.some(item => item.status !== 'D' || !confirmationPath.test(item.path))
      || git(root, ['ls-files', '--others', '--exclude-standard']).length !== 0) {
      throw new MaintenanceFault('The resulting write set is not exactly the approved confirmation deletions.')
    }
    return { status: 'prepared', base, contextFingerprint: committed.contextFingerprint, retention: validated.retention }
  }
  catch (error) {
    if (runId && !commitAttempted) {
      try {
        await invoke(root, runtime, 'transaction', { runId, disposition: 'abandon' }, 'resume')
      }
      catch { /* 无法确认安全放弃时，保留原事务和证据。 */ }
    }
    else if (!runId && !beginAttempted && existsSync(path.join(root, evidence))) {
      rmSync(path.join(root, evidence), { recursive: true })
    }
    throw error
  }
}

/**
 * 独立重建官方清理结果并比对完整 Git 树，验证维护 PR 没有混入其他写入。
 * @param options root/runtime/base/head 均由可信 CI 固定；base 必须是发布时要求的主线身份。
 * @param options.root 业务仓库根目录。
 * @param options.runtime 官方 Runtime 路径。
 * @param options.base 验证时要求的主线提交。
 * @param options.head 维护提案的固定提交。
 * @param options.invoke 同一 Runtime 请求适配器，测试可注入。
 * @returns 与官方结果完全一致的维护提交；过期或额外变更抛错。
 * @remarks 调用阶段：维护身份已经由宿主确认后的只读 PR 验证；仅写入自有临时 worktree。
 */
export async function verifyRetention({ root, runtime, base, head, invoke = requestRuntime }) {
  root = path.resolve(root)
  runtime = path.resolve(root, runtime)
  requireObject(base)
  requireObject(head)
  const parents = git(root, ['rev-list', '--parents', '-n', '1', head]).toString().trim().split(' ')
  if (parents.length !== 2 || parents[1] !== base)
    throw new MaintenanceFault('The maintenance commit must be based directly on the current mainline; regenerate a stale plan.')
  const diff = changes(root, [base, head, '--'])
  if (diff.length === 0 || diff.some(item => item.status !== 'D' || !confirmationPath.test(item.path)))
    throw new MaintenanceFault('A maintenance commit may contain only confirmation deletions.')
  const evidence = evidenceLeaf(root, 'verify-retention')
  const temporary = path.join(root, evidence, 'tree')
  let added = false
  try {
    git(root, ['worktree', 'add', '--detach', temporary, base])
    added = true
    await prepareRetention({ root: temporary, runtime, base, force: true, invoke })
    git(temporary, ['add', '-u', '--', 'context/.meta/confirmations'])
    const expected = git(temporary, ['write-tree']).toString().trim()
    const actual = git(root, ['rev-parse', `${head}^{tree}`]).toString().trim()
    if (actual !== expected)
      throw new MaintenanceFault('The maintenance tree differs from the official retention plan.')
    return { status: 'success', base, head, removedCount: diff.length }
  }
  finally {
    // 未知传输结果或人工恢复现场必须保留，不能因验证失败直接删除运行副本。
    const runs = path.join(temporary, '.scratch/runs')
    const active = existsSync(path.join(temporary, '.scratch/locks/context-write')) || (existsSync(runs) && readdirSync(runs).length > 0)
    if (!active) {
      if (added)
        git(root, ['worktree', 'remove', '--force', temporary])
      rmSync(path.join(root, evidence), { recursive: true })
    }
  }
}

/** 收集完整官方匹配事实，拒绝漏页、重复、来源不可用和快照变化。 */
async function confirmationFacts(root, runtime, invoke) {
  const items = new Map()
  const cursors = new Set()
  let cursor
  let snapshot
  let documents
  let expectedCounts
  const counts = { matched: 0, unmatched: 0 }
  do {
    const response = await invoke(root, runtime, 'confirmation.check', { scope: { kind: 'repository' }, explain: false }, undefined, cursor)
    const data = response.data
    if (!['success', 'incomplete'].includes(response.status) || response.diagnostics?.some(item => item.severity === 'error') || data?.scope?.kind !== 'repository'
      || data.structureState !== 'valid' || data.recordStore?.state !== 'valid' || data.recordStore.coverage !== 'repository'
      || data.sourceState !== 'ready' || !Number.isSafeInteger(data.summary?.documents)
      || data.summary.checked !== data.summary.documents || data.summary.unchecked !== 0
      || data.summary.unavailable !== 0 || data.summary.matched + data.summary.unmatched !== data.summary.documents
      || !/^[a-f0-9]{64}$/.test(data.snapshotFingerprint)
      || !Array.isArray(data.items) || (snapshot !== undefined && snapshot !== data.snapshotFingerprint)) {
      throw new MaintenanceFault('The complete confirmation snapshot is unavailable.')
    }
    snapshot = data.snapshotFingerprint
    documents = data.summary.documents
    const pageCounts = JSON.stringify([data.summary.documents, data.summary.matched, data.summary.unmatched])
    if (expectedCounts !== undefined && expectedCounts !== pageCounts)
      throw new MaintenanceFault('Confirmation counts changed between pages.')
    expectedCounts = pageCounts
    for (const item of data.items) {
      if (items.has(item.documentId) || !['matched', 'unmatched'].includes(item.confirmationState)
        || item.sourceState !== 'ready' || typeof item.documentContentKnown !== 'boolean'
        || !/^[a-f0-9]{64}$/.test(item.currentKey)
        || (item.confirmationState === 'matched' && (item.matchedKey !== item.currentKey || !item.documentContentKnown))) {
        throw new MaintenanceFault('Invalid or duplicate confirmation facts.')
      }
      items.set(item.documentId, {
        documentId: item.documentId,
        path: item.path,
        currentKey: item.currentKey,
        confirmationState: item.confirmationState,
        documentContentKnown: item.documentContentKnown,
        sourceState: item.sourceState,
      })
      counts[item.confirmationState] += 1
    }
    cursor = response.cursor
    if (response.status === 'incomplete' ? typeof cursor !== 'string' || !cursor || data.items.length === 0 || cursors.has(cursor) : cursor !== undefined)
      throw new MaintenanceFault('Confirmation pagination did not complete safely.')
    if (cursor)
      cursors.add(cursor)
  } while (cursor)
  if (items.size !== documents || JSON.stringify([documents, counts.matched, counts.unmatched]) !== expectedCounts)
    throw new MaintenanceFault('Confirmation pagination omitted Documents.')
  return JSON.stringify([...items].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
}

/**
 * 在实际合并结果上证明删除历史没有损失当前依据，允许队列同时包含普通代码变更。
 * @param options 固定队列 base/head；维护身份与普通 PR 追加限制必须先由可信 PR 检查确认。
 * @param options.root 业务仓库根目录。
 * @param options.runtime 官方 Runtime 路径。
 * @param options.base 队列合并的固定基线。
 * @param options.head 队列实际合并结果。
 * @param options.invoke 同一 Runtime 请求适配器，测试可注入。
 * @returns 当前事实保持的结果；需要旧确认、删空身份或来源变化时拒绝。
 * @remarks 仅在独立验证副本恢复原始 Git 确认字节作对照，不改源码、不写业务 Context、不制造确认。
 */
export async function verifyRetentionMerge({ root, runtime, base, head, invoke = requestRuntime }) {
  root = path.resolve(root)
  runtime = path.resolve(root, runtime)
  requireObject(base)
  requireObject(head)
  const diff = changes(root, [base, head, '--', 'context/.meta/confirmations'])
  if (diff.some(item => !['A', 'D'].includes(item.status) || !confirmationPath.test(item.path)))
    throw new MaintenanceFault('The merge result modified an immutable confirmation.')
  const removed = diff.filter(item => item.status === 'D')
  if (removed.length === 0)
    return { status: 'success', base, head, removedCount: 0 }
  const evidence = evidenceLeaf(root, 'verify-retention-merge')
  const temporary = path.join(root, evidence, 'tree')
  let added = false
  try {
    git(root, ['worktree', 'add', '--detach', temporary, head])
    added = true
    const actual = await confirmationFacts(temporary, runtime, invoke)
    for (const item of removed) {
      const target = path.join(temporary, item.path)
      const directory = path.dirname(target)
      if (existsSync(target) || !existsSync(directory) || lstatSync(directory).isSymbolicLink()
        || !readdirSync(directory).some(name => /^[a-f0-9]{64}\.json$/.test(name))) {
        throw new MaintenanceFault('Retention must preserve every historical identity directory.')
      }
      // 从固定 base 读取原始记录，随后由 Runtime 重新验证 canonical 字节和身份。
      const original = git(root, ['show', `${base}:${item.path}`])
      if (original.length > 4096)
        throw new MaintenanceFault('Historical confirmation exceeds the format-one file limit.')
      writeFileSync(target, original, { flag: 'wx', mode: 0o644 })
    }
    const withoutDeletion = await confirmationFacts(temporary, runtime, invoke)
    if (actual !== withoutDeletion)
      throw new MaintenanceFault('The merge needs a discarded confirmation; regenerate the maintenance plan against the new inputs.')
    return { status: 'success', base, head, removedCount: removed.length }
  }
  finally {
    if (added)
      git(root, ['worktree', 'remove', '--force', temporary])
    rmSync(path.join(root, evidence), { recursive: true })
  }
}

/** 解析显式 CI 参数，不从环境或分支名字猜测维护授权。 */
async function main(args) {
  const command = args.shift()
  const options = { root: process.cwd(), force: false }
  while (args.length) {
    const option = args.shift()
    if (option === '--force') {
      options.force = true
      continue
    }
    if (!['--runtime', '--base', '--head'].includes(option) || args.length === 0)
      throw new MaintenanceFault('Use preview/prepare/audit/verify/verify-merge with explicit --runtime, --base and --head as applicable.')
    options[option.slice(2)] = args.shift()
  }
  if (command === 'audit')
    return auditContribution(options)
  if (!options.runtime)
    throw new MaintenanceFault('Supply the official installed --runtime path.')
  options.runtime = path.resolve(options.runtime)
  if (command === 'preview')
    return requestRuntime(options.root, options.runtime, 'confirmation.retention')
  if (command === 'prepare')
    return prepareRetention(options)
  if (command === 'verify')
    return verifyRetention(options)
  if (command === 'verify-merge')
    return verifyRetentionMerge(options)
  throw new MaintenanceFault('Unknown maintenance command.')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(result => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => {
    process.stderr.write(error instanceof MaintenanceFault ? `${error.message}\n` : 'Context maintenance failed. Do not publish; inspect the isolated checkout and preserve any active Runtime run.\n')
    process.exitCode = 1
  })
}
