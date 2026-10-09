// POST /api/ia {q}  → {filtros:{...}, respuesta}
// La IA SOLO traduce el pedido a filtros; el catálogo se busca en la página (nunca inventa títulos).
// Proveedores gratis/baratos (usa el que tengas configurado en Vercel → Environment Variables):
//   GROQ_API_KEY · GEMINI_API_KEY · OPENROUTER_API_KEY · DEEPSEEK_API_KEY   (opcional: IA_PROVIDER, IA_MODEL)
const { redis, ipHash, readBody } = require('./_redis');

const SITIOS = (process.env.IA_ORIGINS || 'catalogo-cloud-rider.vercel.app').split(',').map(s => s.trim()).filter(Boolean);
const POR_MIN = 8, POR_DIA = 80, GLOBAL_DIA = Number(process.env.IA_DIA_MAX || 800);
const GENEROS = ['accion', 'aventura', 'ciencia ficcion', 'fantasia', 'terror', 'comedia', 'romance', 'drama', 'suspense', 'crimen', 'misterio', 'animacion', 'familia', 'belica', 'historia', 'musica', 'western', 'documental'];
const TIPOS = ['peliculas', 'series', 'animes', 'animados', 'doramas', 'novelas', 'juegos'];

const PROMPT = `Eres el motor de búsqueda de un catálogo de películas, series, anime, animados, doramas, novelas y juegos.
El cliente escribe lo que quiere ver. Responde SOLO con un objeto JSON (sin texto extra) con estas claves:
{"tipos":[], "generos":[], "palabras":[], "estricto":false, "excluir_generos":[], "excluir_palabras":[], "desde":null, "hasta":null, "min_nota":null, "respuesta":""}
- tipos: subconjunto de ${TIPOS.join(', ')} (vacío si no especifica).
- generos y excluir_generos: subconjunto de ${GENEROS.join(', ')}.
- palabras: 3 a 10 palabras en español (sin tildes, minúsculas) que aparecerían en la sinopsis de lo que pide (ej. catástrofes: terremoto, volcan, tsunami, meteorito, apocalipsis, supervivientes).
- estricto: true si pide un tema muy concreto (dinosaurios, zombis, tiburones, boda...) que debe aparecer en la sinopsis; false si es solo un género o ambiente.
- excluir_palabras: lo que NO quiere (ej. "sin zombis" -> ["zombi","zombie"]).
- desde/hasta: años (ej. "de los 90" -> 1990 y 1999; "recientes" -> 2022 y null).
- min_nota: 7.5 si pide "las mejores/mejor valoradas", si no null.
- respuesta: una frase corta y amable en español (máximo 15 palabras), sin nombrar títulos.`;

const lista = (a, ok, max) => (Array.isArray(a) ? a : []).map(x => String(x || '').toLowerCase().trim()).filter(x => x && (!ok || ok.includes(x))).slice(0, max);
const anio = v => { const n = parseInt(v, 10); return n >= 1920 && n <= 2035 ? n : null; };
function limpiar(o) {
  const nota = Number(o.min_nota);
  return {
    tipos: lista(o.tipos, TIPOS, 4), gen: lista(o.generos, GENEROS, 4),
    kw: lista(o.palabras, null, 10).map(s => s.slice(0, 24)), need: o.estricto === true,
    exGen: lista(o.excluir_generos, GENEROS, 4), exKw: lista(o.excluir_palabras, null, 6).map(s => s.slice(0, 24)),
    desde: anio(o.desde), hasta: anio(o.hasta), minNota: nota >= 5 && nota <= 9.5 ? nota : null
  };
}
const extraer = t => { const m = String(t || '').match(/\{[\s\S]*\}/); if (!m) throw new Error('sin json'); return JSON.parse(m[0]); };

async function llamar(q) {
  const E = process.env, prov = E.IA_PROVIDER || (E.GROQ_API_KEY ? 'groq' : E.GEMINI_API_KEY ? 'gemini' : E.OPENROUTER_API_KEY ? 'openrouter' : E.DEEPSEEK_API_KEY ? 'deepseek' : '');
  if (!prov) return null;
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 7000);
  try {
    if (prov === 'gemini') {
      const model = E.IA_MODEL || 'gemini-2.0-flash';
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
        method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': E.GEMINI_API_KEY },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: PROMPT }] }, contents: [{ role: 'user', parts: [{ text: q }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 400, responseMimeType: 'application/json' } })
      });
      if (!r.ok) throw new Error('gemini ' + r.status);
      const j = await r.json(); return extraer(j.candidates[0].content.parts[0].text);
    }
    const cfg = {
      groq: ['https://api.groq.com/openai/v1/chat/completions', E.GROQ_API_KEY, 'llama-3.1-8b-instant'],
      openrouter: ['https://openrouter.ai/api/v1/chat/completions', E.OPENROUTER_API_KEY, 'deepseek/deepseek-chat-v3-0324:free'],
      deepseek: ['https://api.deepseek.com/chat/completions', E.DEEPSEEK_API_KEY, 'deepseek-chat']
    }[prov];
    if (!cfg || !cfg[1]) return null;
    const r = await fetch(cfg[0], {
      method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg[1] },
      body: JSON.stringify({ model: E.IA_MODEL || cfg[2], temperature: 0.2, max_tokens: 400, messages: [{ role: 'system', content: PROMPT }, { role: 'user', content: q }] })
    });
    if (!r.ok) throw new Error(prov + ' ' + r.status);
    const j = await r.json(); return extraer(j.choices[0].message.content);
  } finally { clearTimeout(to); }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST' });
  try {
    const org = String(req.headers.origin || req.headers.referer || '');
    let host = ''; try { host = new URL(org).hostname; } catch (e) {}
    if (!SITIOS.some(s => host === s || host.endsWith('.' + s))) return res.status(403).json({ error: 'origen' });
    const q = String(readBody(req).q || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (q.length < 2) return res.status(400).json({ error: 'vacío' });

    const ip = ipHash(req), min = Math.floor(Date.now() / 60000), dia = new Date().toISOString().slice(0, 10);
    const [a, b, g] = await redis([['INCR', 'ia:m:' + ip + ':' + min], ['INCR', 'ia:d:' + ip + ':' + dia], ['INCR', 'ia:g:' + dia]]);
    if (a === 1) await redis([['EXPIRE', 'ia:m:' + ip + ':' + min, 90]]);
    if (b === 1) await redis([['EXPIRE', 'ia:d:' + ip + ':' + dia, 90000]]);
    if (g === 1) await redis([['EXPIRE', 'ia:g:' + dia, 90000]]);
    if (a > POR_MIN || b > POR_DIA || g > GLOBAL_DIA) return res.status(429).json({ error: 'límite' });

    const o = await llamar(q);
    if (!o) return res.status(200).json({ none: true });
    return res.status(200).json({ filtros: limpiar(o), respuesta: String(o.respuesta || '').slice(0, 140) });
  } catch (e) {
    return res.status(502).json({ error: 'ia' });
  }
};
