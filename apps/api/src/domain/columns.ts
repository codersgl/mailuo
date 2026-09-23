/**
 * 完成列的固定 id。
 * 迁移 001 会写入同一 id 的列，进度计数（childDone）以它判定"完成"，改这里必须同步改迁移。
 */
export const DONE_COLUMN_ID = 'done';

/**
 * 「进行中」列的固定 id。
 * 工期计时只在任务的 column_id 等于它时累加（见 docs/spec.md 的「工期提醒」）。
 * 同一个 id 写在迁移 001 的 INSERT 里，改这里必须同步改迁移。
 */
export const DOING_COLUMN_ID = 'doing';
