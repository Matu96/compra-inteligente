"""vtex_scraper.py — catálogo completo de las tiendas VTEX (Jumbo, Disco, Vea, Carrefour, Día).

Recorre el árbol de categorías y pide /api/catalog_system/pub/products/search de a 50. VTEX no deja pasar del
ítem 2500 en una misma búsqueda: si una categoría tiene más, se parte por rangos de precio (fq=P:[a TO b]) hasta
que cada parte entre.
"""
import asyncio
import re
from urllib.parse import quote, urlsplit, urlunsplit

from tqdm import tqdm

from promo_parser import promo
from red import Cliente
from storage import ahora

TIENDAS = {
    "jumbo": "https://www.jumbo.com.ar",
    "disco": "https://www.disco.com.ar",
    "vea": "https://www.vea.com.ar",
    "carrefour": "https://www.carrefour.com.ar",
    "dia": "https://diaonline.supermercadosdia.com.ar",
    "chango": "https://www.masonline.com.ar",          # Chango Más / Más Online (ex Walmart)
}
PAGINA = 50
TOPE = 2500            # VTEX corta en _from + 50 <= 2500
PRECIO_MAX = 10_000_000

# Cucardas y colecciones que describen una promo concreta (no secciones como "Almacén" ni campañas internas)
_ES_PROMO = re.compile(r"\d+\s*%|\b\d+\s*x\s*\d+\b|\b[234]\s*(da|do|ra|ro)\b|segunda unidad|llevando|cuotas|\bcsi\b|cencopay|"
                       r"banco|visa|master|naranja|mercado ?pago|\bmodo\b|cuenta dni|comunidad|mi carrefour|club d[ií]a|"
                       r"jumbo ?\+|disco ?\+|precio exclusivo", re.I)
_BASURA = re.compile(r"_|mailing|carousel|ver m[aá]s|cup[oó]n|env[ií]o|colecci|cucarda|todas las ofertas|\bs\d{2}\b", re.I)


def _limpio(d):
    """VTEX devuelve los Teasers con claves '<Name>k__BackingField': las dejamos como 'Name'."""
    if isinstance(d, dict):
        return {re.sub(r"^<(.+)>k__BackingField$", r"\1", k): _limpio(v) for k, v in d.items()}
    if isinstance(d, list):
        return [_limpio(x) for x in d]
    return d


def _imagen(url, tam=500):
    """.../arquivos/ids/123456/foo.jpg?v=1 → .../arquivos/ids/123456-500-500/foo.jpg?v=1"""
    if not url:
        return None
    url = url.replace("http://", "https://", 1)
    p = urlsplit(url)            # espacios o tildes en el nombre del archivo: codificados, si no el navegador falla
    url = urlunsplit((p.scheme, p.netloc, quote(p.path, safe="/%-._~!$&'()*+,;=:@"), p.query, ""))
    return re.sub(r"(/arquivos/ids/\d+)(?:-\d+-\d+)?/", rf"\1-{tam}-{tam}/", url, count=1)


def _num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def _teasers(oferta, precio):
    """Teasers / PromotionTeasers: las reglas reales de 2x1, 3x2, 2da al X %, por cantidad y de programas."""
    out = []
    for t in _limpio((oferta.get("Teasers") or []) + (oferta.get("PromotionTeasers") or [])):
        nombre = (t.get("Name") or "").strip()
        if not nombre:
            continue
        cond = t.get("Conditions") or {}
        efectos = {p.get("Name"): p.get("Value") for p in (t.get("Effects") or {}).get("Parameters") or []}
        p = promo(nombre, precio)
        if p["precio_unitario_promo"] is None and p["tipo"] != "bancaria":
            pct = _num(efectos.get("PercentualDiscount"))
            minimo = int(_num(cond.get("MinimumQuantity")) or 1)
            if pct and 0 < pct < 100:
                p["precio_unitario_promo"] = round(precio * (1 - pct / 100), 2)
                if minimo > 1 and "llev" not in p["descripcion"].lower():
                    p["descripcion"] += f" (llevando {minimo})"
        out.append(p)
    return out


