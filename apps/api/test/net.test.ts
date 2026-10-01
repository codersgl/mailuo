import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HOST,
  collectLocalAddresses,
  formatHostForUrl,
  hostNameOf,
  isAllowedHostHeader,
  isAllowedOrigin,
  isLoopbackHostName,
  isLoopbackListenHost,
  isWildcardHost,
  normalizeHostEntry,
  parseHostAllow,
} from '../src/domain/net.js';

/** 默认配置：只服务本机，没有额外放行名单。 */
const LOCAL = { listenHost: DEFAULT_HOST };

describe('hostNameOf', () => {
  it('去掉端口、转小写、脱掉 IPv6 的方括号', () => {
    expect(hostNameOf('127.0.0.1:3003')).toBe('127.0.0.1');
    expect(hostNameOf('LOCALHOST:3003')).toBe('localhost');
    expect(hostNameOf('[::1]:3003')).toBe('::1');
    expect(hostNameOf('[::1]')).toBe('::1');
    expect(hostNameOf('  Example.COM  ')).toBe('example.com');
  });

  it('没有端口时原样返回', () => {
    expect(hostNameOf('example.com')).toBe('example.com');
  });

  it('畸形 authority 一律返回空串（不能按第一个冒号宽容切分）', () => {
    // 端口不是数字：按第一个冒号切会得到 127.0.0.1 并当成回环，一个畸形请求就绕过白名单。
    expect(hostNameOf('127.0.0.1:3003.evil.com')).toBe('');
    expect(hostNameOf('127.0.0.1:3999@evil.com')).toBe('');
    expect(hostNameOf('127.0.0.1:')).toBe('');
    expect(hostNameOf('[::1]:abc')).toBe('');
    // 方括号没闭上：解析不出边界时必须整条拒绝（两种输入走同一个分支，第二个是更短的样例）。
    expect(hostNameOf('[::1')).toBe('');
    expect(hostNameOf('[')).toBe('');
    expect(hostNameOf('evil.com/x')).toBe('');
    expect(hostNameOf('evil.com?x=1')).toBe('');
    expect(hostNameOf('a b')).toBe('');
    // 裸 IPv6 在 Host 头里必须带方括号。
    expect(hostNameOf('::1')).toBe('');
    expect(hostNameOf('a:b:c')).toBe('');
    expect(hostNameOf('')).toBe('');
  });

  it('端口与方括号的残留不能在错误的位置被「部分匹配」成功', () => {
    // 这四条针对同一类缺陷：解析用的是带锚点的正则与严格的段数判断，一旦锚点或段数放宽，
    // 下面这些畸形串就会「部分匹配」通过，被解析成回环主机名——白名单随之失效。
    // 每条的注释写明放宽哪一处会让它漏过去。
    // 去 ^：rest = 'evil:3003'，末尾那截 ':3003' 会匹配上。
    expect(hostNameOf('[::1]evil:3003')).toBe('');
    // 去 $：rest = ':3003x'，前缀那截 ':3003' 会匹配上。
    expect(hostNameOf('[::1]:3003x')).toBe('');
    // 段数判断放宽成「至少两段」：会取前两段当 host:port，得到 127.0.0.1。
    expect(hostNameOf('127.0.0.1:3003:evil')).toBe('');
    // 去 ^：port = 'x3003'，末尾的数字会匹配上。
    expect(hostNameOf('127.0.0.1:x3003')).toBe('');
  });
});

describe('isLoopbackHostName', () => {
  it('认回环地址', () => {
    expect(isLoopbackHostName('127.0.0.1')).toBe(true);
    expect(isLoopbackHostName('127.5.5.5')).toBe(true);
    expect(isLoopbackHostName('localhost')).toBe(true);
    expect(isLoopbackHostName('::1')).toBe(true);
  });

  it('不认伪装成回环的域名', () => {
    // 关键用例：`127.0.0.1.evil.com` 可以被攻击者解析到 127.0.0.1，
    // 一旦它被当成回环，Host 校验就整个失效。
    expect(isLoopbackHostName('127.0.0.1.evil.com')).toBe(false);
    expect(isLoopbackHostName('127.0.0.1.')).toBe(false);
    expect(isLoopbackHostName('192.168.1.5')).toBe(false);
    expect(isLoopbackHostName('::2')).toBe(false);
    expect(isLoopbackHostName('')).toBe(false);
  });

  it('回环正则两头的锚点与八位组位数都要对', () => {
    // 去 ^：以 127.0.0.1 结尾的串会被当成回环。这种域名现实中不合法、浏览器也发不出来，
    // 与 hostNameOf 那几条同属纵深防御（裸客户端能伪造 Host，但它本来就能直接写 127.0.0.1）。
    expect(isLoopbackHostName('evil127.0.0.1')).toBe(false);
    // \d{1,3} 写成 \d：127/8 里带多位八位组的地址被误拒，浏览器访问 http://127.0.0.10:3003 会直接 403
    // ——这个方向是真实可达的（fail-closed，用户看得见）。
    expect(isLoopbackHostName('127.0.0.10')).toBe(true);
    expect(isLoopbackHostName('127.0.100.200')).toBe(true);
  });
});

