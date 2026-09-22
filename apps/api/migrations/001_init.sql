-- 001_init.sql：初始表结构与固定三列。
-- 整份文件在 runMigrations 的单个事务中执行，因此不要在本文件里写 BEGIN/COMMIT。

CREATE TABLE columns (
  id         TEXT PRIMARY KEY,
  name       TEXT    NOT NULL,
  orders     INTEGER NOT NULL
);

CREATE TABLE tasks (
  id          TEXT    PRIMARY KEY,
  parent_id   TEXT    REFERENCES tasks(id),
  column_id   TEXT    NOT NULL REFERENCES columns(id),
  title       TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT '',
  duration    INTEGER NOT NULL DEFAULT 0,
  orders      INTEGER NOT NULL,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,
  archived_at TEXT
);

CREATE TABLE task_deps (
  predecessor_id TEXT NOT NULL REFERENCES tasks(id),
  successor_id   TEXT NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (predecessor_id, successor_id),
  CHECK (predecessor_id <> successor_id)
);

CREATE INDEX idx_tasks_board    ON tasks(parent_id, column_id, orders);
CREATE INDEX idx_tasks_parent   ON tasks(parent_id);
CREATE INDEX idx_deps_successor ON task_deps(successor_id);

-- 三列全项目共用，orders 间隔 1000；'done' 是完成列的固定 id，代码里的进度计数依赖它。
INSERT INTO columns (id, name, orders) VALUES
  ('todo',  '待办',   1000),
  ('doing', '进行中', 2000),
  ('done',  '完成',   3000);
