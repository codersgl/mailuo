import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createTask, deleteTask } from '../src/api/client';
import { useTaskActions } from '../src/hooks/useTaskActions';
import type { WriteResult, DeleteResult } from '../src/hooks/useTaskActions';
import type { TaskRecord } from '../src/api/types';

/**
 * 写操作的错误映射：ApiError 用后端的中文文案，其它异常用兜底文案。
 *
 * 为什么在 client 这一层装替身：真实走网络时 `request()` 会把所有失败都包成 ApiError
 * （见 api/client.ts），非 ApiError 那一侧到不了；而写入口有三处（抽屉、新建行、卡片菜单），
 * 界面直接显示 message，所以「不要把代码 bug 的英文 message 冒给用户」必须有用例钉住。
 * 除 createTask / deleteTask 之外的导出保持真实，避免把整个 client 换掉。
 */
vi.mock('../src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/client')>();
  return { ...actual, createTask: vi.fn(), deleteTask: vi.fn() };
});

const createTaskMock = vi.mocked(createTask);
const deleteTaskMock = vi.mocked(deleteTask);

function record(): TaskRecord {
  return {
    id: 't1',
    parentId: null,
    columnId: 'todo',
    title: '写测试',
    description: '',
    durationMinutes: null,
    spentMinutes: 0,
    runningSince: null,
    orders: 1000,
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
    archivedAt: null,
  };
}

const input = { parentId: null, columnId: 'todo', title: '写测试' };

async function createWith(refreshAll: () => void): Promise<WriteResult> {
  const { result } = renderHook(() => useTaskActions(refreshAll));
  let outcome: WriteResult | undefined;
  await act(async () => {
    outcome = await result.current.create(input);
  });
  return outcome!;
}

beforeEach(() => {
  // mockReset 而不是 clearAllMocks：后者只清调用记录，不清 `mockRejectedValueOnce` 的队列。
  createTaskMock.mockReset();
  deleteTaskMock.mockReset();
});

describe('useTaskActions 的失败文案', () => {
  it('非 ApiError 的异常用兜底文案，不把代码 bug 的 message 显示给用户', async () => {
    createTaskMock.mockRejectedValueOnce(new Error('Cannot read properties of undefined'));
    const refreshAll = vi.fn();

    await expect(createWith(refreshAll)).resolves.toEqual({
      ok: false,
      message: '操作失败，请重试',
    });
    // 失败不该触发静默重取：这次写根本没落库，重取只会白跑一趟。
    expect(refreshAll).not.toHaveBeenCalled();
  });

  it('ApiError 的中文文案原样带出（兜底只接管非 ApiError）', async () => {
    createTaskMock.mockRejectedValueOnce(new ApiError(400, '标题不能为空'));

    await expect(createWith(vi.fn())).resolves.toEqual({
      ok: false,
      message: '标题不能为空',
    });
  });

  it('删除路径失败同样走兜底文案', async () => {
    deleteTaskMock.mockRejectedValueOnce(new Error('boom'));
    const refreshAll = vi.fn();
    const { result } = renderHook(() => useTaskActions(refreshAll));

    let outcome: DeleteResult | undefined;
    await act(async () => {
      outcome = await result.current.remove('t1');
    });

    expect(outcome).toEqual({ ok: false, message: '操作失败，请重试' });
    expect(refreshAll).not.toHaveBeenCalled();
  });

  it('成功时返回任务并触发一次静默重取', async () => {
    const created = record();
    createTaskMock.mockResolvedValueOnce(created);
    const refreshAll = vi.fn();

    await expect(createWith(refreshAll)).resolves.toEqual({ ok: true, task: created });
    expect(refreshAll).toHaveBeenCalledTimes(1);
  });
});