describe('isLoopbackListenHost', () => {
  it('接受裸 IPv6 写法（Host 头里它带方括号，监听地址里不带）', () => {
    expect(isLoopbackListenHost('::1')).toBe(true);
    expect(isLoopbackListenHost('127.0.0.1')).toBe(true);
    expect(isLoopbackListenHost('localhost')).toBe(true);
    expect(isLoopbackListenHost('0.0.0.0')).toBe(false);
    expect(isLoopbackListenHost('10.32.213.214')).toBe(false);
  });

  it('两端的空白不影响判定（HOST 写成 " ::1 " 也算本机）', () => {
    // 启动链路给 HOST 做过 trim，所以这条只在直接调纯函数时才有区别；但它是函数的既定行为
    // （先 trim 再判定），少了这一步「带空格的 HOST」会被判成非本机监听而多打一条安全警告。
    expect(isLoopbackListenHost(' ::1 ')).toBe(true);
    expect(isLoopbackListenHost(' 127.0.0.1 ')).toBe(true);
    expect(isLoopbackListenHost(' localhost ')).toBe(true);
  });
});

describe('isWildcardHost', () => {
  it('只认 0.0.0.0 与 ::', () => {
    expect(isWildcardHost('0.0.0.0')).toBe(true);
    expect(isWildcardHost('::')).toBe(true);
    expect(isWildcardHost(' 0.0.0.0 ')).toBe(true);
    expect(isWildcardHost('127.0.0.1')).toBe(false);
    expect(isWildcardHost('')).toBe(false);
  });
});

