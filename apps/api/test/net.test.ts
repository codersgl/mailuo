import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HOST,
  hostNameOf,
  isAllowedHostHeader,
  isAllowedOrigin,
  isLoopbackHostName,
  isWildcardHost,
} from '../src/domain/net.js';

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
    expect(isAllowedHostHeader('127.0.0.1:3003', DEFAULT_HOST)).toBe(true);
    expect(isAllowedHostHeader('localhost:3003', DEFAULT_HOST)).toBe(true);
    expect(isAllowedHostHeader('[::1]:3003', DEFAULT_HOST)).toBe(true);
    expect(isAllowedHostHeader('evil.example', DEFAULT_HOST)).toBe(false);
    expect(isAllowedHostHeader('127.0.0.1.evil.com', DEFAULT_HOST)).toBe(false);
    expect(isAllowedHostHeader('10.32.213.214:3003', DEFAULT_HOST)).toBe(false);
  });

  it('缺失或空 Host 一律拒绝', () => {
    expect(isAllowedHostHeader(undefined, DEFAULT_HOST)).toBe(false);
    expect(isAllowedHostHeader('', DEFAULT_HOST)).toBe(false);
    expect(isAllowedHostHeader('   ', DEFAULT_HOST)).toBe(false);
  });

  it('HOST 设成具体地址时，那个地址也放行', () => {
    expect(isAllowedHostHeader('10.32.213.214:3003', '10.32.213.214')).toBe(true);
    expect(isAllowedHostHeader('kanban.local:3003', 'kanban.local')).toBe(true);
    // 放行的是「这个地址」，不是「任意地址」。
    expect(isAllowedHostHeader('10.32.213.215:3003', '10.32.213.214')).toBe(false);
    expect(isAllowedHostHeader('evil.example', '10.32.213.214')).toBe(false);
  });

  it('HOST 是通配地址时一律放行（用户显式选择的结果）', () => {
    expect(isAllowedHostHeader('evil.example', '0.0.0.0')).toBe(true);
    expect(isAllowedHostHeader('100.65.77.53:3003', '::')).toBe(true);
  });
});

describe('isAllowedOrigin', () => {
  it('同源（Origin 主机 === 请求 Host 主机）放行', () => {
    expect(isAllowedOrigin('http://127.0.0.1:5173', '127.0.0.1:3003', DEFAULT_HOST)).toBe(true);
    expect(isAllowedOrigin('http://localhost:5173', 'localhost:3003', DEFAULT_HOST)).toBe(true);
  });

  it('回环 Origin 在没有 Host 时也放行（开发态 Vite 代理）', () => {
    expect(isAllowedOrigin('http://localhost:5173', undefined, DEFAULT_HOST)).toBe(true);
  });

  it('其它站的 Origin 拒绝', () => {
    expect(isAllowedOrigin('http://evil.example', '127.0.0.1:3003', DEFAULT_HOST)).toBe(false);
    expect(isAllowedOrigin('https://evil.example', '127.0.0.1:3003', DEFAULT_HOST)).toBe(false);
  });

  it('Origin: null 与畸形串拒绝', () => {
    expect(isAllowedOrigin('null', '127.0.0.1:3003', DEFAULT_HOST)).toBe(false);
    expect(isAllowedOrigin('不是 URL', '127.0.0.1:3003', DEFAULT_HOST)).toBe(false);
    expect(isAllowedOrigin('', '127.0.0.1:3003', DEFAULT_HOST)).toBe(false);
  });

  it('非 http(s) 协议的 Origin 拒绝', () => {
    // file:// 页面发来的请求，浏览器给的 Origin 就是这种形态。
    expect(isAllowedOrigin('file://', '127.0.0.1:3003', DEFAULT_HOST)).toBe(false);
    expect(isAllowedOrigin('chrome-extension://abc', '127.0.0.1:3003', DEFAULT_HOST)).toBe(false);
  });

  it('HOST 是通配地址时，Origin 也跟着放宽', () => {
    expect(isAllowedOrigin('http://evil.example', '100.65.77.53:3003', '0.0.0.0')).toBe(true);
  });
});
