import { z } from 'zod';
import { strictObjectError } from './common.js';

/**
 * `PUT /api/tasks/:id/deps` 的请求体：整体替换该任务的前置依赖（见 docs/spec.md）。
 *
 * 空数组是合法输入，表示清空依赖——「没有前置依赖」和「没传这个字段」是两件事，
 * 所以这里不给默认值。
 */
export const setTaskDepsSchema = z.strictObject(
  {
    predecessorIds: z
      .array(z.string({ error: '前置任务 id 必须是字符串' }).min(1, '前置任务 id 不能为空'), {
        error: (issue) => (issue.input === undefined ? '不能为空' : '前置依赖必须是数组'),
      })
      // 重复的 id 是调用方拼错了列表，不是「同一个依赖写两遍」的意思；直接报错比静默去重清楚。
      .refine((ids) => new Set(ids).size === ids.length, { message: '前置依赖不能重复' }),
  },
  { error: strictObjectError },
);

export type SetTaskDepsBody = z.infer<typeof setTaskDepsSchema>;
