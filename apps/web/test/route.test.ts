import { describe, expect, it } from 'vitest';
import { boardPath, parseRoute } from '../src/lib/route';

describe('parseRoute', () => {
  it('根路径是根看板', () => {
    expect(parseRoute('/')).toEqual({ kind: 'board', boardId: null });
  });

  it('/board/:taskId 是那个任务的看板', () => {
    expect(parseRoute('/board/task-1')).toEqual({ kind: 'board', boardId: 'task-1' });
  });

  it('结尾多一个斜杠也认', () => {
    expect(parseRoute('/board/task-1/')).toEqual({ kind: 'board', boardId: 'task-1' });
  });

  it('把百分号编码解回任务 id', () => {
    expect(parseRoute('/board/a%20b')).toEqual({ kind: 'board', boardId: 'a b' });
  });

  it('认不出的路径返回 notFound，并把原路径带出来', () => {
    expect(parseRoute('/nonsense')).toEqual({ kind: 'notFound', pathname: '/nonsense' });
    expect(parseRoute('/board')).toEqual({ kind: 'notFound', pathname: '/board' });
    // 多一层路径不是合法路由：看板层级由任务 id 表达，不存在 /board/a/b。
    expect(parseRoute('/board/a/b')).toEqual({ kind: 'notFound', pathname: '/board/a/b' });
  });

  it('非法百分号编码不算崩溃，按 notFound 处理', () => {
    expect(parseRoute('/board/%')).toEqual({ kind: 'notFound', pathname: '/board/%' });
  });
});

describe('boardPath', () => {
  it('根看板是 /', () => {
    expect(boardPath(null)).toBe('/');
  });

  it('任务看板的路径能被 parseRoute 原样解回来', () => {
    const boardId = 'a b/中';
    expect(boardPath(boardId)).toBe('/board/a%20b%2F%E4%B8%AD');
    expect(parseRoute(boardPath(boardId))).toEqual({ kind: 'board', boardId });
  });
});
