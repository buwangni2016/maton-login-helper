import { getAllWaits, getAllEarlyLinks } from './lib.js';

export default async function handler(req, res) {
  const waits = await getAllWaits();
  const earlyLinks = await getAllEarlyLinks();
  res.json({
    waits: Object.entries(waits).map(([email, w]) => ({
      email,
      ageSeconds: Math.round((Date.now() - w.createdAt) / 1000),
      ready: Boolean(w.link),
    })),
    earlyLinks: Object.entries(earlyLinks).map(([email, item]) => ({
      email,
      ageSeconds: Math.round((Date.now() - item.createdAt) / 1000),
    })),
  });
}
