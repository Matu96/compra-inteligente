#!/usr/bin/env python3
"""
sepa_import.py — Baja la base SEPA (Precios Claros) del día y arma el archivo de datos
para la app Compra Inteligente, filtrado por ubicación.

Solo usa la biblioteca estándar de Python 3.9+.

Ejemplos:
  # Caballito, 5 km a la redonda, datos del día de hoy
  python3 sepa_import.py --lat -34.6186 --lng -58.4410 --radio 5 --nombre "Caballito"

  # Toda una provincia (sin filtro por distancia)
  python3 sepa_import.py --provincia AR-B --nombre "Provincia de Buenos Aires"

  # Usar un ZIP ya descargado y guardar también en SQLite
  python3 sepa_import.py --zip sepa_lunes.zip --lat -34.64 --lng -58.56 --radio 4 --sqlite sepa.db

Salida: compra_inteligente_<fecha>.json  → se carga en el prototipo con "Cargar datos reales".

Marcas: cada producto lleva "tipo" (producto genérico = descripción sin la marca + presentación),
así la app puede ofrecer "elegir marca" o "cualquier marca, la más barata". El filtro de cobertura
se aplica por tipo (no por EAN) para no perder las marcas baratas que tienen menos sucursales.
"""
import argparse, csv, io, json, math, os, re, shutil, sqlite3, subprocess, sys, time, unicodedata, urllib.request, zipfile
from collections import Counter, defaultdict
from datetime import date, datetime

CKAN_URL = "https://datos.produccion.gob.ar/api/3/action/package_show?id=sepa-precios"
DIAS = ["lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo"]  # date.weekday()
# El servidor rechaza (403) pedidos con el User-Agent por defecto de Python: nos presentamos como un navegador.
HEADERS = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
           "Accept": "application/json, application/zip, */*", "Accept-Language": "es-AR,es;q=0.9"}
# Plan B si la API del catálogo falla: cada día de la semana es un recurso fijo que se reemplaza semanalmente.
_BASE = "https://datos.produccion.gob.ar/dataset/6f47ec76-d1ce-4e34-a7e1-621fe9b1d0b5/resource/"
URLS_FIJAS = {
    "lunes": _BASE + "0a9069a9-06e8-4f98-874d-da5578693290/download/sepa_lunes.zip",
    "martes": _BASE + "9dc06241-cc83-44f4-8e25-c9b1636b8bc8/download/sepa_martes.zip",
    "miercoles": _BASE + "1e92cd42-4f94-4071-a165-62c4cb2ce23c/download/sepa_miercoles.zip",
    "jueves": _BASE + "d076720f-a7f0-4af8-b1d6-1b99d5a90c14/download/sepa_jueves.zip",
    "viernes": _BASE + "91bc072a-4726-44a1-85ec-4a8467aad27e/download/sepa_viernes.zip",
    "sabado": _BASE + "b3c3da5d-213d-41e7-8d74-f23fda0a3c30/download/sepa_sabado.zip",
    "domingo": _BASE + "f8e75128-515a-436e-bf8d-5c63a62f2005/download/sepa_domingo.zip",
}

# Espejo público (proyecto preciazo): copia diaria de cada archivo SEPA, ya descomprimido, en .tar.zst.
# Se usa si datos.produccion.gob.ar rechaza la descarga (bloquea, por ejemplo, a los servidores de GitHub).
ESPEJO_INDICE = "https://raw.githubusercontent.com/catdevnull/sepa-precios-metadata/main/index.json"

def abrir(url, timeout=60):
    return urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=timeout)

csv.field_size_limit(10_000_000)


# ---------------------------------------------------------------- utilidades
def sin_tildes(s):
    return "".join(c for c in unicodedata.normalize("NFD", s or "") if unicodedata.category(c) != "Mn").lower()

def km(lat1, lng1, lat2, lng2):
    r = math.radians
    a = math.sin(r(lat2 - lat1) / 2) ** 2 + math.cos(r(lat1)) * math.cos(r(lat2)) * math.sin(r(lng2 - lng1) / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(a))

def num(x):
    if x is None:
        return None
    x = x.strip().replace("$", "")
    if not x:
        return None
    if "," in x and "." in x:          # 1.234,56
        x = x.replace(".", "").replace(",", ".")
    elif "," in x:
        x = x.replace(",", ".")
    try:
        v = float(x)
        return v if v > 0 else None
    except ValueError:
        return None

def log(*a):
    print(*a, file=sys.stderr, flush=True)

