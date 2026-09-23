import { describe, expect, it } from 'vitest';
import { splitByKeyword } from '../src/lib/highlight';

describe('splitByKeyword', () => {
  it('把命中的片段单独切出来，其余部分按原样保留', () => {
    expect(splitByKeyword('重构登录页面', '登录')).toEqual([
      { text: '重构', match: false },
      { text: '登录', match: true },
      { text: '页面', match: false },
    ]);
  });

  it('多处命中都切出来', () => {
    expect(splitByKeyword('登录前先登录', '登录')).toEqual([
      { text: '登录', match: true },
      { text: '前先', match: false },
      { text: '登录', match: true },
    ]);
  });

  it('关键词在开头或结尾时不产生空片段', () => {
    expect(splitByKeyword('登录页面', '登录')).toEqual([
      { text: '登录', match: true },
      { text: '页面', match: false },
    ]);
    expect(splitByKeyword('重构登录', '登录')).toEqual([
      { text: '重构', match: false },
      { text: '登录', match: true },
    ]);
  });

  it('没有命中时整段未命中', () => {
    expect(splitByKeyword('重构登录', '测试')).toEqual([{ text: '重构登录', match: false }]);
  });

  it('关键词为空或只有空白时整段未命中', () => {
    expect(splitByKeyword('重构登录', '')).toEqual([{ text: '重构登录', match: false }]);
    expect(splitByKeyword('重构登录', '   ')).toEqual([{ text: '重构登录', match: false }]);
  });

  it('空文本返回空数组', () => {
    expect(splitByKeyword('', '登录')).toEqual([]);
  });

  it('ASCII 大小写不敏感，且切出来的是原文的大小写', () => {
    expect(splitByKeyword('Refactor Login', 'login')).toEqual([
      { text: 'Refactor ', match: false },
      { text: 'Login', match: true },
    ]);
  });

  it('关键词里有连续空白时，按折叠空白后的文本匹配', () => {
    // 后端的摘要已经把空白折叠过（repositories/search.ts），拿原始关键词匹配会一条都不标黄。
    expect(splitByKeyword('甲 目标 乙', '目标  乙')).toEqual([
      { text: '甲 ', match: false },
      { text: '目标 乙', match: true },
    ]);
  });

  it('折叠也救不回命中时，整段按未命中返回（不能凭空标黄）', () => {
    expect(splitByKeyword('甲 目标 乙', '完全没有的词')).toEqual([
      { text: '甲 目标 乙', match: false },
    ]);
  });

  it('关键词两端空白被去掉后再匹配', () => {
    expect(splitByKeyword('重构登录', ' 登录 ')).toEqual([
      { text: '重构', match: false },
      { text: '登录', match: true },
    ]);
  });
});
