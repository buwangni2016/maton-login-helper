import { randomAlias } from './lib.js';

export default async function handler(req, res) {
  res.json({ email: randomAlias() });
}