def clave_cadena(bandera):
    """Normaliza el nombre de bandera a la clave que usa la app (promos bancarias)."""
    s = sin_tildes(bandera)
    reglas = [(r"chango\s*mas|changomas|chango", "chango"), ("carrefour", "carrefour"), ("jumbo", "jumbo"), ("disco", "disco"),
              ("coto", "coto"), ("anonima", "anonima"), ("cooperativa obrera", "coope"), ("vea", "vea"),
              ("vital", "vital"), ("diarco", "diarco"), ("maxiconsumo", "maxiconsumo"), ("toledo", "toledo"),
              ("libertad", "libertad"), ("josimar", "josimar"), ("nini", "nini")]
    for patron, k in reglas:
        if re.search(r"\b(?:" + patron + r")\b", s):
            return k
    if re.search(r"\bdia\b", s):
        return "dia"
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-") or "otro"


# ---------------------------------------------------------------- producto genérico (para elegir marca)
_UNIDADES = r"(kg|kgs|kgm|kgr|g|gr|grs|grm|l|lt|lts|ltr|ml|mlt|cc|cm3|un|u|uni|unid|unidades)"

# Reglas de producto genérico: la primera que matchea gana. {1}/{2} = grupos capturados.
# Así "Yerba Mate Canarias Serena 1 Kg" y "Yerba Playadito Suave 1 Kg" caen juntas en "Yerba mate 1 kg".
REGLAS_TIPO = [
    (r"\byerba\b.*\b(compuesta|hierbas|saborizada|sabor|naranja|limon|menta|boldo|cedron|burrito)\b", "Yerba compuesta o saborizada"),
    (r"\byerba\b", "Yerba mate"),
    (r"\bdulce de leche\b", "Dulce de leche"),
    (r"\bleche\b.*\ben polvo\b", "Leche en polvo"),
    (r"\bleche\b.*\b(descremada|parcialmente descremada)\b", "Leche descremada"),
    (r"\bleche\b.*\bentera\b", "Leche entera"),
    (r"\byogur\w*\b.*\bbebible\b", "Yogur bebible"),
    (r"\byogur\w*\b", "Yogur"),
    (r"\bmanteca\b", "Manteca"),
    (r"\bqueso\b.*\b(cremoso|rallado|untable|cuartirolo|tybo|barra|en fetas)\b", "Queso {1}"),
    (r"\bfideos?\b.*\b(tirabuzon|spaghetti|tallarin\w*|mostachol\w*|codito\w*|monito\w*|municion|cinta\w*|fusilli|penne|rigatti|vermicelli|nido\w*)\b", "Fideos {1}"),
    (r"\b(fideos?|spaghetti|tallarin\w*)\b", "Fideos"),
    (r"\barroz\b.*\b(largo fino|doble carolina|integral|parboil\w*|yamani|blanco)\b", "Arroz {1}"),
    (r"\barroz\b", "Arroz"),
    (r"\baceite\b.*\b(girasol|maiz|oliva|mezcla|canola|soja)\b", "Aceite de {1}"),
    (r"\bazucar\b", "Azúcar"),
    (r"\bharina\b.*\b(0000|000|leudante|integral|de maiz)\b", "Harina {1}"),
    (r"\bcafe\b.*\b(molido|instantaneo|en grano|torrado|capsulas)\b", "Café {1}"),
    (r"\b(gaseosa|bebida)\b.*\bcola\b|\bcoca.?cola\b|\bpepsi\b", "Gaseosa cola"),
    (r"\bgaseosa\b.*\b(lima limon|lima|limon|naranja|pomelo|tonica)\b", "Gaseosa {1}"),
    (r"\bagua\b.*\b(con gas|gasificada|soda)\b", "Agua con gas"),
    (r"\bagua\b.*\b(mineral|mineralizada|sin gas)\b", "Agua sin gas"),
    (r"\bcerveza\b", "Cerveza"),
    (r"\bdetergente\b", "Detergente"),
    (r"\blavandina\b", "Lavandina"),
    (r"\bpapel higienico\b", "Papel higiénico"),
    (r"\brollo de cocina\b", "Rollo de cocina"),
    (r"\bjabon\b.*\bpolvo\b", "Jabón en polvo"),
    (r"\bjabon\b.*\bliquido\b", "Jabón líquido"),
    (r"\bsuavizante\b", "Suavizante"),
    (r"\bpan\b.*\b(lactal|de molde|blanco)\b", "Pan lactal"),
    (r"\bgalletitas?\b.*\b(agua|crackers)\b", "Galletitas de agua"),
    (r"\b(tomate|pure de tomate)\b.*\b(triturado|pure|perita|entero)\b", "Tomate {2}"),
    (r"\bhuevos?\b", "Huevos"),
    (r"\bmayonesa\b", "Mayonesa"),
    (r"\batun\b", "Atún"),
    (r"\bshampoo\b", "Shampoo"),
    (r"\b(pasta|crema) dental\b", "Pasta dental"),
]
_TILDES = {"tirabuzon": "tirabuzón", "tallarin": "tallarín", "tallarines": "tallarines", "municion": "munición",
           "monito": "moñito", "monitos": "moñitos", "maiz": "maíz", "de maiz": "de maíz", "instantaneo": "instantáneo",
           "limon": "limón", "lima limon": "lima limón", "tonica": "tónica", "pure": "puré", "yamani": "yamaní"}