describe('isAllowedHostHeader', () => {
  it('默认（只服务本机）只放行回环主机名', () => {
    expect(isAllowedHostHeader('127.0.0.1:3003', LOCAL)).toBe(true);
    expect(isAllowedHostHeader('localhost:3003', LOCAL)).toBe(true);
    expect(isAllowedHostHeader('[::1]:3003', LOCAL)).toBe(true);
    expect(isAllowedHostHeader('evil.example', LOCAL)).toBe(false);
    expect(isAllowedHostHeader('127.0.0.1.evil.com', LOCAL)).toBe(false);
    expect(isAllowedHostHeader('10.32.213.214:3003', LOCAL)).toBe(false);
  });

  it('畸形 authority 在入口这一层也一律拒绝（纵深防御）', () => {
    // 这几条经浏览器发不出来（URL 解析器先判非法），只有裸 HTTP 客户端能伪造 Host；
    // 而裸客户端本来就能直接写 `Host: 127.0.0.1` 走回环规则。所以这里钉的是纵深防御：
    // 解析层（hostNameOf 的锚点与段数判断）一旦放宽，白名单入口会跟着放行，这几条就是那层的哨兵。
    expect(isAllowedHostHeader('[::1]evil:3003', LOCAL)).toBe(false);
    expect(isAllowedHostHeader('[::1]:3003x', LOCAL)).toBe(false);
    expect(isAllowedHostHeader('127.0.0.1:3003:evil', LOCAL)).toBe(false);
    expect(isAllowedHostHeader('127.0.0.1:x3003', LOCAL)).toBe(false);
  });

  it('缺失或空 Host 一律拒绝', () => {
    expect(isAllowedHostHeader(undefined, LOCAL)).toBe(false);
    expect(isAllowedHostHeader('', LOCAL)).toBe(false);
    expect(isAllowedHostHeader('   ', LOCAL)).toBe(false);
  });

  it('HOST 设成具体地址时，那个地址也放行', () => {
    const options = { listenHost: '10.32.213.214' };

    expect(isAllowedHostHeader('10.32.213.214:3003', options)).toBe(true);
    expect(isAllowedHostHeader('127.0.0.1:3003', options)).toBe(true);
    // 放行的是「这个地址」，不是「任意地址」。
    expect(isAllowedHostHeader('10.32.213.215:3003', options)).toBe(false);
    expect(isAllowedHostHeader('evil.example', options)).toBe(false);
  });

  it('通配监听只放行列进白名单的地址，不是一律放行', () => {
    const options = { listenHost: '0.0.0.0', allowedHosts: ['10.32.213.214', 'kanban.local'] };

    expect(isAllowedHostHeader('10.32.213.214:3003', options)).toBe(true);
    expect(isAllowedHostHeader('kanban.local:3003', options)).toBe(true);
    expect(isAllowedHostHeader('127.0.0.1:3003', options)).toBe(true);
    // 通配监听下访问方地址由路由器/DNS 决定，但攻击者的域名不在枚举结果里。
    expect(isAllowedHostHeader('evil.example', options)).toBe(false);
    expect(isAllowedHostHeader('100.65.77.53:3003', options)).toBe(false);
  });

  it('通配监听且名单为空时，只有回环能过', () => {
    const options = { listenHost: '0.0.0.0' };

    expect(isAllowedHostHeader('127.0.0.1:3003', options)).toBe(true);
    expect(isAllowedHostHeader('10.32.213.214:3003', options)).toBe(false);
    expect(isAllowedHostHeader('evil.example', options)).toBe(false);
  });

  it('IPv6 的监听地址与白名单条目都要能匹配上（裸地址 vs 方括号 Host）', () => {
    // 网卡地址与 HOST 都是裸 IPv6，Host 头里必须带方括号。不归一化就会把 IPv6 客户端全拒掉。
    expect(isAllowedHostHeader('[fd7a:115c:a1e0::d236:4d36]:3003', {
      listenHost: 'fd7a:115c:a1e0::d236:4d36',
    })).toBe(true);
    expect(
      isAllowedHostHeader('[fd7a:115c:a1e0::d236:4d36]:3003', {
        listenHost: '::',
        allowedHosts: ['fd7a:115c:a1e0::d236:4d36'],
      }),
    ).toBe(true);
    expect(
      isAllowedHostHeader('[fd7a:115c:a1e0::d236:4d36]:3003', {
        listenHost: '::',
        allowedHosts: ['[fd7a:115c:a1e0::d236:4d36]:3003'],
      }),
    ).toBe(true);
    // 不在名单里的 IPv6 照样拒。
    expect(
      isAllowedHostHeader('[fd7a:115c:a1e0::9999]:3003', {
        listenHost: '::',
        allowedHosts: ['fd7a:115c:a1e0::d236:4d36'],
      }),
    ).toBe(false);
  });

  it('HOST_ALLOW 里写了畸形条目时，畸形 Host 也不能因此被放行', () => {
    // HOST_ALLOW=x/y 这种笔误会被归一化成空串（hostNameOf 判它含非法字符）。解析失败的 Host 同样是空串：
    // 若「空串要拒」这一步被去掉，两者就会「相等」而放行——一个手写错的条目把白名单开了一个口子。
    const options = { listenHost: '0.0.0.0', allowedHosts: ['x/y'] };

    expect(isAllowedHostHeader('x/y', options)).toBe(false);
    expect(isAllowedHostHeader('a b', options)).toBe(false);
  });
});

describe('normalizeHostEntry / formatHostForUrl', () => {
  it('裸 IPv6 补方括号后再解析，其余走 hostNameOf', () => {
    expect(normalizeHostEntry('fd7a:115c:a1e0::d236:4d36')).toBe('fd7a:115c:a1e0::d236:4d36');
    expect(normalizeHostEntry('::1')).toBe('::1');
    expect(normalizeHostEntry('[fd7a::1]:3003')).toBe('fd7a::1');
    expect(normalizeHostEntry('10.32.213.214')).toBe('10.32.213.214');
    expect(normalizeHostEntry('10.32.213.214:3003')).toBe('10.32.213.214');
    expect(normalizeHostEntry('KanBan.Local')).toBe('kanban.local');
    expect(normalizeHostEntry('evil.com/x')).toBe('');
    expect(normalizeHostEntry('')).toBe('');
  });

  it('渲染成 URL 形式时给 IPv6 补方括号', () => {
    expect(formatHostForUrl('127.0.0.1')).toBe('127.0.0.1');
    expect(formatHostForUrl('::1')).toBe('[::1]');
    expect(formatHostForUrl('fd7a::1')).toBe('[fd7a::1]');
    expect(formatHostForUrl('[fd7a::1]')).toBe('[fd7a::1]');
  });

  it('两端的空白先去干净（HOST_ALLOW 里手写空格是常见笔误）', () => {
    // 先去空白再归一化/渲染。少了这一步，' ::1 ' 会归一化成 ' ::1 '（匹配不上任何 Host），
    // 渲染出来还会变成 '[ ::1 ]' 这种既不像地址也不像 URL 的串。
    expect(normalizeHostEntry(' ::1 ')).toBe('::1');
    expect(normalizeHostEntry(' 10.32.213.214 ')).toBe('10.32.213.214');
    expect(formatHostForUrl(' ::1 ')).toBe('[::1]');
    expect(formatHostForUrl(' 127.0.0.1 ')).toBe('127.0.0.1');
  });
});

