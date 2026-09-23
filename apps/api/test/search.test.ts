import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Db } from '../src/db/client.js';
import { MAX_QUERY_LENGTH, SEARCH_LIMIT, toLikePattern } from '../src/domain/search.js';
import { createTestDb, insertTask } from './helpers.js';

/** 发一次搜索请求。用 URLSearchParams 拼查询串，免得中文与空格要手工编码。 */
async function search(db: Db, params: Record<string, string>) {
  const query = new URLSearchParams(params).toString();
  const response = await createApp(db).request(`/api/search?${query}`);
  return { status: response.status, body: await response.json() };
}

describe('搜索上限常量', () => {
  it('关键词上限就是 100：前端 apps/web/src/domain/search.ts 里有同一个数，两边各自钉一遍', () => {
    // 只断言「等于自己」是同义反复。钉字面量，改一侧时另一侧的用例才会红。
    expect(MAX_QUERY_LENGTH).toBe(100);
  });
});

describe('toLikePattern', () => {
  it('普通关键词只是包上百分号', () => {
    expect(toLikePattern('登录')).toBe('%登录%');
  });

  it('转义 %、_ 与反斜杠', () => {
    expect(toLikePattern('100%')).toBe('%100\\%%');
    expect(toLikePattern('a_b')).toBe('%a\\_b%');
    expect(toLikePattern('a\\b')).toBe('%a\\\\b%');
  });

  it('转义是单遍的，补进去的反斜杠不再被转义一次', () => {
    expect(toLikePattern('\\')).toBe('%\\\\%');
  });
});

