import { getAllWaits, getAllEarlyLinks, setEarlyLink, delEarlyLink, getWait, delWait } from './lib.js';
import { IMAP_CONFIG, MAIL_MAILBOX, MAIL_LOOKBACK, extractMatonLinks, extractEmailFromMatonLink } from './lib.js';

// 短连接扫描 IMAP，匹配到就存 earlyLink
export async function scanImapOnce() {
  if (!IMAP_CONFIG.host || !IMAP_CONFIG.auth.user || !IMAP_CONFIG.auth.pass) {
    return { scanned: false, matched: 0 };
  }

  const waits = await getAllWaits();
  const waitEmails = Object.keys(waits);
  if (waitEmails.length === 0) {
    // 清理过期 earlyLinks
    const earlyLinks = await getAllEarlyLinks();
    const now = Date.now();
    for (const [email, item] of Object.entries(earlyLinks)) {
      if (now - item.createdAt > 10 * 60 * 1000) await delEarlyLink(email);
    }
    return { scanned: false, matched: 0 };
  }

  let matched = 0;
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

            if (waits[email]) {
              await setEarlyLink(email, link);
              matched++;
              // 删除已用邮件
              try {
                await client.messageDelete(String(message.uid), { uid: true });
              } catch (e) {}
              break;
            } else {
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

  return { scanned: true, matched };
}
