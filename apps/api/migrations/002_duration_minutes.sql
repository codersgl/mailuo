-- 002_duration_minutes.sql：工期的最小刻度从「天」改成「分钟」，并把「未估」与「瞬时」分开。
-- kanban:no-foreign-keys
--
-- 上面那行是给迁移 runner 的标记：SQLite 改不了已有列的类型与约束，只能重建表，
-- 而重建要 DROP 掉被 tasks_new 与 task_deps 引用的旧 tasks 表，外键打开时那条 DROP
-- 会触发隐式 DELETE 并报约束错误。PRAGMA foreign_keys 在事务内是空操作，所以由 runner
-- 在事务外开关外键，并在本文件执行完、提交前做一次 foreign_key_check（见 D31）。
--
-- 语义变化：
--   duration（天，0 表示未估）→ duration_minutes（分钟，NULL 表示未估，0 表示瞬时）
-- 数据换算：旧的 0 与负数一律按「未估」转成 NULL（001 没有 CHECK，手改库可能出现负数）；
-- 其余按 1 天 = 480 分钟（8 小时工作制）折算。
--
-- 下一个人照抄这份迁移时注意两件事：
--   1. 重建表会连带丢掉旧表上的索引，必须在 RENAME 之后手工重建（本文件末尾那两条）。
--   2. 新表最后必须 RENAME 回原来的表名。ALTER TABLE RENAME 只会重写指向新表名的引用，
--      最终名与旧名不一致时，task_deps 里 `REFERENCES tasks(id)` 会静默指错表。

CREATE TABLE tasks_new (
  id               TEXT    PRIMARY KEY,
  parent_id        TEXT    REFERENCES tasks(id),
  column_id        TEXT    NOT NULL REFERENCES columns(id),
  title            TEXT    NOT NULL,
  description      TEXT    NOT NULL DEFAULT '',
  duration_minutes INTEGER CHECK (
    duration_minutes IS NULL OR (typeof(duration_minutes) = 'integer' AND duration_minutes >= 0)
  ),
  orders           INTEGER NOT NULL,
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL,
  archived_at      TEXT
);

INSERT INTO tasks_new (
  id, parent_id, column_id, title, description, duration_minutes, orders, created_at, updated_at, archived_at
)
SELECT
  id, parent_id, column_id, title, description,
  CASE WHEN duration > 0 THEN duration * 480 ELSE NULL END,
  orders, created_at, updated_at, archived_at
FROM tasks;

DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;

CREATE INDEX idx_tasks_board  ON tasks(parent_id, column_id, orders);
CREATE INDEX idx_tasks_parent ON tasks(parent_id);
