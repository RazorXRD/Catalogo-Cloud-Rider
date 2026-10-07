// POST /api/zombie  {clientId, total}  → sortea la Mano Zombie EN EL SERVIDOR.
const { redis, ipHash, readBody, crypto } = require('./_redis');

const MIN = 2500;                 // el pedido debe superar esto (CUP)
const PROBS = [50, 28, 14, 6, 2]; // % de salir con 1,2,3,4,5 dedos (suman 100). Premio = dedos × 100
const LOCK_SEG = 300;             // misma mano durante 5 min por cliente
const MAX_POR_IP = 12;            // tiradas máximas por IP cada 5 min
const ABC = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST' });
  try {
    const b = readBody(req);
    const cid = String(b.clientId || '');
    const total = Number(b.total) || 0;
    if (!/^[\w-]{8,64}$/.test(cid)) return res.status(400).json({ error: 'cliente' });
    if (!(total > MIN)) return res.status(200).json({ none: true });

    const lockKey = 'zb:lock:' + cid;
    const [saved] = await redis([['GET', lockKey]]);
    if (saved) return res.status(200).json(JSON.parse(saved));

    const ipKey = 'zb:ip:' + ipHash(req);
    const [n] = await redis([['INCR', ipKey]]);
    if (n === 1) await redis([['EXPIRE', ipKey, LOCK_SEG]]);
    if (n > MAX_POR_IP) return res.status(429).json({ error: 'demasiadas' });

    let r = crypto.randomInt(10000) / 100, acc = 0, fingers = 1;
    for (let k = 0; k < PROBS.length; k++) { acc += PROBS[k]; if (r < acc) { fingers = k + 1; break; } }
    const idx = [0, 1, 2, 3, 4];
    for (let a = 4; a > 0; a--) { const j = crypto.randomInt(a + 1); [idx[a], idx[j]] = [idx[j], idx[a]]; }
    let mask = 0; idx.slice(0, fingers).forEach(f => { mask |= (1 << f); });
    let code = 'ZB-'; for (let i = 0; i < 8; i++) code += ABC[crypto.randomInt(ABC.length)];

    const rec = { t: Date.now(), mask, fingers, prize: fingers * 100, code };
    await redis([
      ['SET', lockKey, JSON.stringify(rec), 'EX', LOCK_SEG],
      ['SET', 'zb:code:' + code, JSON.stringify(Object.assign({ total, estado: 'pendiente' }, rec)), 'EX', 60 * 60 * 24 * 30]
    ]);
    return res.status(200).json(rec);
  } catch (e) {
    return res.status(500).json({ error: 'servidor' });
  }
};
