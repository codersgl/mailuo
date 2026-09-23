import { describe, expect, it } from 'vitest';
import { MAX_DURATION_MINUTES, MINUTES_PER_DAY } from '../src/domain/duration.js';

/**
 * 工期换算常量的字面量断言。
 *
 * 为什么值得单独占一条用例：480 这个数在仓库里有三份——这份后端常量、002 迁移里的折算、
 * 前端 `apps/web/src/lib/format.ts`——而审计的变异检验实测：把 `MINUTES_PER_DAY` 从 480 改成
 * 60，api 的 264 条用例全绿（见审计报告 E2）。后端接受域一改，界面上的合法输入就会 400，
 * 所以这里把两个数按字面量钉死，改一侧时同名的前端常量断言会一起提醒。
 */
describe('工期换算常量', () => {
  it('1 天 = 480 分钟（8 小时工作制）', () => {
    expect(MINUTES_PER_DAY).toBe(480);
  });

  it('上限 9999 天由同一个换算推出，而不是另一个手写的数', () => {
    expect(MAX_DURATION_MINUTES).toBe(9999 * 480);
    expect(MAX_DURATION_MINUTES).toBe(4_799_520);
  });
});