describe('GET /api/search', () => {
  it('命中标题，并给出祖先路径（根看板到父任务）与所在列', async () => {
    const db = createTestDb();
    const rootId = insertTask(db, { title: '重构登录', columnId: 'todo', orders: 1000 });
    const childId = insertTask(db, {
      title: '前端部分',
      columnId: 'doing',
      orders: 1000,
      parentId: rootId,
    });
    const leafId = insertTask(db, {
      title: '表单校验',
      columnId: 'todo',
      orders: 1000,
      parentId: childId,
    });

    const { status, body } = await search(db, { q: '表单' });

    expect(status).toBe(200);
    expect(body).toEqual({
      columns: [
        { id: 'todo', name: '待办', orders: 1000 },
        { id: 'doing', name: '进行中', orders: 2000 },
        { id: 'done', name: '完成', orders: 3000 },
      ],
      results: [
        {
          id: leafId,
          title: '表单校验',
          snippet: null,
          columnId: 'todo',
          durationMinutes: null,
          archivedAt: null,
          path: [
            { id: null, title: '根看板' },
            { id: rootId, title: '重构登录' },
            { id: childId, title: '前端部分' },
          ],
        },
      ],
      truncated: false,
    });
  });

  it('返回列字典：结果要按列分组，列名与顺序只由后端定', async () => {
    const db = createTestDb();
    insertTask(db, { title: '重构登录', columnId: 'doing', orders: 1000 });

    const { body } = await search(db, { q: '重构' });

    expect(body.columns).toEqual([
      { id: 'todo', name: '待办', orders: 1000 },
      { id: 'doing', name: '进行中', orders: 2000 },
      { id: 'done', name: '完成', orders: 3000 },
    ]);
  });

  it('描述里的关键词带连续空白时摘要照样给出来（与 SQL 的匹配口径一致）', async () => {
    const db = createTestDb();
    insertTask(db, {
      title: '无关标题',
      columnId: 'todo',
      orders: 1000,
      description: '甲 目标  乙',
    });

    // 关键词里是两个空格，描述里也是两个空格：SQL 直接匹配得到，摘要不能因为折叠空白而找不到。
    const { body } = await search(db, { q: '目标  乙' });

    expect(body.results).toHaveLength(1);
    expect(body.results[0].snippet).toBe('甲 目标 乙');
  });

  it('摘要不会切出半个代理对（emoji 只占一个码元宽度时也不能断在中间）', async () => {
    const db = createTestDb();
    // 前面 24 个字符正好把 SNIPPET_RADIUS 用满，末尾再放一个 emoji 让它落在切点上。
    insertTask(db, {
      title: '无关标题',
      columnId: 'todo',
      orders: 1000,
      description: `${'a'.repeat(24)}KEY${'a'.repeat(23)}😀${'a'.repeat(12)}`,
    });

    const { body } = await search(db, { q: 'key' });

    const snippet = body.results[0].snippet as string;
    // 切出来的字符串里不能有孤立的高/低代理（界面上会渲染成 U+FFFD）。
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(snippet)).toBe(false);
    expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(snippet)).toBe(false);
    // 顺带钉住 emoji 没被整个丢掉。
    expect(snippet).toContain('😀');
  });

  it('父链成环的脏数据只让那两条结果没有路径，其余结果照常返回', async () => {
    const db = createTestDb();
    const aId = insertTask(db, { title: '甲 关键词', columnId: 'todo', orders: 1000 });
    const bId = insertTask(db, { title: '乙 关键词', columnId: 'todo', orders: 2000, parentId: aId });
    const normalId = insertTask(db, { title: '丙 关键词', columnId: 'todo', orders: 3000 });
    // 正常接口不会造成这种数据，这里直接改库模拟脏数据（与 tree.test.ts 的成环用例同一手法）。
    // 这一改让甲乙互为父级，两条都落在环里，所以两条的路径都退化成空。
    db.prepare('UPDATE tasks SET parent_id = ? WHERE id = ?').run(bId, aId);

    const { status, body } = await search(db, { q: '关键词' });

    expect(status).toBe(200);
    expect(body.results).toHaveLength(3);
    const pathOf = (id: string) =>
      body.results.find((result: { id: string }) => result.id === id).path;
    expect(pathOf(aId)).toEqual([]);
    expect(pathOf(bId)).toEqual([]);
    // 关键：坏数据没有把整个搜索带下去，正常的那条路径照样算出来。
    expect(pathOf(normalId)).toEqual([{ id: null, title: '根看板' }]);
  });

  it('多余的查询参数被忽略，与其它读接口一致', async () => {
    const db = createTestDb();
    insertTask(db, { title: '重构登录', columnId: 'todo', orders: 1000 });

    const response = await createApp(db).request('/api/search?q=%E7%99%BB%E5%BD%95&foo=1');

    expect(response.status).toBe(200);
    expect((await response.json()).results).toHaveLength(1);
  });

  it('根层任务的路径只有「根看板」', async () => {
    const db = createTestDb();
    const id = insertTask(db, { title: '重构登录', columnId: 'todo', orders: 1000 });

    const { body } = await search(db, { q: '重构' });

    expect(body.results[0]).toMatchObject({ id, path: [{ id: null, title: '根看板' }] });
  });

  it('带上工期：估过给分钟数，未估给 null', async () => {
    const db = createTestDb();
    const estimatedId = insertTask(db, {
      title: '登录页 有工期',
      columnId: 'todo',
      orders: 1000,
      durationMinutes: 1440,
    });
    const unestimatedId = insertTask(db, {
      title: '登录页 未估',
      columnId: 'todo',
      orders: 2000,
    });

    const { body } = await search(db, { q: '登录页' });

    const byId = new Map(
      body.results.map((result: { id: string; durationMinutes: number | null }) => [
        result.id,
        result.durationMinutes,
      ]),
    );
    expect(byId.get(estimatedId)).toBe(1440);
    expect(byId.get(unestimatedId)).toBeNull();
  });

  it('命中描述时给出以关键词为中心的摘要，两端带省略号', async () => {
    const db = createTestDb();
    const description = `${'前'.repeat(40)}目标${'后'.repeat(40)}`;
    insertTask(db, { title: '无关标题', columnId: 'todo', orders: 1000, description });

    const { body } = await search(db, { q: '目标' });

    expect(body.results[0].snippet).toBe(`…${'前'.repeat(24)}目标${'后'.repeat(24)}…`);
  });

  it('描述里的换行与连续空白压成单个空格', async () => {
    const db = createTestDb();
    insertTask(db, {
      title: '无关标题',
      columnId: 'todo',
      orders: 1000,
      description: '第一行\n\n  目标   第三行',
    });

    const { body } = await search(db, { q: '目标' });

    expect(body.results[0].snippet).toBe('第一行 目标 第三行');
  });

  it('标题命中而描述不含关键词时不给摘要', async () => {
    const db = createTestDb();
    insertTask(db, {
      title: '登录页',
      columnId: 'todo',
      orders: 1000,
      description: '与关键词无关的描述',
    });

    const { body } = await search(db, { q: '登录' });

    expect(body.results[0].snippet).toBeNull();
  });

  it('ASCII 大小写不敏感', async () => {
    const db = createTestDb();
    const id = insertTask(db, { title: 'Refactor Login', columnId: 'todo', orders: 1000 });

    const { body } = await search(db, { q: 'refactor' });

    expect(body.results.map((result: { id: string }) => result.id)).toEqual([id]);
  });

  it('转义 LIKE 的通配符：% 与 _ 按字面匹配', async () => {
    const db = createTestDb();
    const percentId = insertTask(db, { title: '完成度 100%', columnId: 'todo', orders: 1000 });
    insertTask(db, { title: '进度 1000 天', columnId: 'todo', orders: 2000 });
    const underscoreId = insertTask(db, { title: 'a_b', columnId: 'todo', orders: 3000 });
    insertTask(db, { title: 'axb', columnId: 'todo', orders: 4000 });

    const percent = await search(db, { q: '100%' });
    const underscore = await search(db, { q: 'a_b' });

    expect(percent.body.results.map((result: { id: string }) => result.id)).toEqual([percentId]);
    expect(underscore.body.results.map((result: { id: string }) => result.id)).toEqual([
      underscoreId,
    ]);
  });

  it('默认不返回已归档任务，includeArchived=1 时返回并带 archivedAt', async () => {
    const db = createTestDb();
    const activeId = insertTask(db, { title: '归档说明', columnId: 'todo', orders: 1000 });
    const archivedId = insertTask(db, {
      title: '归档流程草稿',
      columnId: 'done',
      orders: 1000,
      archived: true,
    });

    const activeOnly = await search(db, { q: '归档' });
    const withArchived = await search(db, { q: '归档', includeArchived: '1' });

    expect(activeOnly.body.results.map((result: { id: string }) => result.id)).toEqual([activeId]);
    expect(withArchived.body.results.map((result: { id: string }) => result.id).sort()).toEqual(
      [activeId, archivedId].sort(),
    );
    expect(
      withArchived.body.results.find((result: { id: string }) => result.id === archivedId)
        .archivedAt,
    ).toBe('2024-01-01T00:00:00.000Z');
  });

  it('标题命中的排在只有描述命中的前面，哪怕后者更新得更晚', async () => {
    const db = createTestDb();
    const titleHitId = insertTask(db, {
      title: '登录页',
      columnId: 'todo',
      orders: 1000,
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    const descriptionHitId = insertTask(db, {
      title: '别的任务',
      columnId: 'todo',
      orders: 2000,
      description: '登录也在这里',
      updatedAt: '2024-06-01T00:00:00.000Z',
    });

    const { body } = await search(db, { q: '登录' });

    expect(body.results.map((result: { id: string }) => result.id)).toEqual([
      titleHitId,
      descriptionHitId,
    ]);
  });

  it('同为标题命中时最近更新的排前面', async () => {
    const db = createTestDb();
    insertTask(db, {
      title: '登录旧',
      columnId: 'todo',
      orders: 1000,
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    const newerId = insertTask(db, {
      title: '登录新',
      columnId: 'todo',
      orders: 2000,
      updatedAt: '2024-06-01T00:00:00.000Z',
    });

    const { body } = await search(db, { q: '登录' });

    expect(body.results[0].id).toBe(newerId);
  });

  it('命中数超过上限时只返回前 SEARCH_LIMIT 条并标记 truncated', async () => {
    const db = createTestDb();
    for (let index = 0; index <= SEARCH_LIMIT; index += 1) {
      insertTask(db, { title: `第${index}项 关键词`, columnId: 'todo', orders: (index + 1) * 1000 });
    }

    const { body } = await search(db, { q: '关键词' });

    expect(body.results).toHaveLength(SEARCH_LIMIT);
    expect(body.truncated).toBe(true);
  });

  it('恰好等于上限时不标记 truncated', async () => {
    const db = createTestDb();
    for (let index = 0; index < SEARCH_LIMIT; index += 1) {
      insertTask(db, { title: `第${index}项 关键词`, columnId: 'todo', orders: (index + 1) * 1000 });
    }

    const { body } = await search(db, { q: '关键词' });

    expect(body.results).toHaveLength(SEARCH_LIMIT);
    expect(body.truncated).toBe(false);
  });

  it('无匹配返回空数组', async () => {
    const db = createTestDb();
    insertTask(db, { title: '重构登录', columnId: 'todo', orders: 1000 });

    const { body } = await search(db, { q: '不存在的词' });

    expect(body.results).toEqual([]);
    expect(body.truncated).toBe(false);
  });

  it('搜索词两端空白被去掉，只有空白算空', async () => {
    const db = createTestDb();
    const id = insertTask(db, { title: '重构登录', columnId: 'todo', orders: 1000 });

    const trimmed = await search(db, { q: '  登录  ' });
    const blank = await search(db, { q: '   ' });

    expect(trimmed.body.results.map((result: { id: string }) => result.id)).toEqual([id]);
    expect(blank.status).toBe(400);
  });

  it('缺少 q 返回 400', async () => {
    const response = await createApp(createTestDb()).request('/api/search');

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('搜索词');
  });

  it('搜索词超长返回 400', async () => {
    const { status, body } = await search(createTestDb(), { q: 'x'.repeat(MAX_QUERY_LENGTH + 1) });

    expect(status).toBe(400);
    expect(body.error).toBe(`q: 搜索词最多 ${MAX_QUERY_LENGTH} 字`);
  });
});
