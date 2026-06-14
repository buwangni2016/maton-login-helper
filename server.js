const crypto = require('crypto');
const path = require('path');
const express = require('express');
require('dotenv').config();

// Prevent unhandled errors from crashing the process
process.on('uncaughtException', (err) => {
  console.error(`[FATAL] Uncaught exception: ${err.message}\n${err.stack}`);
});
process.on('unhandledRejection', (err) => {
  console.error(`[FATAL] Unhandled rejection: ${err && err.message || err}`);
});

const app = express();
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || process.env.BIND_HOST || '127.0.0.1';
const defaultDomain = process.env.DEFAULT_DOMAIN || 'iosos.cloudns.biz';
const matonBaseUrl = process.env.MATON_BASE_URL || 'https://www.maton.ai';
const matonCallbackBaseUrl = process.env.MATON_CALLBACK_BASE_URL || 'https://maton.ai';
const matonFallbackUrl = process.env.MATON_FALLBACK_URL || 'https://maton.ai';
const mailListen = ['1', 'true', 'yes', 'on'].includes(String(process.env.MAIL_LISTEN || '').toLowerCase());
const mailHost = process.env.MAIL_IMAP_HOST || '';
const mailPort = Number(process.env.MAIL_IMAP_PORT || 993);
const mailSecure = !['0', 'false', 'no', 'off'].includes(String(process.env.MAIL_IMAP_SECURE || 'true').toLowerCase());
const mailUser = process.env.MAIL_USER || '';
const mailPassword = process.env.MAIL_PASSWORD || '';
const mailMailbox = process.env.MAIL_MAILBOX || 'INBOX';
const mailPollSeconds = Number(process.env.MAIL_POLL_SECONDS || 5);
const mailLookback = Number(process.env.MAIL_LOOKBACK || 20);
const telegramListen = ['1', 'true', 'yes', 'on'].includes(String(process.env.TELEGRAM_LISTEN || '').toLowerCase());
const telegramApiId = Number(process.env.TELEGRAM_API_ID || 0);
const telegramApiHash = process.env.TELEGRAM_API_HASH || '';
const telegramSession = process.env.TELEGRAM_SESSION || '';
const telegramSourceUsername = String(process.env.TELEGRAM_SOURCE_USERNAME || '').replace(/^@/, '').toLowerCase();
const telegramProxyHost = process.env.TELEGRAM_PROXY_HOST || '';
const telegramProxyPort = Number(process.env.TELEGRAM_PROXY_PORT || 0);
const telegramProxySocksType = Number(process.env.TELEGRAM_PROXY_SOCKS_TYPE || 5);

