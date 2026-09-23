import { z } from 'zod';
import { MAX_DURATION_MINUTES, MINUTES_PER_DAY } from '../domain/duration.js';
import { strictObjectError } from './common.js';

/**
 * 入参校验 schema。字段说明用中文，`validationHook` 会把第一条报错转成 `{ error: string }`，
 * 所以这里的 message 就是调用方最终看到的文案。
 * 一律用 strictObject：字段名打错时直接 400，而不是被静默丢弃。
 */

/** 标题：去两端空格后不能为空。 */
const titleSchema = z
  .string({ error: '标题必须是字符串' })
  .trim()
  .min(1, '标题不能为空')
  .max(200, '标题最多 200 字');

/** 新建任务。parentId 省略或传 null 表示建在根看板下。 */
export const createTaskSchema = z.strictObject(
  {
    parentId: z
      .string({ error: '父任务 id 必须是字符串' })
      .min(1, '父任务 id 不能为空')
      .nullable()
      .default(null),
    columnId: z.string({ error: '列 id 必须是字符串' }).min(1, '列 id 不能为空'),
    title: titleSchema,
  },
  { error: strictObjectError },
);

/**
 * 修改任务：改基础字段，或移动（columnId + position），至少要传一个。
 * 移动的两个参数必须成对出现：只给 columnId 无法确定插到哪，只给 position 无法确定列。
 */
export const updateTaskSchema = z
  .strictObject(
    {
      title: titleSchema.optional(),
      description: z.string({ error: '描述必须是字符串' }).max(10000, '描述最多 10000 字').optional(),
      // 单位是分钟；传 null 表示改回未估工期，省略表示不动这一项。
      // 上界见 domain/duration.ts：把合法取值域收敛到 9999 天（不安全整数在 .int() 就已挡住）。
      durationMinutes: z
        .number({ error: '工期必须是数字' })
        .int('工期必须是整数分钟')
        .min(0, '工期不能为负')
        .max(MAX_DURATION_MINUTES, `工期最多 ${MAX_DURATION_MINUTES / MINUTES_PER_DAY} 天`)
        .nullable()
        .optional(),
      columnId: z.string({ error: '列 id 必须是字符串' }).min(1, '列 id 不能为空').optional(),
      position: z
        .number({ error: '位置必须是数字' })
        .int('位置必须是整数')
        .min(0, '位置不能为负')
        .optional(),
    },
    { error: strictObjectError },
  )
  .refine((patch) => Object.keys(patch).length > 0, { message: '没有需要修改的字段' })
  .refine((patch) => (patch.columnId === undefined) === (patch.position === undefined), {
    message: '移动必须同时提供 columnId 与 position',
  });

/** 改父级（任务树拖动）：新父任务 + 落到新父级的哪一列。parentId 必填，null 表示移到根看板。 */
export const changeTaskParentSchema = z.strictObject(
  {
    parentId: z
      .string({
        error: (issue) =>
          issue.input === undefined
            ? '不能为空，移到根看板请传 null'
            : '父任务 id 必须是字符串',
      })
      .min(1, '父任务 id 不能为空')
      .nullable(),
    columnId: z.string({ error: '列 id 必须是字符串' }).min(1, '列 id 不能为空'),
  },
  { error: strictObjectError },
);

/** 归档或取消归档。布尔值必填：省略时无法判断意图，不给默认值。 */
export const setTaskArchivedSchema = z.strictObject(
  {
    archived: z.boolean({
      error: (issue) => (issue.input === undefined ? '不能为空' : '必须是布尔值'),
    }),
  },
  { error: strictObjectError },
);

export type CreateTaskBody = z.infer<typeof createTaskSchema>;
export type UpdateTaskBody = z.infer<typeof updateTaskSchema>;
export type ChangeTaskParentBody = z.infer<typeof changeTaskParentSchema>;
export type SetTaskArchivedBody = z.infer<typeof setTaskArchivedSchema>;
