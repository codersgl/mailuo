import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import type { Db } from '../db/client.js';
import { columnExists } from '../repositories/columns.js';
import { createTask, findTask, updateTaskFields } from '../repositories/tasks.js';
import { createTaskSchema, updateTaskSchema } from '../schemas/task.js';
import { validationHook } from './validation.js';

/**
 * 写接口：新建任务、改基础字段。
 * 拖拽移动（orders 重排）与改父级在下一步接入，归档与删除也还没做。
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
    const updated = updateTaskFields(db, c.req.param('id'), c.req.valid('json'));
    if (!updated) {
      return c.json({ error: '任务不存在' }, 404);
    }
    return c.json(updated);
  });

  return routes;
}
