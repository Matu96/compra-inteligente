"""coto_scraper.py — catálogo completo de Coto Digital (Oracle Endeca / ATG).

1. Sesión: abre la web con Playwright (cookies de sesión y sucursal) y mira qué pedidos JSON hace la página
   para listar productos (el sitio pide la misma URL con format=json). Si no hace falta navegador, va directo.
2. Recorre todo el catálogo de a --nrpp registros (parámetros Endeca No / Nrpp) con aiohttp.
3. Cada registro trae atributos 'product.*' y 'sku.*': precio activo, precio de referencia, EAN, marca, imagen
   y los descuentos (Comunidad Coto, 2x1, 2da al 70 %, bancos) en product.dtoDescuentos.
"""
import asyncio
import json
import re
from urllib.parse import quote, parse_qsl, urlencode, urlsplit, urlunsplit

from tqdm import tqdm

from promo_parser import promo, precio_explicito
from red import Cliente
from storage import ahora

BASE = "https://www.cotodigital.com.ar"
SUCURSAL = "200"
# Candidatas (en orden) para listar todo el catálogo en JSON; la que use la página tiene prioridad.
CANDIDATAS = [
    f"{BASE}/sitios/cdigi/categoria?Dy=1&format=json",
    f"{BASE}/sitios/cdigi/categoria/_/N-1?format=json",
    f"{BASE}/sitios/cdigi/browse?format=json",
    "https://www.cotodigital3.com.ar/sitios/cdigi/browse?format=json",
]
PAGINA_PRUEBA = f"{BASE}/sitios/cdigi/categoria/catalogo-almacen/_/N-8pub5z"


# ------------------------------------------------------------ lectura de la respuesta Endeca
def registros(nodo):
    """Busca en cualquier parte del JSON los registros de producto (dicts con 'attributes')."""
    if isinstance(nodo, dict):
        if isinstance(nodo.get("attributes"), dict) and any(k.startswith(("product.", "sku.")) for k in nodo["attributes"]):
            hijos = nodo.get("records")
            if isinstance(hijos, list) and hijos and isinstance(hijos[0], dict) and "attributes" in hijos[0]:
                # registro agrupado: el producto con sus SKU adentro; el SKU hereda lo del producto
                for h in hijos:
                    h = dict(h)
                    h["attributes"] = {**nodo["attributes"], **h.get("attributes", {})}
                    yield h
            else:
                yield nodo
            return
        for v in nodo.values():
            yield from registros(v)
    elif isinstance(nodo, list):
        for v in nodo:
            yield from registros(v)


def total_registros(nodo):
    """'totalNumRecs' de la lista de resultados (el mayor que aparezca)."""
    mejor = 0
    if isinstance(nodo, dict):
        for k, v in nodo.items():
            if k in ("totalNumRecs", "totalNumberOfRecords", "totalRecNum") and isinstance(v, (int, str)) and str(v).isdigit():
                mejor = max(mejor, int(v))
            else:
                mejor = max(mejor, total_registros(v))
    elif isinstance(nodo, list):
        for v in nodo:
            mejor = max(mejor, total_registros(v))
    return mejor


def _uno(attrs, *claves):
    for k in claves:
        v = attrs.get(k)
        if isinstance(v, list):
            v = next((x for x in v if x not in (None, "")), None)
        if v not in (None, ""):
            return v
    return None