app.use(express.json({ limit: '512kb' }));
app.use(express.text({ type: ['text/*'], limit: '512kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const waits = new Map();
const earlyLinks = new Map();
const recentNotifications = [];
const processedMailUids = new Set();
const processedMailLinks = new Set();
const maxProcessedMailItems = 200;
const telegramLogin = {
  prompt: null,
  value: null,
  resolver: null,
  session: '',
  enabled: telegramListen,
  connected: false,
  error: null,
  client: null,
};

function randomAlias() {
  return `maton-${crypto.randomBytes(4).toString('hex')}@${defaultDomain}`;
}

function normalizeAlias(input) {
  const value = String(input || '').trim().toLowerCase();
  if (!value) return randomAlias();
  if (value.includes('@')) return value;
  return `${value.replace(/[^a-z0-9._-]/g, '')}@${defaultDomain}`;
}

function extractMatonLink(text, alias = '') {
  const normalized = String(text || '')
    .replace(/=\r?\n/g, '')
    .replace(/&amp;/g, '&')
    .replace(/\\u0026/g, '&');
  const marker = `${matonCallbackBaseUrl}/api/auth/callback/nodemailer?`;
  const index = normalized.indexOf(marker);
  if (index < 0) return null;
  const link = normalized.slice(index).split(/[\s"'<>]/)[0];
  if (!alias) return link;
  const lowerLink = link.toLowerCase();
  const variants = [alias.toLowerCase(), encodeURIComponent(alias).toLowerCase()];
  return variants.some(value => lowerLink.includes(value)) ? link : null;
}

function extractEmailFromMatonLink(link) {
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

async function collectMessageParts(message) {
  const parts = [message?.message || ''];
  const buttonSummaries = [];
  const entitySummaries = [];

  if (message?.entities?.length) {
    const body = message?.message || '';
    for (const entity of message.entities) {
      const url = entity.url || entity.webpage?.url;
      const sliced = typeof entity.offset === 'number' && typeof entity.length === 'number'
        ? body.slice(entity.offset, entity.offset + entity.length)
        : '';
      entitySummaries.push({
        className: entity.className || entity.constructor?.name || null,
        offset: entity.offset,
        length: entity.length,
        url: url || '',
        text: sliced,
      });
      if (url) parts.push(url);
      if (/^https?:\/\//i.test(sliced)) parts.push(sliced);
    }
  }

  const buttons = await message.getButtons?.().catch(() => null);
  for (const row of buttons || []) {
    for (const button of row || []) {
      const text = button.text || '';
      const url = button.url || button.button?.url || '';
      buttonSummaries.push({ text, url, className: button.button?.className || button.button?.constructor?.name || null });
      if (text) parts.push(text);
      if (url) parts.push(url);
    }
  }

  if (message?.replyMarkup?.rows?.length) {
    for (const row of message.replyMarkup.rows) {
      for (const button of row.buttons || []) {
        if (button.url) parts.push(button.url);
        if (button.text) parts.push(button.text);
      }
    }
  }

  return { text: parts.filter(Boolean).join('\n'), buttons, buttonSummaries, entitySummaries };
}

function shouldClickMailButton(button) {
  const haystack = `${button.text || ''} ${button.url || ''} ${button.button?.url || ''}`.toLowerCase();
  return /邮件|邮箱|查看|打开|详情|sign|maton|login|mail/.test(haystack);
}

function handleNotificationText(text, source = 'manual', meta = {}) {
  const matched = [];
  const generalLink = extractMatonLink(text);
  const cachedEmail = generalLink ? extractEmailFromMatonLink(generalLink) : null;
  if (generalLink && cachedEmail) {
    earlyLinks.set(cachedEmail, { link: generalLink, createdAt: Date.now(), source });
  }
  const hasMatonMarker = String(text || '').includes(`${matonCallbackBaseUrl}/api/auth/callback/nodemailer?`);
  const hasMatonDomain = /(^|[^a-z0-9.-])(?:https?:\/\/)?(?:www\.)?maton\.ai(?:\b|\/)/i.test(String(text || ''));
  for (const [email, wait] of waits.entries()) {
    const link = extractMatonLink(text, email);
    if (link) {
      wait.link = link;
      wait.updatedAt = Date.now();
      wait.source = source;
      matched.push(email);
      continue;
    }
    if (!wait.link && hasMatonDomain) {
      wait.fallbackLink = matonFallbackUrl;
      wait.fallbackSource = `${source}-fallback`;
      wait.updatedAt = Date.now();
    }
  }
  const event = {
    at: new Date().toISOString(),
    source,
    hasMatonMarker,
    hasMatonDomain,
    matched,
    cachedEmail,
    buttons: meta.buttons || [],
    entities: meta.entities || [],
    waitingEmails: Array.from(waits.keys()),
    preview: String(text || '').replace(/\s+/g, ' ').slice(0, 160),
  };
  recentNotifications.unshift(event);
  recentNotifications.splice(20);
  console.log(`Notification ${source}: marker=${hasMatonMarker} matched=${matched.length} waiting=${waits.size}`);
  if (matched.length) {
    console.log(`Matched Maton link from ${source}: ${matched.join(', ')}`);
  }
  return matched;
}

function rememberBounded(set, value, maxItems = maxProcessedMailItems) {
  if (!value) return;
  set.add(value);
  while (set.size > maxItems) {
    set.delete(set.values().next().value);
  }
}

async function deleteMailByUid(client, uid) {
  if (!uid) return;
  try {
    await client.messageDelete(String(uid), { uid: true });
    console.log(`Deleted used Maton mail UID ${uid}`);
  } catch (error) {
    console.warn(`Failed to delete used Maton mail UID ${uid}: ${error.message}`);
  }
}

function extractMatonLinks(text) {
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

function waitForTelegramInput(prompt) {
  telegramLogin.prompt = prompt;
  telegramLogin.value = null;
  console.log(`Waiting for ${prompt} from web UI`);
  return new Promise(resolve => {
    telegramLogin.resolver = value => {
      telegramLogin.prompt = null;
      telegramLogin.value = null;
      telegramLogin.resolver = null;
      resolve(value);
    };
  });
}

function upsertEnvValue(key, value) {
  const envPath = path.join(__dirname, '.env');
  let lines = [];
  try {
    lines = require('fs').readFileSync(envPath, 'utf8').split(/\r?\n/);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let replaced = false;
  lines = lines.map(line => {
    if (!line.startsWith(`${key}=`)) return line;
    replaced = true;
    return `${key}=${value}`;
  });
  if (!replaced) lines.push(`${key}=${value}`);
  require('fs').writeFileSync(envPath, lines.filter((line, index, arr) => line || index < arr.length - 1).join('\n') + '\n');
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function requestMagicLink(email) {
  const csrfPage = await fetchWithTimeout(`${matonCallbackBaseUrl}/api/auth/csrf`);
  if (!csrfPage.ok) throw new Error(`Maton CSRF failed: HTTP ${csrfPage.status}`);
  const csrfCookie = csrfPage.headers.get('set-cookie') || '';
  const csrf = await csrfPage.json();
  const body = new URLSearchParams({
    email,
    csrfToken: csrf.csrfToken,
    callbackUrl: `${matonCallbackBaseUrl}/tasks`,
    json: 'true',
  });
  const response = await fetchWithTimeout(`${matonBaseUrl}/api/auth/signin/nodemailer`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: csrfCookie,
    },
    body,
    redirect: 'manual',
  });
  const location = response.headers.get('location') || '';
  if (response.status === 302 && location.includes('/api/auth/verify-request')) return;
  const text = await response.text();
  if (!response.ok) throw new Error(`Maton sign-in failed: HTTP ${response.status} ${text.slice(0, 200)}`);
}

async function scanMailboxForMatonLinks() {
  if (!mailListen || !mailHost || !mailUser || !mailPassword) return;
  const { ImapFlow } = require('imapflow');
  const { simpleParser } = require('mailparser');
  const client = new ImapFlow({
    host: mailHost,
    port: mailPort,
    secure: mailSecure,
    auth: { user: mailUser, pass: mailPassword },
    logger: false,
  });
  client.on('error', (err) => {
    console.warn(`[IMAP] Connection error: ${err.message}`);
  });
  await client.connect();
  try {
    const lock = await client.getMailboxLock(mailMailbox);
    try {
      const total = client.mailbox.exists || 0;
      if (!total) return;
      const start = Math.max(1, total - mailLookback + 1);
      for await (const message of client.fetch(`${start}:*`, { envelope: true, source: true }, { uid: true })) {
        const uidKey = `${mailMailbox}:${message.uid}`;
        if (processedMailUids.has(uidKey)) continue;
        const subject = message.envelope?.subject || '';
        if (!/maton|sign in/i.test(subject)) continue;
        const parsed = await simpleParser(message.source);
        const text = [parsed.subject, parsed.text, parsed.html].filter(Boolean).join('\n');
        const links = extractMatonLinks(text);
        if (links.length && links.every(link => processedMailLinks.has(link))) {
          rememberBounded(processedMailUids, uidKey);
          continue;
        }
        const matched = handleNotificationText(text, 'imap');
        if (matched.length) {
          rememberBounded(processedMailUids, uidKey);
          for (const link of links) rememberBounded(processedMailLinks, link);
          await deleteMailByUid(client, message.uid);
          return;
        }
        rememberBounded(processedMailUids, uidKey);
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

function startMailPolling() {
  if (!mailListen) return;
  if (!mailHost || !mailUser || !mailPassword) {
    console.warn('Mail polling disabled: MAIL_IMAP_HOST/MAIL_USER/MAIL_PASSWORD missing');
    return;
  }
  console.log(`Mail polling enabled for ${mailUser} every ${mailPollSeconds}s`);
  let running = false;
  const tick = async () => {
    if (running || waits.size === 0) return;
    running = true;
    try {
      await scanMailboxForMatonLinks();
    } catch (error) {
      console.warn(`Mail polling failed: ${error.message}`);
    } finally {
      running = false;
    }
  };
  setInterval(tick, Math.max(1, mailPollSeconds) * 1000);
  tick();
}

app.get('/api/random-alias', (req, res) => {
  res.json({ email: randomAlias() });
});

app.post('/api/send-login-email', async (req, res) => {
  try {
    const email = normalizeAlias(req.body.email);
    await requestMagicLink(email);
    const cached = earlyLinks.get(email);
    waits.set(email, { createdAt: Date.now(), link: cached?.link || null, source: cached?.source || null });
    if (cached) earlyLinks.delete(email);
    res.json({ email, sent: true, waiting: true, ready: Boolean(cached?.link) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/wait-link', (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  const wait = waits.get(email);
  if (!wait) {
    const cached = earlyLinks.get(email);
    if (cached && Date.now() - cached.createdAt <= 10 * 60 * 1000) {
      earlyLinks.delete(email);
      waits.set(email, { createdAt: Date.now(), link: cached.link, source: cached.source });
      res.json({ email, link: cached.link, ready: true });
      return;
    }
    res.status(404).json({ error: '这个邮箱没有等待中的登录请求' });
    return;
  }
  if (!wait.link) {
    const cached = earlyLinks.get(email);
    if (cached && Date.now() - cached.createdAt <= 10 * 60 * 1000) {
      earlyLinks.delete(email);
      wait.link = cached.link;
      wait.source = cached.source;
      wait.updatedAt = Date.now();
    }
  }
  if (Date.now() - wait.createdAt > 10 * 60 * 1000) {
    waits.delete(email);
    res.status(410).json({ error: '等待已超时，请重新请求登录邮件' });
    return;
  }
  res.json({
    email,
    link: wait.link,
    ready: Boolean(wait.link),
    fallbackLink: wait.fallbackLink || null,
    fallbackReady: Boolean(wait.fallbackLink),
  });
});

app.get('/api/telegram-login/status', (req, res) => {
  res.json({
    enabled: telegramLogin.enabled,
    connected: telegramLogin.connected,
    prompt: telegramLogin.prompt,
    error: telegramLogin.error,
    hasSession: Boolean(telegramSession || telegramLogin.session),
  });
});

app.get('/api/debug', (req, res) => {
  res.json({
    waits: Array.from(waits.entries()).map(([email, wait]) => ({
      email,
      ageSeconds: Math.round((Date.now() - wait.createdAt) / 1000),
      ready: Boolean(wait.link),
      source: wait.source || null,
    })),
    earlyLinks: Array.from(earlyLinks.entries()).map(([email, item]) => ({
      email,
      ageSeconds: Math.round((Date.now() - item.createdAt) / 1000),
      source: item.source,
    })),
    recentNotifications,
    telegram: {
      enabled: telegramLogin.enabled,
      connected: telegramLogin.connected,
      prompt: telegramLogin.prompt,
      error: telegramLogin.error,
      sourceUsername: telegramSourceUsername || null,
    },
  });
});

app.get('/api/telegram-history', async (req, res) => {
  try {
    if (!telegramLogin.client || !telegramLogin.connected) {
      res.status(409).json({ error: 'Telegram listener not connected' });
      return;
    }
    const entityName = telegramSourceUsername || 'nodeseek_mail_bot';
    const entity = await telegramLogin.client.getEntity(entityName);
    const messages = await telegramLogin.client.getMessages(entity, { limit: Number(req.query.limit || 10) });
    const result = [];
    for (const message of messages) {
      const { text, buttonSummaries, entitySummaries } = await collectMessageParts(message);
      result.push({
        id: message.id,
        date: message.date,
        text: text.replace(/\s+/g, ' ').slice(0, 500),
        buttons: buttonSummaries,
        entities: entitySummaries,
        hasReplyMarkup: Boolean(message.replyMarkup),
      });
    }
    res.json({ entity: entityName, messages: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/telegram-login/input', (req, res) => {
  const value = String(req.body.value || '').trim();
  if (!telegramLogin.resolver || !telegramLogin.prompt) {
    res.status(409).json({ error: '当前没有等待中的 Telegram 登录输入' });
    return;
  }
  if (!value) {
    res.status(400).json({ error: '输入不能为空' });
    return;
  }
  telegramLogin.resolver(value);
  res.json({ ok: true });
});

app.post('/api/notify', (req, res) => {
  const text = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
  const matched = handleNotificationText(text, 'http-notify');
  res.json({ matched, matchedCount: matched.length });
});

app.post('/api/extract-link', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const link = extractMatonLink(req.body.text, email);
  if (!link) {
    res.status(400).json({ error: '没有从粘贴内容中找到匹配的 Maton 登录链接' });
    return;
  }
  res.json({ link });
});

async function startTelegramListener() {
  if (!telegramListen) return;
  if (!telegramApiId || !telegramApiHash) {
    console.warn('Telegram listener disabled: TELEGRAM_API_ID/TELEGRAM_API_HASH missing');
    return;
  }

  const { TelegramClient } = require('telegram');
  const { StringSession } = require('telegram/sessions');
  const { NewMessage } = require('telegram/events');
  const proxy = telegramProxyHost && telegramProxyPort ? {
    ip: telegramProxyHost,
    port: telegramProxyPort,
    socksType: telegramProxySocksType,
    timeout: 10,
  } : undefined;
  const client = new TelegramClient(new StringSession(telegramSession), telegramApiId, telegramApiHash, {
    connectionRetries: 5,
    proxy,
  });

  await client.start({
    phoneNumber: async () => waitForTelegramInput('phoneNumber'),
    password: async () => waitForTelegramInput('password'),
    phoneCode: async () => waitForTelegramInput('phoneCode'),
    onError: error => {
      telegramLogin.error = error.message;
      console.error('Telegram login error:', error.message);
    },
  });

  telegramLogin.connected = true;
  telegramLogin.error = null;
  telegramLogin.client = client;
  const session = client.session.save();
  if (!telegramSession && session) {
    telegramLogin.session = session;
    upsertEnvValue('TELEGRAM_SESSION', session);
    console.log('Telegram session saved to .env');
  }

  client.addEventHandler(async event => {
    const message = event.message;

    if (telegramSourceUsername) {
      const sender = await message.getSender();
      const username = String(sender?.username || '').toLowerCase();
      if (username !== telegramSourceUsername) return;
    }

    const { text, buttons, buttonSummaries, entitySummaries } = await collectMessageParts(message);
    if (text) handleNotificationText(text, 'telegram', { buttons: buttonSummaries, entities: entitySummaries });

    for (const row of buttons || []) {
      for (const button of row || []) {
        if (!shouldClickMailButton(button)) continue;
        try {
          console.log(`Clicking NodeSeek mail button: ${button.text || button.url || 'unnamed'}`);
          const result = await button.click({});
          if (typeof result === 'string') handleNotificationText(result, 'telegram-button-result', { buttons: buttonSummaries });
          return;
        } catch (error) {
          console.warn(`NodeSeek mail button click failed: ${error.message}`);
        }
      }
    }
  }, new NewMessage({}));

  console.log('Telegram listener enabled for Maton mail notifications');
}

app.listen(port, host, () => {
  const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  console.log(`Maton login helper: http://${displayHost}:${port}`);
  startMailPolling();
  startTelegramListener().catch(error => {
    console.error('Telegram listener failed:', error.message);
  });
});
