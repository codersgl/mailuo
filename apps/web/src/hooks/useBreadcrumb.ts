import { fetchBreadcrumb } from '../api/client';
import type { BreadcrumbItem } from '../api/types';
import { useAsync } from './useAsync';
import type { AsyncState } from './useAsync';

/**
 * 根看板那句文案。根看板没有任务 id，`GET /api/breadcrumb/:taskId` 没得查，
 * 所以这一段只能由前端给出；任务看板的第一段由后端 readBreadcrumb 补上。
 * 两处必须一致：apps/api/src/domain/board.ts 的 ROOT_BOARD_TITLE。
 */
export const ROOT_BOARD_TITLE = '根看板';

/** 根看板的面包屑，只有一段，不可点（它本身就是当前层）。 */
const ROOT_CRUMB: BreadcrumbItem[] = [{ id: null, title: ROOT_BOARD_TITLE }];

/**
 * 根看板这一段不依赖任何请求，同步就是 ready：否则顶栏第一帧是空白面包屑，闪一下才出现。
 * 任务看板要走一次后端回溯，等的就是网络。
 */
const ROOT_STATE: AsyncState<BreadcrumbItem[]> = { status: 'ready', data: ROOT_CRUMB };

/**
 * 当前看板的面包屑。boardId 为 null 时是根看板；其余情况由后端沿 parent_id 回溯
 * （见 docs/spec.md），前端不自己拼。
 */
export function useBreadcrumb(boardId: string | null) {
  const result = useAsync(
    () => (boardId === null ? Promise.resolve(ROOT_CRUMB) : fetchBreadcrumb(boardId)),
    [boardId],
    '加载面包屑失败',
  );

  return boardId === null ? { ...result, state: ROOT_STATE } : result;
}
