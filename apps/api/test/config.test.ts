import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PORT, loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('默认端口是 3001，数据库指向仓库 data/kanban.db', () => {
    const config = loadConfig({});

    expect(config.port).toBe(DEFAULT_PORT);
    expect(DEFAULT_PORT).toBe(3001);
    expect(config.dbPath.endsWith(path.join('data', 'kanban.db'))).toBe(true);
    expect(config.migrationsDir.endsWith(path.join('apps', 'api', 'migrations'))).toBe(true);
  });

  it('环境变量可覆盖端口与数据库路径', () => {
    const config = loadConfig({ PORT: '4567', KANBAN_DB_PATH: '/tmp/kanban-test.db' });

    expect(config.port).toBe(4567);
    expect(config.dbPath).toBe('/tmp/kanban-test.db');
  });

  it('端口非法时报错', () => {
    expect(() => loadConfig({ PORT: '不是数字' })).toThrow(/PORT/);
    expect(() => loadConfig({ PORT: '0' })).toThrow(/PORT/);
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/PORT/);
  });
});
