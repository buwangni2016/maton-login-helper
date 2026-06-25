import { Redis } from '@upstash/redis';

// Upstash Redis 从环境变量自动读取 UPSTASH_REDIS_REST_URL 和 UPSTASH_REDIS_REST_TOKEN
export function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export const DEFAULT_DOMAIN = process.env.DEFAULT_DOMAIN || 'iosos.cloudns.biz';
export const MATON_BASE_URL = process.env.MATON_BASE_URL || 'https://www.maton.ai';
export const MATON_CALLBACK_BASE_URL = process.env.MATON_CALLBACK_BASE_URL || 'https://maton.ai';

// IMAP 配置
export const IMAP_CONFIG = {
  host: process.env.MAIL_IMAP_HOST || '',
  port: Number(process.env.MAIL_IMAP_PORT || 993),
  secure: true,
  auth: {
    user: process.env.MAIL_USER || '',
    pass: process.env.MAIL_PASSWORD || '',
  },
};

export const MAIL_MAILBOX = process.env.MAIL_MAILBOX || 'INBOX';
export const MAIL_LOOKBACK = Number(process.env.MAIL_LOOKBACK || 20);

// 生成随机邮箱别名
export function randomAlias() {
  const hex = Math.random().toString(16).slice(2, 10);
  return `maton-${hex}@${DEFAULT_DOMAIN}`;
}

export function normalizeAlias(input) {
  const value = String(input || '').trim().toLowerCase();
  if (!value) return randomAlias();
  if (value.includes('@')) return value;
  return `${value.replace(/[^a-z0-9._-]/g, '')}@${DEFAULT_DOMAIN}`;
}

// 提取 Maton 登录链接
export function extractMatonLink(text, alias = '') {
  const normalized = String(text || '')
    .replace(/=\r?\n/g, '')
    .replace(/&amp;/g, '&')
    .replace(/\\u0026/g, '&');
  const marker = `${MATON_CALLBACK_BASE_URL}/api/auth/callback/nodemailer?`;
  const index = normalized.indexOf(marker);
  if (index < 0) return null;
  const link = normalized.slice(index).split(/[\s"'<>]/)[0];
  if (!alias) return link;
  const lowerLink = link.toLowerCase();
  const variants = [alias.toLowerCase(), encodeURIComponent(alias).toLowerCase()];
  return variants.some(v => lowerLink.includes(v)) ? link : null;
}

export function extractMatonLinks(text) {
  const links = [];
  let remaining = String(text || '');
  while (true) {
    const link = extractMatonLink(remaining);
    if (!link) break;
    links.push(link);
    remaining = remaining.slice(remaining.indexOf(link) + link.length);
  }
  return links;
}

export function extractEmailFromMatonLink(link) {
  try {
    const url = new URL(link);
    const direct = url.searchParams.get('email');
    if (direct) return direct.trim().toLowerCase();
    const callbackUrl = url.searchParams.get('callbackUrl') || '';
    const match = decodeURIComponent(callbackUrl).match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
    return match ? match[0].toLowerCase() : null;
  } catch {
    const match = String(link || '').match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
    return match ? decodeURIComponent(match[0]).toLowerCase() : null;
  }
}

// Redis 操作封装
const WAIT_KEY = 'maton:waits';
const EARLY_KEY = 'maton:early';
const WAIT_TTL = 600; // 10 分钟

export async function setWait(email, link = null) {
  const redis = getRedis();
  if (!redis) return;
  await redis.hset(WAIT_KEY, { [email]: JSON.stringify({ link, createdAt: Date.now() }) });
  await redis.expire(WAIT_KEY, WAIT_TTL);
}

export async function getWait(email) {
  const redis = getRedis();
  if (!redis) return null;
  const data = await redis.hget(WAIT_KEY, email);
  return data ? JSON.parse(data) : null;
}

export async function delWait(email) {
  const redis = getRedis();
  if (!redis) return;
  await redis.hdel(WAIT_KEY, email);
}

export async function getAllWaits() {
  const redis = getRedis();
  if (!redis) return {};
  const data = await redis.hgetall(WAIT_KEY);
  if (!data) return {};
  const result = {};
  for (const [k, v] of Object.entries(data)) {
    result[k] = typeof v === 'string' ? JSON.parse(v) : v;
  }
  return result;
}

export async function setEarlyLink(email, link) {
  const redis = getRedis();
  if (!redis) return;
  await redis.hset(EARLY_KEY, { [email]: JSON.stringify({ link, createdAt: Date.now() }) });
  await redis.expire(EARLY_KEY, WAIT_TTL);
}

export async function getEarlyLink(email) {
  const redis = getRedis();
  if (!redis) return null;
  const data = await redis.hget(EARLY_KEY, email);
  return data ? JSON.parse(data) : null;
}

export async function delEarlyLink(email) {
  const redis = getRedis();
  if (!redis) return;
  await redis.hdel(EARLY_KEY, email);
}

export async function getAllEarlyLinks() {
  const redis = getRedis();
  if (!redis) return {};
  const data = await redis.hgetall(EARLY_KEY);
  if (!data) return {};
  const result = {};
  for (const [k, v] of Object.entries(data)) {
    result[k] = typeof v === 'string' ? JSON.parse(v) : v;
  }
  return result;
}

// 请求 Maton 发送登录邮件
export async function requestMagicLink(email) {
  const csrfRes = await fetch(`${MATON_CALLBACK_BASE_URL}/api/auth/csrf`);
  if (!csrfRes.ok) throw new Error(`CSRF failed: HTTP ${csrfRes.status}`);
  const csrfCookie = csrfRes.headers.get('set-cookie') || '';
  const csrf = await csrfRes.json();
  const body = new URLSearchParams({
    email,
    csrfToken: csrf.csrfToken,
    callbackUrl: `${MATON_CALLBACK_BASE_URL}/tasks`,
    json: 'true',
  });
  const res = await fetch(`${MATON_BASE_URL}/api/auth/signin/nodemailer`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: csrfCookie,
    },
    body,
    redirect: 'manual',
  });
  const location = res.headers.get('location') || '';
  if (res.status === 302 && location.includes('/api/auth/verify-request')) return;
  const text = await res.text();
  if (!res.ok) throw new Error(`Sign-in failed: HTTP ${res.status} ${text.slice(0, 200)}`);
}
