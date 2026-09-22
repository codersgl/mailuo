import type { Db } from '../db/client.js';

export interface ColumnRecord {
  id: string;
  name: string;
  orders: number;
}

/** 三列全项目共用，按 orders 升序返回。 */
export function listColumns(db: Db): ColumnRecord[] {
  return db.prepare('SELECT id, name, orders FROM columns ORDER BY orders').all() as ColumnRecord[];
}

/** 列 id 是否存在。入参校验用，避免把不存在的 column_id 写进 tasks。 */
export function columnExists(db: Db, columnId: string): boolean {
  return db.prepare('SELECT 1 FROM columns WHERE id = ?').get(columnId) !== undefined;
}
