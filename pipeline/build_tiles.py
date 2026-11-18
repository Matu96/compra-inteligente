#!/usr/bin/env python3
"""
build_tiles.py — Genera los datos estáticos que consume la app a partir de la base SEPA del día.

Salida (carpeta --salida, por defecto public/data):
  index.json            fecha del dato, tamaño de cuadrícula y lista de cuadrículas con sucursales
  catalogo.json         {tipos: [producto genérico], productos: [[EAN, nombre, marca, presentación, índice de tipo]]}
  tiles/<lat>_<lng>.json  sucursales de esa cuadrícula + listas de precios por cadena

Cuadrícula: celdas de 0,05° (~5,5 x 4,5 km). La app baja solo las celdas que cubren su radio.
El catálogo se decide en zonas más grandes (0,2°) para que no dependa de celdas con pocas sucursales.
Para que pese poco, cada cadena tiene una "lista base" por celda (el precio más común de cada producto)
y cada sucursal guarda solo lo que difiere de esa lista.

Uso:
  python3 pipeline/build_tiles.py                      # baja el ZIP del día y procesa todo el país
  python3 pipeline/build_tiles.py --zip sepa.zip       # usa un ZIP ya descargado
  python3 pipeline/build_tiles.py --provincia AR-C     # solo una provincia (pruebas)
"""
import argparse, json, math, os, shutil, sys, tempfile, time
from collections import Counter, defaultdict
from datetime import date, datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sepa_import import (obtener_sepa, iterar_comercios, buscar, leer_csv, num,
                         parsear_promo, clave_cadena, tipo_de, log)

TAM = 0.05      # celdas que baja la app (~5 km)
TAM_CAT = 0.2   # zonas para decidir qué productos entran al catálogo (~20 km)


def celda(lat, lng):
    return f"{math.floor(lat / TAM)}_{math.floor(lng / TAM)}"


def en_argentina(lat, lng):
    return -56 < lat < -21 and -74 < lng < -53


def pasada1(path_zip, args, tmp):
    """Lee el ZIP una sola vez: metadatos de sucursales/productos y filas de precio volcadas a un TSV por celda."""
    sucursales, productos, nombres_cad = {}, {}, {}
    n_filas = 0
    for nombre, zf in iterar_comercios(path_zip):
        f_com, f_suc, f_prod = buscar(zf, "comercio.csv"), buscar(zf, "sucursales.csv"), buscar(zf, "productos.csv")
        if not (f_com and f_suc and f_prod):
            continue
        banderas = {(c.get("id_comercio"), c.get("id_bandera")):
                    (c.get("comercio_bandera_nombre") or c.get("comercio_razon_social", "")).strip()
                    for c in leer_csv(zf, f_com)}
        locales = {}
        for s in leer_csv(zf, f_suc):
            try:
                lat = float(s["sucursales_latitud"].replace(",", "."))
                lng = float(s["sucursales_longitud"].replace(",", "."))
            except (KeyError, ValueError):
                continue
            if not en_argentina(lat, lng):
                continue
            if args.provincia and s.get("sucursales_provincia", "").upper() != args.provincia.upper():
                continue
            k = "-".join((s["id_comercio"], s["id_bandera"], s["id_sucursal"]))
            bandera = banderas.get((s["id_comercio"], s["id_bandera"]), "")
            cad = clave_cadena(bandera)
            nombres_cad.setdefault(cad, bandera.title() if bandera.isupper() else bandera)
            locales[k] = {
                "id": k, "cad": cad, "b": bandera,
                "dir": f"{s.get('sucursales_calle', '').strip().title()} {s.get('sucursales_numero', '').strip()}".strip(),
                "loc": s.get("sucursales_localidad", "").strip().title(),
                "lat": round(lat, 6), "lng": round(lng, 6), "celda": celda(lat, lng),
            }
        if not locales:
            continue
        sucursales.update(locales)
        buf = defaultdict(list)
        for p in leer_csv(zf, f_prod):
            k = "-".join((p.get("id_comercio", ""), p.get("id_bandera", ""), p.get("id_sucursal", "")))
            s = locales.get(k)
            if not s or p.get("productos_ean", "1").strip() != "1":
                continue
            ean = p.get("id_producto", "").strip().lstrip("0")
            lista = num(p.get("productos_precio_lista"))
            if not ean or not lista or len(ean) < 7:
                continue
            if ean not in productos:
                cant = num(p.get("productos_cantidad_presentacion", ""))
                pres = f"{cant:g} {p.get('productos_unidad_medida_presentacion', '').strip()}".strip() if cant else \
                       p.get("productos_unidad_medida_presentacion", "").strip()
                desc, marca = p.get("productos_descripcion", "").strip(), p.get("productos_marca", "").strip()
                tipo, tipo_nombre = tipo_de(desc, marca, pres)
                productos[ean] = [desc, marca, pres, tipo, tipo_nombre]
            mejor, ley = 0, ""
            for i in ("1", "2"):
                pu = num(p.get(f"productos_precio_unitario_promo{i}"))
                if pu and pu < lista and (not mejor or pu < mejor):
                    mejor, ley = pu, p.get(f"productos_leyenda_promo{i}", "").strip().replace("\t", " ")
            buf[s["celda"]].append(f"{k}\t{ean}\t{lista:g}\t{mejor:g}\t{ley}\n")
        for c, filas in buf.items():
            with open(os.path.join(tmp, c + ".tsv"), "a", encoding="utf-8") as f:
                f.writelines(filas)
            n_filas += len(filas)
        log(f"  {nombre}: {len(locales)} sucursales · acumulado {n_filas:,} precios")
    return sucursales, productos, nombres_cad


