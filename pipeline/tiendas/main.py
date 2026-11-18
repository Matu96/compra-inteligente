"""main.py — extrae el catálogo de las tiendas online (Jumbo, Disco, Vea, Carrefour, Día, Coto Digital).

    python main.py                                   # todas las tiendas, guarda en salida/tiendas.sqlite
    python main.py --tiendas dia,coto --prueba       # pocas categorías/páginas, para probar
    python main.py --reiniciar                       # empieza de cero (si no, sigue donde quedó)
    python main.py --app ../../data --catalogo ../../data/catalogo.json   # además arma los datos para la app

Salida: salida/tiendas.sqlite (tabla productos) y salida/productos.json con el esquema:
tienda, ean, sku_tienda, nombre, marca, precio_lista, precio_final, descuento_porcentaje,
promociones [{tipo, descripcion, precio_unitario_promo}], image_url, product_url, fecha_extraccion.
No se descargan imágenes: solo se guarda la URL del súper.
"""
import argparse
import asyncio
import json
import os
import sys
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from storage import Almacen  # noqa: E402
from vtex_scraper import TIENDAS, TiendaVtex  # noqa: E402

TODAS = [*TIENDAS, "coto"]
ORDEN_FOTO = ["carrefour", "jumbo", "disco", "vea", "dia", "coto"]   # de qué tienda tomar la foto primero


def log(*a):
    print(*a, flush=True)


async def correr(args, almacen):
    tareas = []
    for t in args.tiendas:
        if args.reiniciar:
            almacen.reiniciar(t)
        if t == "coto":
            from coto_scraper import TiendaCoto
            tareas.append(TiendaCoto(almacen, rps=args.rps_coto, concurrencia=min(args.concurrencia, 4),
                                     max_paginas=3 if args.prueba else None, navegador=not args.sin_navegador,
                                     muestra=os.path.join(args.salida, "coto_muestra.json"), log=log).correr())
        else:
            tareas.append(TiendaVtex(t, almacen, rps=args.rps, concurrencia=args.concurrencia,
                                     max_categorias=4 if args.prueba else None, log=log).correr())
    # cada tienda es otro servidor: corren a la vez, cada una con su propio límite de pedidos
    res = await asyncio.gather(*tareas, return_exceptions=True)
    for t, r in zip(args.tiendas, res):
        if isinstance(r, Exception):
            log(f"✗ {t}: {type(r).__name__}: {r}")
        else:
            log(f"✔ {t}: {r['productos']:,} productos · {r['pedidos']:,} pedidos · {r['reintentos']} reintentos")
    return res


def exportar_app(almacen, carpeta, catalogo=None):
    """Datos chicos para la app, partidos por los 3 últimos dígitos del EAN (la app baja solo el que necesita):
    data/web/NNN.json = {ean: {"f": [urls de foto], "t": {tienda: [product_url, precio_final, precio_lista, [[tipo, descripcion, precio_unitario], ...]]}}}
    Sin promos bancarias (la app las calcula con promos.json) y como mucho 3 promos por tienda."""
    validos = None
    if catalogo and os.path.exists(catalogo):
        validos = {p[0].lstrip("0") for p in json.load(open(catalogo))["productos"]}
    partes, imgs = defaultdict(dict), defaultdict(dict)
    for p in almacen.productos():
        ean = (p["ean"] or "").lstrip("0")
        if not ean or (validos is not None and ean not in validos):
            continue
        e = partes[ean[-3:].zfill(3)].setdefault(ean, {"f": [], "t": {}})
        promos = [[x["tipo"], x["descripcion"][:80], x["precio_unitario_promo"]] for x in p["promociones"] if x["tipo"] != "bancaria"][:3]
        e["t"][p["tienda"]] = [p["product_url"], p["precio_final"], p["precio_lista"], promos]
        imgs[ean][p["tienda"]] = p["image_url"]
    for parte in partes.values():
        for ean, e in parte.items():
            e["f"] = [imgs[ean][t] for t in ORDEN_FOTO if t in imgs[ean]][:2]
    os.makedirs(os.path.join(carpeta, "web"), exist_ok=True)
    total = 0
    for nn in (f"{i:03d}" for i in range(1000)):
        parte = partes.get(nn, {})
        json.dump(parte, open(os.path.join(carpeta, "web", f"{nn}.json"), "w"), ensure_ascii=False, separators=(",", ":"))
        total += len(parte)
    return total


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tiendas", default=",".join(TODAS), help=f"separadas por coma ({','.join(TODAS)})")
    ap.add_argument("--salida", default="salida")
    ap.add_argument("--rps", type=float, default=4, help="pedidos por segundo por tienda VTEX")
    ap.add_argument("--rps-coto", type=float, default=2)
    ap.add_argument("--concurrencia", type=int, default=6)
    ap.add_argument("--prueba", action="store_true", help="pocas categorías/páginas por tienda")
    ap.add_argument("--reiniciar", action="store_true", help="no reanudar: vuelve a pedir todo")
    ap.add_argument("--sin-navegador", action="store_true", help="Coto sin Playwright")
    ap.add_argument("--dias-vigencia", type=int, default=3, help="borra productos que no se vieron en estos días")
    ap.add_argument("--app", help="carpeta data/ de la app: escribe data/web/NN.json")
    ap.add_argument("--catalogo", help="catalogo.json de la app: exporta solo esos EAN")
    args = ap.parse_args()
    args.tiendas = [t.strip() for t in args.tiendas.split(",") if t.strip()]
    malas = [t for t in args.tiendas if t not in TODAS]
    if malas:
        ap.error(f"tiendas desconocidas: {malas}")
    os.makedirs(args.salida, exist_ok=True)
    almacen = Almacen(os.path.join(args.salida, "tiendas.sqlite"))
    t0 = time.time()
    asyncio.run(correr(args, almacen))
    corte = (datetime.now(timezone.utc) - timedelta(days=args.dias_vigencia)).isoformat(timespec="seconds")
    for t in args.tiendas:
        n = almacen.borrar_viejos(t, corte)
        if n:
            log(f"  {t}: {n} productos viejos borrados")
    n = almacen.exportar_json(os.path.join(args.salida, "productos.json"))
    resumen = {t: almacen.contar(t) for t in TODAS}
    json.dump({"fecha": datetime.now(timezone.utc).isoformat(timespec="seconds"), "productos": resumen},
              open(os.path.join(args.salida, "resumen.json"), "w"), indent=1)
    log(f"✔ {n:,} productos en {args.salida}/productos.json · {resumen} · {time.time() - t0:.0f}s")
    if args.app:
        k = exportar_app(almacen, args.app, args.catalogo)
        log(f"✔ app: {k:,} productos con foto y enlace en {args.app}/web/")
    almacen.cerrar()


if __name__ == "__main__":
    main()
