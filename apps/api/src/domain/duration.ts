/**
 * 工期的存储口径（见 docs/spec.md 的「关键路径」）。
 * 单位是分钟整数：`NULL` 表示未估工期，`0` 表示瞬时任务，其余是工期分钟数。
 */

/** 1 天 = 480 分钟（8 小时工作制）。只用于换算与上界，CPM 不引入工作日 / 周末 / 节假日模型。 */
export const MINUTES_PER_DAY = 480;

/**
 * 工期上限：9999 天。**这是产品范围，不是在补一个 500。**
 *
 * 实测（加上限之前的代码）：传 `1e20` 已经返回 400「工期必须是整数分钟」——Zod 的 `.int()`
 * 会拒绝不安全整数，所以「值被绑成 REAL、撞上 `typeof(duration_minutes) = 'integer'` 的 CHECK」
 * 这条路走不到；`1e20` 到不了数据库。
 *
 * 真正的缺口是 `Number.MAX_SAFE_INTEGER`（约 9007199254740991 分钟 ≈ 1.7e10 年）这类
 * 「安全但毫无意义」的值会被正常存下来。加上限让接口接受的取值域与界面一致。
 *
 * 前端 `apps/web/src/lib/format.ts` 的 `MAX_DURATION_MINUTES` 是同一个数（拦在界面上给提示），
 * 改这里要同步改那里。
 */
export const MAX_DURATION_MINUTES = 9999 * MINUTES_PER_DAY;
