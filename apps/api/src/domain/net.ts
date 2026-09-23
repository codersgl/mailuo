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

/**
 * Host 头（或 Origin 的 host 部分）里的主机名：转小写、去掉端口与 IPv6 的方括号。
 * `localhost:3003` → `localhost`，`[::1]:3003` → `::1`，`127.0.0.1` → `127.0.0.1`。
 * 判空交给调用方，这里只做切分。
 */
export function hostNameOf(host: string): string {
  const value = host.trim().toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end === -1 ? value : value.slice(1, end);
  }
  const colon = value.indexOf(':');
  return colon === -1 ? value : value.slice(0, colon);
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

/** 通配监听地址：用户显式要求「哪个网卡都收」时用的那两个写法。 */
export function isWildcardHost(host: string): boolean {
  const value = host.trim().toLowerCase();
  return value === '0.0.0.0' || value === '::';
}

/**
 * Host 头是否允许。三道规则，按顺序：
 *
 * 1. 回环主机名永远允许——本地访问（浏览器、Vite 代理、curl）全落在这里。
 * 2. `listenHost` 本身允许——用户把 HOST 设成 `192.168.1.5` 或某台机器名时，
 *    用那个地址访问要能通。
 * 3. `listenHost` 是通配地址时一律允许。这一条是妥协：`0.0.0.0` 下访问方的地址由路由器/DNS 决定，
 *    列不出白名单。它是**显式选择**的结果（默认值不是通配地址），而且此时 API 本来就对同网段
 *    完全敞开，Host 校验已经挡不住什么——真正的解法是加鉴权，不在这一步范围内。
 *
 * 缺失或空的 Host 头一律拒绝：HTTP/1.1 请求必须有 Host。
 */
export function isAllowedHostHeader(hostHeader: string | undefined, listenHost: string): boolean {
  if (hostHeader === undefined) return false;
  const name = hostNameOf(hostHeader);
  if (name === '') return false;
  if (isLoopbackHostName(name)) return true;
  if (name === hostNameOf(listenHost)) return true;
  return isWildcardHost(listenHost);
}

/**
 * 写请求的 Origin 是否允许。读请求不看它：浏览器对跨站读的拦截靠 CORS，而 DNS rebinding
 * 那类同源读已经由 Host 白名单挡住。
 *
 * 允许的三种情形：
 * - Origin 缺失：curl、同源表单、服务端调用都不带它。
 * - Origin 与本次请求的 Host 同主机名：这是浏览器自己保证的「同源」，开发态 Vite 代理
 *   （`changeOrigin: true` 会把 Host 改写成目标地址）也走这条。
 * - Origin 主机本身在 Host 白名单里。
 *
 * `Origin: null`（沙箱 iframe、本地文件）解析失败，直接拒绝。
 */
export function isAllowedOrigin(
  origin: string,
  hostHeader: string | undefined,
  listenHost: string,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (hostHeader !== undefined && hostNameOf(parsed.host) === hostNameOf(hostHeader)) return true;
  return isAllowedHostHeader(parsed.host, listenHost);
}
