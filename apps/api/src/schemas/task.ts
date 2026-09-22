import { z } from 'zod';

/**
 * 入参校验 schema。字段说明用中文，`validationHook` 会把第一条报错转成 `{ error: string }`，
 * 所以这里的 message 就是调用方最终看到的文案。
 * 一律用 strictObject：字段名打错时直接 400，而不是被静默丢弃。
 */

/** 对象级文案。只替换「未定义字段」这一种，请求体不是对象时保留 Zod 默认可读的英文描述。 */
const strictObjectError = (issue: { code: string }): string | undefined =>
  issue.code === 'unrecognized_keys' ? '存在未定义的字段' : undefined;

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
      duration: z
        .number({ error: '工期必须是数字' })
        .int('工期必须是整数')
        .min(0, '工期不能为负')
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

/** 改父级（文件树拖动）：新父任务 + 落到新父级的哪一列。 */
export const changeTaskParentSchema = z.strictObject(
  {
    parentId: z
      .string({ error: '父任务 id 必须是字符串' })
      .min(1, '父任务 id 不能为空')
      .nullable(),
    columnId: z.string({ error: '列 id 必须是字符串' }).min(1, '列 id 不能为空'),
  },
  { error: strictObjectError },
);

export type CreateTaskBody = z.infer<typeof createTaskSchema>;
export type UpdateTaskBody = z.infer<typeof updateTaskSchema>;
export type ChangeTaskParentBody = z.infer<typeof changeTaskParentSchema>;