def presentacion_canonica(presentacion):
    """'1.00 kg' / '1000 gr' → ('1000g', '1 kg'). Permite agrupar la misma presentación aunque esté escrita distinto."""
    m = re.search(r"([\d.,]+)\s*([a-z0-9]+)", sin_tildes(presentacion))
    if not m:
        return sin_tildes(presentacion).strip(), ""
    try:
        v = float(m.group(1).replace(",", "."))
    except ValueError:
        return sin_tildes(presentacion).strip(), presentacion.strip()
    u = m.group(2)
    # SEPA usa varias formas para la misma unidad: "kgm", "grm", "ltr", "mlt", "uni"…
    if u in ("kg", "kgs", "kgm", "kgr", "kilo", "kilos", "kilogramo", "kilogramos"):
        v, u = v * 1000, "g"
    elif u in ("g", "gr", "grs", "grm", "grms", "gramo", "gramos"):
        u = "g"
    elif u in ("l", "lt", "lts", "ltr", "ltrs", "litro", "litros"):
        v, u = v * 1000, "ml"
    elif u in ("ml", "mlt", "mls", "cc", "cm3", "cm"):
        u = "ml"
    elif u in ("un", "u", "uni", "unid", "unidad", "unidades", "und", "uds"):
        u = "u"
    v = round(v)
    if u == "g":
        vis = f"{v/1000:g} kg" if v >= 1000 else f"{v} g"
    elif u == "ml":
        vis = f"{v/1000:g} L".replace(".", ",") if v >= 1000 else f"{v} ml"
    elif u == "u":
        vis = f"x{v}"
    else:
        vis = f"{v} {u}"
    return f"{v}{u}", vis

def tipo_de(nombre, marca, presentacion):
    """'Yerba Mate Canarias Serena 1 Kg' + 'CANARIAS' + '1 kg' → ('yerba mate|1000g', 'Yerba mate 1 kg').
    Primero prueba las reglas curadas; si ninguna aplica, usa la descripción sin la marca ni cantidades."""
    s = " " + re.sub(r"[^a-z0-9%]+", " ", sin_tildes(nombre)) + " "
    clave_pres, vis_pres = presentacion_canonica(presentacion)
    for patron, plantilla in REGLAS_TIPO:
        m = re.search(patron, s)
        if m:
            gen = re.sub(r"\{(\d)\}", lambda g: _TILDES.get(m.group(int(g.group(1))) or "", m.group(int(g.group(1))) or ""), plantilla)
            return f"{sin_tildes(gen)}|{clave_pres}", f"{gen} {vis_pres}".strip()
    d = s
    for w in re.split(r"[^a-z0-9]+", sin_tildes(marca)):
        if len(w) > 1:
            d = d.replace(" " + w + " ", " ")
    d = re.sub(r" \d+([.,]\d+)? ?" + _UNIDADES + r"(?= )", " ", d)
    d = re.sub(r" x ?\d+(?= )", " ", d)
    d = re.sub(r"\s+", " ", d).strip()
    visible = (d[:1].upper() + d[1:]) if d else nombre.strip()
    return f"{d}|{clave_pres}", f"{visible} {vis_pres}".strip()


