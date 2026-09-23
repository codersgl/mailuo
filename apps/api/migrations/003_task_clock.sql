-- 003_task_clock.sql：记录「工期已经用掉多少」，供工期提醒使用（见 docs/spec.md 的「工期提醒」）。
--
-- 两列的语义：
--   spent_minutes  已结算的累计用时，单位分钟，只在进行中列里增长
--   running_since  当前这一段的开始时刻；非空表示正在计时
--
-- 不变式：running_since IS NOT NULL  ⟺  (column_id = 'doing' AND archived_at IS NULL)。
-- 仓储层的每个写入口都维持它（见 domain/clock.ts 的 settleClock）。
--
-- 回填取舍：迁移时已经在「进行中」的任务，无法回溯真实开工时刻，统一从**本次迁移执行的时刻**
-- 起算，spent_minutes 保持 0。这里刻意不用 updated_at 充数——它只是最后一次改动的时刻，
-- 一个放着没动半年的任务会被算成「已用 180 天」，界面立刻显示「超期 180 天」这种假数字。
--
-- 用 strftime 而不是 datetime：格式与 JS 的 new Date().toISOString() 一致（含 T 与毫秒 Z），
-- 前端用 Date.parse 直接解析。datetime('now') 得到的是空格分隔、无毫秒的另一种写法。
ALTER TABLE tasks ADD COLUMN spent_minutes INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(spent_minutes) = 'integer' AND spent_minutes >= 0);

ALTER TABLE tasks ADD COLUMN running_since TEXT;

UPDATE tasks
   SET running_since = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE column_id = 'doing' AND archived_at IS NULL;