def leer_celda(tmp, c):
    with open(os.path.join(tmp, c + ".tsv"), encoding="utf-8") as f:
        for linea in f:
            sid, ean, lista, promo, ley = linea.rstrip("\n").split("\t")
            yield sid, ean, float(lista), float(promo), ley


def zona_catalogo(c):
    la, lo = (int(x) for x in c.split("_"))
    return f"{math.floor(la * TAM / TAM_CAT)}_{math.floor(lo * TAM / TAM_CAT)}"


def armar_catalogo(tmp, celdas, productos, sucursales, args):
    """Por zona (0,2°): entran los productos genéricos (tipo) presentes en al menos --cobertura de sus
    sucursales y en al menos 2 cadenas (si la zona tiene más de una), con TODAS sus marcas
    (también las baratas o propias que tienen pocas sucursales)."""
    pop_ean, pop_tipo = Counter(), Counter()
    elegidos = set()
    zonas = defaultdict(list)
    for c in celdas:
        zonas[zona_catalogo(c)].append(c)
    for z, cs in zonas.items():
        pres = defaultdict(set)
        for c in cs:
            for sid, ean, *_ in leer_celda(tmp, c):
                pres[ean].add(sid)
        suc_tipo = defaultdict(set)
        for ean, ss in pres.items():
            suc_tipo[productos[ean][3]] |= ss
        todas = set().union(*pres.values()) if pres else set()
        n = len(todas) or 1
        cadenas_zona = {sucursales[x]["cad"] for x in todas}
        min_cad = min(2, len(cadenas_zona))
        tipos_ok = {t for t, ss in suc_tipo.items()
                    if len(ss) / n >= args.cobertura and len(ss) >= min(2, n)
                    and len({sucursales[x]["cad"] for x in ss}) >= min_cad}
        cand = sorted((e for e in pres if productos[e][3] in tipos_ok),
                      key=lambda e: (-len(suc_tipo[productos[e][3]]), -len(pres[e])))
        elegidos.update(cand[: args.max_por_zona])
        for ean, ss in pres.items():
            pop_ean[ean] += len(ss)
        for t, ss in suc_tipo.items():
            pop_tipo[t] += len(ss)
    return elegidos, pop_ean, pop_tipo


def fila_json(lista, promo, ley, cache_spec):
    if not promo:
        return [lista]
    if ley not in cache_spec:
        cache_spec[ley] = parsear_promo(ley)
    return [lista, promo, cache_spec[ley], ley or None]