# ---------------------------------------------------------------- promos del súper
def parsear_promo(leyenda):
    """Convierte la leyenda libre de SEPA en algo que el motor sepa calcular por cantidad.
    Devuelve dict o None (si no se entiende, la app usa el precio unitario promo tal cual)."""
    if not leyenda:
        return None
    s = sin_tildes(leyenda)
    m = re.search(r"\b(\d)\s*x\s*(\d)\b", s)                                  # 2x1, 3x2, 4x3
    if m and int(m.group(1)) > int(m.group(2)) > 0:
        return {"t": "nxm", "n": int(m.group(1)), "m": int(m.group(2))}
    m = re.search(r"(\d{1,3})\s*%[^0-9]*(?:2d[oa]|segunda|2\s*unid)", s) or \
        re.search(r"(?:2d[oa]|segunda|2\s*unid)[^0-9%]*(?:al\s*)?(\d{1,3})\s*%", s)
    if m:
        pct = int(m.group(1))
        # "2da al 70%" = pagás 70% de la 2da; "70% off en la 2da" = pagás 30%. Distinguimos por "al".
        paga = pct / 100 if re.search(r"al\s*" + m.group(1), s) else 1 - pct / 100
        return {"t": "2da", "v": round(1 - paga, 3)}                          # v = descuento sobre la 2da
    m = re.search(r"(\d{1,2})\s*%\s*(?:off|dto|desc|de descuento)?", s)
    if m and 0 < int(m.group(1)) < 90:
        min_q = re.search(r"llevando\s*(\d)", s)
        d = {"t": "pct", "v": int(m.group(1)) / 100}
        if min_q:
            d["min"] = int(min_q.group(1))
        return d
    return None


# ---------------------------------------------------------------- descarga
def elegir_recurso(fecha):
    log("Consultando el catálogo de datos abiertos…")
    try:
        with abrir(CKAN_URL) as r:
            res = json.load(r)["result"]["resources"]
    except Exception as e:  # noqa: BLE001
        # sin catálogo: el archivo de hoy si ya salió (~16:20), si no el de ayer
        from datetime import datetime as _dt, timedelta
        dia = fecha if _dt.now().hour >= 17 else fecha - timedelta(days=1)
        log(f"⚠ No pude leer el catálogo ({e}). Uso la URL fija de {DIAS[dia.weekday()]}.")
        return {"name": DIAS[dia.weekday()], "url": URLS_FIJAS[DIAS[dia.weekday()]],
                "last_modified": dia.isoformat(), "size": 0}
    zips = [x for x in res if x.get("format", "").upper() == "ZIP" or x["url"].endswith(".zip")]
    dia = DIAS[fecha.weekday()]
    candidato = next((x for x in zips if sin_tildes(x["name"]) == dia), None)
    if candidato and candidato["last_modified"][:10] == fecha.isoformat():
        return candidato
    ultimo = max(zips, key=lambda x: x["last_modified"])
    log(f"⚠ Todavía no está publicado el archivo del {fecha} (suele salir ~16:20). "
        f"Uso el más reciente: {ultimo['name']} {ultimo['last_modified'][:10]}.")
    return ultimo

def descargar(recurso, carpeta):
    os.makedirs(carpeta, exist_ok=True)
    fecha = recurso["last_modified"][:10]
    destino = os.path.join(carpeta, f"sepa_{fecha}.zip")
    esperado = recurso.get("size") or 0
    if os.path.exists(destino) and (not esperado or os.path.getsize(destino) >= esperado * 0.98):
        log(f"Ya descargado: {destino}")
        return destino, fecha
    log(f"Descargando {recurso['url']} ({esperado/1e6:.0f} MB)…")
    tmp = destino + ".part"
    with abrir(recurso["url"], timeout=300) as r, open(tmp, "wb") as f:
        bajado, t0 = 0, time.time()
        while True:
            b = r.read(1 << 20)
            if not b:
                break
            f.write(b); bajado += len(b)
            if esperado:
                print(f"\r  {bajado/1e6:6.0f} / {esperado/1e6:.0f} MB  ({bajado/1e6/max(time.time()-t0,1):.1f} MB/s)",
                      end="", file=sys.stderr)
    print(file=sys.stderr)
    os.replace(tmp, destino)
    return destino, fecha


