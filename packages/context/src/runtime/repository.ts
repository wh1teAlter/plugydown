import type { Buffer } from 'node:buffer'
import type { Diagnostic } from './protocol.js'
import { createHash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { isRecord, RuntimeFault, sha256 } from './protocol.js'
import { compactJson, compareCodeUnits } from './stable-json.js'

// 业务仓库中的正式知识根目录。
export const CONTEXT_ROOT = 'context'
// 业务仓库中的临时工作目录，不能作为正式知识。
export const SCRATCH_ROOT = '.scratch'
// 宿主收集的 Git 原始证据所在集合。
export const EVIDENCE_ROOT = `${SCRATCH_ROOT}/evidence`
// 尚未晋升或丢弃的临时反馈所在集合。
export const FEEDBACK_ROOT = `${SCRATCH_ROOT}/feedback`
// Runtime 拥有的事务运行目录集合。
export const RUNS_ROOT = `${SCRATCH_ROOT}/runs`
// 当前仓库唯一写事务的原子目录锁位置。
export const LOCK_ROOT = `${SCRATCH_ROOT}/locks/context-write`
// 持久写锁所有者文件的格式标识。
export const LOCK_SCHEMA = 'plugydown.context.lock/v1'

// 单个 Markdown 文件的读取上限，单位为字节。
export const MAX_MARKDOWN_BYTES = 1024 * 1024
// 单个 front matter 的读取上限，单位为字节。
export const MAX_FRONT_MATTER_BYTES = 64 * 1024
// JSON 或通用文本读取的上限，单位为字节。
export const MAX_JSON_TEXT_BYTES = 4 * 1024 * 1024
// 单份 Git 证据文件的读取上限，单位为字节。
export const MAX_GIT_EVIDENCE_BYTES = 16 * 1024 * 1024
// 单次源码展开或正式树扫描允许的最大文件数量。
export const MAX_SOURCE_FILES = 10_000
// 单次源码展开或正式树扫描的总字节上限。
export const MAX_SOURCE_BYTES = 512 * 1024 * 1024

// 不允许进入仓库路径的环境变量表达式。
const VARIABLE = /\$|%[A-Z_]\w*%/i
// 受控 glob 不支持的通配语法字符。
const UNSUPPORTED_GLOB = /[?[\]{}!]/
// 写锁中合法事务 UUID v4 的格式。
const RUN_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
// 仅禁止仓库根级的 .git、.scratch 和 context 作为源码；node_modules 则在任何深度都禁止，避免误拒绝 packages/context/**。
const FORBIDDEN_SOURCE_ROOTS = new Set(['.git', '.scratch', 'context'])
// 允许由工作流独占和清理的直接叶子目录名格式。
const SCRATCH_LEAF_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
// 可转换为安全产品故障的已知文件系统 errno 白名单。
const KNOWN_FILESYSTEM_CODES = new Set([
  'ENOENT',
  'EACCES',
  'EPERM',
  'ENOTDIR',
  'EISDIR',
  'EEXIST',
  'ENOSPC',
  'EROFS',
  'EMFILE',
  'ENFILE',
  'EIO',
  'EBUSY',
  'EXDEV',
])

/** 判断候选路径是否可作为诊断公开，不进行文件系统访问。 */
function isSafeDiagnosticPath(candidate: string): boolean {
  if (candidate.length === 0 || candidate.length > 1_024 || candidate.includes('\\')
    || path.posix.isAbsolute(candidate) || path.win32.isAbsolute(candidate) || /^[A-Z]:/i.test(candidate)
    || [...candidate].some((character) => {
      // 当前字符的 Unicode 码点，用于拒绝控制字符。
      const value = character.codePointAt(0) as number
      return value <= 0x1F || value === 0x7F
    })
    || VARIABLE.test(candidate)) {
    return false
  }
  // 待校验路径的逐级分段，不允许空段或目录穿越。
  const segments = candidate.split('/')
  return !segments.some(segment => segment.length === 0 || segment === '.' || segment === '..' || segment.includes('~'))
}

/** 抛出路径故障，仅在明确允许且路径安全时附带路径文本。 */
function pathFault(code: string, message: string, candidate: string, disclose = false): never {
  throw new RuntimeFault(code, message, disclose && isSafeDiagnosticPath(candidate) ? candidate : undefined)
}

/**
 * 判断异常是否属于可转为产品诊断的已知文件系统错误。
 *
 * @param error - 待分类的异常，可能是产品故障或未知错误。
 * @returns 是否属于允许转换的 errno 类型，同时缩窄异常类型。
 * @throws 合法类型输入下不主动抛出业务异常。
 * @remarks 调用阶段：路径、源码或 Git 证据进入对应能力前；除调用方传入的文件操作回调外，辅助读取不修改正式文件。
 */
export function isKnownFilesystemError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null
    && typeof (error as NodeJS.ErrnoException).code === 'string'
    && KNOWN_FILESYSTEM_CODES.has((error as NodeJS.ErrnoException).code as string)
}

/**
 * 保留已有产品故障、转换已知 errno，并原样抛出未知异常。
 *
 * @param error - 待分类的异常，可能是产品故障或未知错误。
 * @param candidate - 待验证的仓库相对路径。
 * @throws 已有 RuntimeFault 或未知异常原样抛出；已知 errno 转为 REPOSITORY_IO_FAILED。
 * @remarks 调用阶段：路径、源码或 Git 证据进入对应能力前；除调用方传入的文件操作回调外，辅助读取不修改正式文件。 返回约定：不返回；始终抛出转换后的产品故障或原异常。
 */
export function throwFilesystemFault(error: unknown, candidate?: string): never {
  if (error instanceof RuntimeFault)
    throw error
  if (!isKnownFilesystemError(error))
    throw error
  throw new RuntimeFault(
    'REPOSITORY_IO_FAILED',
    `A repository filesystem operation failed with ${error.code}.`,
    candidate !== undefined && isSafeDiagnosticPath(candidate) ? candidate : undefined,
  )
}

/**
 * 执行一次文件系统操作，仅将已知 errno 转为安全的 Runtime 故障。
 *
 * @param operation - 由调用方提供的单次异步文件系统操作。
 * @param candidate - 待验证的仓库相对路径。
 * @returns 底层异步操作的原始结果。
 * @throws 已知 errno 转为 REPOSITORY_IO_FAILED；已有 RuntimeFault 与未知异常原样抛出。
 * @remarks 调用阶段：路径、源码或 Git 证据进入对应能力前；除调用方传入的文件操作回调外，辅助读取不修改正式文件。
 */
export async function filesystemOperation<T>(operation: () => Promise<T>, candidate?: string): Promise<T> {
  try {
    return await operation()
  }
  catch (error) {
    throwFilesystemFault(error, candidate)
  }
}

/**
 * 校验 Runtime 仓库相对路径的词法安全边界。
 *
 * @param candidate - 待验证的仓库相对路径。
 * @throws 路径、类型、编码或资源限制不满足时抛出 RuntimeFault；未分类异常继续传播。
 * @remarks 调用阶段：路径、源码或 Git 证据进入对应能力前；除调用方传入的文件操作回调外，辅助读取不修改正式文件。 返回约定：校验通过时无返回值。
 */
