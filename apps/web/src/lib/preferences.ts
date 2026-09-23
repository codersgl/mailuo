/**
 * 只存在前端的界面偏好（localStorage 的 key）。
 *
 * 这些项都不落库（见 docs/spec.md 的「归档」与「界面行为」）：换台设备打开时回到默认值，
 * 不影响任何任务数据。key 统一以 `kanban.` 开头，集中在这里是为了能一眼看全「前端偷偷存了什么」。
 */

/** 任务树里被折叠的节点 id 数组。存「已折叠」而不是「已展开」：默认全展开。 */
export const COLLAPSED_TASKS_KEY = 'kanban.tree.collapsed';

/** 「显示已归档」总开关。同时决定看板列与任务树里有没有归档任务。 */
export const SHOW_ARCHIVED_KEY = 'kanban.tree.showArchived';

/**
 * 整个任务树面板是否收起。收起后侧栏只留一条 44px 的窄条，把宽度让给看板。
 * 存的是单个 boolean，与上面两项一样：坏了（不是 boolean）就按默认展开算。
 */
export const TREE_COLLAPSED_KEY = 'kanban.tree.panelCollapsed';
