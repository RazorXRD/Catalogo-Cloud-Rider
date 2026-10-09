// GET  /api/pedido?top=1                → los 10 títulos más pedidos del mes
// POST /api/pedido {clientId, items:[{k}]} → suma +1 a cada título que el cliente AÑADE a su pedido (1 por cliente, título y día)
const { redis, ipHash, readBody } = require('./_redis');

const ym = d => d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
async function topDe(key) {
  const [r] = await redis([['ZREVRANGE', key, 0, 9, 'WITHSCORES']]);
  const out = []; for (let i = 0; i < (r || []).length; i += 2) out.push({ k: r[i], n: Number(r[i + 1]) });
  return out;
}
module.exports = async (req, res) => {
  try {
    const now = new Date();
    if (req.method === 'GET') {
      let top = await topDe('top:' + ym(now));
      if (top.length < 3) { const p = new Date(now); p.setUTCMonth(p.getUTCMonth() - 1); top = top.concat(await topDe('top:' + ym(p))).slice(0, 10); }
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600'); // casi no toca Redis
      return res.status(200).json({ top });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'método' });
    res.setHeader('Cache-Control', 'no-store');
    const b = readBody(req), cid = String(b.clientId || '');
    if (!/^[\w-]{8,64}$/.test(cid)) return res.status(400).json({ error: 'cliente' });
    const keys = [...new Set((Array.isArray(b.items) ? b.items : []).map(x => String((x && x.k) || '').slice(0, 160)).filter(k => k.includes('|')))].slice(0, 40);
    if (!keys.length) return res.status(200).json({ ok: true, n: 0 });

    const rl = 'ped:ip:' + ipHash(req) + ':' + now.toISOString().slice(0, 13);
    const [c] = await redis([['INCR', rl]]);
    if (c === 1) await redis([['EXPIRE', rl, 3600]]);
    if (c > 200) return res.status(429).json({ error: 'demasiados' });

    const dia = now.toISOString().slice(0, 10);
    const sets = await redis(keys.map(k => ['SET', 'ped:d:' + cid + ':' + dia + ':' + k, '1', 'NX', 'EX', 86400])); // 1 voto por título/cliente/día
    const nuevos = keys.filter((k, i) => sets[i] === 'OK');
    if (nuevos.length) {
      const key = 'top:' + ym(now);
      await redis(nuevos.map(k => ['ZINCRBY', key, 1, k]).concat([['EXPIRE', key, 60 * 60 * 24 * 100]]));
    }
    return res.status(200).json({ ok: true, n: nuevos.length });
  } catch (e) {
    return res.status(500).json({ error: 'servidor' });
  }
};
