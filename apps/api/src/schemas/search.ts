import { z } from 'zod';
import { MAX_QUERY_LENGTH } from '../domain/search.js';

/**
 * `GET /api/search` 的查询参数。
 *
 * 用 `z.object` 而不是项目里写请求体惯用的 `z.strictObject`：读接口对多余的查询参数一律忽略
 * （`/api/board`、`/api/tree` 都是这么做的），这里若改成 strictObject，`?q=x&foo=1` 会变成
 * 400 且报错文案是 Zod 的英文原文，既与其它读接口口径不一致，也破坏了「错误文案都是中文」的约定。
 *
 * `includeArchived` 不在这里声明：它的取值语义（认 `1` 与 `true`）由 routes/query.ts 的
 * `wantsArchived` 统一判定，和所有读接口共用一套。`q` 缺失、空白或超长都在这里变成 400。
 */
export const searchQuerySchema = z.object({
  q: z
    .string({ error: '搜索词必须是字符串' })
    .trim()
    .min(1, '搜索词不能为空')
    .max(MAX_QUERY_LENGTH, `搜索词最多 ${MAX_QUERY_LENGTH} 字`),
});

export type SearchQuery = z.infer<typeof searchQuerySchema>;
