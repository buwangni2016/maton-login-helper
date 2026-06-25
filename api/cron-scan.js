import { getAllWaits, getAllEarlyLinks, setEarlyLink, delEarlyLink } from './lib.js';
import { IMAP_CONFIG, MAIL_MAILBOX, MAIL_LOOKBACK, extractMatonLinks, extractEmailFromMatonLink } from './lib.js';

export default async function handler(req, res) {
  // Vercel Cron 请求带 CRON_SECRET_HEADER，验证一下
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!IMAP_CONFIG.host || !IMAP_CONFIG.auth.user || !IMAP_CONFIG.auth.pass) {
    return res.status(200).json({ skipped: true, reason: 'IMAP not configured' });
  }

  const waits = await getAllWaits();
  const waitEmails = Object.keys(waits);

  // 没有等待中的请求，直接返回
  if (waitEmails.length === 0) {
    // 顺便清理过期 earlyLinks
    const earlyLinks = await getAllEarlyLinks();
    const now = Date.now();
    for (const [email, item] of Object.entries(earlyLinks)) {
      if (now - item.createdAt > 10 * 60 * 1000) await delEarlyLink(email);
    }
    return res.status(200).json({ scanned: false, reason: 'no waits', waits: 0 });
  }

  // 连接 IMAP 扫描邮件
  let matched = 0;
  try {
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
        if (total > 0) {
          const start = Math.max(1, total - MAIL_LOOKBACK + 1);
          for await (const message of client.fetch(`${start}:*`, { envelope: true, source: true }, { uid: true })) {
            const subject = message.envelope?.subject || '';
            if (!/maton|sign in/i.test(subject)) continue;

            const parsed = await simpleParser(message.source);
            const text = [parsed.subject, parsed.text, parsed.html].filter(Boolean).join('\n');
            const links = extractMatonLinks(text);

            for (const link of links) {
              const email = extractEmailFromMatonLink(link);
              if (!email) continue;

              // 如果有等待中的请求，匹配上就存
              if (waits[email]) {
                waits[email].link = link;
                waits[email].updatedAt = Date.now();
                await setEarlyLink(email, link);
                matched++;

                // 删除已用邮件
                try {
                  await client.messageDelete(String(message.uid), { uid: true });
                } catch (e) {
                  // 删除失败不影响流程
                }
                break;
              } else {
                // 没匹配的也存 earlyLink，备用
                await setEarlyLink(email, link);
              }
            }
          }
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => {});
    }
  } catch (error) {
    return res.status(200).json({ scanned: true, error: error.message, waits: waitEmails.length, matched });
  }

  res.status(200).json({ scanned: true, waits: waitEmails.length, matched });
}
