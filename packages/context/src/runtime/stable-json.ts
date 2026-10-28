/** 协议响应和确定性文件允许承载的 JSON 值。 */
export type JsonValue
  = | null
    | boolean
    | number
    | string
    | JsonValue[]
    | { [key: string]: JsonValue }

/** 仅以字符串键保存 JSON 值的协议对象。 */
export interface JsonObject { [key: string]: JsonValue }

/**
 * 按字符码元比较字符串，使排序不依赖机器区域设置。
 *
 * @param left - 参与比较的左值。
 * @param right - 参与比较的右值。
 * @returns 负数、零或正数，分别表示左值小于、等于或大于右值。
 * @throws 合法类型输入下不主动抛出业务异常。
 * @remarks 调用阶段：文档读取、候选验证或确定性序列化；纯计算，不读写文件。
 */
export function compareCodeUnits(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1
}

/**
 * 递归排序对象键，同时保留数组元素的业务顺序。
 *
 * @param value - 待校验或规范化的输入值。
 * @returns 对象键已递归排序的 JSON 值；原始数组顺序保持不变。
 * @throws 合法类型输入下不主动抛出业务异常。
 * @remarks 调用阶段：文档读取、候选验证或确定性序列化；纯计算，不读写文件。
 */
export function stableValue(value: JsonValue): JsonValue {
  if (Array.isArray(value))
    return value.map(stableValue)
  if (value === null || typeof value !== 'object')
    return value

  // 按确定性顺序组织的结果，避免受机器区域设置影响。
  const sorted: JsonObject = {}
  for (const key of Object.keys(value).sort(compareCodeUnits))
    sorted[key] = stableValue(value[key] as JsonValue)
  return sorted
}

/**
 * 生成缩进为两空格、末尾恰有一个换行的确定性 JSON。
 *
 * @param value - 待校验或规范化的输入值。
 * @returns 带两空格缩进和单个末尾 LF 的 JSON 文本。
 * @throws 合法类型输入下不主动抛出业务异常。
 * @remarks 调用阶段：文档读取、候选验证或确定性序列化；纯计算，不读写文件。
 */
export function stableJson(value: JsonValue): string {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`
}

/**
 * 生成用于指纹与游标的紧凑确定性 JSON。
 *
 * @param value - 待校验或规范化的输入值。
 * @returns 无多余空白的确定性 JSON 文本。
 * @throws 合法类型输入下不主动抛出业务异常。
 * @remarks 调用阶段：文档读取、候选验证或确定性序列化；纯计算，不读写文件。
 */
export function compactJson(value: JsonValue): string {
  return JSON.stringify(stableValue(value))
}
