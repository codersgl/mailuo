/**
 * Host 与 Origin 的判定：不碰 Hono、不碰数据库，可以单独测（与 `domain/duration.ts` 同一分工）。
 *
 * 为什么需要它：这个 API 没有鉴权（`docs/spec.md` 的「明确排除」里写明了不做账号系统），
 * 所以「谁能访问」只能靠两道门划定边界——**监听地址**（`config.ts` 的 `host`）决定谁能连上，
 * **Host 白名单**决定一个连上来的浏览器页面是不是真的在跟本机 API 说话。
 *
 * 后者挡的是 DNS rebinding：恶意页面把自己的域名先解析到攻击者、再重绑定到 `127.0.0.1`，
 * 浏览器随即认为这个页面与 API 同源，于是既不受 CORS 限制，也能自由发 `Content-Type: application/json`
 * 的写请求。这种请求带的是攻击者的域名，所以 Host 白名单能挡住它。见 `docs/decisions.md` D55。
 */

/**
 * 默认监听地址：只服务本机。
 * 想跨设备访问必须把 `HOST` 显式设成别的值——这是刻意的，默认值不承担「网上谁能读写我的任务」这个决定。
 */
export const DEFAULT_HOST = '127.0.0.1';

/** Host 串里不允许出现的字符：userinfo、路径、转义、空白都是畸形 authority 的信号。 */
const INVALID_HOST_CHARS = /[@/\\%?#\s]/;

/**
 * Host 头（或 Origin 的 host 部分）里的主机名：转小写、去掉端口与 IPv6 的方括号。
 * `localhost:3003` → `localhost`，`[::1]:3003` → `::1`，`127.0.0.1` → `127.0.0.1`。
 *
 * 解析失败一律返回空串，调用方把空串当「不允许」。**不能宽容**：`127.0.0.1:3003.evil.com`
 * 这种 authority 里端口不是数字，若按第一个冒号切分就会得到 `127.0.0.1` 并当成回环——
 * 一个畸形请求就绕过了白名单。同理，裸 IPv6（`::1`）在 Host 头里本来就必须带方括号。
 */
export function hostNameOf(host: string): string {
  const value = host.trim().toLowerCase();
  if (value === '' || INVALID_HOST_CHARS.test(value)) return '';

  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end === -1) return '';
    const rest = value.slice(end + 1);
    if (rest !== '' && !/^:\d{1,5}$/.test(rest)) return '';
    return value.slice(1, end);
  }

  const parts = value.split(':');
  if (parts.length === 1) return parts[0]!;
  if (parts.length === 2) {
    const [name, port] = parts as [string, string];
    return /^\d{1,5}$/.test(port) ? name : '';
  }
  return '';
}

/**
 * 回环地址：`127.0.0.0/8`、`localhost`、`::1`。
 *
 * IPv4 用严格正则而不是 `startsWith('127.')`：后者会放行 `127.0.0.1.evil.com` 这种域名，
 * 而攻击者完全可以把这种域名解析到 127.0.0.1 来做 DNS rebinding——Host 校验就地失效。
 */
const LOOPBACK_IPV4 = /^127(?:\.\d{1,3}){3}$/;

export function isLoopbackHostName(name: string): boolean {
  return name === 'localhost' || name === '::1' || LOOPBACK_IPV4.test(name);
}

/**
 * 监听地址是否指向本机。除了 `hostNameOf` 认得的形式，还要接受裸 IPv6 写法
 * （`HOST=::1` 是合法的 `server.listen` 入参，但它在 Host 头里必须带方括号，
 * 所以 `hostNameOf('::1')` 会返回空串）。启动时的「非本机监听」警告用它判断。
 */
export function isLoopbackListenHost(host: string): boolean {
  return isLoopbackHostName(hostNameOf(host)) || isLoopbackHostName(host.trim().toLowerCase());
}

/** 通配监听地址：用户显式要求「哪个网卡都收」时用的那两个写法。 */
export function isWildcardHost(host: string): boolean {
  const value = host.trim().toLowerCase();
  return value === '0.0.0.0' || value === '::';
}

/** Host 白名单的判定参数。 */
export interface HostAllowOptions {
  /** 监听地址。是回环值时只认回环主机名。 */
  listenHost: string;
  /**
   * 额外放行的主机名。跨设备访问时由启动方填：本机所有网卡地址 + `HOST_ALLOW` 里用户列的名字。
   * 它让通配监听不必「一律放行」，否则 DNS rebinding 那道锁会跟着一起消失。
   */
  allowedHosts?: readonly string[];
}