def escribir_celda(tmp, c, sucursales, catalogo, args, salida, fecha, cache_spec):
    filas = defaultdict(dict)                       # sid -> ean -> fila
    for sid, ean, lista, promo, ley in leer_celda(tmp, c):
        if ean in catalogo:
            filas[sid][ean] = (lista, promo, ley)
    # descartar locales que no son almacenes/súper (electro, farmacias…): pocos productos del catálogo
    filas = {sid: f for sid, f in filas.items() if len(f) >= args.min_productos}
    if not filas:
        return 0, 0
    por_cadena = defaultdict(list)
    for sid in filas:
        s = sucursales[sid]
        por_cadena[(s["cad"], s["b"])].append(sid)
    listas, out_sucs = [], []
    cache_spec = cache_spec
    for (cad, b), sids in sorted(por_cadena.items()):
        conteo = defaultdict(Counter)
        for sid in sids:
            for ean, f in filas[sid].items():
                conteo[ean][f] += 1
        base = {}
        for ean, cnt in conteo.items():
            f, n = cnt.most_common(1)[0]
            if sum(cnt.values()) / len(sids) >= 0.5:
                base[ean] = f
        li = len(listas)
        listas.append({ean: fila_json(*f, cache_spec) for ean, f in base.items()})
        for sid in sids:
            propias = filas[sid]
            dif = {ean: fila_json(*f, cache_spec) for ean, f in propias.items() if base.get(ean) != f}
            for ean in base:
                if ean not in propias:
                    dif[ean] = None
            s = sucursales[sid]
            out_sucs.append({"id": sid, "cad": cad, "b": b, "dir": s["dir"], "loc": s["loc"],
                             "lat": s["lat"], "lng": s["lng"], "lp": li, "dif": dif})
    data = {"fecha": fecha, "celda": c, "sucursales": out_sucs, "listas": listas}
    with open(os.path.join(salida, "tiles", c + ".json"), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    return len(out_sucs), sum(len(l) for l in listas) + sum(len(s["dif"]) for s in out_sucs)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip", help="ZIP SEPA ya descargado")
    ap.add_argument("--fecha", help="AAAA-MM-DD (default hoy)")
    ap.add_argument("--cache", default="sepa_cache")
    ap.add_argument("--salida", default="public/data")
    ap.add_argument("--provincia", help="limitar a una provincia (AR-C, AR-B, …) para pruebas")
    ap.add_argument("--cobertura", type=float, default=0.2, help="presencia mínima del producto genérico (cualquier marca) en las sucursales de la zona")
    ap.add_argument("--max-por-zona", type=int, default=8000, help="tope de variantes (EAN) por zona de catálogo")
    ap.add_argument("--min-productos", type=int, default=80, help="sucursales con menos productos del catálogo se descartan")
    args = ap.parse_args()

    t0 = time.time()
    fecha = date.fromisoformat(args.fecha) if args.fecha else date.today()
    if args.zip:
        path_zip, fecha_dato = args.zip, fecha.isoformat()
    else:
        path_zip, fecha_dato = obtener_sepa(fecha, args.cache)

    tmp = tempfile.mkdtemp(prefix="sepa_celdas_")
    try:
        log("Pasada 1: leyendo SEPA…")
        sucursales, productos, nombres_cad = pasada1(path_zip, args, tmp)
        celdas = sorted(f[:-4] for f in os.listdir(tmp))
        if not celdas:
            log("No se encontraron precios. ¿El ZIP está vacío o cambió el formato?")
            sys.exit(1)
        log(f"Pasada 2: catálogo sobre {len({zona_catalogo(c) for c in celdas})} zonas…")
        catalogo, popularidad, pop_tipo = armar_catalogo(tmp, celdas, productos, sucursales, args)
        log(f"  {len({productos[e][3] for e in catalogo}):,} productos genéricos · {len(catalogo):,} variantes/marcas")

        if os.path.exists(os.path.join(args.salida, "tiles")):
            shutil.rmtree(os.path.join(args.salida, "tiles"))
        os.makedirs(os.path.join(args.salida, "tiles"), exist_ok=True)
        log("Pasada 3: escribiendo celdas…")
        indice, total_s, total_p, cache_spec = {}, 0, 0, {}
        for c in celdas:
            ns, np_ = escribir_celda(tmp, c, sucursales, catalogo, args, args.salida, fecha_dato, cache_spec)
            if ns:
                indice[c] = ns
                total_s += ns
                total_p += np_
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    # catálogo: tipos (producto genérico) por popularidad y, dentro de cada uno, sus variantes/marcas
    tipos = sorted({productos[e][3] for e in catalogo}, key=lambda t: -pop_tipo[t])
    t_idx = {t: i for i, t in enumerate(tipos)}
    nombre_tipo = {productos[e][3]: productos[e][4] for e in catalogo}
    cat = sorted(catalogo, key=lambda e: (t_idx[productos[e][3]], -popularidad[e]))
    with open(os.path.join(args.salida, "catalogo.json"), "w", encoding="utf-8") as f:
        json.dump({"tipos": [nombre_tipo[t] for t in tipos],
                   "productos": [[e, productos[e][0], productos[e][1], productos[e][2], t_idx[productos[e][3]]] for e in cat]},
                  f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(args.salida, "index.json"), "w", encoding="utf-8") as f:
        json.dump({"fecha": fecha_dato, "generado": datetime.now().isoformat(timespec="seconds"),
                   "fuente": "SEPA - Precios Claros (Secretaría de Comercio), CC-BY 4.0",
                   "tam": TAM, "celdas": indice, "cadenas": nombres_cad,
                   "sucursales": total_s, "productos": len(cat), "tipos": len(tipos)}, f, ensure_ascii=False, separators=(",", ":"))
    import gzip
    def gz(path):
        with open(path, "rb") as f:
            return len(gzip.compress(f.read(), 6))
    tiles_dir = os.path.join(args.salida, "tiles")
    grandes = sorted(os.listdir(tiles_dir), key=lambda f: -os.path.getsize(os.path.join(tiles_dir, f)))[:5]
    cat_path = os.path.join(args.salida, "catalogo.json")
    log(f"  catálogo: {os.path.getsize(cat_path)/1e6:.1f} MB ({gz(cat_path)/1e6:.1f} MB comprimido)")
    for f in grandes:
        fp = os.path.join(tiles_dir, f)
        log(f"  celda {f}: {indice[f[:-5]]} sucursales · {os.path.getsize(fp)/1e6:.1f} MB ({gz(fp)/1e6:.1f} MB comprimido)")
    peso = sum(os.path.getsize(os.path.join(dp, fn)) for dp, _, fns in os.walk(args.salida) for fn in fns)
    log(f"✔ {len(indice)} celdas · {total_s:,} sucursales · {len(cat):,} productos · {total_p:,} registros · "
        f"{peso/1e6:.0f} MB · {time.time()-t0:.0f}s")


if __name__ == "__main__":
    main()
