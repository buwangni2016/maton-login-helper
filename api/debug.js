// 无状态版 debug，返回固定信息
export default async function handler(req, res) {
  res.json({ 
    mode: 'stateless',
    message: 'No Redis needed. Each poll connects IMAP directly.'
  });
}
