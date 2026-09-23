import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import type { Db } from '../db/client.js';
import { readBoard } from '../repositories/board.js';
import { readLayerSchedule } from '../repositories/deps.js';
import { searchTasks } from '../repositories/search.js';
import { findTask, listTreeTasks, readBreadcrumb } from '../repositories/tasks.js';
import { searchQuerySchema } from '../schemas/search.js';
import { wantsArchived } from './query.js';
import { validationHook } from './validation.js';

/** 读接口：看板、任务树、面包屑、搜索、关键路径。 */
export function createBoardRoutes(db: Db): Hono {
  const routes = new Hono();

  routes.get('/api/board', (c) => c.json(readBoard(db, null, wantsArchived(c))));

  /**
   * 根看板的关键路径。与 `/api/board`（根看板）对称：根看板没有 parentId，
   * 所以它走独立的路径段，而不是给 `/api/board/:parentId/cpm` 编一个特殊 id。
   * 注册在 `/api/board/:parentId` 之前，避免被那条参数路由抢先匹配。
   */
  routes.get('/api/board/cpm', (c) => c.json(readLayerSchedule(db, null, wantsArchived(c))));

  routes.get('/api/board/:parentId', (c) => {
    const parentId = c.req.param('parentId');
    // 仓储只负责查询，不校验存在性；404 归路由层（见 docs/decisions.md D8）。
    if (!findTask(db, parentId)) {
      return c.json({ error: '任务不存在' }, 404);
    }
    return c.json(readBoard(db, parentId, wantsArchived(c)));
  });

  /**
   * 某一层看板的依赖图与关键路径：节点带最早 / 最晚开始时间与松弛时间，边带是否关键。
   * 计算结果不落库，每次读取时重算（见 docs/spec.md 的「关键路径」）。
   * 依赖图成环（只可能来自手工改库）会让计算抛错 → 500 记日志，不返回一张假图。
   */
  routes.get('/api/board/:parentId/cpm', (c) => {
    const parentId = c.req.param('parentId');
    if (!findTask(db, parentId)) {
      return c.json({ error: '任务不存在' }, 404);
    }
    return c.json(readLayerSchedule(db, parentId, wantsArchived(c)));
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
