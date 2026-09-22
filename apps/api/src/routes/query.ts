import type { Context } from 'hono';

/**
 * 「显示已归档」开关：`?includeArchived=1`（也接受 `true`）。
 * 规范里这个开关只存在前端、不落库，所以用查询参数表达，缺省即关闭（见 docs/decisions.md D6）。
 * 重复参数时 Hono 取第一次出现的值；`TRUE`、`yes`、`0` 一律当作关闭。
 *
 * 写接口的响应也读它：前端处于显示归档模式时按 D18 整列替换，列表里必须仍包含归档卡片，
 * 否则改个标题就会把归档卡片从当前视图里抹掉。
 */
export function wantsArchived(c: Context): boolean {
  const value = c.req.query('includeArchived');
  return value === '1' || value === 'true';
}