def descargar_espejo(carpeta, fecha_max=None):
    """Baja la copia más reciente del espejo y la descomprime. Devuelve (carpeta, fecha)."""
    with abrir(ESPEJO_INDICE) as r:
        indice = json.load(r)
    fechas = sorted((f for f, v in indice.items() if any(x.get("link") for x in v)
                     and (not fecha_max or f <= fecha_max)), reverse=True)
    if not fechas:
        raise RuntimeError("el espejo no tiene archivos")
    fecha = fechas[0]
    entrada = [x for x in indice[fecha] if x.get("link")][-1]
    destino = os.path.join(carpeta, f"sepa_{fecha}")
    if os.path.isdir(destino) and os.listdir(destino):
        log(f"Ya descargado del espejo: {destino}")
        return destino, fecha
    os.makedirs(carpeta, exist_ok=True)
    archivo = destino + ".tar.zst"
    log(f"Descargando copia del espejo ({fecha}): {entrada['link']}")
    with abrir(entrada["link"], timeout=600) as r, open(archivo + ".part", "wb") as f:
        shutil.copyfileobj(r, f, 1 << 20)
    os.replace(archivo + ".part", archivo)
    log(f"  {os.path.getsize(archivo)/1e6:.0f} MB · descomprimiendo…")
    os.makedirs(destino, exist_ok=True)
    zstd = subprocess.Popen(["zstd", "-d", "--long=31", "-c", archivo], stdout=subprocess.PIPE)
    subprocess.run(["tar", "-x", "-C", destino], stdin=zstd.stdout, check=True)
    if zstd.wait() != 0:
        raise RuntimeError("zstd no pudo descomprimir la copia")
    os.remove(archivo)
    return destino, fecha

def obtener_sepa(fecha, carpeta):
    """Archivo del día: primero el sitio oficial; si falla, el espejo. Devuelve (ruta ZIP o carpeta, fecha del dato)."""
    try:
        return descargar(elegir_recurso(fecha), carpeta)
    except Exception as e:  # noqa: BLE001
        log(f"⚠ No pude bajar del sitio oficial ({e}). Pruebo con el espejo público…")
        return descargar_espejo(carpeta, fecha.isoformat())


# ---------------------------------------------------------------- lectura de CSV SEPA
def leer_csv(zf, nombre):
    """Lee un CSV de SEPA tolerando UTF-16, BOM, separador | o ; y la línea final de 'Última actualización'."""
    with zf.open(nombre) as fb:
        cabeza = fb.read(4)
    enc = "utf-16" if cabeza[:2] in (b"\xff\xfe", b"\xfe\xff") else "utf-8-sig"
    with zf.open(nombre) as fb:
        txt = io.TextIOWrapper(fb, encoding=enc, errors="replace", newline="")
        primera = txt.readline()
        sep = "|" if primera.count("|") >= primera.count(";") else ";"
        cols = [c.strip().strip('"').lower() for c in primera.replace("\0", "").rstrip("\r\n").split(sep)]
        for fila in csv.reader((l.replace("\0", "") for l in txt), delimiter=sep):
            if not fila or len(fila) < 3:
                continue
            if sin_tildes(fila[0]).strip().startswith("ultima actualizacion"):
                continue
            yield dict(zip(cols, (c.strip() for c in fila)))

class _Carpeta:
    """Carpeta de un comercio ya descomprimida, con la misma interfaz que ZipFile (namelist/open)."""
    def __init__(self, ruta): self.ruta = ruta
    def namelist(self): return os.listdir(self.ruta)
    def open(self, n): return open(os.path.join(self.ruta, n), "rb")

def iterar_comercios(path_zip):
    """El ZIP del día trae un ZIP por comercio (a veces en subcarpetas). Devuelve ZipFile por comercio.
    También acepta una carpeta ya descomprimida (copia del espejo)."""
    if os.path.isdir(path_zip):
        for raiz, _, archivos in sorted(os.walk(path_zip)):
            bajos = {a.lower() for a in archivos}
            if "productos.csv" in bajos:
                yield os.path.relpath(raiz, path_zip), _Carpeta(raiz)
            for a in sorted(archivos):
                if a.lower().endswith(".zip"):
                    try:
                        yield a, zipfile.ZipFile(os.path.join(raiz, a))
                    except zipfile.BadZipFile:
                        log(f"  ✗ ZIP dañado, lo salteo: {a}")
        return
    externo = zipfile.ZipFile(path_zip)
    nombres = externo.namelist()
    internos = [n for n in nombres if n.lower().endswith(".zip")]
    if internos:
        for n in internos:
            try:
                yield n, zipfile.ZipFile(io.BytesIO(externo.read(n)))
            except zipfile.BadZipFile:
                log(f"  ✗ ZIP dañado, lo salteo: {n}")
    else:  # ya descomprimido en carpetas dentro de un único zip
        carpetas = sorted({os.path.dirname(n) for n in nombres if n.endswith("productos.csv")})
        for c in carpetas:
            yield c, _SubZip(externo, c)