def _clusters(prod, precio):
    out = []
    vistos = set()
    for fuente in ("clusterHighlights", "productClusters"):
        for nombre in (prod.get(fuente) or {}).values():
            nombre = (nombre or "").strip()
            if not nombre or nombre.lower() in vistos:
                continue
            if not _ES_PROMO.search(nombre) or _BASURA.search(nombre):
                continue
            vistos.add(nombre.lower())
            out.append(promo(nombre, precio))
    return out


def parsear(tienda, base, prod, fecha):
    """Un producto VTEX → filas del esquema (una por SKU con stock e imagen)."""
    filas = []
    for item in prod.get("items") or []:
        vendedores = item.get("sellers") or []
        vend = next((s for s in vendedores if s.get("sellerDefault")), vendedores[0] if vendedores else None)
        if not vend:
            continue
        of = vend.get("commertialOffer") or {}
        if not of.get("AvailableQuantity") or of.get("IsAvailable") is False:
            continue
        final, lista = _num(of.get("Price")), _num(of.get("ListPrice"))
        if not final or final <= 0:
            continue
        # Jumbo/Disco/Vea mandan a veces un ListPrice sin sentido (x80); entonces vale PriceWithoutDiscount
        if not lista or lista < final or lista > final * 3:
            sin = _num(of.get("PriceWithoutDiscount"))
            lista = sin if sin and final <= sin <= final * 3 else final
        img = next((_imagen(i.get("imageUrl")) for i in item.get("images") or [] if i.get("imageUrl")), None)
        if not img or not img.startswith("https://"):
            continue
        promos = _teasers(of, final) + _clusters(prod, final)
        # descuento directo (ListPrice > Price) también como promo, para ordenar ofertas
        desc = round((1 - final / lista) * 100) if lista > final else 0
        if desc:
            promos.insert(0, {"tipo": "directa", "descripcion": f"{desc}% off", "precio_unitario_promo": final})
        # sin repetidos (mismo texto)
        unicas, vistos = [], set()
        for p in promos:
            k = p["descripcion"].lower()
            if k not in vistos:
                vistos.add(k)
                unicas.append(p)
        ean = (item.get("ean") or "").strip() or None
        if ean and not re.fullmatch(r"\d{6,14}", ean):
            ean = None
        filas.append({
            "tienda": tienda, "ean": ean, "sku_tienda": str(item.get("itemId")),
            "nombre": (item.get("nameComplete") or prod.get("productName") or "").strip(),
            "marca": (prod.get("brand") or "").strip() or None,
            "precio_lista": lista, "precio_final": final, "descuento_porcentaje": desc,
            "promociones": unicas, "image_url": img,
            "product_url": f"{base}/{prod['linkText']}/p" if prod.get("linkText") else prod.get("link"),
            "fecha_extraccion": fecha,
        })
    return filas