describe('isAllowedOrigin', () => {
  it('回环 Origin 放行（本机 dev、Vite 代理 changeOrigin 的主体）', () => {
    // 真实的代理组合是 Host: 127.0.0.1:3003 + Origin: http://localhost:5173，
    // 两者主机名不同，起作用的是「回环」这条规则。
    expect(isAllowedOrigin('http://localhost:5173', LOCAL)).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:5173', LOCAL)).toBe(true);
  });

  it('白名单里的 Origin 放行，其它站的拒绝', () => {
    const options = { listenHost: '0.0.0.0', allowedHosts: ['10.32.213.214'] };

    expect(isAllowedOrigin('http://10.32.213.214:3003', options)).toBe(true);
    expect(isAllowedOrigin('http://evil.example', options)).toBe(false);
    expect(isAllowedOrigin('https://evil.example', LOCAL)).toBe(false);
  });

  it('Origin: null 与畸形串拒绝', () => {
    expect(isAllowedOrigin('null', LOCAL)).toBe(false);
    expect(isAllowedOrigin('不是 URL', LOCAL)).toBe(false);
    expect(isAllowedOrigin('', LOCAL)).toBe(false);
  });

  it('非 http(s) 协议的 Origin 拒绝', () => {
    // file:// 页面发来的请求，浏览器给的 Origin 就是这种形态；
    // chrome-extension 同理。
    expect(isAllowedOrigin('file://', LOCAL)).toBe(false);
    expect(isAllowedOrigin('chrome-extension://abc', LOCAL)).toBe(false);
    // 上面两条其实是被「host 不在白名单」挡住的（host 分别是空串与 abc）。要钉住协议这一层，
    // 输入必须带一个本来会被放行的 host：file://127.0.0.1 的 host 就是回环，协议门一去掉就会放行。
    expect(isAllowedOrigin('file://127.0.0.1', LOCAL)).toBe(false);
    expect(isAllowedOrigin('chrome-extension://127.0.0.1', LOCAL)).toBe(false);
  });

  it('https 的 Origin 要放行（反向代理 + TLS 的部署就是这个形态）', () => {
    // 白名单写成「只认 http」会让所有 https 页面上的写请求 403——功能回退，不是安全收紧。
    expect(isAllowedOrigin('https://127.0.0.1:5173', LOCAL)).toBe(true);
    expect(isAllowedOrigin('https://localhost:3003', LOCAL)).toBe(true);
  });
});

describe('parseHostAllow', () => {
  it('逗号分隔、去空白、丢空项', () => {
    expect(parseHostAllow(undefined)).toEqual([]);
    expect(parseHostAllow('')).toEqual([]);
    expect(parseHostAllow(' , ')).toEqual([]);
    expect(parseHostAllow('kanban.local, 100.65.77.53')).toEqual(['kanban.local', '100.65.77.53']);
  });
});

describe('collectLocalAddresses', () => {
  it('取出所有网卡地址并去重，跳过 undefined', () => {
    const addresses = collectLocalAddresses({
      lo: [{ address: '127.0.0.1' }, { address: '::1' }],
      eth0: [{ address: '10.32.213.214' }],
      down: undefined,
      docker0: [{ address: '10.32.213.214' }, { address: '172.17.0.1' }],
    });

    expect(addresses.sort()).toEqual(['10.32.213.214', '127.0.0.1', '172.17.0.1', '::1'].sort());
  });
});
