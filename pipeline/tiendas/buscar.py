"""buscar.py catalogo.json productos.json.gz texto... — dónde está (o no) un producto: catálogo de la app y tiendas online."""
import gzip, json, sys
cat = json.load(open(sys.argv[1])); web = json.load(gzip.open(sys.argv[2], "rt"))
for q in sys.argv[3:]:
    ql = q.lower().lstrip("0")
    print(f"\n### {q}")
    for p in cat["productos"]:
        if ql in p[0].lower() or all(w in f"{p[1]} {p[2]}".lower() for w in ql.split()):
            print("  app:", p[:4], "tipo:", cat["tipos"][p[4]])
    for p in web:
        if ql == (p["ean"] or "").lstrip("0") or all(w in (p["nombre"] or "").lower() for w in ql.split()):
            print("  web:", p["tienda"], p["ean"], p["nombre"], p["precio_final"], p["image_url"][:90])
