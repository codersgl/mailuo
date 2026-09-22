/**
 * 同一 (parent_id, column_id) 内 orders 的编号间隔。
 * 新建任务追加到列末尾时取该列当前 MAX(orders) + ORDERS_STEP；
 * 拖拽引发的列内重排也按这个间隔重新编号（见 docs/spec.md）。
 */
export const ORDERS_STEP = 1000;