class _SubZip:
    def __init__(self, zf, carpeta): self.zf, self.c = zf, carpeta
    def namelist(self): return [n[len(self.c) + 1:] for n in self.zf.namelist() if n.startswith(self.c + "/")]
    def open(self, n): return self.zf.open(f"{self.c}/{n}")

def buscar(zf, base):
    return next((n for n in zf.namelist() if os.path.basename(n).lower() == base), None)


# ---------------------------------------------------------------- proceso principal
def procesar(path_zip, fecha, args):
    sucursales, productos, filas = {}, {}, []
    cadenas = {}
    n_com = 0
    for nombre, zf in iterar_comercios(path_zip):
        f_com, f_suc, f_prod = buscar(zf, "comercio.csv"), buscar(zf, "sucursales.csv"), buscar(zf, "productos.csv")
        if not (f_com and f_suc and f_prod):
            continue
        n_com += 1
        banderas = {}
        for c in leer_csv(zf, f_com):
            banderas[(c.get("id_comercio"), c.get("id_bandera"))] = c.get("comercio_bandera_nombre") or c.get("comercio_razon_social", "")
        # sucursales dentro del radio / provincia
        locales = {}
        for s in leer_csv(zf, f_suc):
            try:
                lat, lng = float(s["sucursales_latitud"].replace(",", ".")), float(s["sucursales_longitud"].replace(",", "."))
            except (KeyError, ValueError):
                continue
            if args.provincia and s.get("sucursales_provincia", "").upper() != args.provincia.upper():
                continue
            dist = km(args.lat, args.lng, lat, lng) if args.lat is not None else 0
            if args.lat is not None and dist > args.radio:
                continue
            if args.solo_super and "super" not in sin_tildes(s.get("sucursales_tipo", "")) and \
               "hiper" not in sin_tildes(s.get("sucursales_tipo", "")) and "autoservicio" not in sin_tildes(s.get("sucursales_tipo", "")):
                continue
            k = (s["id_comercio"], s["id_bandera"], s["id_sucursal"])
            bandera = banderas.get((s["id_comercio"], s["id_bandera"]), "")
            cad = clave_cadena(bandera)
            cadenas.setdefault(cad, bandera.strip().title() if bandera.isupper() else bandera.strip())
            locales[k] = {
                "id": "-".join(k), "cad": cad, "bandera": bandera.strip(),
                "nombre": s.get("sucursales_nombre", ""),
                "dir": f"{s.get('sucursales_calle','').strip().title()} {s.get('sucursales_numero','').strip()}".strip(),
                "localidad": s.get("sucursales_localidad", "").strip().title(),
                "provincia": s.get("sucursales_provincia", ""),
                "lat": round(lat, 6), "lng": round(lng, 6), "dist": round(dist, 2),
            }
        if not locales:
            continue  # este comercio no tiene sucursales en la zona: no leemos sus productos
        log(f"  {nombre}: {len(locales)} sucursales en la zona — leyendo precios…")
        sucursales.update(locales)
        for p in leer_csv(zf, f_prod):
            k = (p.get("id_comercio"), p.get("id_bandera"), p.get("id_sucursal"))
            if k not in locales:
                continue
            if p.get("productos_ean", "1").strip() != "1":   # 0 = código interno: no comparable entre cadenas
                continue
            ean = p.get("id_producto", "").strip().lstrip("0")
            lista = num(p.get("productos_precio_lista"))
            if not ean or not lista:
                continue
            if ean not in productos:
                cant = num(p.get("productos_cantidad_presentacion", ""))
                pres = f"{cant:g} {p.get('productos_unidad_medida_presentacion','')}".strip() if cant else \
                       p.get("productos_unidad_medida_presentacion", "").strip()
                desc, marca = p.get("productos_descripcion", "").strip(), p.get("productos_marca", "").strip()
                tipo, tipo_nombre = tipo_de(desc, marca, pres)
                productos[ean] = {"ean": ean, "nombre": desc, "marca": marca, "presentacion": pres,
                                  "tipo": tipo, "tipo_nombre": tipo_nombre}
            promos = []
            for i in ("1", "2"):
                pu, ley = num(p.get(f"productos_precio_unitario_promo{i}")), p.get(f"productos_leyenda_promo{i}", "").strip()
                if pu and pu < lista:
                    promos.append({"precio": pu, "leyenda": ley, "spec": parsear_promo(ley)})
            mejor = min(promos, key=lambda x: x["precio"]) if promos else None
            filas.append(("-".join(k), ean, lista, mejor))
    log(f"Comercios leídos: {n_com} · sucursales en zona: {len(sucursales)} · filas de precio: {len(filas):,}")
    return cadenas, sucursales, productos, filas

