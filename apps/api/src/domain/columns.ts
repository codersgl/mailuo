/**
 * 完成列的固定 id。
 * 迁移 001 会写入同一 id 的列，进度计数（childDone）以它判定"完成"，改这里必须同步改迁移。
 */
export const DONE_COLUMN_ID = 'done';
