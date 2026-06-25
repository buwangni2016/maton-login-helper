import { extractMatonLink, extractEmailFromMatonLink } from './lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const email = String(req.body?.email || '').trim().toLowerCase();
  const link = extractMatonLink(req.body?.text, email);
  if (!link) {
    return res.status(400).json({ error: '没有找到匹配的 Maton 登录链接' });
  }
  res.json({ link });
}
