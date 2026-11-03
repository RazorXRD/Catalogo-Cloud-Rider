/* api/tasa.js — Devuelve la tasa del USD (CUP por 1 USD) del mercado informal según elTOQUE.
   Requiere la variable de entorno ELTOQUE_TOKEN en Vercel (el token NUNCA va en index.html).
   Respuesta: { usd: 800, updated: "2026-10-15T18:00:00.000Z", source: "elTOQUE" } */
let cache = { usd: null, t: 0, iso: null };
const TTL = 30 * 60 * 1000; // 30 min: pocas peticiones a elTOQUE (la API limita por clave)

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=86400');
  if (cache.usd && Date.now() - cache.t < TTL) {
    return res.status(200).json({ usd: cache.usd, updated: cache.iso, source: 'elTOQUE' });
  }
  try {
    const token = process.env.ELTOQUE_TOKEN;
    if (!token) throw new Error('Falta ELTOQUE_TOKEN');
    const now = new Date();
    const from = new Date(now.getTime() - 23 * 3600 * 1000);
    const fmt = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
    const url = 'https://tasas.eltoque.com/v1/trmi?date_from=' + encodeURIComponent(fmt(from)) +
                '&date_to=' + encodeURIComponent(fmt(now));
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error('elTOQUE HTTP ' + r.status);
    const j = await r.json();
    const usd = Number(j && j.tasas && j.tasas.USD);
    if (!(usd > 50 && usd < 10000)) throw new Error('Valor de USD inválido');
    cache = { usd, t: Date.now(), iso: now.toISOString() };
    return res.status(200).json({ usd, updated: cache.iso, source: 'elTOQUE' });
  } catch (e) {
    if (cache.usd) { // si falla elTOQUE, se sirve el último valor bueno
      return res.status(200).json({ usd: cache.usd, updated: cache.iso, source: 'elTOQUE', stale: true });
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: 'tasa no disponible' });
  }
};
