#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_data.py  —  Cloud Rider Catálogo
=======================================
Lee tus CSV y genera la carpeta data/ que usa el index.html:

  data/manifest.json          versiones + "Recién Actualizados"  (pocos KB)
  data/lista_<cat>.json       lo mínimo para el grid, filtros, búsqueda y carrito
  data/d/<cat>_<n>.json       detalle (sinopsis, reparto, trailer...) en bloques de 100
                              títulos; el navegador solo baja el bloque del título
                              que la persona abre.
  data/s/<cat>.json           solo sinopsis (para buscar por sinopsis cuando el título no
                              da resultados)

Uso (en la carpeta donde están los CSV y el index.html):

    python build_data.py

Ejecútalo cada vez que cambies un CSV, antes de subir a GitHub.
Los CSV siguen siendo tu fuente de verdad; data/ se regenera completa.
"""
import csv, json, os, re, sys, math, gzip, shutil, hashlib, unicodedata

csv.field_size_limit(sys.maxsize)

BASE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(BASE, 'data')
SHARD = 100           # títulos por bloque de detalle (mantiene data/ por debajo de 100 archivos)
RECIENTES_POR_ARCHIVO = 3

# Mismo orden que CSV_CAT_MAP del index.html (el orden define el orden del catálogo)
FILES = [
    ('series_data.csv',              'series'),
    ('peliculas_data_avanzado.csv',  'peliculas'),
    ('peliculas_data_avanzado2.csv', 'peliculas'),
    ('animes_data.csv',              'animes'),
    ('animados_data.csv',            'animados'),
    ('doramas_data.csv',             'doramas'),
    ('novelas_data.csv',             'novelas'),
    ('juegos_data.csv',              'juegos'),
]
CATS = []
for _f, _c in FILES:
    if _c not in CATS:
        CATS.append(_c)

# Copia fiel de CSV_SCHEMA del index.html: qué columna alimenta cada dato
def S(keyClean, keyOrig, poster, punt, temporadas, episodios, url, anio,
      tdet=None, reparto=True, peso=None, req=False, ptemp=None):
    d = dict(keyClean=keyClean, keyOrig=keyOrig, sinopsis='Sinopsis', poster=poster,
             backdrop='Backdrop_URL', generos='Generos', puntuacion=punt,
             temporadas=temporadas, episodios=episodios, url=url, anio=anio,
             temporadasDet=tdet, recomendaciones='Recomendaciones', trailer='Trailer_URL')
    if reparto:
        d.update(reparto='Reparto', repartoFotos='Reparto_Fotos', equipo='Equipo')
    if peso:
        d['peso'] = peso
    if ptemp:
        d['pesoTemp'] = ptemp
    if req:
        d.update(reqMin='Requisitos_Minimos', reqRec='Requisitos_Recomendados')
    return d

SCHEMA = {
    'animados':  S('Titulo', 'Original', 'Link_Imagen', 'Puntuacion_IMDb', 'Temporadas', 'Episodios', 'URL_TMDB', 'Anio', tdet='Temporadas_Detalle', peso='Peso_GB', ptemp='Peso_Temporadas_Detalle'),
    'animes':    S('Titulo_encontrado', 'Titulo_original', 'Poster_URL', 'Puntuacion', None, 'Episodios', 'URL_Externa', None, tdet='Temporadas_Detalle', peso='Peso_GB', ptemp='Peso_Temporadas_Detalle'),
    'doramas':   S('Titulo_encontrado', 'Titulo_original', 'Poster_URL', 'Puntuacion_TMDB', 'Temporadas', 'Episodios', 'URL_Externa', 'Anio', tdet='Temporadas_Detalle', peso='Peso_GB', ptemp='Peso_Temporadas_Detalle'),
    'juegos':    S('Titulo_encontrado', 'Titulo_original', 'Poster_URL', 'Puntuacion_Usuario', None, None, 'URL_Slug', 'Anio', reparto=False, peso='Peso_GB', req=True),
    'novelas':   S('Titulo_encontrado', 'Titulo_original', 'Poster_URL', 'Puntuacion_TMDB', 'Temporadas', 'Episodios', 'URL_TMDB', 'Anio', tdet='Temporadas_Detalle', peso='Peso_GB', ptemp='Peso_Temporadas_Detalle'),
    'peliculas': S('Titulo_encontrado', 'Titulo_original', 'Poster_URL', 'Puntuacion', None, None, 'URL_Externa', 'Anio', peso='Peso_GB'),
    'series':    S('Titulo', None, 'Link_Imagen', 'Puntuacion_IMDb', 'Temporadas', 'Capitulos', 'URL_TMDB', 'Anio', tdet='Temporadas_Detalle', peso='Peso_GB', ptemp='Peso_Temporadas_Detalle'),
}


# ───────────── helpers equivalentes a los del index.html ─────────────
def norm_csv(s):
    """normCSV(): para detectar títulos duplicados."""
    if not s:
        return ''
    s = re.sub(r'\[.*?\]', '', s)
    s = unicodedata.normalize('NFD', s.lower())
    s = ''.join(ch for ch in s if unicodedata.category(ch) != 'Mn')
    return re.sub(r'[^a-z0-9]', '', s).strip()

_NUM = re.compile(r'^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?')
_INT = re.compile(r'^\s*[-+]?\d+')

def parse_float(s):
    m = _NUM.match(s or '')
    return float(m.group(0)) if m else None

def parse_int(s):
    m = _INT.match(s or '')
    return int(m.group(0)) if m else None

def fmt_rating(x):
    v = math.floor(x * 10 + 0.5) / 10          # Math.round de JS
    return str(int(v)) if v == int(v) else repr(v)

def read_csv(path):
    """Mismo lector que usaba el index.html (parseCSV): línea por línea, las comillas
    solo agrupan el separador y se descartan. Así el resultado es idéntico al de antes
    aunque alguna fila tenga comillas mal cerradas."""
    with open(path, encoding='utf-8-sig', newline='') as fh:
        text = fh.read()
    lines = [l for l in re.split(r'\r?\n', text) if l.strip()]
    if not lines:
        return []
    h0 = lines[0]
    tabs, semis, commas = h0.count('\t'), h0.count(';'), h0.count(',')
    sep = '\t' if (tabs >= semis and tabs >= commas) else (';' if semis >= commas else ',')
    headers = [h.strip() for h in h0.split(sep)]
    rows = []
    for line in lines[1:]:
        cells, cur, in_q = [], [], False
        for ch in line:
            if ch == '"':
                in_q = not in_q
            elif ch == sep and not in_q:
                cells.append(''.join(cur)); cur = []
            else:
                cur.append(ch)
        cells.append(''.join(cur))
        if len(cells) < 2:
            continue
        rows.append({h: (cells[i].strip() if i < len(cells) else '') for i, h in enumerate(headers)})
    return rows

def parse_cast(reparto, fotos):
    cast = []
    for part in reparto.split(','):
        part = part.strip()
        if not part:
            continue
        p_open, p_close = part.find('('), part.rfind(')')
        if p_open > -1 and p_close > p_open:
            cast.append({'name': part[:p_open].strip(), 'char': part[p_open + 1:p_close].strip()})
        else:
            cast.append({'name': part, 'char': ''})
    if fotos:
        fl = [x.strip() for x in fotos.split(',')]
        if len(fl) == len(cast):
            for a, f in zip(cast, fl):
                if f:
                    a['photo'] = f
    out = []
    for a in cast:
        o = {'n': a['name']}
        if a['char']:
            o['c'] = a['char']
        if a.get('photo'):
            o['f'] = a['photo']
        out.append(o)
    return out


def build_category(cat, rows_by_file):
    """Devuelve (lista, detalle) alineados por posición, replicando applyCSVRows()."""
    sc = SCHEMA[cat]
    lista, detalle = [], []
    seen_cat = set()                      # dedupe entre archivos de la misma categoría
    for rows in rows_by_file:
        by_clean, by_orig = {}, {}
        for row in rows:                  # el último duplicado gana, igual que el JS
            clean = row.get(sc['keyClean'], '') if sc['keyClean'] else ''
            orig = row.get(sc['keyOrig'], '') if sc['keyOrig'] else ''
            if clean:
                by_clean[norm_csv(clean)] = row
            if orig:
                by_orig[norm_csv(orig)] = row
        seen_file = set()
        for row in rows:
            clean = row.get(sc['keyClean'], '') if sc['keyClean'] else ''
            orig = row.get(sc['keyOrig'], '') if sc['keyOrig'] else clean
            title = clean or orig
            if not title:
                continue
            nk = norm_csv(title)
            if nk in seen_file or nk in seen_cat:
                continue
            seen_file.add(nk)
            seen_cat.add(nk)

            anio = row.get(sc['anio'], '') if sc['anio'] else ''
            year = ''
            if anio:
                m = re.search(r'(\d{4})', anio)
                year = m.group(1) if m else anio.strip()
            gen = row.get(sc['generos'], '')
            garr = [g.strip() for g in re.split(r'[,|;]|\. |\s/\s', gen)] if gen else []
            garr = [g for g in garr if g]

            L = {'t': title}
            if year:
                L['y'] = year
            if orig != title:
                L['a'] = orig
            if garr:
                L['g'] = garr
            D = {'t': title}

            r = by_clean.get(nk) or by_orig.get(nk)
            if r is not None:
                g = lambda k: (r.get(sc[k], '') if sc.get(k) else '')
                poster = g('poster')
                if poster.startswith('http'):
                    L['p'] = poster
                pt = parse_float(g('puntuacion'))
                if g('puntuacion') and pt is not None:
                    L['r'] = fmt_rating(pt)
                t = parse_int(g('temporadas'))
                if t and t > 0:
                    L['s'] = t
                e = parse_int(g('episodios'))
                if e and e > 0:
                    L['e'] = e
                peso = g('peso')
                if peso:
                    pw = parse_float(peso.replace(',', '.'))
                    if pw is not None and pw > 0:
                        L['w'] = pw if pw != int(pw) else int(pw)
                td = g('temporadasDet')
                ptd = g('pesoTemp')
                if ptd:
                    pw = []
                    for part in ptd.split('|'):
                        mm = re.match(r'^T(\d+):(\d+(?:[.,]\d+)?)$', part.strip(), re.I)
                        if mm:
                            gbv = float(mm.group(2).replace(',', '.'))
                            if gbv > 0:
                                pw.append([int(mm.group(1)), gbv if gbv != int(gbv) else int(gbv)])
                    if pw:
                        L['pw'] = pw
                if td:
                    sd = []
                    for part in td.split('|'):
                        mm = re.match(r'^T(\d+):(\d+)$', part.strip(), re.I)
                        if mm:
                            sd.append([int(mm.group(1)), int(mm.group(2))])
                    if sd:
                        L['sd'] = sd
                # ---- detalle ----
                if g('sinopsis'):
                    D['ov'] = g('sinopsis')
                bd = g('backdrop')
                if bd.startswith('http'):
                    D['b'] = bd
                u = g('url')
                if u.startswith('http'):
                    D['u'] = u
                rep = g('reparto')
                if rep:
                    cast = parse_cast(rep, g('repartoFotos'))
                    if cast:
                        D['cast'] = cast
                if g('equipo'):
                    D['crew'] = g('equipo')
                recs = [x.strip() for x in g('recomendaciones').split(',') if x.strip()]
                if recs:
                    D['recs'] = recs
                if g('reqMin'):
                    D['rq'] = g('reqMin')
                if g('reqRec'):
                    D['rr'] = g('reqRec')
                tr = g('trailer')
                if tr.startswith('http'):
                    D['tr'] = tr
            lista.append(L)
            detalle.append(D)
    return lista, detalle


def recientes(rows_by_file_named):
    """Igual que el carrusel: últimas filas de cada CSV (películas: solo el archivo 2)."""
    cfg = [
        ('peliculas_data_avanzado2.csv', 'peliculas', 'Titulo_encontrado', 'Poster_URL'),
        ('series_data.csv',   'series',   'Titulo',            'Link_Imagen'),
        ('animes_data.csv',   'animes',   'Titulo_encontrado', 'Poster_URL'),
        ('animados_data.csv', 'animados', 'Titulo',            'Link_Imagen'),
        ('doramas_data.csv',  'doramas',  'Titulo_encontrado', 'Poster_URL'),
        ('novelas_data.csv',  'novelas',  'Titulo_encontrado', 'Poster_URL'),
        ('juegos_data.csv',   'juegos',   'Titulo_encontrado', 'Poster_URL'),
    ]
    out = []
    for f, c, tk, pk in cfg:
        for row in reversed(rows_by_file_named.get(f, [])[-RECIENTES_POR_ARCHIVO:]):
            t, p = row.get(tk, ''), row.get(pk, '')
            if t and p.startswith('http'):
                out.append({'t': t, 'c': c, 'img': p})
    return out


def dump(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(',', ':'))

def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(text)
    return len(text.encode('utf-8'))


def main():
    rows_named = {}
    for f, _ in FILES:
        p = os.path.join(BASE, f)
        if not os.path.exists(p):
            print(f'  (no existe {f}, se omite)')
            continue
        rows_named[f] = read_csv(p)

    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT)

    manifest = {'shard': SHARD, 'cats': {}}   # sin fecha: la salida es idéntica si los CSV no cambian
    tot_raw = tot_gz = 0
    print(f'{"categoría":11s}{"títulos":>8s}{"lista KB":>10s}{"(gzip)":>9s}{"detalle KB":>12s}{"bloques":>9s}')
    for cat in CATS:
        groups = [rows_named[f] for f, c in FILES if c == cat and f in rows_named]
        if not groups:
            continue
        lista, detalle = build_category(cat, groups)
        ltxt = dump(lista)
        lb = write(os.path.join(OUT, f'lista_{cat}.json'), ltxt)
        lgz = len(gzip.compress(ltxt.encode('utf-8'), 6))
        hsh = hashlib.sha1(ltxt.encode('utf-8'))
        dbytes = 0
        nsh = math.ceil(len(detalle) / SHARD)
        for k in range(nsh):
            txt = dump(detalle[k * SHARD:(k + 1) * SHARD])
            hsh.update(txt.encode('utf-8'))
            dbytes += write(os.path.join(OUT, 'd', f'{cat}_{k}.json'), txt)
        # sinopsis sueltas: solo se bajan si una búsqueda no encuentra nada por título
        stxt = dump([d.get('ov', '') for d in detalle])
        write(os.path.join(OUT, 's', f'{cat}.json'), stxt)
        # la versión cambia si cambia CUALQUIER dato de la categoría (lista o detalle)
        manifest['cats'][cat] = {'n': len(lista), 'v': hsh.hexdigest()[:10]}
        tot_raw += lb
        tot_gz += lgz
        print(f'{cat:11s}{len(lista):8d}{lb/1024:10.0f}{lgz/1024:9.0f}{dbytes/1024:12.0f}{nsh:9d}')

    manifest['rec'] = recientes(rows_named)
    write(os.path.join(OUT, 'manifest.json'), dump(manifest))
    print(f'\nAl abrir el sitio se descarga: {tot_raw/1024:.0f} KB de listas ({tot_gz/1024:.0f} KB comprimidos) + manifest.')
    print(f'Al abrir una ficha: 1 bloque de ~{SHARD} títulos (decenas de KB).')
    print('Listo → sube index.html, logo.webp y la carpeta data/ a GitHub.')

if __name__ == '__main__':
    main()
