import { randomAlias, normalizeAlias, requestMagicLink } from './lib.js';

// 无状态版：不存 wait，只负责发邮件
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const email = normalizeAlias(req.body?.email);
    await requestMagicLink(email);
    res.json({ email, sent: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
