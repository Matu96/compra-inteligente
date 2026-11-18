"""promo_parser.py — clasifica textos de promociones de súper argentinos y calcula el precio unitario real.

    >>> precio_unitario("2x1", 1000)
    500.0
    >>> precio_unitario("3x2", 900)
    600.0
    >>> precio_unitario("2da al 70%", 1000)    # 70 % off en la segunda: (1000 + 300) / 2
    650.0
    >>> precio_unitario("Llevando 3, 20% off", 1000)
    800.0
    >>> clasificar("20% dto. Mi Carrefour")
    'fidelidad'
    >>> clasificar("Banco Nación 25% los miércoles")
    'bancaria'

Regla argentina: "2da al 70%" = la segunda unidad tiene 70 % de descuento (se paga el 30 %).
Las promos bancarias no se convierten en precio unitario: tienen topes, días y medios de pago (la app
las calcula aparte con promos.json), así que su precio_unitario_promo queda en None salvo que venga explícito.
"""
import re
import unicodedata

_FIDELIDAD = r"comunidad coto|mi carrefour|mi crf|club d[ií]a|club dia|jumbo ?(\+|mas|más|prime)|disco ?(\+|mas|más|prime)|vea ?(\+|mas|más)|" \
             r"prime|socios?|tarjeta (coto|carrefour|cencosud|jumbo|disco)|cencosud score|beneficio exclusivo"
_BANCARIA = r"banco|bna|naci[oó]n|provincia|cuenta dni|santander|galicia|bbva|macro|ciudad|hsbc|icbc|supervielle|patagonia|" \
            r"credicoop|comafi|columbia|hipotecario|visa|master|amex|american express|cabal|naranja|mercado ?pago|modo|" \
            r"personal pay|uala|ual[aá]|brubank|lemon|prex|billetera|tarjeta|d[eé]bito|cr[eé]dito|cuotas|reintegro"
_VOLUMEN = r"\b\d+\s*x\s*\d+\b|\b(2|3|4)\s*(da|do|ra|ro|ta|to|°|º)?\s*(unidad|u\.?)?\s*al\s*\d+|segund[ao]|tercer[ao]|llevando|" \
           r"lleva\s*\d|comprando\s*\d|\bx\s*\d+\s*u|\d+\s*unidades|combo|pack"


def _n(t):
    t = unicodedata.normalize("NFD", t or "")
    return "".join(c for c in t if unicodedata.category(c) != "Mn").lower().strip()


def clasificar(texto):
    """'volumen' | 'fidelidad' | 'bancaria' | 'directa'"""
    t = _n(texto)
    if re.search(_FIDELIDAD, t):
        return "fidelidad"
    if re.search(_BANCARIA, t):
        return "bancaria"
    if re.search(_VOLUMEN, t):
        return "volumen"
    return "directa"


def precio_explicito(texto):
    """'$1.234,50' → 1234.5 (el precio que trae el texto, si trae uno)."""
    m = re.search(r"\$\s*([\d.]+(?:,\d{1,2})?)", texto or "")
    if not m:
        return None
    try:
        return float(m.group(1).replace(".", "").replace(",", "."))
    except ValueError:
        return None


