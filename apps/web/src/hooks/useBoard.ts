import { fetchBoard } from '../api/client';
import { useAsync } from './useAsync';

/**
 * 读某一层看板。parentId 为 null 时读根看板。
 * 请求失败时把后端的中文错误文案原样带出来（见 src/api/client.ts）。
 */
export function useBoard(parentId: string | null) {
  return useAsync(() => fetchBoard(parentId), [parentId], '加载看板失败');
}
