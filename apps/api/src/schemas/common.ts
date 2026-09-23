/**
 * 请求体 schema 的公共片段。写接口一律用 `z.strictObject`，字段名打错时直接 400，
 * 而不是被静默丢弃（见 docs/decisions.md D12）。
 */

/**
 * strictObject 的对象级文案。只替换「未定义字段」这一种，
 * 请求体不是对象时保留 Zod 默认可读的英文描述。
 */
export const strictObjectError = (issue: { code: string }): string | undefined =>
  issue.code === 'unrecognized_keys' ? '存在未定义的字段' : undefined;
