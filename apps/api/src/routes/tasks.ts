import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import type { Db } from '../db/client.js';
import { readColumnTasks } from '../repositories/board.js';
import { columnExists } from '../repositories/columns.js';
import { findDependencyCycle, listPredecessorIds, setTaskDeps } from '../repositories/deps.js';
import {
  applyTaskUpdate,
  changeTaskParent,
  countActiveChildren,
  createTask,
  deleteTaskSubtree,
  findTask,
  isSelfOrDescendant,
  setTaskArchived,
  type TaskRecord,
} from '../repositories/tasks.js';
import { setTaskDepsSchema } from '../schemas/deps.js';
import {
  changeTaskParentSchema,
  createTaskSchema,
  setTaskArchivedSchema,
  updateTaskSchema,
} from '../schemas/task.js';
import { wantsArchived } from './query.js';
import { validationHook } from './validation.js';

/** 写接口：新建、改字段与移动、改父级、归档、删除、设置依赖。 */
export function createTaskRoutes(db: Db): Hono {
  const routes = new Hono();

  // zValidator 在 Content-Type 不是 JSON 时会直接跳过解析，请求体变成 undefined，
  // 报错就成了「列 id 必须是字符串」这种误导文案（curl -d 默认发 form-urlencoded）。
  // 先明确提示，省掉一轮排查。
  //
  // 路径判据要带边界：`startsWith('/api/tasks')` 会把 /api/tasks-nope 也算进来，
  // 把本该 404 的路径变成 400。这里刻意**宁可多拦**：
  // /api/tasks/<id> 这类不存在的写路由也会拿到这条 400 而不是 404，代价可接受；
  // 反过来漏拦会让新加的写路由静默退回那条误导文案（见 docs/decisions.md D15）。
  routes.use('*', async (c, next) => {
    const isWrite = ['POST', 'PATCH', 'PUT'].includes(c.req.method);
    const isTaskApiPath = c.req.path === '/api/tasks' || c.req.path.startsWith('/api/tasks/');
    if (isWrite && isTaskApiPath) {
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

    // 顺序固定为：任务存在（404）→ 任务未归档（400）→ 目标列存在（400）→ 有子任务不可手动换列（400）
    // → 有子任务不可单独设工期（400）。
    const precheck = precheckTaskWritable(db, id);
    if (!precheck.ok) {
      return c.json({ error: precheck.error }, precheck.status);
    }
    if (patch.columnId !== undefined && !columnExists(db, patch.columnId)) {
      return c.json({ error: `列不存在: ${patch.columnId}` }, 400);
    }
    const hasChildren = countActiveChildren(db, id) > 0;
    if (patch.columnId !== undefined && hasChildren) {
      return c.json({ error: MANUAL_COLUMN_MOVE_REJECTED }, 400);
    }
    // 父任务的工期是子树叶子的汇总，写进去也没有任何地方会读它（见 domain/subtreeDuration.ts），
    // 所以在入口就拒掉，而不是留一个能写但没用的字段。与上一条同一个理由、同一种做法。
    if (patch.durationMinutes !== undefined && hasChildren) {
      return c.json({ error: DERIVED_DURATION_REJECTED }, 400);
    }

    const updated = requireTask(applyTaskUpdate(db, id, patch));
    return c.json(withColumnTasks(db, updated, wantsArchived(c)));
  });

  routes.patch(
    '/api/tasks/:id/parent',
    zValidator('json', changeTaskParentSchema, validationHook),
    (c) => {
      const id = c.req.param('id');
      const input = c.req.valid('json');

      // 与 PATCH /api/tasks/:id 保持同一顺序：任务存在 → 任务未归档 → 列存在 → 父级检查
      // → 有子任务时列必须不变（排在最后，让父级本身的问题优先报出来）。
      const precheck = precheckTaskWritable(db, id);
      if (!precheck.ok) {
        return c.json({ error: precheck.error }, precheck.status);
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

      // 改父级本身允许（任务树里拖动）；但顺带换列对有子任务的父任务同样没有意义——
      // 它的列由子任务推导。任务树拖动发过来的就是它当前的列，正常路径不会撞上这条。
      // 排在校验链最后：父级本身的问题（成环、不存在、已归档）优先报出来。
      if (input.columnId !== precheck.task.columnId && countActiveChildren(db, id) > 0) {
        return c.json({ error: MANUAL_COLUMN_MOVE_REJECTED }, 400);
      }

      const updated = requireTask(changeTaskParent(db, id, input));
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

  /**
   * 整体替换任务的前置依赖（见 docs/spec.md 的 `PUT /api/tasks/:id/deps`）。
   *
   * 校验顺序固定为：任务存在（404）→ 任务未归档（400）→ 依赖自己（409）→ 逐个前置任务
   * （不存在 404 → 不同层 400 → 已归档 400）→ 成环（409）。顺序由测试钉死；
   * 「先资源后入参」与两条 PATCH 一致（见 docs/decisions.md D23），而入参本身的形状
   * （数组、重复项）在 schema 里就拦掉了，排在所有这些之前。
   *
   * 依赖变化会影响这个任务的最早 / 最晚开始时间，所以响应给出 `task`，前端按 D35 的做法
   * 静默重取整个图（`GET /api/board[/:parentId]/cpm`），不在这里回一整张图。
   */
  routes.put(
    '/api/tasks/:id/deps',
    zValidator('json', setTaskDepsSchema, validationHook),
    (c) => {
      const id = c.req.param('id');
      const { predecessorIds } = c.req.valid('json');

      const precheck = precheckTaskWritable(db, id);
      if (!precheck.ok) {
        return c.json({ error: precheck.error }, precheck.status);
      }
      const { task } = precheck;
      // 自己依赖自己在图的定义里就是一个环，单独给一句更直白的文案。
      if (predecessorIds.includes(id)) {
        return c.json({ error: '任务不能依赖自己' }, 409);
      }
      for (const predecessorId of predecessorIds) {
        const predecessor = findTask(db, predecessorId);
        if (!predecessor) {
          return c.json({ error: `前置任务不存在: ${predecessorId}` }, 404);
        }
        // 依赖两端必须同层，否则关键路径会在两个看板之间串算（见 docs/spec.md 的「数据模型」）。
        if (predecessor.parentId !== task.parentId) {
          return c.json({ error: `跨层依赖不允许: ${predecessorId}` }, 400);
        }
        if (predecessor.archivedAt !== null) {
          return c.json({ error: `前置任务已归档: ${predecessorId}` }, 400);
        }
      }
      const cyclic = findDependencyCycle(db, id, predecessorIds);
      if (cyclic !== undefined) {
        return c.json({ error: `依赖形成环: ${cyclic}` }, 409);
      }

      const updated = requireTask(setTaskDeps(db, id, predecessorIds));
      return c.json({ task: updated, predecessorIds: listPredecessorIds(db, id) });
    },
  );

  return routes;
}

/**
 * 拒绝手动改一个「有子任务」的父任务的列时用的文案。
 *
 * 两条写路由（`PATCH /api/tasks/:id` 的移动、`PATCH /api/tasks/:id/parent` 的顺带换列）
 * 共用同一句，前端把 `error` 直接显示给用户（见 apps/web/src/api/client.ts），
 * 所以这里要写成「用户看完知道为什么卡片不动」的一句话，而不是「非法请求」。
 */
const MANUAL_COLUMN_MOVE_REJECTED = '任务有子任务，所在列由子任务决定，不能手动移动';

/**
 * 拒绝给一个有子任务的父任务单独设工期时用的文案。
 *
 * 父任务的工期是子树叶子的汇总（见 domain/subtreeDuration.ts），写进去没有任何地方会读它。
 * 与上面那条同一个形状：前端对父任务把工期显示成只读并带上「按子任务汇总」，后端这条是权威兜底。
 */
const DERIVED_DURATION_REJECTED = '任务有子任务，工期由子任务的工期汇总，不能单独设置';

/**
 * 写接口的前置校验：任务存在（404）→ 任务未归档（400）。
 *
 * 三条写路由（`PATCH /api/tasks/:id`、`PATCH /api/tasks/:id/parent`、`PUT /api/tasks/:id/deps`）
 * 的这两步原本逐字重复三份，顺序又被测试钉死（先资源后入参、未归档先于其它校验，见
 * docs/decisions.md D23 与 D48），于是每次调整都要同时改三处加三组测试，漏一处就出现
 * 「同一种错误在两条路径上状态码不同」。抽到一处后，各路由只负责自己特有的后续校验
 * （列存在、父级成环、依赖各项…），顺序就只有一个来源。返回判别式联合而不是 Response：
 * helper 拿不到 Context，也不需要知道调用方会怎么包装响应。
 */
function precheckTaskWritable(
  db: Db,
  id: string,
): { ok: true; task: TaskRecord } | { ok: false; error: string; status: 400 | 404 } {
  const task = findTask(db, id);
  if (!task) return { ok: false, error: '任务不存在', status: 404 };
  if (task.archivedAt !== null) return { ok: false, error: '任务已归档', status: 400 };
  return { ok: true, task };
}

/**
 * 前置校验通过后，仓储层仍按「查不到返回 undefined」的契约返回，但这一步已经不可达：
 * better-sqlite3 是同步的，校验与写入之间没有 await，任务不可能凭空消失。
 *
 * 原本三处各写一次 `if (!updated) return 404`——读者判断不出哪一层权威，而将来若在前置校验
 * 与仓储调用之间插入 await，那三处会从不可达变成没被测试过的真实竞态。这里收敛成一条显式
 * 断言：真触发就是 500 加日志，比一个看起来像「另一层权威」的 404 更诚实（见审计报告 D10）。
 * 代价要说清：真走到这里时写事务可能已经提交，客户端却只拿到 500——那种情况会变成「重试一次
 * 可能重复写入」的语义，所以这条断言的目标是让它响亮地暴露，而不是替调用方兜底。
 */
function requireTask(task: TaskRecord | undefined): TaskRecord {
  if (!task) {
    throw new Error('前置校验通过后任务却查不到，说明校验与写入之间被插入了异步操作');
  }
  return task;
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
