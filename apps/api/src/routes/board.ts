import { Hono } from 'hono';
import type { Db } from '../db/client.js';
import { readBoard } from '../repositories/board.js';
import { findTask, listTreeTasks, readBreadcrumb } from '../repositories/tasks.js';
import { wantsArchived } from './query.js';

/** 读接口：看板、任务树、面包屑。 */
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

  return routes;
}
