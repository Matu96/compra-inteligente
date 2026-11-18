"""revisar.py salida/ — resumen de calidad por tienda (EAN, marca, promos) y los campos crudos de un registro de Coto."""
import collections
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from coto_scraper import registros  # noqa: E402

d = sys.argv[1] if len(sys.argv) > 1 else "salida"
P = json.load(open(os.path.join(d, "productos.json")))
por = collections.defaultdict(list)
for p in P:
    por[p["tienda"]].append(p)
for t, ps in por.items():
    n = len(ps)
    tipos = collections.Counter(x["tipo"] for p in ps for x in p["promociones"])
    descs = collections.Counter(x["descripcion"] for p in ps for x in p["promociones"])
    print(f"\n== {t}: {n} productos · con EAN {sum(1 for p in ps if p['ean'])} · con marca {sum(1 for p in ps if p['marca'])}"
          f" · con promo {sum(1 for p in ps if p['promociones'])} · {dict(tipos)}")
    for desc, k in descs.most_common(15):
        ej = next(x for p in ps for x in p["promociones"] if x["descripcion"] == desc)
        print(f"   {k:5d} × [{ej['tipo']}] {desc[:90]!r} → {ej['precio_unitario_promo']}")
    for p in ps[:2]:
        print("   ej:", json.dumps({k: p[k] for k in ("ean", "sku_tienda", "nombre", "marca", "precio_lista", "precio_final", "image_url", "product_url")}, ensure_ascii=False))
m = os.path.join(d, "coto_muestra.json")
if os.path.exists(m):
    regs = list(registros(json.load(open(m))))
    print(f"\n== Coto: {len(regs)} registros en la muestra. Campos del primero:")
    for k, v in sorted(regs[0]["attributes"].items()):
        print(f"   {k} = {json.dumps(v, ensure_ascii=False)[:220]}")
    con = [r for r in regs if any("dto" in k.lower() or "promo" in k.lower() or "descuento" in k.lower() for k in r["attributes"])]
    for r in con[:3]:
        print("   promo:", {k: v for k, v in r["attributes"].items() if any(w in k.lower() for w in ("dto", "promo", "descuento", "precio", "price"))})
    textos = collections.Counter()
    medios = collections.Counter()
    for r in regs:
        for d in json.loads((r["attributes"].get("product.dtoDescuentos") or ["[]"])[0] or "[]"):
            textos[(d.get("textoDescuento"), d.get("precioDescTextoAdicional"))] += 1
        for d in json.loads((r["attributes"].get("product.dtoDescuentosMediosPago") or ["[]"])[0] or "[]"):
            medios[json.dumps(d, ensure_ascii=False)[:250]] += 1
    print("   textoDescuento más comunes:", textos.most_common(25))
    print("   medios de pago:", medios.most_common(8))
