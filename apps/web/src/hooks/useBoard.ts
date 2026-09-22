import { fetchBoard } from '../api/client';
import { useAsync } from './useAsync';

/**
 * 读某一层看板。parentId 为 null 时读根看板。
 * includeArchived 是「显示已归档」总开关：打开后列里也带归档卡片，否则归档任务在界面上
 * 没有任何取消归档的入口（见 docs/decisions.md D35）。开关变化属于「换了一份数据」，会走加载态。
 * 请求失败时把后端的中文错误文案原样带出来（见 src/api/client.ts）。
 */
export function useBoard(parentId: string | null, includeArchived: boolean) {
  return useAsync(
    () => fetchBoard(parentId, includeArchived),
    [parentId, includeArchived],
    '加载看板失败',
  );
}
