import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import type { Db } from '../db/client.js';
import { readColumnTasks } from '../repositories/board.js';
import { columnExists } from '../repositories/columns.js';
import {
  applyTaskUpdate,
  changeTaskParent,
  createTask,
  findTask,
  isSelfOrDescendant,
  type TaskRecord,
} from '../repositories/tasks.js';
import { changeTaskParentSchema, createTaskSchema, updateTaskSchema } from '../schemas/task.js';
import { validationHook } from './validation.js';

/**
 * 写接口：新建任务、改字段与移动、改父级。
 * 归档与删除还没做。
 */
export function createTaskRoutes(db: Db): Hono {
  const routes = new Hono();

  // zValidator 在 Content-Type 不是 JSON 时会直接跳过解析，请求体变成 undefined，
  // 报错就成了「列 id 必须是字符串」这种误导文案（curl -d 默认发 form-urlencoded）。
  // 先明确提示，省掉一轮排查。
  routes.use('*', async (c, next) => {
    if (c.req.method === 'POST' || c.req.method === 'PATCH') {
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
    const patch = c.req.valid('json');
    if (patch.columnId !== undefined && !columnExists(db, patch.columnId)) {
      return c.json({ error: `列不存在: ${patch.columnId}` }, 400);
    }

    const updated = applyTaskUpdate(db, c.req.param('id'), patch);
    if (!updated) {
      return c.json({ error: '任务不存在' }, 404);
    }
    return c.json(withColumnTasks(db, updated));
  });

  routes.patch(
    '/api/tasks/:id/parent',
    zValidator('json', changeTaskParentSchema, validationHook),
    (c) => {
      const id = c.req.param('id');
      const input = c.req.valid('json');

      if (!findTask(db, id)) {
        return c.json({ error: '任务不存在' }, 404);
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
      return c.json(withColumnTasks(db, updated));
    },
  );

  return routes;
}

/**
 * 写接口的统一响应：改动后的任务 + 它所在列的完整有序列表。
 * 移动后前端直接整列替换，不做本地重排（见 docs/spec.md 与 docs/decisions.md D18）。
 */
function withColumnTasks(db: Db, task: TaskRecord) {
  return {
    task,
    columnTasks: readColumnTasks(db, task.parentId, task.columnId),
  };
}
