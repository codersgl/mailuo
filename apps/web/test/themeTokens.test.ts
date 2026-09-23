import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 「组件一行不改、靠 .dark 覆盖同名令牌」这个设计的唯一静默失败模式：
 * 往 @theme 加了一个令牌却忘了在 .dark 里覆盖，它在深色下会保持浅色值——类型检查、其它单测、
 * 构建全都不会报。阴影那次就是这么踩到的（Tailwind 会把 --shadow-* 内联，见 index.css 的注释）。
 *
 * 所以这里直接读 index.css 的源码，把「两套必须成对」这件事钉成会红的断言。
 */

const css = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'index.css'), 'utf8');

/** 取出某选择器块里声明的自定义属性名。同一个选择器出现多次（:root）时全部合并。 */
function customProps(selector: string): string[] {
  const names: string[] = [];
  let from = 0;
  for (;;) {
    const start = css.indexOf(`${selector} {`, from);
    if (start === -1) break;
    const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
    names.push(
      ...[...body.matchAll(/(--[\w-]+)\s*:/g)]
        .map((match) => match[1])
        .filter((name) => name !== undefined),
    );
    from = start + 1;
  }
  return names;
}

/** 挑出某个前缀的令牌名，去重排序，方便直接比较两个集合。 */
const withPrefix = (names: string[], prefix: string) =>
  [...new Set(names.filter((name) => name.startsWith(prefix)))].sort();

describe('index.css 的令牌两套成对', () => {
  it('@theme 里的每个颜色令牌都在 .dark 里有覆盖，反之亦然', () => {
    const light = withPrefix(customProps('@theme'), '--color-');
    const dark = withPrefix(customProps('.dark'), '--color-');

    // 先确认解析没跑偏：一个令牌都没读到的话，下面那条断言会因为「两边都空」而假通过。
    expect(light.length).toBeGreaterThan(10);
    expect(dark).toEqual(light);
  });

  it('阴影令牌也必须两套成对（它们不在 @theme 里）', () => {
    const light = withPrefix(customProps(':root'), '--shadow-');
    const dark = withPrefix(customProps('.dark'), '--shadow-');

    expect(light.length).toBeGreaterThan(0);
    expect(dark).toEqual(light);
  });

  it('浅色的阴影 :root 排在 .dark 之前', () => {
    // 两条规则都未分层、权重同为 (0,1,0)，后面那条赢。:root 若排到 .dark 之后，
    // html 上的 --shadow-* 会取浅色值，深色阴影静默失效——这是实测踩到过的
    // （整理 index.css 时把 :root 挪到 .dark 下面，浏览器里阴影立刻变回浅色那串）。
    expect(css.indexOf('--shadow-menu')).toBeLessThan(css.indexOf('.dark {'));
  });

  it('每个阴影令牌都有一个同名 @utility 在读它，并且保留与 ring 的组合能力', () => {
    // 阴影不能用 @theme 的 --shadow-*（值会被构建时内联），必须靠 @utility 读运行时变量。
    // 少了对应的 @utility，组件里的 shadow-xxx 会静默变成「没有阴影」。
    for (const name of withPrefix(customProps(':root'), '--shadow-')) {
      const utility = name.replace('--shadow-', 'shadow-');
      const block = css.slice(css.indexOf(`@utility ${utility} {`));
      const body = block.slice(0, block.indexOf('}'));
      expect(body).toContain(`--tw-shadow: var(${name});`);
      // 直接写 box-shadow 会吃掉 ring-*（见 index.css 的注释），所以这条也钉住。
      expect(body).toContain('var(--tw-ring-shadow)');
    }
  });
});