export function assertSafeRelativePath(candidate: string): void {
  if (candidate.length === 0)
    pathFault('PATH_EMPTY', 'A repository-relative path must not be empty.', candidate)
  if (candidate.length > 1_024)
    pathFault('PATH_LENGTH_EXCEEDED', 'A repository-relative path exceeds the length limit.', candidate)
  if (candidate.includes('\\'))
    pathFault('PATH_SEPARATOR_INVALID', 'Repository paths must use forward slashes.', candidate)
  if (path.posix.isAbsolute(candidate) || path.win32.isAbsolute(candidate) || /^[A-Z]:/i.test(candidate))
    pathFault('PATH_ABSOLUTE', 'A repository path must be relative.', candidate)
  if ([...candidate].some((character) => {
    // 当前字符的 Unicode 码点，用于拒绝控制字符。
    const value = character.codePointAt(0) as number
    return value <= 0x1F || value === 0x7F
  })) {
    pathFault('PATH_CONTROL_CHARACTER', 'A repository path must not contain control characters.', candidate)
  }
  if (VARIABLE.test(candidate))
    pathFault('PATH_VARIABLE', 'A repository path must not contain variables.', candidate)
  // 待校验路径的逐级分段，不允许空段或目录穿越。
  const segments = candidate.split('/')
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..' || segment.includes('~')))
    pathFault('PATH_SEGMENT_INVALID', 'A repository path contains an unsafe segment.', candidate)
}

/**
 * 判断声明是否包含通配符或不受支持的 glob 语法。
 *
 * @param pattern - 精确源码路径或受控 glob 声明。
 * @returns 声明是否包含通配符或受限制的 glob 字符。
 * @throws 合法类型输入下不主动抛出业务异常。
 * @remarks 调用阶段：路径、源码或 Git 证据进入对应能力前；除调用方传入的文件操作回调外，辅助读取不修改正式文件。
 */
export function hasGlob(pattern: string): boolean {
  return pattern.includes('*') || UNSUPPORTED_GLOB.test(pattern)
}

/**
 * 校验 code.paths 与路径范围允许使用的受控 glob 语法。
 *
 * @param pattern - 精确源码路径或受控 glob 声明。
 * @throws 路径、类型、编码或资源限制不满足时抛出 RuntimeFault；未分类异常继续传播。
 * @remarks 调用阶段：路径、源码或 Git 证据进入对应能力前；除调用方传入的文件操作回调外，辅助读取不修改正式文件。 返回约定：校验通过时无返回值。
 */
export function assertSourcePattern(pattern: string): void {
  assertSafeRelativePath(pattern)
  // 待校验路径的逐级分段，不允许空段或目录穿越。
  const segments = pattern.split('/')
  if (pattern.includes('*') && (segments.length < 2 || segments[0]?.includes('*')))
    pathFault('GLOB_ANCHOR_INVALID', 'A source pattern must begin with a concrete directory.', pattern)
  if (UNSUPPORTED_GLOB.test(pattern))
    pathFault('GLOB_SYNTAX_INVALID', 'A source pattern uses unsupported glob syntax.', pattern)
  if (segments.filter(segment => segment === '**').length > 1 || segments.some(segment => segment.includes('**') && segment !== '**'))
    pathFault('GLOB_RECURSION_INVALID', 'A source pattern may contain one complete recursive segment.', pattern)
  if (FORBIDDEN_SOURCE_ROOTS.has(segments[0] ?? '') || segments.includes('node_modules'))
    pathFault('SOURCE_ROOT_FORBIDDEN', 'A source pattern points into a forbidden repository root.', pattern)
}

/** 从写锁中读出的所有权状态，不包含事务内容是否可恢复的判断。 */
export type LockOwner
  = | { readonly state: 'absent' }
    | {
      readonly state: 'valid'
      /** Runtime 生成的事务 UUID，也是运行目录和写锁所有权标识。 */
      readonly runId: string
    }
    | { readonly state: 'corrupt' }

/**
 * 统一读取写锁所有者，使检查和事务入口采用同一有效性标准。
 *
 * @param root - 业务仓库根目录。
 * @returns 写锁缺失、有效 UUID 所有者或损坏三种状态之一。
 * @throws 可预期读取或 JSON 错误归为 corrupt；未知异常继续抛出。
 * @remarks 调用阶段：路径、源码或 Git 证据进入对应能力前；除调用方传入的文件操作回调外，辅助读取不修改正式文件。
 */
export async function readLockOwner(root: string): Promise<LockOwner> {
  try {
    // 通过 lstat 取得的文件类型、权限和大小，避免隐式跟随链接。
    const info = await lstatRepositoryPath(root, LOCK_ROOT)
    if (info === undefined)
      return { state: 'absent' }
    if (!info.isDirectory())
      return { state: 'corrupt' }
    // 从持久文件或未校验输入取得的原始数据。
    const raw = JSON.parse(await readUtf8File(root, `${LOCK_ROOT}/owner.json`, MAX_JSON_TEXT_BYTES)) as unknown
    if (!isRecord(raw) || Object.keys(raw).length !== 2 || raw.schema !== LOCK_SCHEMA
      || typeof raw.runId !== 'string' || !RUN_ID.test(raw.runId)) {
      return { state: 'corrupt' }
    }
    return { state: 'valid', runId: raw.runId }
  }
  catch (error) {
    if (error instanceof RuntimeFault || error instanceof SyntaxError)
      return { state: 'corrupt' }
    throw error
  }
}