def _precio(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip()
    if re.fullmatch(r"\$?\s*\d+(\.\d{1,6})?", s):          # "2205.00", "$2205.00": punto decimal
        return float(s.lstrip("$ "))
    if "$" in s or "," in s:
        p = precio_explicito(s if "$" in s else "$" + s)
        if p:
            return p
    try:
        return float(s)
    except ValueError:
        return None


def _slug(t):
    t = re.sub(r"[^a-z0-9]+", "-", (t or "").lower()).strip("-")
    return t or "producto"


def _json(v):
    if isinstance(v, list):
        v = v[0] if v else None
    if isinstance(v, str) and v.strip().startswith(("[", "{")):
        try:
            return json.loads(v)
        except json.JSONDecodeError:
            return None
    return v


_SOLO_PCT = re.compile(r"^\s*\d{1,2}\s*%\s*(dto\.?|descuento|off)?\s*$", re.I)


def _descuentos(attrs, lista):
    """product.dtoDescuentos (ofertas del súper: 40%Dto, 2x1, 2do al 70 %, Comunidad Coto) y
    product.dtoDescuentosMediosPago (bancos y billeteras). Devuelve (promos, precio directo o None)."""
    promos, directo = [], None
    for d in _json(attrs.get("product.dtoDescuentos")) or []:
        if not isinstance(d, dict):
            continue
        texto = " ".join(x for x in (str(d.get("textoDescuento") or "").strip(), str(d.get("precioDescTextoAdicional") or "").strip()) if x)
        pu = _precio(d.get("precioDesc")) or _precio(d.get("precioDescuento"))
        if not texto:
            continue
        p = promo(texto, lista, pu if pu and pu < lista else None)
        if p["tipo"] == "directa" and _SOLO_PCT.match(texto) and p["precio_unitario_promo"]:
            # "40%Dto" sin condición: es el precio de góndola de hoy
            directo = min(directo or 1e18, p["precio_unitario_promo"])
        if d.get("comentarios") and "no acumulable" in str(d["comentarios"]).lower():
            p["descripcion"] += " (no acumulable)"
        promos.append(p)
    for d in _json(attrs.get("product.dtoDescuentosMediosPago")) or []:
        if not isinstance(d, dict):
            continue
        # cuotas sin interés: {"cantidadCuotas": "12", "precioCuota": "$16194.67", "imagenDescuento": ".../pagando-con-todas-tarjetas.png"}
        texto = str(d.get("textoDescuento") or d.get("descripcion") or "").strip()
        if not texto and d.get("cantidadCuotas"):
            cuota = _precio(d.get("precioCuota"))
            quien = re.sub(r"[-_]+", " ", re.sub(r"^.*/|\.\w+$", "", str(d.get("imagenDescuento") or ""))).strip()
            quien = quien.replace("pagando ", "", 1) if quien else "con tarjeta"
            texto = f"{d['cantidadCuotas']} cuotas sin interés" + (f" de ${cuota:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".") if cuota else "") + f" {quien}"
        if texto:
            promos.append({"tipo": "bancaria", "descripcion": texto, "precio_unitario_promo": None})
    unicas, vistos = [], set()
    for p in promos:
        k = p["descripcion"].lower()
        if k and k not in vistos:
            vistos.add(k)
            unicas.append(p)
    return unicas, directo


def parsear(reg, fecha):
    a = reg.get("attributes") or {}
    sku = _uno(a, "sku.repositoryId", "product.repositoryId", "record.id", "product.id")
    nombre = _uno(a, "product.displayName", "sku.displayName", "product.description")
    if not sku or not nombre:
        return None
    sku = str(sku).strip()
    # sku.activePrice = precio de góndola; sku.referencePrice es por kilo/litro (no sirve como lista)
    dto_precio = _json(a.get("sku.dtoPrice")) or {}
    lista = _precio(dto_precio.get("precioLista") if isinstance(dto_precio, dict) else None) or _precio(_uno(a, "sku.activePrice", "product.activePrice"))
    if not lista or lista <= 0:
        return None
    promos, directo = _descuentos(a, lista)
    final = directo if directo and directo < lista else lista
    disp = _uno(a, "product.sDisp_" + SUCURSAL, "sku.sDisp_" + SUCURSAL, "sku.stockAvailable")
    if disp is not None and str(disp).strip().lower() in ("0", "false", "no"):
        return None
    img = _uno(a, "product.mediumImage.url", "product.largeImage.url", "sku.mediumImage.url", "product.smallImage.url",
               "product.imagen", "sku.imagen")
    if img:
        img = img.replace("/fotos/medium/", "/fotos/large/").replace("/fotos/small/", "/fotos/large/")
    if img:
        img = quote(img, safe="/%-._~!$&'()*+,;=:@?#")       # espacios o tildes en la dirección
    if img and img.startswith("//"):
        img = "https:" + img
    elif img and img.startswith("/"):
        img = "https://static.cotodigital3.com.ar" + img
    if not img or not img.startswith("https://"):
        return None
    ean = _uno(a, "product.eanPrincipal", "sku.eanPrincipal", "product.ean", "sku.ean", "product.EAN")
    ean = str(ean).strip() if ean else None
    if ean and not re.fullmatch(r"\d{6,14}", ean):
        ean = None
    desc = round((1 - final / lista) * 100) if lista > final else 0
    num = re.sub(r"\D", "", sku)
    rid = _uno(a, "record.id") or f"{num}-{num}-{SUCURSAL}"
    url = f"{BASE}/sitios/cdigi/productos/{_slug(nombre)}/_/R-{rid}"
    return {
        "tienda": "coto", "ean": ean, "sku_tienda": sku, "nombre": str(nombre).strip(),
        "marca": (str(_uno(a, "product.brand", "product.MARCA", "product.marca", "sku.brand") or "").strip() or None),
        "precio_lista": lista, "precio_final": final, "descuento_porcentaje": desc,
        "promociones": promos, "image_url": img, "product_url": url, "fecha_extraccion": fecha,
    }


def con_params(url, **cambios):
    p = urlsplit(url)
    q = [(k, v) for k, v in parse_qsl(p.query, keep_blank_values=True) if k not in cambios]
    q += [(k, str(v)) for k, v in cambios.items() if v is not None]
    return urlunsplit((p.scheme, p.netloc, p.path, urlencode(q, safe="|:(),"), ""))


# ------------------------------------------------------------ sesión con navegador (Playwright)
async def sesion_navegador(log=print, muestra=None):
    """Abre la web como un navegador: devuelve (cookies, urls JSON que pidió la página)."""
    from playwright.async_api import async_playwright
    vistas = []
    async with async_playwright() as p:
        nav = await p.chromium.launch(headless=True)
        ctx = await nav.new_context(locale="es-AR", user_agent=None)
        pag = await ctx.new_page()

        async def mirar(resp):
            try:
                if "json" in (resp.headers.get("content-type") or "") or "format=json" in resp.url:
                    datos = await resp.json()
                    if any(True for _ in registros(datos)):
                        vistas.append(resp.url)
                        if muestra and not vistas[1:]:
                            json.dump(datos, open(muestra, "w"), ensure_ascii=False)
            except Exception:
                pass
        pag.on("response", mirar)
        for url in (BASE, PAGINA_PRUEBA):
            try:
                await pag.goto(url, wait_until="networkidle", timeout=60000)
            except Exception as e:
                log(f"  coto: {url} → {e}")
        cookies = {c["name"]: c["value"] for c in await ctx.cookies()}
        await nav.close()
    log(f"coto: navegador listo, {len(cookies)} cookies, {len(vistas)} pedidos JSON de productos")
    for u in vistas[:3]:
        log(f"  · {u[:200]}")
    return cookies, vistas


class TiendaCoto:
    def __init__(self, almacen, rps=2, concurrencia=4, nrpp=200, max_paginas=None, navegador=True, muestra=None, log=print):
        self.almacen, self.rps, self.conc, self.nrpp = almacen, rps, concurrencia, nrpp
        self.max_paginas, self.navegador, self.muestra, self.log = max_paginas, navegador, muestra, log

    async def plantilla(self, cli, vistas):
        """Primera URL que devuelva registros: las que usó la página (sin la categoría = todo el catálogo) y las candidatas."""
        probar = []
        for u in vistas:
            probar.append(re.sub(r"/_/N-[^/?]+", "", u))          # sin categoría: todo el catálogo
            probar.append(u)
        probar += CANDIDATAS
        for u in dict.fromkeys(probar):
            try:
                datos, _ = await cli.get(con_params(u, No=0, Nrpp=self.nrpp, format="json"))
            except Exception as e:
                self.log(f"  coto: {u[:120]} → {e}")
                continue
            n = sum(1 for _ in registros(datos))
            tot = total_registros(datos)
            self.log(f"  coto: {u[:120]} → {n} registros, total {tot}")
            if n:
                if self.muestra:
                    json.dump(datos, open(self.muestra, "w"), ensure_ascii=False)
                return u, tot, datos
        raise RuntimeError("Coto: ninguna URL devolvió productos (ver la muestra y los logs)")

    async def correr(self):
        fecha = ahora()
        cookies, vistas = {}, []
        if self.navegador:
            try:
                cookies, vistas = await sesion_navegador(self.log, self.muestra)
            except Exception as e:
                self.log(f"coto: sin navegador ({e}); sigo sin cookies")
        cli = Cliente(rps=self.rps, concurrencia=self.conc, cookies=cookies,
                      headers={"Referer": BASE + "/sitios/cdigi/", "Accept": "application/json, text/html;q=0.8"})
        try:
            url, total, primera = await self.plantilla(cli, vistas)
            paginas = list(range(0, max(total, self.nrpp), self.nrpp))
            if self.max_paginas:
                paginas = paginas[: self.max_paginas]
            self.log(f"coto: {total} registros en {len(paginas)} páginas de {self.nrpp}")
            barra = tqdm(total=len(paginas), desc="coto", unit="pág", mininterval=5)

            async def una(no):
                clave = f"No={no}&Nrpp={self.nrpp}"
                if self.almacen.hecha("coto", clave):
                    barra.update(1)
                    return
                try:
                    datos = primera if no == 0 else (await cli.get(con_params(url, No=no, Nrpp=self.nrpp, format="json")))[0]
                    filas = [f for f in (parsear(r, fecha) for r in registros(datos)) if f]
                    self.almacen.guardar(filas)
                    self.almacen.marcar("coto", clave)
                except Exception as e:
                    self.log(f"  ✗ coto página {no}: {e}")
                barra.update(1)
            await asyncio.gather(*(una(no) for no in paginas))
            barra.close()
        finally:
            await cli.cerrar()
        return {"tienda": "coto", "productos": self.almacen.contar("coto"), "pedidos": cli.pedidos,
                "reintentos": cli.errores, "inicio": fecha}
