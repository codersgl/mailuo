import { fetchLayerSchedule } from '../api/client';
import { useAsync } from './useAsync';

/**
 * 读某一层的依赖图（任务依赖 + 关键路径），供抽屉里的「前置任务」使用。
 *
 * 依赖图是**整层**的，不是一个任务的：要判断「谁能加入而不成环」，需要这一层所有的边，
 * 所以用现成的 `GET /api/board[/:parentId]/cpm`，不为单条任务新增读接口。
 *
 * 固定 `includeArchived = true`，与看板的「显示已归档」开关解耦：
 * 关着开关时后端返回的图会把归档任务与连着它的边一起省略，前端于是不知道某个前置已经归档，
 * 保存这份草稿就会把那条依赖静默删掉。取全图后界面能明确提示「有 N 个前置已归档，保存后解除」。
 * 代价只是多回归档任务的那几行，个人规模可忽略。
 *
 * 页面进来就取一次（不是打开抽屉才取）：看板与图是同一份数据的两种看法，
 * 后续的图上标记也要用它；一次 GET 换掉「哪些状态还没准备好」的一整类判断。
 */
export function useLayerSchedule(parentId: string | null) {
  return useAsync(() => fetchLayerSchedule(parentId, true), [parentId], '加载依赖关系失败');
}
