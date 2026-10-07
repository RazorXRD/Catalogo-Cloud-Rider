// POST /api/zombie {clientId, total, envio?, code?}
//  - Sin "envio": sortea (o devuelve) la Mano Zombie cuando el pedido pasa de MIN.
//  - Con "envio": el cliente envía el pedido; la mano queda marcada como enviada (solo una vez).
const { redis, ipHash, readBody, crypto } = require('./_redis');

const MIN = 2500;                 // el pedido debe superar esto (CUP)
const PROBS = [50, 28, 14, 6, 2]; // % de salir con 1,2,3,4,5 dedos (suman 100). Premio = dedos × 100
const LOCK_SEG = 300;             // misma mano durante 5 min por cliente
const MAX_POR_IP = 12;            // tiradas máximas por IP cada 5 min
const ABC = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const pub = r => ({ t: r.t, mask: r.mask, fingers: r.fingers, prize: r.prize, code: r.code });

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST' });
  try {
    const b = readBody(req);
    const cid = String(b.clientId || '');
    const total = Number(b.total) || 0;
    const envio = b.envio === true;
    if (!/^[\w-]{8,64}$/.test(cid)) return res.status(400).json({ error: 'cliente' });
    if (!(total > MIN)) return res.status(200).json({ none: true });

    const lockKey = 'zb:lock:' + cid;
    const marcar = async (rec) => {            // marca la mano como enviada en un pedido
      rec.enviado = true; rec.totalEnvio = total; rec.tEnvio = Date.now();
      await redis([['SET', 'zb:code:' + rec.code, JSON.stringify(rec), 'KEEPTTL']]);
      await redis([['SET', lockKey, JSON.stringify(rec), 'KEEPTTL']]).catch(() => {});
      return res.status(200).json(pub(rec));
    };

    // 1) El cliente ya tiene una mano y la está enviando (aunque hayan pasado los 5 min)
    if (envio && /^ZB-[A-Z0-9]{8}$/.test(String(b.code || ''))) {
      const [raw] = await redis([['GET', 'zb:code:' + b.code]]);
      if (raw) {
        const rec = JSON.parse(raw);
        if (rec.cid === cid) return rec.enviado ? res.status(200).json({ none: true, usada: true }) : marcar(rec);
      }
    }
    // 2) Mano bloqueada por 5 min
    const [saved] = await redis([['GET', lockKey]]);
    if (saved) {
      const s = JSON.parse(saved);
      if (s.enviado) return res.status(200).json({ none: true, espera: true });
      if (!envio) return res.status(200).json(pub(s));
      const [full] = await redis([['GET', 'zb:code:' + s.code]]);
      return marcar(full ? JSON.parse(full) : s);
    }
    // 3) Tirada nueva
    const ipKey = 'zb:ip:' + ipHash(req);
    const [n] = await redis([['INCR', ipKey]]);
    if (n === 1) await redis([['EXPIRE', ipKey, LOCK_SEG]]);
    if (n > MAX_POR_IP) return res.status(429).json({ error: 'demasiadas' });

    const r = crypto.randomInt(10000) / 100; let acc = 0, fingers = 1;
    for (let k = 0; k < PROBS.length; k++) { acc += PROBS[k]; if (r < acc) { fingers = k + 1; break; } }
    const idx = [0, 1, 2, 3, 4];
    for (let a = 4; a > 0; a--) { const j = crypto.randomInt(a + 1); [idx[a], idx[j]] = [idx[j], idx[a]]; }
    let mask = 0; idx.slice(0, fingers).forEach(f => { mask |= (1 << f); });
    let code = 'ZB-'; for (let i = 0; i < 8; i++) code += ABC[crypto.randomInt(ABC.length)];

    const rec = { t: Date.now(), mask, fingers, prize: fingers * 100, code, cid, total, estado: 'pendiente', enviado: false };
    await redis([
      ['SET', lockKey, JSON.stringify(rec), 'EX', LOCK_SEG],
      ['SET', 'zb:code:' + code, JSON.stringify(rec), 'EX', 60 * 60 * 24 * 30]
    ]);
    return envio ? marcar(rec) : res.status(200).json(pub(rec));
  } catch (e) {
    return res.status(500).json({ error: 'servidor' });
  }
};