def elegir_productos(sucursales, productos, filas, args):
    """Para la app no mandamos todo. La cobertura se mide por producto genérico (tipo): si 'yerba 1 kg'
    está en ≥30% de las sucursales, entran todas sus marcas con presencia mínima (--min-marca),
    incluidas las marcas propias y las baratas que solo tienen algunas cadenas."""
    n = max(len(sucursales), 1)
    presencia = Counter(ean for _, ean, _, _ in filas)
    suc_por_tipo = defaultdict(set)
    for sid, ean, _, _ in filas:
        suc_por_tipo[productos[ean]["tipo"]].add(sid)
    tipos_ok = {t for t, s in suc_por_tipo.items() if len(s) / n >= args.cobertura}
    candidatos = [e for e in presencia
                  if productos[e]["tipo"] in tipos_ok and presencia[e] / n >= args.min_marca]
    candidatos.sort(key=lambda e: (-len(suc_por_tipo[productos[e]["tipo"]]), -presencia[e]))
    elegidos = set(candidatos[: args.max_productos])
    if args.catalogo and os.path.exists(args.catalogo):
        forzados = {l.strip().lstrip("0") for l in open(args.catalogo, encoding="utf-8") if l.strip() and not l.startswith("#")}
        elegidos |= forzados & set(presencia)
    log(f"Productos genéricos: {len({productos[e]['tipo'] for e in elegidos})} · variantes/marcas: {len(elegidos)}")
    return elegidos