def precio_unitario(texto, precio, tipo=None):
    """Precio efectivo por unidad llevando la promo, o None si no se puede calcular con seguridad."""
    if not precio or precio <= 0:
        return None
    t = _n(texto)
    tipo = tipo or clasificar(texto)
    # "4x3", "3 x 2": llevás N y pagás M
    m = re.search(r"\b(\d+)\s*x\s*(\d+)\b", t)
    if m:
        n, p = int(m.group(1)), int(m.group(2))
        if 1 <= p < n <= 12:
            return round(precio * p / n, 2)
    # "2da al 70%", "2do al 50", "segunda unidad al 80%", "70% en la 2da", "3ra al 50%"
    m = re.search(r"\b(2|3|4)\s*(?:da|do|ra|ro|ta|to|°|º)?\s*(?:unidad|u\.?)?\s*(?:al|con|a)\s*(?:el\s*)?(\d{1,3})\s*%?", t) \
        or re.search(r"\b(segund|tercer|cuart)[ao]\s*(?:unidad)?\s*(?:al|con|a)\s*(\d{1,3})\s*%?", t)
    m2 = re.search(r"(\d{1,3})\s*%\s*(?:off|dto\.?|de descuento|desc\.?)?\s*(?:en|sobre)\s*la\s*(2|3|4|segund|tercer|cuart)", t)
    if m or m2:
        orden = {"segund": 2, "tercer": 3, "cuart": 4}
        if m:
            k, pct = m.group(1), int(m.group(2))
        else:
            pct, k = int(m2.group(1)), m2.group(2)
        k = orden.get(k, None) or int(k)
        if 0 < pct <= 100:
            return round(precio * (k - 1 + (1 - pct / 100)) / k, 2)
    if tipo == "bancaria":
        return precio_explicito(texto)
    # precio explícito del texto ("Precio Comunidad Coto $1.234", "2 por $3.000")
    m = re.search(r"\b(\d+)\s*(?:por|x)\s*\$\s*([\d.]+(?:,\d{1,2})?)", t)
    if m:
        try:
            return round(float(m.group(2).replace(".", "").replace(",", ".")) / int(m.group(1)), 2)
        except ValueError:
            pass
    explicito = precio_explicito(texto)
    if explicito and explicito < precio:
        return explicito
    # "Llevando 3, 20% off", "25% dto. Mi Carrefour", "-30%"
    m = re.search(r"(\d{1,2}(?:[.,]\d)?)\s*%", t)
    if m:
        pct = float(m.group(1).replace(",", "."))
        if 0 < pct < 100:
            return round(precio * (1 - pct / 100), 2)
    return None


def promo(texto, precio, precio_promo=None):
    """Arma el objeto del esquema: {tipo, descripcion, precio_unitario_promo}."""
    texto = re.sub(r"\s+", " ", (texto or "")).strip()
    tipo = clasificar(texto)
    pu = precio_promo if precio_promo else precio_unitario(texto, precio, tipo)
    return {"tipo": tipo, "descripcion": texto, "precio_unitario_promo": pu}


if __name__ == "__main__":
    import doctest
    doctest.testmod(verbose=False)
    casos = [("2x1", 1000, 500.0), ("3x2", 900, 600.0), ("4x3", 1000, 750.0), ("2da al 70%", 1000, 650.0),
             ("2do al 50%", 1000, 750.0), ("2da unidad al 80%", 1000, 600.0), ("Segunda unidad al 50%", 1000, 750.0),
             ("70% en la 2da unidad", 1000, 650.0), ("3ra al 50%", 900, 750.0), ("Llevando 3, 20% off", 1000, 800.0),
             ("2 por $3.000", 2000, 1500.0), ("Precio Comunidad Coto $1.234,50", 1500, 1234.5),
             ("20% dto. Mi Carrefour", 1000, 800.0), ("Banco Nación 25% los miércoles", 1000, None)]
    mal = 0
    for t, p, esperado in casos:
        got = precio_unitario(t, p)
        if got != esperado:
            mal += 1
            print(f"✗ {t!r} con ${p}: {got} (esperado {esperado})")
    tipos = [("2x1", "volumen"), ("2da al 70%", "volumen"), ("20% dto. Mi Carrefour", "fidelidad"),
             ("Precio Comunidad Coto", "fidelidad"), ("Club Día 10%", "fidelidad"), ("Jumbo+ 15%", "fidelidad"),
             ("Mercado Pago 20%", "bancaria"), ("Visa 6 cuotas sin interés", "bancaria"), ("25% off", "directa")]
    for t, esperado in tipos:
        if clasificar(t) != esperado:
            mal += 1
            print(f"✗ clasificar({t!r}) = {clasificar(t)} (esperado {esperado})")
    raise SystemExit(f"{mal} casos fallaron" if mal else print(f"✔ promos: {len(casos) + len(tipos)} casos OK"))