/** 判断已解析路径是否仍位于指定根目录或根目录之下。 */
function isInside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${path.sep}`)
}

/** 解析真实仓库根目录并确认它是目录。 */
async function realRoot(root: string): Promise<string> {
  // 通过 realpath 得到的真实仓库根目录。
  const resolved = await filesystemOperation(() => fs.realpath(root))
  // 通过 lstat 取得的文件类型、权限和大小，避免隐式跟随链接。
  const info = await filesystemOperation(() => fs.lstat(resolved))
  if (!info.isDirectory())
    throw new RuntimeFault('REPOSITORY_ROOT_INVALID', 'The Runtime root must be a directory.')
  return resolved
}

/**
 * 取得经过真实路径和目录类型校验的 Runtime 根目录。
 *
 * @param root - 业务仓库根目录。
 * @returns 真实存在且类型为目录的绝对仓库根路径。
 * @throws 路径、类型、编码或资源限制不满足时抛出 RuntimeFault；未分类异常继续传播。
 * @remarks 调用阶段：路径、源码或 Git 证据进入对应能力前；除调用方传入的文件操作回调外，辅助读取不修改正式文件。
 */
export async function resolveRepositoryRoot(root: string): Promise<string> {
  return realRoot(root)
}

/**
 * 解析仓库相对路径并逐级拒绝符号链接，即使链接仍指向仓库内部。
 *
 * @param root - 业务仓库根目录。
 * @param candidate - 待验证的仓库相对路径。
 * @param allowMissingTail - 是否允许路径末段尚不存在，创建或检查路径时使用。
 * @returns 经过边界和逐级链接检查的绝对路径。
 * @throws 路径、类型、编码或资源限制不满足时抛出 RuntimeFault；未分类异常继续传播。
 * @remarks 调用阶段：路径、源码或 Git 证据进入对应能力前；除调用方传入的文件操作回调外，辅助读取不修改正式文件。
 */
export async function resolveRepositoryPath(root: string, candidate: string, allowMissingTail = false): Promise<string> {
  assertSafeRelativePath(candidate)
  // 本次操作固定的根目录或去除阶段性字段后的事务基础事实。
  const base = await realRoot(root)
  // 通过仓库边界检查的绝对路径，仅用于内部文件操作。
  const absolute = path.resolve(base, ...candidate.split('/'))
  if (!isInside(base, absolute))
    pathFault('PATH_ESCAPE', 'A repository path resolves outside the Runtime root.', candidate)

  // 待校验路径的逐级分段，不允许空段或目录穿越。
  const segments = candidate.split('/')
  // 本轮处理的节点或重新读取的状态。
  let current = base
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index] as string)
    // 通过 lstat 取得的文件类型、权限和大小，避免隐式跟随链接。
    let info
    try {
      info = await fs.lstat(current)
    }
    catch (error) {
      if (allowMissingTail && (error as NodeJS.ErrnoException).code === 'ENOENT')
        return absolute
      throwFilesystemFault(error, candidate)
    }
    if (info.isSymbolicLink())
      pathFault('PATH_SYMLINK', 'Repository paths must not traverse symlinks.', candidate)
    if (index < segments.length - 1 && !info.isDirectory())
      pathFault('PATH_PARENT_NOT_DIRECTORY', 'A repository path parent must be a directory.', candidate)
  }
  return absolute
}

/**
 * 安全读取路径元信息；目标不存在时返回 undefined。
 *
 * @param root - 业务仓库根目录。
 * @param candidate - 待验证的仓库相对路径。
 * @returns 目标的文件系统信息；目标不存在时为 undefined。
 * @throws 路径、类型、编码或资源限制不满足时抛出 RuntimeFault；未分类异常继续传播。
 * @remarks 调用阶段：路径、源码或 Git 证据进入对应能力前；除调用方传入的文件操作回调外，辅助读取不修改正式文件。
 */
export async function lstatRepositoryPath(root: string, candidate: string): Promise<import('node:fs').Stats | undefined> {
  // 通过仓库边界检查的绝对路径，仅用于内部文件操作。
  const absolute = await resolveRepositoryPath(root, candidate, true)
  try {
    return await fs.lstat(absolute)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return undefined
    throwFilesystemFault(error, candidate)
  }
}

/**
 * 在路径安全检查通过后判断目标是否存在。
 *
 * @param root - 业务仓库根目录。
 * @param candidate - 待验证的仓库相对路径。
 * @returns 目标是否存在；路径安全错误不会被当作不存在。
 * @throws 路径、类型、编码或资源限制不满足时抛出 RuntimeFault；未分类异常继续传播。
 * @remarks 调用阶段：路径、源码或 Git 证据进入对应能力前；除调用方传入的文件操作回调外，辅助读取不修改正式文件。
 */
export async function pathExists(root: string, candidate: string): Promise<boolean> {
  return (await lstatRepositoryPath(root, candidate)) !== undefined
}

/**
 * 限量读取普通文件原始字节，拒绝链接和特殊文件。
 *
 * @param root - 业务仓库根目录。
 * @param candidate - 待验证的仓库相对路径。
 * @param maximum - 允许读取或处理的上限；文件读取时单位为字节。
 * @returns 文件原始字节 Buffer。
 * @throws 路径、类型、编码或资源限制不满足时抛出 RuntimeFault；未分类异常继续传播。
 * @remarks 调用阶段：路径、源码或 Git 证据进入对应能力前；除调用方传入的文件操作回调外，辅助读取不修改正式文件。
 */
export async function readRegularBytes(root: string, candidate: string, maximum: number): Promise<Buffer> {
  // 通过仓库边界检查的绝对路径，仅用于内部文件操作。
  const absolute = await resolveRepositoryPath(root, candidate)
  // 通过 lstat 取得的文件类型、权限和大小，避免隐式跟随链接。
  const info = await filesystemOperation(() => fs.lstat(absolute), candidate)
  if (!info.isFile() || info.isSymbolicLink())
    pathFault('PATH_NOT_REGULAR_FILE', 'A repository path must reference a regular file.', candidate)
  if (info.size > maximum)
    pathFault('FILE_SIZE_EXCEEDED', 'A repository file exceeds its resource limit.', candidate)
  return filesystemOperation(() => fs.readFile(absolute), candidate)
}

/**
 * 严格解码 UTF-8 字节，非法编码转为带安全路径的产品故障。
 *
 * @param bytes - 原始字节序列。
 * @param candidate - 待验证的仓库相对路径。
 * @returns 严格 UTF-8 解码后的文本。
 * @throws 路径、类型、编码或资源限制不满足时抛出 RuntimeFault；未分类异常继续传播。
 * @remarks 调用阶段：路径、源码或 Git 证据进入对应能力前；除调用方传入的文件操作回调外，辅助读取不修改正式文件。
 */
export function decodeUtf8(bytes: Uint8Array, candidate: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }
  catch {
    pathFault('FILE_ENCODING_INVALID', 'A Runtime text file must be valid UTF-8.', candidate)
  }
}

/**
 * 安全限量读取普通文件并严格解码为 UTF-8 文本。
 *
 * @param root - 业务仓库根目录。
 * @param candidate - 待验证的仓库相对路径。
 * @param maximum - 允许读取或处理的上限；文件读取时单位为字节。
 * @returns 不超读取上限且编码有效的文件文本。
 * @throws 路径、类型、编码或资源限制不满足时抛出 RuntimeFault；未分类异常继续传播。
 * @remarks 调用阶段：路径、源码或 Git 证据进入对应能力前；除调用方传入的文件操作回调外，辅助读取不修改正式文件。
 */
export async function readUtf8File(root: string, candidate: string, maximum: number): Promise<string> {
  return decodeUtf8(await readRegularBytes(root, candidate, maximum), candidate)
}

/** 安全目录读取返回的名称与条目类型，不隐式跟随符号链接。 */
export interface DirectoryEntry {
  /** 目录条目或资源的相对名称。 */
  readonly name: string
  /** 用于选择合法分支的种类判别值。 */
  readonly kind: 'directory' | 'file' | 'symlink' | 'special'
}

/**
 * 读取目录并按名称稳定排序，保留链接和特殊条目的类型供上层拒绝。
 *
 * @param root - 业务仓库根目录。
 * @param candidate - 待验证的仓库相对路径。
 * @returns 按名称稳定排序的目录条目，包含明确的文件类型。
 * @throws 路径、类型、编码或资源限制不满足时抛出 RuntimeFault；未分类异常继续传播。
 * @remarks 调用阶段：路径、源码或 Git 证据进入对应能力前；除调用方传入的文件操作回调外，辅助读取不修改正式文件。
 */
export async function readDirectory(root: string, candidate: string): Promise<readonly DirectoryEntry[]> {
  // 通过仓库边界检查的绝对路径，仅用于内部文件操作。
  const absolute = await resolveRepositoryPath(root, candidate)
  // 通过 lstat 取得的文件类型、权限和大小，避免隐式跟随链接。
  const info = await filesystemOperation(() => fs.lstat(absolute), candidate)
  if (!info.isDirectory())
    pathFault('PATH_NOT_DIRECTORY', 'A repository path must reference a directory.', candidate)
  return (await filesystemOperation(() => fs.readdir(absolute, { withFileTypes: true }), candidate))
    .map((entry) => {
      // 当前目录条目的明确文件类型。
      const kind = entry.isSymbolicLink()
        ? 'symlink' as const
        : entry.isDirectory()
          ? 'directory' as const
          : entry.isFile()
            ? 'file' as const
            : 'special' as const
      return { name: entry.name, kind }
    })
    .sort((left, right) => compareCodeUnits(left.name, right.name))
}

/** 严格目录快照中的相对路径、原始字节和 POSIX 权限位。 */
export interface TreeFile {
  /** 相对业务仓库根目录的实际文件路径。 */
  readonly path: string
  /** 该文件的原始字节 Buffer，不做文本规范化。 */
  readonly bytes: Buffer
  /** 文件的 POSIX 权限位，仅保留低九位。 */
  readonly mode: number
}

/**
 * 遍历普通目录树并限制文件数和总字节数，不跟随或静默丢弃不安全条目。
 *
 * @param root - 业务仓库根目录。
 * @param treePath - 待遍历的仓库相对目录。
 * @param maximumFileBytes - 单个文件允许读取的最大字节数。
 * @returns 按相对路径排序的文件原始字节与权限快照。
 * @throws 路径、类型、编码或资源限制不满足时抛出 RuntimeFault；未分类异常继续传播。
 * @remarks 调用阶段：路径、源码或 Git 证据进入对应能力前；除调用方传入的文件操作回调外，辅助读取不修改正式文件。
 */
export async function readTree(root: string, treePath: string, maximumFileBytes = MAX_JSON_TEXT_BYTES): Promise<readonly TreeFile[]> {
  // 当前文档或交付单元实际包含的文件快照。
  const files: TreeFile[] = []
  // 本次累计读取或完整正文占用的 UTF-8 字节数量。
  let totalBytes = 0
  /** 遍历当前模式或快照允许访问的目录，收集满足安全与资源限制的文件。 */
  const visit = async (relative: string): Promise<void> => {
    for (const entry of await readDirectory(root, relative)) {
      // 当前目录下的实际子路径或受控启动的子进程。
      const child = `${relative}/${entry.name}`
      if (entry.kind === 'directory') {
        await visit(child)
      }
      else if (entry.kind === 'file') {
        // 通过仓库边界检查的绝对路径，仅用于内部文件操作。
        const absolute = await resolveRepositoryPath(root, child)
        // 通过 lstat 取得的文件类型、权限和大小，避免隐式跟随链接。
        const info = await filesystemOperation(() => fs.lstat(absolute), child)
        if (info.size > maximumFileBytes)
          pathFault('FILE_SIZE_EXCEEDED', 'A repository file exceeds its resource limit.', child, true)
        if (files.length + 1 > MAX_SOURCE_FILES)
          throw new RuntimeFault('FORMAL_FILE_LIMIT_EXCEEDED', 'The formal Context tree exceeds the file-count limit.')
        totalBytes += info.size
        if (totalBytes > MAX_SOURCE_BYTES)
          throw new RuntimeFault('FORMAL_BYTE_LIMIT_EXCEEDED', 'The formal Context tree exceeds the byte limit.')
        files.push({ path: child, bytes: await filesystemOperation(() => fs.readFile(absolute), child), mode: info.mode & 0o777 })
      }
      else {
        pathFault(entry.kind === 'symlink' ? 'PATH_SYMLINK' : 'PATH_SPECIAL_FILE', 'A strict repository tree contains a non-ordinary entry.', child)
      }
    }
  }
  await visit(treePath)
  return files.sort((left, right) => compareCodeUnits(left.path, right.path))
}

/**
 * 将目录中的规范路径与文件内容哈希汇总为 Context 指纹。
 *
 * @param root - 业务仓库根目录。
 * @param treePath - 待遍历的仓库相对目录。
 * @param canonicalRoot - 指纹中使用的规范根路径，使候选与正式目录可比较。
 * @returns 绑定规范路径和文件内容的 SHA-256 指纹，不包含权限位。
 * @throws 路径、类型、编码或资源限制不满足时抛出 RuntimeFault；未分类异常继续传播。
 * @remarks 调用阶段：路径、源码或 Git 证据进入对应能力前；除调用方传入的文件操作回调外，辅助读取不修改正式文件。
 */
export async function fingerprintTree(root: string, treePath: string, canonicalRoot = CONTEXT_ROOT): Promise<string> {
  // 当前文档或交付单元实际包含的文件快照。
  const files = await readTree(root, treePath, MAX_JSON_TEXT_BYTES)
  // 从实际路径转换为规范相对路径时移除的前缀。
  const prefix = `${treePath}/`
  return sha256(compactJson(files.map(file => ({
    path: `${canonicalRoot}/${file.path.slice(prefix.length)}`,
    hash: sha256(file.bytes),
  }))))
}

/** 把单路径段的受控星号模式匹配到实际名称。 */
function segmentMatches(pattern: string, candidate: string): boolean {
  // 从受控星号模式构造的单段匹配表达式。
  let expression = '^'
  for (const character of pattern)
    expression += character === '*' ? '.*' : character.replace(/[|{}()[\]^$+?.]/g, '\\$&')
  return new RegExp(`${expression}$`, 'u').test(candidate)
}

/**
 * 将精确路径或受控 glob 声明匹配到具体源码相对路径。
 *
 * @param declaration - 待匹配的精确路径或受控 glob 声明。
 * @param candidate - 待验证的仓库相对路径。
 * @returns 声明是否匹配给定的具体仓库相对路径。
 * @throws 合法类型输入下不主动抛出业务异常。
 * @remarks 调用阶段：路径、源码或 Git 证据进入对应能力前；除调用方传入的文件操作回调外，辅助读取不修改正式文件。
 */
export function declarationMatches(declaration: string, candidate: string): boolean {
  return declaration === candidate || (declaration.includes('*') && controlledGlobMatches(declaration, candidate))
}

/**
 * 按路径段匹配受控 glob，递归处理唯一的双星号段。
 *
 * @param pattern - 精确源码路径或受控 glob 声明。
 * @param candidate - 待验证的仓库相对路径。
 * @returns 受控 glob 是否匹配给定的具体仓库相对路径。
 * @throws 合法类型输入下不主动抛出业务异常。
 * @remarks 调用阶段：路径、源码或 Git 证据进入对应能力前；除调用方传入的文件操作回调外，辅助读取不修改正式文件。
 */
export function controlledGlobMatches(pattern: string, candidate: string): boolean {
  // 源码声明按斜杠拆分后的模式段。
  const patterns = pattern.split('/')
  // 待匹配具体路径按斜杠拆分的路径段。
  const candidates = candidate.split('/')
  /** 遍历当前模式或快照允许访问的目录，收集满足安全与资源限制的文件。 */
  const visit = (patternIndex: number, candidateIndex: number): boolean => {
    if (patternIndex === patterns.length)
      return candidateIndex === candidates.length
    // 当前待匹配的路径模式段。
    const part = patterns[patternIndex] as string
    if (part === '**')
      return visit(patternIndex + 1, candidateIndex) || (candidateIndex < candidates.length && visit(patternIndex, candidateIndex + 1))
    return candidateIndex < candidates.length
      && segmentMatches(part, candidates[candidateIndex] as string)
      && visit(patternIndex + 1, candidateIndex + 1)
  }
  return visit(0, 0)
}

/** 读取前检查剩余字节预算，再通过只读流计算文件哈希和文件大小。 */
async function hashRegularFile(root: string, candidate: string, remainingBytes: number): Promise<{
  /** 文件原始字节的 SHA-256 指纹。 */
  readonly hash: string
  /** 文件原始字节总数。 */
  readonly size: number
}> {
  // 通过仓库边界检查的绝对路径，仅用于内部文件操作。
  const absolute = await resolveRepositoryPath(root, candidate)
  // 通过 lstat 取得的文件类型、权限和大小，避免隐式跟随链接。
  const info = await filesystemOperation(() => fs.lstat(absolute), candidate)
  if (!info.isFile() || info.isSymbolicLink())
    pathFault('SOURCE_NOT_REGULAR_FILE', 'A source declaration must resolve only to regular files.', candidate, true)
  if (info.size > remainingBytes)
    throw new RuntimeFault('SOURCE_BYTE_LIMIT_EXCEEDED', 'A source expansion exceeds the byte limit.')
  // 当前文件内容的 SHA-256 累计器或固定测试指纹。
  const hash = createHash('sha256')
  try {
    await new Promise<void>((resolve, reject) => {
      // 当前源码文件的只读流，避免一次性加载整个文件。
      const stream = createReadStream(absolute)
      stream.on('data', chunk => hash.update(chunk))
      stream.on('error', reject)
      stream.on('end', resolve)
    })
  }
  catch (error) {
    throwFilesystemFault(error, candidate)
  }
  return { hash: hash.digest('hex'), size: info.size }
}

/** 判断当前目录之下是否仍可能出现匹配目标。 */
function couldContainMatch(parts: readonly string[], segments: readonly string[]): boolean {
  /** 遍历当前模式或快照允许访问的目录，收集满足安全与资源限制的文件。 */
  const visit = (part: number, segment: number): boolean => {
    if (segment === segments.length)
      return part < parts.length
    if (part === parts.length)
      return false
    if (parts[part] === '**')
      return visit(part + 1, segment) || visit(part, segment + 1)
    return segmentMatches(parts[part] as string, segments[segment] as string) && visit(part + 1, segment + 1)
  }
  return visit(0, 0)
}

/**
 * 仅遍历模式仍可能命中的目录，并拒绝必经的符号链接或特殊条目。
 * 任何深度均不进入 node_modules；无关目录保持未打开状态，不影响展开成败或文件数量预算。
 */
async function expandGlob(root: string, pattern: string, visitedFiles: Set<string>): Promise<readonly string[]> {
  // 按路径分隔符拆分的层级，用于位置和模式校验。
  const parts = pattern.split('/')
  // 模式首段已保证是固定目录名，后续剪枝只在该目录之下收窄遍历。
  const base = parts[0] as string
  // 通过 lstat 取得的文件类型、权限和大小，避免隐式跟随链接。
  const info = await lstatRepositoryPath(root, base)
  if (info === undefined || !info.isDirectory())
    return []
  // 当前模式或查询实际命中的结果集合。
  const matches: string[] = []
  /** 遍历当前模式或快照允许访问的目录，收集满足安全与资源限制的文件。 */
  const visit = async (relative: string): Promise<void> => {
    for (const entry of await readDirectory(root, relative)) {
      if (entry.name === 'node_modules')
        continue
      // 当前目录下的实际子路径或受控启动的子进程。
      const child = `${relative}/${entry.name}`
      // 当前目录之下是否仍可能出现匹配目标。
      const descends = couldContainMatch(parts, child.split('/'))
      // 当前路径是否直接满足完整 glob 模式。
      const selected = controlledGlobMatches(pattern, child)
      if (entry.kind === 'directory') {
        if (descends)
          await visit(child)
      }
      else if (entry.kind === 'file') {
        if (!selected)
          continue
        visitedFiles.add(child)
        if (visitedFiles.size > MAX_SOURCE_FILES)
          throw new RuntimeFault('SOURCE_FILE_LIMIT_EXCEEDED', 'A source expansion exceeds the file-count limit.')
        matches.push(child)
      }
      else if (selected || descends) {
        pathFault(entry.kind === 'symlink' ? 'PATH_SYMLINK' : 'PATH_SPECIAL_FILE', 'A source expansion encountered a non-ordinary entry.', child, true)
      }
    }
  }
  await visit(base)
  return matches.sort(compareCodeUnits)
}

/** 本次源码证据中的仓库相对路径与原始内容哈希。 */
export interface SourceFile {
  /** 源码文件相对业务仓库根目录的路径。 */
  readonly path: string
  /** 文件原始字节的 SHA-256 指纹，不做文本规范化。 */
  readonly contentHash: string
  /** 该源码文件计入展开预算的原始字节数。 */
  readonly bytes: number
}

/** 由文档或显式证据所有者声明的一组源码路径模式。 */
export interface SourcePatternSet {
  /** 源码声明的所有者键，区分文档与宿主补充证据。 */
  readonly owner: string
  /** 该所有者声明的仓库相对路径或受控 glob 集合。 */
  readonly patterns: readonly string[]
}

/** 源码模式展开失败时保存的所有者、模式和安全诊断。 */
export interface SourceExpansionIssue {
  /** 源码声明的所有者键，区分文档与宿主补充证据。 */
  readonly owner: string
  /** 当前发生问题的单个源码路径声明。 */
  readonly pattern: string
  /** 可公开的结构化证据错误，不包含绝对路径。 */
  readonly diagnostic: Diagnostic
}

/** 一次受限源码展开的文件映射、问题集合与整体证据指纹。 */
export interface SourceExpansionResult {
  /** 按所有者分组的当前源码文件快照。 */
  readonly filesByOwner: ReadonlyMap<string, readonly SourceFile[]>
  /** 本次内部完整问题集合，不能用裁剪后的输出代替安全判断。 */
  readonly issues: readonly SourceExpansionIssue[]
  /** 所描述数据集的确定性 SHA-256 指纹。 */
  readonly fingerprint: string
}

// 必须直接终止展开、不能降格为单文档问题的资源超限错误。
const SOURCE_RESOURCE_FAILURES = new Set(['SOURCE_FILE_LIMIT_EXCEEDED', 'SOURCE_BYTE_LIMIT_EXCEEDED'])

/** 将已知读取故障投影为源码证据问题，未知异常继续传播。 */
function sourceDiagnostic(error: unknown): Diagnostic {
  if (!(error instanceof RuntimeFault))
    throw error
  if (SOURCE_RESOURCE_FAILURES.has(error.code))
    throw error
  return error.diagnostics[0] as Diagnostic
}

/**
 * 把所有声明展开为一个有总量上限的源码数据集，每个唯一文件只哈希一次。
 *
 * @param root - 业务仓库根目录。
 * @param sets - 按所有者组织的源码路径声明集合。
 * @returns 按所有者分组的文件、完整问题与整体指纹；单个声明错误保留归属。
 * @throws 声明级故障进入 issues；资源总量超限及无法安全归属的故障按 RuntimeFault 传播。
 * @remarks 调用阶段：路径、源码或 Git 证据进入对应能力前；除调用方传入的文件操作回调外，辅助读取不修改正式文件。
 */
export async function expandSourcePatternSets(root: string, sets: readonly SourcePatternSet[]): Promise<SourceExpansionResult> {
  // 按所有者稳定排序的源码声明集合。
  const orderedSets = [...sets].sort((left, right) => compareCodeUnits(left.owner, right.owner))
  // 每个声明所有者实际选中的源码路径集合。
  const selectedByOwner = new Map<string, Set<string>>()
  // 当前读取过程收集的完整问题，保留到调用方统一处理。
  const issues: SourceExpansionIssue[] = []
  // 本次源码展开已计入文件数量预算的去重路径集合。
  const visitedFiles = new Set<string>()
  // 当前展开调用内按完整模式复用的异步结果缓存。
  const globCache = new Map<string, Promise<readonly string[]>>()

  for (const set of orderedSets) {
    // 当前声明所有者已命中的去重源码路径集合。
    const selected = selectedByOwner.get(set.owner) ?? new Set<string>()
    selectedByOwner.set(set.owner, selected)
    for (const pattern of set.patterns) {
      try {
        assertSourcePattern(pattern)
        if (!hasGlob(pattern)) {
          // 通过 lstat 取得的文件类型、权限和大小，避免隐式跟随链接。
          const info = await lstatRepositoryPath(root, pattern)
          if (info === undefined)
            pathFault('SOURCE_EXACT_MISSING', 'An exact source declaration does not exist.', pattern, true)
          if (!info.isFile())
            pathFault('SOURCE_NOT_REGULAR_FILE', 'An exact source declaration must identify a regular file.', pattern, true)
          visitedFiles.add(pattern)
          if (visitedFiles.size > MAX_SOURCE_FILES)
            throw new RuntimeFault('SOURCE_FILE_LIMIT_EXCEEDED', 'A source expansion exceeds the file-count limit.')
          selected.add(pattern)
          continue
        }
        // 缓存按完整模式复用；重叠模式仍会重复遍历共享目录，但每个文件只哈希一次，必要时可按固定前缀共享遍历。
        let expansion = globCache.get(pattern)
        if (expansion === undefined) {
          expansion = expandGlob(root, pattern, visitedFiles)
          globCache.set(pattern, expansion)
        }
        // 当前模式或查询实际命中的结果集合。
        const matches = await expansion
        if (matches.length === 0)
          pathFault('SOURCE_GLOB_ZERO_MATCH', 'A source glob matched no regular files.', pattern, true)
        matches.forEach(candidate => selected.add(candidate))
      }
      catch (error) {
        issues.push({ owner: set.owner, pattern, diagnostic: sourceDiagnostic(error) })
      }
    }
  }

  // 所有声明共同命中的去重源码路径，统一计算哈希。
  const allSelected = [...new Set([...selectedByOwner.values()].flatMap(paths => [...paths]))].sort(compareCodeUnits)
  // 已成功读取并计算指纹的源码文件映射。
  const hashed = new Map<string, SourceFile>()
  // 本次累计读取或完整正文占用的 UTF-8 字节数量。
  let totalBytes = 0
  for (const candidate of allSelected) {
    try {
      // 单个文件读取后的内容哈希及计入预算的字节数。
      const sample = await hashRegularFile(root, candidate, MAX_SOURCE_BYTES - totalBytes)
      totalBytes += sample.size
      hashed.set(candidate, { path: candidate, contentHash: sample.hash, bytes: sample.size })
    }
    catch (error) {
      // 需要保留所有权并向上层传播的源码诊断。
      const problem = sourceDiagnostic(error)
      for (const [owner, paths] of selectedByOwner) {
        if (paths.has(candidate))
          issues.push({ owner, pattern: candidate, diagnostic: problem })
      }
    }
  }

  // 按声明所有者重组的最终源码快照。
  const filesByOwner = new Map<string, readonly SourceFile[]>()
  for (const set of orderedSets) {
    filesByOwner.set(set.owner, [...(selectedByOwner.get(set.owner) ?? [])]
      .sort(compareCodeUnits)
      .flatMap(candidate => hashed.has(candidate) ? [hashed.get(candidate) as SourceFile] : []))
  }
  // 按所有者、模式和错误码稳定排序的问题集合。
  const orderedIssues = issues.sort((left, right) => compareCodeUnits(
    `${left.owner}\0${left.pattern}\0${left.diagnostic.code}`,
    `${right.owner}\0${right.pattern}\0${right.diagnostic.code}`,
  ))
  // 当前数据集的确定性指纹，用于快照绑定。
  const fingerprint = sha256(compactJson(orderedSets.map(set => ({
    owner: set.owner,
    declarations: [...set.patterns].sort(compareCodeUnits),
    files: (filesByOwner.get(set.owner) ?? []).map(file => ({ path: file.path, contentHash: file.contentHash })),
    issues: orderedIssues.filter(item => item.owner === set.owner).map(item => ({
      pattern: item.pattern,
      code: item.diagnostic.code,
      path: item.diagnostic.path ?? '',
    })),
  }))))
  return { filesByOwner, issues: orderedIssues, fingerprint }
}

/**
 * 汇总排序后的源码声明、文件路径及内容哈希，生成审查依据指纹。
 *
 * @param patterns - 参与聚合的原始源码路径声明集合。
 * @param files - 已读取的源码文件路径和内容哈希集合。
 * @returns 按稳定顺序绑定全部声明与源码文件的 SHA-256 指纹。
 * @throws 合法类型输入下不主动抛出业务异常。
 * @remarks 调用阶段：路径、源码或 Git 证据进入对应能力前；除调用方传入的文件操作回调外，辅助读取不修改正式文件。
 */
export function aggregateSourceFingerprint(patterns: readonly string[], files: readonly SourceFile[]): string {
  return sha256(compactJson({
    declarations: [...patterns].sort(compareCodeUnits),
    files: [...files].sort((left, right) => compareCodeUnits(left.path, right.path)).map(file => ({
      path: file.path,
      contentHash: file.contentHash,
    })),
  }))
}

/** 增量分析关心的 Git 文件变更类别。 */
export type GitChangeKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'

/** Git 证据中的新路径、变更种类和可选旧路径。 */
export interface GitChange {
  /** 仓库相对路径；正式知识诊断统一使用 context/ 前缀。 */
  readonly path: string
  /** 用于选择合法分支的种类判别值。 */
  readonly kind: GitChangeKind
  /** 重命名或复制之前的仓库相对路径。 */
  readonly previousPath?: string
}

/** 宿主收集并经严格校验的 Git 快照，不由 Runtime 启动 Git 进程。 */
export interface GitEvidence {
  /** 宿主证据记录的当前 Git HEAD 对象 ID。 */
  readonly currentRevision: string
  /** Git 是否仍处于合并、变基等未完成操作。 */
  readonly midOperation: boolean
  /** 未完成 Git 操作的具体类别。 */
  readonly midOperationKind?: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect'
  /** 从状态与差异原始字节合并得到的文件变更。 */
  readonly changes: readonly GitChange[]
  /** 宿主是否提供相对基线的 diff.bin，决定历史路径列表是否完整。 */
  readonly hasDiff: boolean
  /** porcelain v2 是否包含未合并条目，Repair 必须拒绝。 */
  readonly hasUnmergedPaths: boolean
  /** 所描述数据集的确定性 SHA-256 指纹。 */
  readonly fingerprint: string
}

/** 将 Git 状态字符映射为协议中的变更类别。 */
function changeKind(code: string): GitChangeKind {
  if (code === 'A')
    return 'added'
  if (code === 'D')
    return 'deleted'
  if (code === 'R' || code === 'C')
    return 'renamed'
  return 'modified'
}

/** 校验 Git 原始证据中的路径，拒绝不安全的仓库相对形式。 */
function validateGitPath(candidate: string): string {
  assertSafeRelativePath(candidate)
  return candidate
}

/** 从 NUL 分隔的 porcelain v2 状态中读取的版本、变更与冲突标志。 */
interface PorcelainEvidence {
  /** 完整 Git 提交对象 ID，不依赖分支名称。 */
  readonly revision: string
  /** 从状态与差异原始字节合并得到的文件变更。 */
  readonly changes: readonly GitChange[]
  /** porcelain v2 是否包含未合并条目，Repair 必须拒绝。 */
  readonly hasUnmergedPaths: boolean
}

/** 严格解析 porcelain v2 原始字节，保留未合并路径标志。 */
function parsePorcelainEvidence(bytes: Uint8Array): PorcelainEvidence {
  // 本次安全读取的 UTF-8 文本。
  const text = decodeUtf8(bytes, 'status.bin')
  if (text.length === 0 || !text.endsWith('\0'))
    throw new RuntimeFault('GIT_STATUS_INVALID', 'Git status evidence must be NUL-delimited.', 'status.bin')
  // NUL 分隔后的 Git porcelain 原始记录。
  const records = text.split('\0')
  // 从 Git 原始证据解析出的文件变更集合。
  const changes: GitChange[] = []
  // 状态证据中的 HEAD 对象 ID，用于与 head.txt 交叉校验。
  let revision: string | undefined
  // Git 分支头名称，仅用于验证状态头完整性。
  let branchHead: string | undefined
  // 是否已读取 upstream 头，防止重复证据字段。
  let upstreamSeen = false
  // 是否已读取 ahead/behind 头，防止重复证据字段。
  let aheadBehindSeen = false
  // 是否发现未合并文件，用于阻止 Repair 在冲突中执行。
  let hasUnmergedPaths = false
  for (let index = 0; index < records.length; index += 1) {
    // 从 NUL 分隔证据中取出的当前 Git 原始记录。
    const record = records[index] as string
    if (record.length === 0)
      continue
    if (record.startsWith('# ')) {
      if (record.startsWith('# branch.oid ')) {
        if (revision !== undefined || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(record.slice(13)))
          throw new RuntimeFault('GIT_STATUS_INVALID', 'Git status evidence has an invalid or duplicate branch.oid header.', 'status.bin')
        revision = record.slice(13)
        continue
      }
      if (record.startsWith('# branch.head ')) {
        if (branchHead !== undefined || record.slice(14).length === 0)
          throw new RuntimeFault('GIT_STATUS_INVALID', 'Git status evidence has an invalid or duplicate branch.head header.', 'status.bin')
        branchHead = record.slice(14)
        continue
      }
      if (record.startsWith('# branch.upstream ')) {
        if (upstreamSeen || record.slice(18).length === 0)
          throw new RuntimeFault('GIT_STATUS_INVALID', 'Git status evidence has an invalid or duplicate branch.upstream header.', 'status.bin')
        upstreamSeen = true
        continue
      }
      if (record.startsWith('# branch.ab ')) {
        if (aheadBehindSeen || !/^\+\d+ -\d+$/.test(record.slice(12)))
          throw new RuntimeFault('GIT_STATUS_INVALID', 'Git status evidence has an invalid or duplicate branch.ab header.', 'status.bin')
        aheadBehindSeen = true
        continue
      }
      throw new RuntimeFault('GIT_STATUS_INVALID', 'Git status evidence contains an unknown header.', 'status.bin')
    }
    if (record.startsWith('? ')) {
      // Git 默认会把未跟踪目录折叠为 dir/；增量映射需要具体文件，因此明确要求使用 --untracked-files=all。
      if (record.endsWith('/'))
        throw new RuntimeFault('GIT_STATUS_UNTRACKED_COLLAPSED', 'Git status evidence lists an untracked directory instead of its files; collect it with --untracked-files=all.', 'status.bin')
      changes.push({ path: validateGitPath(record.slice(2)), kind: 'untracked' })
      continue
    }
    if (record.startsWith('! '))
      continue
    // 当前记录是否匹配普通文件状态格式。
    const ordinary = /^1 ([^ ]+) [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ (.+)$/su.exec(record)
    if (ordinary !== null) {
      // Git 索引与工作区的双列状态码。
      const xy = ordinary[1] as string
      // 本次应公开或映射的稳定状态、错误码。
      const code = xy[0] !== '.' ? xy[0] as string : xy[1] as string
      changes.push({ path: validateGitPath(ordinary[2] as string), kind: changeKind(code) })
      continue
    }
    // 当前记录是否匹配重命名状态格式。
    const renamed = /^2 ([^ ]+) [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ (.+)$/su.exec(record)
    if (renamed !== null) {
      // 重命名前的仓库相对路径。
      const previous = records[index + 1]
      if (previous === undefined || previous.length === 0)
        throw new RuntimeFault('GIT_STATUS_INVALID', 'A rename record is missing its previous path.', 'status.bin')
      index += 1
      changes.push({
        path: validateGitPath(renamed[2] as string),
        kind: 'renamed',
        previousPath: validateGitPath(previous),
      })
      continue
    }
    // 当前记录是否属于未合并文件状态。
    const unmerged = /^u [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ (.+)$/su.exec(record)
    if (unmerged !== null) {
      hasUnmergedPaths = true
      changes.push({ path: validateGitPath(unmerged[1] as string), kind: 'modified' })
      continue
    }
    throw new RuntimeFault('GIT_STATUS_INVALID', 'Git status evidence contains an unknown record.', 'status.bin')
  }
  if (revision === undefined || branchHead === undefined)
    throw new RuntimeFault('GIT_STATUS_INVALID', 'Git status evidence requires exactly one branch.oid and branch.head header.', 'status.bin')
  return { revision, changes, hasUnmergedPaths }
}

/**
 * 解析 NUL 分隔的 Git name-status 输出，保留重命名的新旧路径。
 *
 * @param bytes - 原始字节序列。
 * @returns 按输入记录顺序解析的变更项，重命名保留旧路径。
 * @throws 路径、类型、编码或资源限制不满足时抛出 RuntimeFault；未分类异常继续传播。
 * @remarks 调用阶段：路径、源码或 Git 证据进入对应能力前；除调用方传入的文件操作回调外，辅助读取不修改正式文件。
 */
export function parseNameStatus(bytes: Uint8Array): readonly GitChange[] {
  // 本次安全读取的 UTF-8 文本。
  const text = decodeUtf8(bytes, 'diff.bin')
  if (text.length > 0 && !text.endsWith('\0'))
    throw new RuntimeFault('GIT_DIFF_INVALID', 'Git diff evidence must be NUL-delimited.', 'diff.bin')
  // 当前协议对象需要校验的业务字段集合。
  const fields = text.split('\0')
  // 从 Git 原始证据解析出的文件变更集合。
  const changes: GitChange[] = []
  for (let index = 0; index < fields.length - 1;) {
    // 当前 Git 差异条目的状态码。
    const status = fields[index++] as string
    if (!/^[ACDMRTUXB]\d*$/.test(status))
      throw new RuntimeFault('GIT_DIFF_INVALID', 'Git diff evidence contains an unknown status.', 'diff.bin')
    if (status.startsWith('R') || status.startsWith('C')) {
      // 重命名前的仓库相对路径。
      const previous = fields[index++]
      // 本轮处理的节点或重新读取的状态。
      const current = fields[index++]
      if (!previous || !current)
        throw new RuntimeFault('GIT_DIFF_INVALID', 'Git diff rename evidence is incomplete.', 'diff.bin')
      changes.push({ path: validateGitPath(current), previousPath: validateGitPath(previous), kind: 'renamed' })
    }
    else {
      // 本次正在校验或推导的候选值。
      const candidate = fields[index++]
      if (!candidate)
        throw new RuntimeFault('GIT_DIFF_INVALID', 'Git diff evidence is incomplete.', 'diff.bin')
      changes.push({ path: validateGitPath(candidate), kind: changeKind(status[0] as string) })
    }
  }
  return changes
}

/** 确认 Runtime 根目录具有有效类型的 .git 元数据入口。 */
async function assertGitRepository(root: string): Promise<void> {
  // 通过 lstat 取得的文件类型、权限和大小，避免隐式跟随链接。
  const info = await lstatRepositoryPath(root, '.git')
  if (info === undefined || (!info.isDirectory() && !info.isFile()))
    throw new RuntimeFault('GIT_REPOSITORY_REQUIRED', 'This capability requires Git metadata in the Runtime root.', '.git')
}

/**
 * 读取并严格校验宿主收集的 Git 证据叶子，计算其字节指纹。
 *
 * @param root - 业务仓库根目录。
 * @param evidencePath - 宿主创建且由当前工作流拥有的 Git 证据叶子。
 * @returns 严格校验后的 Git 快照与原始证据指纹。
 * @throws 路径、类型、编码或资源限制不满足时抛出 RuntimeFault；未分类异常继续传播。
 * @remarks 调用阶段：路径、源码或 Git 证据进入对应能力前；除调用方传入的文件操作回调外，辅助读取不修改正式文件。
 */
export async function readGitEvidence(root: string, evidencePath: string): Promise<GitEvidence> {
  await assertGitRepository(root)
  assertGitEvidencePath(evidencePath)
  // 通过 lstat 取得的文件类型、权限和大小，避免隐式跟随链接。
  const info = await lstatRepositoryPath(root, evidencePath)
  if (info === undefined || !info.isDirectory())
    throw new RuntimeFault('GIT_EVIDENCE_PATH_INVALID', 'Git evidence path must be a regular directory.', evidencePath)
  // 本次目录扫描或快照结果集合。
  const entries = await readDirectory(root, evidencePath)
  // 当前证据目录实际包含的文件名集合。
  const names = entries.map(entry => entry.name)
  // 当前对象或目录允许出现的项目集合。
  const allowed = new Set(['head.txt', 'mid-operation.json', 'status.bin', 'diff.bin'])
  if (entries.some(entry => entry.kind !== 'file' || !allowed.has(entry.name)))
    throw new RuntimeFault('GIT_EVIDENCE_UNKNOWN_FILE', 'Git evidence contains an unknown or non-regular entry.', evidencePath)
  for (const required of ['head.txt', 'mid-operation.json', 'status.bin']) {
    if (!names.includes(required))
      throw new RuntimeFault('GIT_EVIDENCE_FILE_MISSING', `Git evidence is missing ${required}.`, evidencePath)
  }
  // 从持久文件或未校验输入取得的原始数据。
  const raw = new Map<string, Buffer>()
  for (const name of names)
    raw.set(name, await readRegularBytes(root, `${evidencePath}/${name}`, MAX_GIT_EVIDENCE_BYTES))
  // head.txt 记录的原始 Git 对象 ID 文本。
  const head = decodeUtf8(raw.get('head.txt') as Buffer, `${evidencePath}/head.txt`)
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?\n$/.test(head))
    throw new RuntimeFault('GIT_HEAD_INVALID', 'Git HEAD evidence must contain one full lowercase revision.', `${evidencePath}/head.txt`)
  // 宿主记录的 Git 操作状态 JSON 文本。
  const midText = decodeUtf8(raw.get('mid-operation.json') as Buffer, `${evidencePath}/mid-operation.json`).replace(/^\uFEFF/, '')
  // 尚未校验形状的 Git 操作状态对象。
  let mid: unknown
  try {
    mid = JSON.parse(midText)
  }
  catch {
    throw new RuntimeFault('GIT_MID_OPERATION_INVALID', 'Git mid-operation evidence must be valid JSON.', `${evidencePath}/mid-operation.json`)
  }
  if (typeof mid !== 'object' || mid === null || Array.isArray(mid))
    throw new RuntimeFault('GIT_MID_OPERATION_INVALID', 'Git mid-operation evidence must be an object.', `${evidencePath}/mid-operation.json`)
  // 已确认为对象的原始数据，后续继续校验封闭字段。
  const object = mid as Record<string, unknown>
  // 待验证对象实际包含的字段名集合。
  const keys = Object.keys(object).sort(compareCodeUnits)
  // 根据 active 状态决定的操作状态对象合法字段名。
  const expected = object.active === true ? ['active', 'kind'] : ['active']
  if (JSON.stringify(keys) !== JSON.stringify(expected) || typeof object.active !== 'boolean'
    || (object.active === true && !['merge', 'rebase', 'cherry-pick', 'revert', 'bisect'].includes(String(object.kind)))) {
    throw new RuntimeFault('GIT_MID_OPERATION_INVALID', 'Git mid-operation evidence has an invalid shape.', `${evidencePath}/mid-operation.json`)
  }

  // 已解析并可与 HEAD 交叉验证的工作区状态证据。
  const porcelain = parsePorcelainEvidence(raw.get('status.bin') as Buffer)
  if (porcelain.revision !== head.trim())
    throw new RuntimeFault('GIT_STATUS_HEAD_MISMATCH', 'Git status branch.oid must equal head.txt.', `${evidencePath}/status.bin`)
  // 从 Git 原始证据解析出的文件变更集合。
  const changes = [
    ...(raw.has('diff.bin') ? parseNameStatus(raw.get('diff.bin') as Buffer) : []),
    ...porcelain.changes,
  ].sort((left, right) => compareCodeUnits(`${left.path}\0${left.kind}\0${left.previousPath ?? ''}`, `${right.path}\0${right.kind}\0${right.previousPath ?? ''}`))
  // 稳定排序并去重后的 Git 文件变更。
  const unique = changes.filter((change, index) => index === 0
    || compactJson(change as unknown as import('./stable-json.js').JsonValue)
    !== compactJson(changes[index - 1] as unknown as import('./stable-json.js').JsonValue))
  // 当前数据集的确定性指纹，用于快照绑定。
  const fingerprint = sha256(compactJson([...raw.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([name, bytes]) => ({ name, hash: sha256(bytes) }))))
  return {
    currentRevision: head.trim(),
    midOperation: object.active as boolean,
    ...(object.active === true ? { midOperationKind: object.kind as NonNullable<GitEvidence['midOperationKind']> } : {}),
    changes: unique,
    hasDiff: raw.has('diff.bin'),
    hasUnmergedPaths: porcelain.hasUnmergedPaths,
    fingerprint,
  }
}

/**
 * 将可清理的 Git 证据限制在直接属于 evidence/ 的单个叶子内。
 *
 * @param evidencePath - 宿主创建且由当前工作流拥有的 Git 证据叶子。
 * @throws 路径、类型、编码或资源限制不满足时抛出 RuntimeFault；未分类异常继续传播。
 * @remarks 调用阶段：路径、源码或 Git 证据进入对应能力前；除调用方传入的文件操作回调外，辅助读取不修改正式文件。 返回约定：校验通过时无返回值。
 */
export function assertGitEvidencePath(evidencePath: string): void {
  assertSafeRelativePath(evidencePath)
  // 待校验路径的逐级分段，不允许空段或目录穿越。
  const segments = evidencePath.split('/')
  if (segments.length !== 3 || `${segments[0]}/${segments[1]}` !== EVIDENCE_ROOT || !SCRATCH_LEAF_ID.test(segments[2] as string))
    throw new RuntimeFault('GIT_EVIDENCE_PATH_INVALID', 'Git evidence must be one named leaf under .scratch/evidence/.', evidencePath)
}