def guardar_sqlite(path, fecha, cadenas, sucursales, productos, filas):
    if os.path.dirname(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
    db = sqlite3.connect(path)
    db.executescript("""
    CREATE TABLE IF NOT EXISTS sucursal(id TEXT PRIMARY KEY, cadena TEXT, bandera TEXT, nombre TEXT, direccion TEXT,
        localidad TEXT, provincia TEXT, lat REAL, lng REAL);
    CREATE TABLE IF NOT EXISTS producto(ean TEXT PRIMARY KEY, nombre TEXT, marca TEXT, presentacion TEXT,
        tipo TEXT, tipo_nombre TEXT);
    CREATE TABLE IF NOT EXISTS precio(fecha TEXT, sucursal_id TEXT, ean TEXT, precio_lista REAL, precio_promo REAL,
        leyenda_promo TEXT, promo_spec TEXT, PRIMARY KEY(fecha, sucursal_id, ean));
    CREATE INDEX IF NOT EXISTS ix_precio_ean ON precio(fecha, ean);
    """)
    cols = {r[1] for r in db.execute("PRAGMA table_info(producto)")}
    for c in ("tipo", "tipo_nombre"):          # bases creadas con la versión anterior
        if c not in cols:
            db.execute(f"ALTER TABLE producto ADD COLUMN {c} TEXT")
    db.execute("CREATE INDEX IF NOT EXISTS ix_producto_tipo ON producto(tipo)")
    db.executemany("INSERT OR REPLACE INTO sucursal VALUES (?,?,?,?,?,?,?,?,?)",
                   [(s["id"], s["cad"], s["bandera"], s["nombre"], s["dir"], s["localidad"], s["provincia"], s["lat"], s["lng"])
                    for s in sucursales.values()])
    db.executemany("INSERT OR REPLACE INTO producto(ean,nombre,marca,presentacion,tipo,tipo_nombre) VALUES (?,?,?,?,?,?)",
                   [(p["ean"], p["nombre"], p["marca"], p["presentacion"], p["tipo"], p["tipo_nombre"]) for p in productos.values()])
    db.executemany("INSERT OR REPLACE INTO precio VALUES (?,?,?,?,?,?,?)",
                   [(fecha, sid, ean, lista, m and m["precio"], m and m["leyenda"], m and json.dumps(m["spec"]))
                    for sid, ean, lista, m in filas])
    db.commit(); db.close()
    log(f"SQLite actualizado: {path}")

def main():
    ap = argparse.ArgumentParser(description="Importa precios SEPA para Compra Inteligente")
    ap.add_argument("--lat", type=float); ap.add_argument("--lng", type=float)
    ap.add_argument("--radio", type=float, default=5, help="km alrededor de lat/lng (default 5)")
    ap.add_argument("--provincia", help="código ISO, ej. AR-C (CABA), AR-B (Bs. As.), AR-X (Córdoba)")
    ap.add_argument("--nombre", default="Mi zona", help="nombre de la zona para mostrar en la app")
    ap.add_argument("--fecha", help="AAAA-MM-DD (default hoy)")
    ap.add_argument("--zip", help="usar un ZIP SEPA (o carpeta descomprimida) ya descargado en vez de bajarlo")
    ap.add_argument("--cache", default="sepa_cache", help="carpeta donde se guardan los ZIP")
    ap.add_argument("--salida", default=".", help="carpeta del JSON de salida")
    ap.add_argument("--cobertura", type=float, default=0.3,
                    help="mínimo %% de sucursales donde aparece el producto genérico (cualquier marca), 0-1")
    ap.add_argument("--min-marca", type=float, default=0.0,
                    help="mínimo %% de sucursales para incluir una marca/variante (default 0 = todas las marcas), 0-1")
    ap.add_argument("--max-productos", type=int, default=15000, help="tope de variantes (EAN) en el JSON")
    ap.add_argument("--catalogo", help="archivo con EANs (uno por línea) que siempre se incluyen")
    ap.add_argument("--solo-super", action="store_true", help="excluir mayoristas/otros tipos de local")
    ap.add_argument("--sqlite", help="además guardar todo (sin filtrar productos) en esta base SQLite")
    args = ap.parse_args()

    if (args.lat is None) != (args.lng is None):
        ap.error("--lat y --lng van juntos")
    if args.lat is None and not args.provincia:
        ap.error("indicá --lat/--lng (con --radio) o --provincia")

    fecha = date.fromisoformat(args.fecha) if args.fecha else date.today()
    if args.zip:
        path_zip, fecha_dato = args.zip, fecha.isoformat()
    else:
        path_zip, fecha_dato = obtener_sepa(fecha, args.cache)

    t0 = time.time()
    cadenas, sucursales, productos, filas = procesar(path_zip, fecha_dato, args)
    if not sucursales:
        log("No encontré sucursales con ese filtro. Revisá lat/lng (Argentina: lat negativa, lng negativa) o el radio.")
        sys.exit(1)
    if args.sqlite:
        guardar_sqlite(args.sqlite, fecha_dato, cadenas, sucursales, productos, filas)

    elegidos = elegir_productos(sucursales, productos, filas, args)
    sids = sorted(sucursales, key=lambda k: sucursales[k]["dist"])
    s_idx = {"-".join(k): i for i, k in enumerate(sids)}
    p_list = sorted(elegidos, key=lambda e: (productos[e]["tipo_nombre"], productos[e]["marca"]))
    p_idx = {e: i for i, e in enumerate(p_list)}
    precios = []
    for sid, ean, lista, m in filas:
        if ean in p_idx:
            precios.append([s_idx[sid], p_idx[ean], lista,
                            m and m["precio"], m and m["spec"], m and m["leyenda"] or None])
    centro = {"lat": args.lat, "lng": args.lng} if args.lat is not None else {
        "lat": sum(s["lat"] for s in sucursales.values()) / len(sucursales),
        "lng": sum(s["lng"] for s in sucursales.values()) / len(sucursales)}
    salida = {
        "version": 2, "fuente": "SEPA - Precios Claros (datos.produccion.gob.ar), CC-BY 4.0",
        "fecha": fecha_dato, "generado": datetime.now().isoformat(timespec="seconds"),
        "zona": {"nombre": args.nombre, **centro, "radio_km": args.radio if args.lat is not None else None,
                 "provincia": args.provincia},
        "cadenas": [{"key": k, "nombre": v} for k, v in sorted(cadenas.items())],
        "sucursales": [{k: v for k, v in sucursales[k].items()} for k in sids],
        "productos": [productos[e] for e in p_list],
        "precios": precios,
    }
    os.makedirs(args.salida, exist_ok=True)
    out = os.path.join(args.salida, f"compra_inteligente_{fecha_dato}.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(salida, f, ensure_ascii=False, separators=(",", ":"))
    con_promo = sum(1 for p in precios if p[3])
    log(f"✔ {out}  ({os.path.getsize(out)/1e6:.1f} MB) · {len(sids)} sucursales · {len(p_list)} productos · "
        f"{len(precios):,} precios ({con_promo:,} con promo) · {time.time()-t0:.0f}s")

if __name__ == "__main__":
    main()
