import { randomAlias, normalizeAlias, requestMagicLink, setWait, getEarlyLink, delEarlyLink } from './lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const email = normalizeAlias(req.body?.email);
    await requestMagicLink(email);

    // 检查是否已有 earlyLink（之前 cron 已扫到）
    const cached = await getEarlyLink(email);
    await setWait(email, cached?.link || null);
    if (cached) await delEarlyLink(email);

    res.json({ email, sent: true, waiting: true, ready: Boolean(cached?.link) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
