/**
 * 三个列的 id 由迁移写死：apps/api/migrations/001_init.sql 里 INSERT 的是 todo / doing / done。
 * 前端只在这两处样式规则上依赖具体 id，其余地方（列名、列顺序、列数量）一律用后端返回的值。
 *
 * 改列 id 时必须同时改三处：上面的迁移、apps/api/src/domain/columns.ts 的完成列常量、以及这里。
 * 后端那份常量用于进度计数（见 docs/decisions.md D5）。
 */

/** 完成列：这一列的卡片整体降一档。 */
export const DONE_COLUMN_ID = 'done';

/** 进行中列：列头的任务数用强调色（定版原型 A 的写法）。 */
export const DOING_COLUMN_ID = 'doing';
