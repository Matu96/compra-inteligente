#!/usr/bin/env python3
"""Diagnóstico: muestra, para un texto de búsqueda, lo que informa SEPA (crudo) y lo que ve la app (celdas),
en las sucursales cercanas a un punto. Uso: python pipeline/diagnostico.py "taragui 1" --cadena dia"""
import argparse, json, os, sys, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sepa_import import iterar_comercios, buscar, leer_csv, sin_tildes, km, clave_cadena

ap = argparse.ArgumentParser()
ap.add_argument("texto"); ap.add_argument("--cadena", default="")
ap.add_argument("--lat", type=float, default=-34.6186); ap.add_argument("--lng", type=float, default=-58.4410)
ap.add_argument("--radio", type=float, default=3); ap.add_argument("--sepa", required=True); ap.add_argument("--data", required=True)
a = ap.parse_args()
toks = sin_tildes(a.texto).split()

print(f"== SEPA crudo: '{a.texto}' en {a.cadena or 'todas'} a <{a.radio} km ==")
crudo = {}
for nombre, zf in iterar_comercios(a.sepa):
    fc, fs, fp = buscar(zf, "comercio.csv"), buscar(zf, "sucursales.csv"), buscar(zf, "productos.csv")
    if not (fc and fs and fp): continue
    band = {(c.get("id_comercio"), c.get("id_bandera")): c.get("comercio_bandera_nombre", "") for c in leer_csv(zf, fc)}
    if a.cadena and not any(clave_cadena(b) == a.cadena for b in band.values()): continue
    sucs = {}
    for s in leer_csv(zf, fs):
        try: d = km(a.lat, a.lng, float(s["sucursales_latitud"]), float(s["sucursales_longitud"]))
        except Exception: continue
        if d <= a.radio:
            sucs[(s["id_comercio"], s["id_bandera"], s["id_sucursal"])] = (d, s.get("sucursales_calle", "") + " " + s.get("sucursales_numero", ""))
    if not sucs: continue
    for p in leer_csv(zf, fp):
        k = (p.get("id_comercio"), p.get("id_bandera"), p.get("id_sucursal"))
        if k not in sucs: continue
        txt = sin_tildes(p.get("productos_descripcion", "") + " " + p.get("productos_marca", ""))
        if all(t in txt for t in toks):
            d, dirr = sucs[k]
            crudo["-".join(k)] = p
            print(f"{d:4.1f} km {band.get(k[:2])} {dirr[:28]:28} | {p.get('id_producto')} {p.get('productos_descripcion')[:40]:40} "
                  f"| lista={p.get('productos_precio_lista')} ref={p.get('productos_precio_referencia')} "
                  f"promo1={p.get('productos_precio_unitario_promo1')} '{p.get('productos_leyenda_promo1')}' "
                  f"promo2={p.get('productos_precio_unitario_promo2')} '{p.get('productos_leyenda_promo2')}'")

print("\n== Lo que ve la app ==")
idx = json.load(open(os.path.join(a.data, "index.json")))
cat = json.load(open(os.path.join(a.data, "catalogo.json")))
prods = {p[0]: p for p in cat["productos"]}
tam = idx["tam"]
dl, dg = a.radio / 111, a.radio / (111 * math.cos(math.radians(a.lat)))
for la in range(math.floor((a.lat - dl) / tam), math.floor((a.lat + dl) / tam) + 1):
    for lo in range(math.floor((a.lng - dg) / tam), math.floor((a.lng + dg) / tam) + 1):
        f = os.path.join(a.data, "tiles", f"{la}_{lo}.json")
        if not os.path.exists(f): continue
        t = json.load(open(f))
        for s in t["sucursales"]:
            if a.cadena and s["cad"] != a.cadena: continue
            d = km(a.lat, a.lng, s["lat"], s["lng"])
            if d > a.radio: continue
            for ean, p in prods.items():
                if not all(x in sin_tildes(p[1] + " " + p[2]) for x in toks): continue
                fila = s["dif"][ean] if ean in s["dif"] else t["listas"][s["lp"]].get(ean)
                if fila is not None:
                    print(f"{d:4.1f} km {s['b']} {s['dir'][:28]:28} | {ean} {p[1][:40]:40} | tipo={cat['tipos'][p[4]]} | fila={fila}")
