// GET  /api/verificar?code=ZB-XXXX   (cabecera x-admin-key)  → datos de la mano
// POST /api/verificar {code, accion:'canjear'}               → la marca como canjeada (solo una vez)
const { redis, readBody, crypto } = require('./_redis');

const igual = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const admin = process.env.ADMIN_KEY;
  if (!admin || !igual(req.headers['x-admin-key'] || '', admin)) return res.status(401).json({ error: 'clave' });
  try {
    const b = req.method === 'POST' ? readBody(req) : req.query || {};
    const code = String(b.code || '').trim().toUpperCase();
    if (!/^ZB-[A-Z0-9]{8}$/.test(code)) return res.status(400).json({ error: 'formato' });
    const key = 'zb:code:' + code;
    const [raw] = await redis([['GET', key]]);
    if (!raw) return res.status(404).json({ error: 'no existe o ya venció (30 días)' });
    const rec = JSON.parse(raw);
    if (req.method === 'POST' && b.accion === 'canjear') {
      if (rec.estado === 'canjeado') { delete rec.cid; return res.status(409).json({ error: 'ya canjeado', rec }); }
      rec.estado = 'canjeado'; rec.canjeado = Date.now();
      await redis([['SET', key, JSON.stringify(rec), 'KEEPTTL']]);
    }
    delete rec.cid;
    return res.status(200).json(rec);
  } catch (e) {
    return res.status(500).json({ error: 'servidor' });
  }
};