class TiendaVtex:
    def __init__(self, tienda, almacen, rps=4, concurrencia=6, max_categorias=None, log=print):
        self.tienda, self.base = tienda, TIENDAS[tienda]
        self.almacen, self.rps, self.conc = almacen, rps, concurrencia
        self.max_categorias, self.log = max_categorias, log
        self.api = f"{self.base}/api/catalog_system/pub"

    async def hojas(self, cli):
        """Categorías hoja del árbol (nivel 3), con su ruta de ids: '1/12/123'."""
        arbol, _ = await cli.get(f"{self.api}/category/tree/3")
        hojas = []

        def recorrer(nodos, ruta):
            for n in nodos or []:
                r = ruta + [str(n["id"])]
                if n.get("children"):
                    recorrer(n["children"], r)
                else:
                    hojas.append(("/".join(r), n.get("name", "")))
        recorrer(arbol, [])
        return hojas

    async def total(self, cli, fq):
        datos, h = await cli.get(f"{self.api}/products/search", params=[*fq, ("_from", 0), ("_to", 0)])
        m = re.search(r"/(\d+)", h.get("resources", "") or "")
        return int(m.group(1)) if m else len(datos or [])

    async def partes(self, cli, ruta):
        """Divide la categoría en búsquedas de ≤ 2500 ítems. Primero por rango de precio (fq=P:[a TO b]); si la
        tienda no acepta ese filtro (Cencosud y Carrefour devuelven 400), pide la categoría con varios órdenes
        distintos (precio ↑↓, nombre ↑↓, más vendidos…): cada orden trae otros 2500 y se deduplica por SKU."""
        base = [("fq", f"C:/{ruta}/")]
        n = await self.total(cli, base)
        if n <= TOPE:
            return [(base, n)] if n else []
        try:
            out, pila = [], [(0, PRECIO_MAX)]
            while pila:
                a, b = pila.pop()
                fq = base + [("fq", f"P:[{a} TO {b}]")]
                k = await self.total(cli, fq)
                if not k:
                    continue
                if k <= TOPE or b - a < 1:
                    out.append((fq, min(k, TOPE)))
                else:
                    medio = round((a + b) / 2, 2)
                    pila += [(a, medio), (round(medio + 0.01, 2), b)]
            return out
        except PermissionError:
            ordenes = ["OrderByPriceASC", "OrderByPriceDESC", "OrderByNameASC", "OrderByNameDESC",
                       "OrderByTopSaleDESC", "OrderByReleaseDateDESC", "OrderByBestDiscountDESC"]
            usar = ordenes[: min(len(ordenes), -(-n // TOPE) + 2)]     # algunos de más: los órdenes se pisan
            self.log(f"  {self.tienda}: categoría {ruta} con {n} productos → {len(usar)} órdenes")
            return [(base + [("O", o)], TOPE) for o in usar]

    async def bajar(self, cli, fq, n, fecha):
        filas = []
        desdes = range(0, min(n, TOPE), PAGINA)
        respuestas = await asyncio.gather(*(cli.get(f"{self.api}/products/search", params=[*fq, ("_from", d), ("_to", d + PAGINA - 1)])
                                            for d in desdes), return_exceptions=True)
        for r in respuestas:
            if isinstance(r, Exception):
                self.log(f"  ⚠ {self.tienda}: {r}")
                continue
            for prod in r[0] or []:
                try:
                    filas += parsear(self.tienda, self.base, prod, fecha)
                except Exception as e:      # un producto raro no frena la categoría
                    self.log(f"  ⚠ {self.tienda}: producto {prod.get('productId')}: {e}")
        return filas

    async def correr(self):
        fecha = ahora()
        cli = Cliente(rps=self.rps, concurrencia=self.conc)
        try:
            hojas = await self.hojas(cli)
            if self.max_categorias:
                hojas = hojas[: self.max_categorias]
            pendientes = [(r, nom) for r, nom in hojas if not self.almacen.hecha(self.tienda, r)]
            self.log(f"{self.tienda}: {len(hojas)} categorías ({len(hojas) - len(pendientes)} ya hechas)")
            barra = tqdm(total=len(pendientes), desc=self.tienda, unit="cat", mininterval=5)
            sem = asyncio.Semaphore(3)            # categorías en paralelo; los pedidos los limita el Cliente

            async def una(ruta, nombre):
                async with sem:
                    try:
                        guardadas = 0
                        for fq, n in await self.partes(cli, ruta):
                            guardadas += self.almacen.guardar(await self.bajar(cli, fq, n, fecha))
                        self.almacen.marcar(self.tienda, ruta)
                        barra.set_postfix_str(f"{nombre[:20]}: {guardadas}", refresh=False)
                    except Exception as e:
                        self.log(f"  ✗ {self.tienda} {nombre} ({ruta}): {e}")
                    barra.update(1)
            await asyncio.gather(*(una(r, nom) for r, nom in pendientes))
            barra.close()
        finally:
            await cli.cerrar()
        return {"tienda": self.tienda, "productos": self.almacen.contar(self.tienda), "pedidos": cli.pedidos,
                "reintentos": cli.errores, "inicio": fecha}
