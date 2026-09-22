// @vitest-environment node
// 这个文件必须跑在 node 环境：apps/web 默认用 jsdom（见 vitest.config.ts），
// 而 jsdom 会替换 TextEncoder / Uint8Array 这类全局对象，esbuild 的启动自检
// （new TextEncoder().encode('') instanceof Uint8Array）在跨 realm 下会失败，测试直接跑不起来。
import { fileURLToPath } from 'node:url';
import { loadConfigFromFile } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * 钉住 vite.config.ts 里「后端端口 → /api 代理目标」这段接线（见 docs/decisions.md D28、D41）。
 *
 * apps/api 那边测的是 loadEnvFileIfPresent 本身；这里测的是 Vite 配置有没有把端口接上。
 * 两侧各有一份读 .env 的代码，这个用例是防它们漂移的其中一半。
 * 另一半（repoRoot 推导 + 根 .env 真的被读到）由 apps/api/test/config.test.ts 的 envFilePath
 * 断言和手工验证覆盖：本用例用命令行环境变量定值，避免依赖本机 .env 是否存在。
 */
const configFile = fileURLToPath(new URL('../vite.config.ts', import.meta.url));

describe('vite.config.ts', () => {
  const savedPort = process.env.PORT;

  afterEach(() => {
    if (savedPort === undefined) {
      delete process.env.PORT;
    } else {
      process.env.PORT = savedPort;
    }
  });

  it('把 PORT 接到 /api 的代理目标上', async () => {
    process.env.PORT = '4567';

    const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' }, configFile);
    const proxy = loaded?.config.server?.proxy as
      | Record<string, { target?: string }>
      | undefined;

    expect(proxy?.['/api']?.target).toBe('http://127.0.0.1:4567');
  });
});
