import { getWait, delWait, getEarlyLink, delEarlyLink } from './lib.js';
import { scanImapOnce } from './scan.js';

export default async function handler(req, res) {
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!email) {
    return res.status(400).json({ error: '缺少 email 参数' });
  }

  const wait = await getWait(email);

  // 没有 wait，检查 earlyLink
  if (!wait) {
    const cached = await getEarlyLink(email);
    if (cached && Date.now() - cached.createdAt < 10 * 60 * 1000) {
      await delEarlyLink(email);
      return res.json({ email, link: cached.link, ready: true });
    }
    return res.status(404).json({ error: '没有等待中的登录请求' });
  }

  // 超时检查
  if (Date.now() - wait.createdAt > 10 * 60 * 1000) {
    await delWait(email);
    return res.status(410).json({ error: '等待已超时，请重新请求' });
  }

  // 如果还没 link，触发一次 IMAP 扫描
  if (!wait.link) {
    try {
      await scanImapOnce();
    } catch (e) {
      // IMAP 失败不影响流程，继续返回等待
    }

    // 扫描后重新检查 earlyLink
    const cached = await getEarlyLink(email);
    if (cached && Date.now() - cached.createdAt < 10 * 60 * 1000) {
      await delEarlyLink(email);
      wait.link = cached.link;
    }
  }

  const ready = Boolean(wait.link);
  if (ready) await delWait(email);

  res.json({ email, link: wait.link, ready });
}
