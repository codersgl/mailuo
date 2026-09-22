import type { Context } from 'hono';

/**
 * Zod 报错的最小结构。这里刻意不写 `ZodError`：
 * Zod 4 的 `z.ZodError`（带 format/flatten 的那个类）与 zValidator 实际抛出的
 * `$ZodError`（core 里的类型）不是同一个东西，按结构声明才能同时兼容。
 */
interface ZodIssueLike {
  path: readonly PropertyKey[];
  message: string;
}

interface ZodErrorLike {
  issues: readonly ZodIssueLike[];
}

/**
 * zValidator 的失败回调。
 *
 * 规范要求错误统一返回 `{ error: string }`，而 zValidator 默认回 `{ success: false, error: {...} }`，
 * 所以在这里改写。只取第一条问题，格式是 `字段名: 说明`（没有字段名时只给说明），
 * 既满足契约，也能让调用方看出是哪个字段错了。
 */
export function validationHook(
  result: { success: boolean; error?: ZodErrorLike },
  c: Context,
): Response | undefined {
  if (result.success) return undefined;

  const issue = result.error?.issues[0];
  const field = issue ? issue.path.map(String).join('.') : '';
  const message = issue?.message ?? '入参非法';
  return c.json({ error: field ? `${field}: ${message}` : message }, 400);
}
