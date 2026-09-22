import { fetchTree } from '../api/client';
import { useAsync } from './useAsync';

/**
 * 读完整任务树，用来建左侧文件树。
 * includeArchived 变一次就重取一次：归档节点是否返回由后端的查询参数决定（D24），
 * 前端不做本地过滤，免得「树里没有」和「树里有但被藏起来」两种状态混在一起。
 */
export function useTree(includeArchived: boolean) {
  return useAsync(() => fetchTree(includeArchived), [includeArchived], '加载文件树失败');
}
