import { describe, expect, it } from 'vitest';
import { subtreeLeafDurations } from '../src/domain/subtreeDuration.js';
import type { DurationNode } from '../src/domain/subtreeDuration.js';

/**
 * 父任务工期的汇总口径（见 docs/decisions.md D78）：Σ 子树里未归档叶子的工期，有叶子未估即为 null。
 *
 * 这是纯函数用例。它在接口上的表现（依赖图的节点工期）在 cpm.test.ts，
 * 前端同名口径（domain/subtreeTime.ts）在 apps/web/test/subtreeTime.test.ts——两边用同一组夹具。
 */

function node(id: string, parentId: string | null, durationMinutes: number | null = null): DurationNode {
  return { id, parentId, durationMinutes };
}

describe('subtreeLeafDurations', () => {
  it('汇总的是子树里的叶子，中间层自己的工期不进和', () => {
    // root ─ mid ─ leaf1
    //      └ leaf2
    const sums = subtreeLeafDurations([
      node('root', null, 9999),
      node('mid', 'root', 9999),
      node('leaf1', 'mid', 480),
      node('leaf2', 'root', 240),
    ]);

    expect(sums.get('root')).toBe(720);
    expect(sums.get('mid')).toBe(480);
    // 叶子不在表里：调用方用任务自己的 duration_minutes。
    expect(sums.has('leaf1')).toBe(false);
    expect(sums.has('leaf2')).toBe(false);
  });

  it('有一片叶子未估，整个和就是 null（不是把未估当 0 加）', () => {
    const sums = subtreeLeafDurations([
      node('root', null),
      node('leaf1', 'root', 480),
      node('leaf2', 'root', null),
    ]);

    expect(sums.get('root')).toBeNull();
  });

  it('没有任何未归档子任务的任务不在表里', () => {
    const sums = subtreeLeafDurations([node('lonely', null, 120)]);

    expect(sums.size).toBe(0);
  });

  it('全部叶子工期为 0（瞬时）时和是 0，而不是 null', () => {
    const sums = subtreeLeafDurations([
      node('root', null),
      node('a', 'root', 0),
      node('b', 'root', 0),
    ]);

    expect(sums.get('root')).toBe(0);
  });

  it('成环的脏数据不吃掉进程，环上那两个不在表里，结果与输入顺序无关', () => {
    // a.parent = b、b.parent = a，c 挂在 a 下面。手工改库才可能造出来（接口层挡住了）。
    const cyclic = [node('a', 'b', 60), node('b', 'a', 60), node('c', 'a', 60)];
    const one = subtreeLeafDurations(cyclic);
    const two = subtreeLeafDurations([cyclic[1]!, cyclic[0]!, cyclic[2]!]);

    expect(one.has('a')).toBe(false);
    expect(one.has('b')).toBe(false);
    expect([...two.entries()]).toEqual([...one.entries()]);
  });

  it('环是封闭的：环上的任务不影响非环任务的汇总', () => {
    // 甲↔乙这种环没法挂在别的任务下面——每个任务只有一个 parentId，环里的人不可能同时属于环外。
    // 所以剔环只影响环自己，p 这条正常的父子链照常汇总。
    const sums = subtreeLeafDurations([
      node('p', null, 300),
      node('leaf', 'p', 60),
      node('a', 'b', 60),
      node('b', 'a', 60),
    ]);

    expect(sums.get('p')).toBe(60);
    expect(sums.has('a')).toBe(false);
    expect(sums.has('b')).toBe(false);
  });
});
