import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import type { Db } from '../db/client.js';
import { readColumnTasks } from '../repositories/board.js';
import { columnExists } from '../repositories/columns.js';
import {
  applyTaskUpdate,
  changeTaskParent,
  createTask,
  deleteTaskSubtree,
  findTask,
  isSelfOrDescendant,
  setTaskArchived,
  type TaskRecord,
} from '../repositories/tasks.js';
import {
  changeTaskParentSchema,
  createTaskSchema,
  setTaskArchivedSchema,
  updateTaskSchema,
} from '../schemas/task.js';
import { wantsArchived } from './query.js';
import { validationHook } from './validation.js';

/** 写接口：新建、改字段与移动、改父级、归档、删除。 */
export function createTaskRoutes(db: Db): Hono {
  const routes = new Hono();

  // zValidator 在 Content-Type 不是 JSON 时会直接跳过解析，请求体变成 undefined，
  // 报错就成了「列 id 必须是字符串」这种误导文案（curl -d 默认发 form-urlencoded）。
  // 先明确提示，省掉一轮排查。只拦 /api/tasks 下的写请求，别影响其他路径的 404。
  routes.use('*', async (c, next) => {
    const isWrite = c.req.method === 'POST' || c.req.method === 'PATCH';
    if (isWrite && c.req.path.startsWith('/api/tasks')) {
      const contentType = c.req.header('content-type') ?? '';
      if (!contentType.includes('application/json')) {
        return c.json({ error: 'Content-Type 必须是 application/json' }, 400);
      }
    }
    await next();
  });

  routes.post('/api/tasks', zValidator('json', createTaskSchema, validationHook), (c) => {
    const input = c.req.valid('json');

    if (!columnExists(db, input.columnId)) {
      return c.json({ error: `列不存在: ${input.columnId}` }, 400);
    }
    if (input.parentId !== null) {
      const parent = findTask(db, input.parentId);
      if (!parent) {
        return c.json({ error: '父任务不存在' }, 404);
      }
      // 归档任务的整棵子树是隐藏的，在它下面建任务会立刻变成看不见的孤儿。
      if (parent.archivedAt !== null) {
        return c.json({ error: '父任务已归档' }, 400);
      }
    }

    return c.json(createTask(db, input), 201);
  });

  routes.patch('/api/tasks/:id', zValidator('json', updateTaskSchema, validationHook), (c) => {
    const id = c.req.param('id');
    const patch = c.req.valid('json');

    // 顺序固定为：任务存在（404）→ 任务未归档（400）→ 目标列存在（400）。顺序写进测试。
    const task = findTask(db, id);
    if (!task) {
      return c.json({ error: '任务不存在' }, 404);
    }
    if (task.archivedAt !== null) {
      return c.json({ error: '任务已归档' }, 400);
    }
    if (patch.columnId !== undefined && !columnExists(db, patch.columnId)) {
      return c.json({ error: `列不存在: ${patch.columnId}` }, 400);
    }

    const updated = applyTaskUpdate(db, id, patch);
    if (!updated) {
      return c.json({ error: '任务不存在' }, 404);
    }
    return c.json(withColumnTasks(db, updated, wantsArchived(c)));
  });

  routes.patch(
    '/api/tasks/:id/parent',
    zValidator('json', changeTaskParentSchema, validationHook),
    (c) => {
      const id = c.req.param('id');
      const input = c.req.valid('json');

      // 与 PATCH /api/tasks/:id 保持同一顺序：任务存在 → 任务未归档 → 列存在 → 父级检查。
      const task = findTask(db, id);
      if (!task) {
        return c.json({ error: '任务不存在' }, 404);
      }
      if (task.archivedAt !== null) {
        return c.json({ error: '任务已归档' }, 400);
      }
      if (!columnExists(db, input.columnId)) {
        return c.json({ error: `列不存在: ${input.columnId}` }, 400);
      }
      if (input.parentId !== null) {
        // 挂到自己或自己的后代下会形成环，必须先拦掉。
        if (isSelfOrDescendant(db, id, input.parentId)) {
          return c.json({ error: '不能把任务挂到自己或自己的后代下' }, 400);
        }
        const parent = findTask(db, input.parentId);
        if (!parent) {
          return c.json({ error: '父任务不存在' }, 404);
        }
        if (parent.archivedAt !== null) {
          return c.json({ error: '父任务已归档' }, 400);
        }
      }

      const updated = changeTaskParent(db, id, input);
      if (!updated) {
        return c.json({ error: '任务不存在' }, 404);
      }
      return c.json(withColumnTasks(db, updated, wantsArchived(c)));
    },
  );

  // 归档是唯一接受「已归档任务」的写接口：它正是把任务从归档状态里拿出来（或再放回去）的入口，
  // 所以不套用 D16 的「写接口拒绝归档任务」。重复归档与重复取消归档都是幂等的空操作。
  routes.patch(
    '/api/tasks/:id/archive',
    zValidator('json', setTaskArchivedSchema, validationHook),
    (c) => {
      const id = c.req.param('id');
      const { archived } = c.req.valid('json');

      const updated = setTaskArchived(db, id, archived);
      if (!updated) {
        return c.json({ error: '任务不存在' }, 404);
      }
      // 归档后该任务不在任何列里，所以这里的 columnTasks 不含它；取消归档后它回到原列原位置。
      // 前端开着「显示已归档」时列表照旧带上归档卡片，不能因为改状态就少一张。
      return c.json(withColumnTasks(db, updated, wantsArchived(c)));
    },
  );

  // 删除整棵子树。已归档任务同样可删：归档只是收起来，删除才是清理入口。
  routes.delete('/api/tasks/:id', (c) => {
    const removed = deleteTaskSubtree(db, c.req.param('id'));
    if (!removed) {
      return c.json({ error: '任务不存在' }, 404);
    }
    // 没有 task 可回，只返回它原来所在列的列表，前端整列替换即可。
    return c.json({
      columnTasks: readColumnTasks(db, removed.parentId, removed.columnId, wantsArchived(c)),
    });
  });

  return routes;
}

/**
 * 写接口的统一响应：改动后的任务 + 它所在列的完整有序列表。
 * 移动后前端直接整列替换，不做本地重排（见 docs/spec.md 与 docs/decisions.md D18）。
 * includeArchived 沿用请求参数：前端在「显示已归档」模式下整列替换时不能丢归档卡片。
 */
function withColumnTasks(db: Db, task: TaskRecord, includeArchived: boolean) {
  return {
    task,
    columnTasks: readColumnTasks(db, task.parentId, task.columnId, includeArchived),
  };
}
