import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import type { Db } from '../db/client.js';
import { readBoard } from '../repositories/board.js';
import { searchTasks } from '../repositories/search.js';
import { findTask, listTreeTasks, readBreadcrumb } from '../repositories/tasks.js';
import { searchQuerySchema } from '../schemas/search.js';
import { wantsArchived } from './query.js';
import { validationHook } from './validation.js';

/** 读接口：看板、任务树、面包屑、搜索。 */
export function createBoardRoutes(db: Db): Hono {
  const routes = new Hono();

  routes.get('/api/board', (c) => c.json(readBoard(db, null, wantsArchived(c))));

  routes.get('/api/board/:parentId', (c) => {
    const parentId = c.req.param('parentId');
    // 仓储只负责查询，不校验存在性；404 归路由层（见 docs/decisions.md D8）。
    if (!findTask(db, parentId)) {
      return c.json({ error: '任务不存在' }, 404);
    }
    return c.json(readBoard(db, parentId, wantsArchived(c)));
  });

  routes.get('/api/tree', (c) => c.json({ tasks: listTreeTasks(db, wantsArchived(c)) }));

  routes.get('/api/breadcrumb/:taskId', (c) => {
    const items = readBreadcrumb(db, c.req.param('taskId'));
    if (!items) {
      return c.json({ error: '任务不存在' }, 404);
    }
    return c.json({ items });
  });

  // 搜索是读接口，但和看板不同：它跨层级、不受当前看板限制（见 docs/spec.md 的「第二批」）。
  // 匹配范围与排序口径在 repositories/search.ts。
  routes.get('/api/search', zValidator('query', searchQuerySchema, validationHook), (c) => {
    const { q } = c.req.valid('query');
    return c.json(searchTasks(db, q, wantsArchived(c)));
  });

  return routes;
}
