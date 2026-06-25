import { IMAP_CONFIG, MAIL_MAILBOX, MAIL_LOOKBACK, extractMatonLinks, extractEmailFromMatonLink } from './lib.js';

export default async function handler(req, res) {
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!email) {
    return res.status(400).json({ error: 'missing email' });
  }

  console.log('wait-link called for:', email);
  console.log('IMAP_CONFIG:', JSON.stringify({ host: IMAP_CONFIG.host, port: IMAP_CONFIG.port, user: IMAP_CONFIG.auth.user ? 'set' : 'empty' }));

  if (!IMAP_CONFIG.host || !IMAP_CONFIG.auth.user) {
    return res.status(500).json({ error: 'IMAP not configured', host: IMAP_CONFIG.host, user: !!IMAP_CONFIG.auth.user });
  }

  let client;
  try {
    const { ImapFlow } = await import('imapflow');
    const { simpleParser } = await import('mailparser');

    console.log('Connecting to IMAP...', IMAP_CONFIG.host, IMAP_CONFIG.port);

    client = new ImapFlow({
      host: IMAP_CONFIG.host,
      port: IMAP_CONFIG.port,
      secure: IMAP_CONFIG.secure,
      auth: IMAP_CONFIG.auth,
      logger: false,
      socketTimeout: 8000,
      emitLogs: true,
    });

    client.on('error', (err) => console.error('IMAP error:', err.message));

    await client.connect();
    console.log('IMAP connected');

    const lock = await client.getMailboxLock(MAIL_MAILBOX);
    try {
      const total = client.mailbox.exists || 0;
      console.log('Total mails:', total);
      if (total === 0) {
        return res.json({ email, ready: false });
      }

      const start = Math.max(1, total - MAIL_LOOKBACK + 1);
      let checked = 0;
      for await (const message of client.fetch(`${start}:*`, { envelope: true, source: true }, { uid: true })) {
        const subject = message.envelope?.subject || '';
        if (!/maton|sign in/i.test(subject)) continue;
        checked++;
        console.log('Checking mail:', subject);

        const parsed = await simpleParser(message.source);
        const text = [parsed.subject, parsed.text, parsed.html].filter(Boolean).join('\n');
        const links = extractMatonLinks(text);
        console.log('Found links:', links.length);

        for (const link of links) {
          const linkEmail = extractEmailFromMatonLink(link);
          console.log('Link email:', linkEmail, 'vs', email);
          if (linkEmail === email) {
            try { await client.messageDelete(String(message.uid), { uid: true }); } catch (e) {}
            return res.json({ email, link, ready: true });
          }
        }
      }
      console.log('Checked', checked, 'maton mails, no match');
    } finally {
      lock.release();
    }

    res.json({ email, ready: false });
  } catch (error) {
    console.error('wait-link error:', error.message, error.stack);
    res.json({ email, ready: false, error: error.message });
  } finally {
    if (client) {
      try { await client.logout(); } catch (e) {}
    }
  }
}
