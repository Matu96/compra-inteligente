"""cobertura.py catalogo.json productos.json[.gz] — qué productos de la app no tienen datos web y por qué."""
import collections, gzip, json, re, sys

cat = json.load(open(sys.argv[1]))
abrir = gzip.open if sys.argv[2].endswith(".gz") else open
web = json.load(abrir(sys.argv[2], "rt"))
TIPOS = cat["tipos"]
por_ean = collections.defaultdict(list)
por_sku = {}
for p in web:
    if p["ean"]:
        por_ean[p["ean"].lstrip("0")].append(p)
    if p["tienda"] == "coto":
        por_sku[re.sub(r"\D", "", p["sku_tienda"]).lstrip("0")] = p
prods = cat["productos"]
sin, internos, marcas_sin, marcas_tot = [], [], collections.Counter(), collections.Counter()
for ean, nombre, marca, pres, ti in prods:
    marcas_tot[marca] += 1
    if ean.startswith("i"):
        internos.append((ean, nombre, marca))
        marcas_sin[marca] += 1
        continue
    if ean.lstrip("0") not in por_ean:
        sin.append((ean, nombre, marca))
        marcas_sin[marca] += 1
print(f"catálogo {len(prods)} · con EAN real {len(prods) - len(internos)} · sin datos web {len(sin)} · códigos internos {len(internos)}")
print("\nMarcas con más productos sin foto web (sin/total):")
for m, k in marcas_sin.most_common(40):
    print(f"  {k:5d}/{marcas_tot[m]:5d}  {m}")
print("\nCódigos internos por comercio:", collections.Counter(e.split("-")[0] for e, *_ in internos).most_common(10))
for e, n, m in internos[:15]:
    cod = e.split("-", 1)[1].lstrip("0")
    hit = por_sku.get(cod)
    print(f"  {e:22} {n[:45]:45} {m or '':15} → coto sku: {hit['nombre'][:40] if hit else '—'}")
print("\nEjemplos sin datos web:")
for e, n, m in sin[:25]:
    print(f"  {e:15} {n[:50]:50} {m}")
# ¿se podrían encontrar por nombre? palabras del nombre + marca en algún producto web
idx = collections.defaultdict(set)
for i, p in enumerate(web):
    for w in set(re.findall(r"[a-z0-9]{3,}", (p["nombre"] or "").lower())):
        idx[w].add(i)

# ¿Las fotos cargan desde otra página? (la app las pide sin Referer)
import random, urllib.request
from urllib.parse import urlsplit
random.seed(1)
print("\nFotos de cada tienda (25 al azar, sin Referer y con Referer de la app):")
for t in sorted({p["tienda"] for p in web}):
    urls = random.sample([p["image_url"] for p in web if p["tienda"] == t], 25)
    for ref in (None, "https://matu96.github.io/"):
        res = collections.Counter()
        for u in urls:
            h = {"User-Agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131 Mobile Safari/537.36"}
            if ref:
                h["Referer"] = ref
            try:
                with urllib.request.urlopen(urllib.request.Request(u, headers=h), timeout=20) as r:
                    tipo = r.headers.get("content-type", "")
                    res[f"{r.status} {tipo.split(';')[0]} {'chica' if len(r.read()) < 3000 else 'ok'}"] += 1
            except Exception as e:
                res[str(getattr(e, "code", type(e).__name__))] += 1
        print(f"  {t:10} {'con' if ref else 'sin'} Referer: {dict(res)}  ej: {urlsplit(urls[0]).netloc}")
