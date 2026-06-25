import { randomAlias, normalizeAlias, requestMagicLink, extractMatonLink, extractMatonLinks, extractEmailFromMatonLink } from './lib.js';

// 无状态版：不需要 Redis，每次请求直接查 IMAP

export default async function handler(req, res) {
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!email) {
    return res.status(400).json({ error: '缺少 email 参数' });
  }

  // 直接连 IMAP 查邮件
  try {
    const { IMAP_CONFIG, MAIL_MAILBOX, MAIL_LOOKBACK } = await import('./lib.js');
    
    if (!IMAP_CONFIG.host || !IMAP_CONFIG.auth.user) {
      return res.status(500).json({ error: 'IMAP not configured' });
    }

    const { ImapFlow } = await import('imapflow');
    const { simpleParser } = await import('mailparser');

    const client = new ImapFlow({
      host: IMAP_CONFIG.host,
      port: IMAP_CONFIG.port,
      secure: IMAP_CONFIG.secure,
      auth: IMAP_CONFIG.auth,
      logger: false,
    });

    await client.connect();

    try {
      const lock = await client.getMailboxLock(MAIL_MAILBOX);
      try {
        const total = client.mailbox.exists || 0;
        if (total === 0) {
          return res.json({ email, ready: false });
        }

        const start = Math.max(1, total - MAIL_LOOKBACK + 1);
        for await (const message of client.fetch(`${start}:*`, { envelope: true, source: true }, { uid: true })) {
          const subject = message.envelope?.subject || '';
          if (!/maton|sign in/i.test(subject)) continue;

          const parsed = await simpleParser(message.source);
          const text = [parsed.subject, parsed.text, parsed.html].filter(Boolean).join('\n');
          const links = extractMatonLinks(text);

          for (const link of links) {
            const linkEmail = extractEmailFromMatonLink(link);
            if (linkEmail === email) {
              // 匹配到了！删除邮件并返回链接
              try {
                await client.messageDelete(String(message.uid), { uid: true });
              } catch (e) {}
              return res.json({ email, link, ready: true });
            }
          }
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => {});
    }

    // 没找到匹配的链接
    res.json({ email, ready: false });
  } catch (error) {
    res.json({ email, ready: false, error: error.message });
  }
}
