import { describe, expect, it } from 'vitest';
import { MAX_DURATION_MINUTES, MINUTES_PER_DAY } from '../src/domain/duration.js';

/**
 * 工期换算常量的字面量断言。
 *
 * 为什么值得单独占一条用例：1440 这个数在仓库里有两份——这份后端常量与前端
 * `apps/web/src/lib/format.ts`——而审计的变异检验实测：把 `MINUTES_PER_DAY` 从当时的值改成 60，
 * api 的 264 条用例全绿（见审计报告 E2）。后端接受域一改，界面上的合法输入就会 400，
 * 所以这里把两个数按字面量钉死，改一侧时同名的前端常量断言会一起提醒。
 *
 * `apps/api/migrations/004_duration_natural_day.sql` 里的 480 不在这两份之内：它是**旧刻度的快照**。
 * 迁移一旦发布就不该跟着常量走，否则同一个库在不同版本上跑会得到不同的结果（D80）。
 */
describe('工期换算常量', () => {
  it('1 天 = 1440 分钟（自然日）', () => {
    expect(MINUTES_PER_DAY).toBe(1440);
  });

  it('上限 9999 天由同一个换算推出，而不是另一个手写的数', () => {
    expect(MAX_DURATION_MINUTES).toBe(9999 * 1440);
    expect(MAX_DURATION_MINUTES).toBe(14_398_560);
  });
});
