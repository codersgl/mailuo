import { useCallback, useMemo } from 'react';
import {
  ApiError,
  createTask,
  deleteTask,
  moveTask,
  setTaskArchived,
  updateTaskFields,
} from '../api/client';
import type { CreateTaskInput, TaskFieldsPatch } from '../api/client';
import type { TaskRecord } from '../api/types';

/** 写操作的结果。失败时 message 就是后端的中文文案，可以直接显示。 */
export type WriteResult =
  | { ok: true; task: TaskRecord }
  | { ok: false; message: string };

export type DeleteResult = { ok: true } | { ok: false; message: string };

export interface TaskActions {
  create: (input: CreateTaskInput) => Promise<WriteResult>;
  update: (id: string, patch: TaskFieldsPatch) => Promise<WriteResult>;
  /** 移动任务（拖拽落定）。`position` 的口径见 domain/board.ts 的 positionForDrop。 */
  move: (id: string, input: { columnId: string; position: number }) => Promise<WriteResult>;
  setArchived: (id: string, archived: boolean) => Promise<WriteResult>;
  remove: (id: string) => Promise<DeleteResult>;
}

/**
 * 任务的写操作。
 *
 * 失败不抛异常，而是返回 `{ ok: false, message }`：写入口有三处（抽屉面板、列底新建行、
 * 卡片的「⋯」菜单），各自要把错误显示在自己的位置上，用一个共享的 error state 会串台
 * （面板的错误冒到新建行上）。
 *
 * 成功后统一调用 `refreshAll()` 静默重取看板、文件树与面包屑，而不是拿写响应里的
 * `columnTasks` 做整列替换（见 docs/decisions.md D35）。
 */
export function useTaskActions(refreshAll: () => void): TaskActions {
  const run = useCallback(
    async (action: () => Promise<TaskRecord>): Promise<WriteResult> => {
      try {
        const task = await action();
        refreshAll();
        return { ok: true, task };
      } catch (cause: unknown) {
        return { ok: false, message: writeFailureMessage(cause) };
      }
    },
    [refreshAll],
  );

  return useMemo(
    () => ({
      create: (input: CreateTaskInput) => run(() => createTask(input)),
      update: (id: string, patch: TaskFieldsPatch) => run(() => updateTaskFields(id, patch)),
      move: (id: string, input: { columnId: string; position: number }) =>
        run(() => moveTask(id, input)),
      setArchived: (id: string, archived: boolean) => run(() => setTaskArchived(id, archived)),
      remove: async (id: string): Promise<DeleteResult> => {
        try {
          await deleteTask(id);
          refreshAll();
          return { ok: true };
        } catch (cause: unknown) {
          return { ok: false, message: writeFailureMessage(cause) };
        }
      },
    }),
    [run, refreshAll],
  );
}

/** 非 ApiError 只可能是代码 bug（client 已经把网络失败包成 ApiError）。 */
function writeFailureMessage(cause: unknown): string {
  return cause instanceof ApiError ? cause.message : '操作失败，请重试';
}