/**
 * Host 头是否允许。三道规则，按顺序：
 *
 * 1. 回环主机名永远允许——本地访问（浏览器、Vite 代理、curl）全落在这里。
 * 2. `listenHost` 本身允许——用户把 HOST 设成 `192.168.1.5` 或某台机器名时，用那个地址访问要能通。
 * 3. `allowedHosts` 里列出的主机名允许——通配监听（`0.0.0.0`）下访问方用的是本机某个网卡地址，
 *    启动方会把这些地址枚举进来，用户用的机器名/域名自己写进 `HOST_ALLOW`。
 *
 * 缺失、空、或解析失败的 Host 在这里一律拒绝。注意生产链路上 `@hono/node-server` 会在 Host
 * 缺失时用监听地址兜底（纯函数层看不到这一层），所以 HTTP/1.0 无 Host 的请求会被当成监听地址放行。
 */
export function isAllowedHostHeader(
  hostHeader: string | undefined,
  options: HostAllowOptions,
): boolean {
  if (hostHeader === undefined) return false;
  const name = hostNameOf(hostHeader);
  if (name === '') return false;
  if (isLoopbackHostName(name)) return true;
  // 监听地址可能是裸 IPv6（`HOST=::1`），而 Host 头里的 IPv6 必须带方括号，走同一个归一化。
  if (name === normalizeHostEntry(options.listenHost)) return true;
  return matchesAllowedHost(name, options.allowedHosts);
}

/** 写请求的 Origin 是否允许：Origin 的主机名必须落在同一份白名单里。 */
export function isAllowedOrigin(origin: string, options: HostAllowOptions): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return isAllowedHostHeader(parsed.host, options);
}

/**
 * 白名单条目（监听地址、网卡地址、`HOST_ALLOW` 里的项）的归一化。
 *
 * 为什么不能直接用 `hostNameOf`：条目里的 IPv6 是**裸地址**（`os.networkInterfaces()` 给的就是
 * `fd7a:115c:a1e0::d236:4d36` 这种），而 Host 头里的 IPv6 必须带方括号，`hostNameOf` 因此
 * 对裸 IPv6 返回空串。不补这一层的话，`HOST=::` 下所有 IPv6 客户端都会被 403，而
 * `HOST=<具体 IPv6 地址>` 更是连本机都进不来（审阅实测）。
 *
 * 判据是「冒号数量」：裸 IPv6 至少两个冒号（`::1`、`fd7a::1`）；`host:port` 只有一处冒号，
 * 照常交给 `hostNameOf` 去端口。要写带端口的 IPv6 就自己带方括号（`[fd7a::1]:3003`）。
 */
export function normalizeHostEntry(entry: string): string {
  const value = entry.trim();
  if (value === '') return '';
  if (!value.startsWith('[') && value.split(':').length > 2) return hostNameOf(`[${value}]`);
  return hostNameOf(value);
}

/** 把一个监听地址/网卡地址渲染成能拼进 URL 的形式（IPv6 加方括号）。 */
export function formatHostForUrl(host: string): string {
  const value = host.trim();
  return value.includes(':') && !value.startsWith('[') ? `[${value}]` : value;
}

/** 把 `HOST_ALLOW` 的逗号分隔值切成主机名列表，空白项丢掉。 */
export function parseHostAllow(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/** `os.networkInterfaces()` 的形状里我们只关心地址。 */
export interface NetworkInterfaceLike {
  address: string;
}

/**
 * 本机所有网卡地址，去重。通配监听时用它填 Host 白名单：
 * 手机用 `http://192.168.1.5:3003` 访问，Host 就是那个网卡地址，必须在名单里。
 */
export function collectLocalAddresses(
  interfaces: Record<string, NetworkInterfaceLike[] | undefined>,
): string[] {
  const names = new Set<string>();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) names.add(entry.address);
  }
  return [...names];
}

function matchesAllowedHost(name: string, allowed: readonly string[] | undefined): boolean {
  if (allowed === undefined) return false;
  // 条目走 normalizeHostEntry：网卡地址里的 IPv6 是裸形式，不归一化就永远匹配不上。
  return allowed.some((entry) => normalizeHostEntry(entry) === name);
}
