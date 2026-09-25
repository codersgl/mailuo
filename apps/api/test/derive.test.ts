import { describe, expect, it } from 'vitest';
import { deriveColumns, type DeriveNode } from '../src/domain/derive.js';

/** 造一个节点。省略 parentId 就是根任务，省略 columnId 就是待办。 */
function node(id: string, parentId: string | null = null, columnId = 'todo'): DeriveNode {
  return { id, parentId, columnId };
}

/** 把推导结果收成 `id -> columnId` 的普通对象，断言读起来比 Map 直白。 */
function resolved(tasks: DeriveNode[]): Record<string, string> {
  return Object.fromEntries(deriveColumns(tasks));
}

describe('deriveColumns', () => {
  it('叶子保留自己的列：没有子任务时推导管不着它', () => {
    expect(resolved([node('a', null, 'todo'), node('b', null, 'doing'), node('c', null, 'done')])).toEqual(
      { a: 'todo', b: 'doing', c: 'done' },
    );
  });

  it('有一个子任务在进行中，父任务就是进行中', () => {
    // 父任务原本停在「完成」，但子任务还在干，它就不该继续显示完成。
    const tasks = [node('p', null, 'done'), node('c1', 'p', 'done'), node('c2', 'p', 'doing')];
    expect(resolved(tasks).p).toBe('doing');
  });

  it('子任务全部完成，父任务就是完成', () => {
    const tasks = [node('p', null, 'todo'), node('c1', 'p', 'done'), node('c2', 'p', 'done')];
    expect(resolved(tasks).p).toBe('done');
  });

  it('有子任务但既没干完也没在干，父任务回到待办', () => {
    // 这是「完全推导」与「只加两条单向规则」的区别所在：子任务从进行中退回待办后，
    // 父任务不该留在进行中（那会得到一个「父任务在进行中、整棵子树却没人干活」的看板）。
    const tasks = [node('p', null, 'doing'), node('c1', 'p', 'todo'), node('c2', 'p', 'done')];
    expect(resolved(tasks).p).toBe('todo');
  });

  it('一层层往上推导：孙子在进行中，爷爷也是进行中', () => {
    const tasks = [node('g', null, 'todo'), node('p', 'g', 'todo'), node('c', 'p', 'doing')];
    expect(resolved(tasks)).toMatchObject({ g: 'doing', p: 'doing', c: 'doing' });
  });

  it('全部子任务完成会一路上推：孙子完成，爷爷也完成', () => {
    const tasks = [node('g', null, 'todo'), node('p', 'g', 'todo'), node('c', 'p', 'done')];
    expect(resolved(tasks)).toMatchObject({ g: 'done', p: 'done', c: 'done' });
  });

  it('孙子还没干完就挡住爷爷：中间那层是待办，爷爷不能显示完成', () => {
    const tasks = [
      node('g', null, 'done'),
      node('p', 'g', 'done'),
      node('c1', 'p', 'done'),
      node('c2', 'p', 'todo'),
    ];
    expect(resolved(tasks)).toMatchObject({ g: 'todo', p: 'todo' });
  });

  it('「进行中」优先于「完成」：有兄弟在干就不算干完', () => {
    const tasks = [node('p'), node('done1', 'p', 'done'), node('doing1', 'p', 'doing')];
    expect(resolved(tasks).p).toBe('doing');
  });

  it('父行不在这一批里时当作根，自己仍按子任务推导', () => {
    // 父行已归档（调用方只传未归档任务）时会出现这种输入，不能因此漏掉这一支。
    const tasks = [node('p', 'archived-parent', 'todo'), node('c', 'p', 'doing')];
    expect(resolved(tasks)).toMatchObject({ p: 'doing', c: 'doing' });
  });

  it('父子成环的脏数据不挂：环上的任务保留各自的列', () => {
    // 这个夹具抓住过一个真缺陷（审阅 D76）：早先的实现让「已在栈上」的那个节点退回当前列，
    // 但兜底值会泄漏到它的邻居——乙只有一个子任务甲，甲返回「完成」时乙被算成「完成」，
    // 而甲自己又按乙的兜底值算成「待办」，结果自相矛盾、还随输入顺序变。
    const tasks = [node('a', 'b', 'done'), node('b', 'a', 'todo'), node('x', 'a', 'todo')];
    const result = deriveColumns(tasks);

    // 环上（a、b）整段退出推导、保留各自的列：环上没有保证可达的不动点，迭代求不动点会来回翻。
    expect(result.get('a')).toBe('done');
    expect(result.get('b')).toBe('todo');
    // 挂在环下面的 x 没有子任务，照常保留自己的列。
    expect(result.get('x')).toBe('todo');
  });

  it('成环时结果与输入顺序无关', () => {
    const forward = deriveColumns([
      node('a', 'b', 'done'),
      node('b', 'a', 'todo'),
      node('x', 'a', 'todo'),
    ]);
    // 同一条环，换个起点（也换掉输入顺序）。
    const backward = deriveColumns([
      node('x', 'a', 'todo'),
      node('b', 'a', 'todo'),
      node('a', 'b', 'done'),
    ]);

    expect(Object.fromEntries(backward)).toEqual(Object.fromEntries(forward));
  });

  it('同一层里有多个子任务时按整层判定，不只看第一个', () => {
    const tasks = [
      node('p'),
      node('a', 'p', 'done'),
      node('b', 'p', 'done'),
      node('c', 'p', 'todo'),
    ];
    expect(resolved(tasks).p).toBe('todo');
  });
});
