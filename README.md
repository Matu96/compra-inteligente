# 🛒 Compra Inteligente

Web instalable (PWA) que, según **dónde estás**, busca los supermercados cercanos y te dice **dónde y con qué medio de pago** te sale más barata tu lista, combinando:

- precios por sucursal y ofertas del súper (2x1, 3x2, 2da al X%, % off) de la base oficial **SEPA / Precios Claros**, actualizada todos los días;
- promos bancarias y de billeteras por día (Cuenta DNI, Mercado Pago, MODO, bancos), con mínimos y topes.

Cada producto de la lista es un **producto genérico** ("Yerba mate 1 kg") donde elegís **una o varias marcas** o **"cualquiera, la más barata"**: en cada súper se usa la variante que da el menor total con la oferta del súper aplicada a la cantidad (un 2x1 de una marca más cara puede ganar). Si tus marcas te encarecen la compra, te dice cuánto y lo podés cambiar con un toque.

Además sugiere **qué día de la semana** conviene, si vale la pena **dividir la compra en dos súper**, y avisa cuando te falta poco para activar una promo.

## Cómo funciona

```
GitHub Actions (todos los días 17:40)                 Celular
┌─────────────────────────────────────┐   GitHub    ┌──────────────────────────────┐
│ pipeline/build_tiles.py             │   Pages     │ app/ (PWA)                   │
│  1. baja el ZIP SEPA del día        │ ──────────▶ │  1. GPS o dirección          │
│  2. arma catálogo de productos      │  archivos   │  2. baja solo las celdas     │
│  3. parte el país en celdas de 0,1° │  estáticos  │     cercanas (~1 MB)         │
│     (~10 km) → data/tiles/*.json    │             │  3. calcula todo en el       │
└─────────────────────────────────────┘             │     teléfono (app/motor.js)  │
                                                    └──────────────────────────────┘
```

No hay servidor encendido: todo es estático, gratis y escala solo. La app funciona sin conexión con los últimos precios que bajó.

## Puesta en marcha (una sola vez)

1. Subí este repo a GitHub (público: GitHub Pages es gratis en repos públicos).
2. **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. **Actions → "Actualizar precios y publicar" → Run workflow**. La primera corrida tarda unos minutos (baja ~330 MB).
4. Abrí `https://<tu-usuario>.github.io/<repo>/` en el celular → **Instalar app** (Android/Chrome) o **Compartir → Agregar a inicio** (iPhone).

Desde ahí se actualiza sola todos los días.

### De dónde baja SEPA
`datos.produccion.gob.ar` bloquea a los servidores de GitHub (responde 403). Por eso el script, si el sitio oficial falla, usa la **copia diaria del espejo público** del proyecto [preciazo](https://github.com/catdevnull/preciazo) (índice en `catdevnull/sepa-precios-metadata`), que tiene el mismo contenido. Si algún día el espejo deja de actualizarse:
- cargá un proxy argentino en **Settings → Secrets and variables → Actions → New secret** con nombre `SEPA_PROXY` (ej. `http://usuario:clave@host:puerto`), o
- registrá tu compu como *self-hosted runner* (Settings → Actions → Runners) y cambiá `runs-on: ubuntu-latest` por `runs-on: self-hosted` en el job `build`: la descarga sale desde Argentina.

Si un día falla, la web sigue mostrando los datos del último día que funcionó.

## Actualizar promos bancarias (cada mes)

Editá `app/promos.json`. Cada promo:

```json
{ "cad": "chango", "medio": "cuentadni", "dias": [4], "pct": 0.20, "tope": null, "min": 0,
  "desde": "2026-11-01", "hasta": "2026-11-30", "nota": "Jueves 20% sin tope", "fuente": "https://…" }
```

- `dias`: 0 = domingo … 6 = sábado · `tope`: `null` = sin tope · `min`: compra mínima.
- `cad`: clave de cadena (`dia`, `coto`, `carrefour`, `chango`, `jumbo`, `disco`, `vea`, `anonima`, `coope`, `josimar`, `nini`, `dar`…). Para ver las claves de tu zona mirá `cadenas` en `data/index.json`.
- Para agregar un medio de pago nuevo, sumalo en `medios`.

Al hacer push, la web se vuelve a publicar sola.

## Probar en tu compu

```bash
# generar datos solo de CABA (más rápido) dentro de la carpeta de la app
python3 pipeline/build_tiles.py --provincia AR-C --salida app/data
# servir la app
python3 -m http.server 8000 -d app
# abrir http://localhost:8000  (el GPS funciona en localhost)
```

Pruebas del motor de cálculo: `node tests/motor.test.mjs`

`pipeline/sepa_import.py` es el script anterior para generar un solo JSON de una zona (útil para análisis).

## Estructura

| Ruta | Qué es |
|---|---|
| `pipeline/sepa_import.py` | Descarga SEPA, lee sus CSV (tolera UTF-16, `;`, línea final "Última actualización"), parsea leyendas de promo y agrupa productos genéricos (`tipo_de`) |
| `pipeline/build_tiles.py` | Genera `index.json`, `catalogo.json` (productos genéricos + todas sus marcas) y `tiles/<celda>.json` (lista base por cadena + diferencias por sucursal) |
| `app/motor.js` | Cálculo: ofertas por cantidad, mejor medio de pago con mínimo/tope/vigencia, ranking, compra dividida, mejor día |
| `app/app.js` | Interfaz, GPS, búsqueda de dirección (OpenStreetMap), lista guardada en el teléfono |
| `app/promos.json` | Promos bancarias del mes |
| `app/sw.js`, `manifest.webmanifest` | Instalación y uso sin conexión |
| `.github/workflows/actualizar.yml` | Tarea diaria + publicación en GitHub Pages |

## Limitaciones conocidas

- Carne, verdura y fiambre se venden por peso y casi no tienen código de barras: no se comparan.
- Los productos genéricos salen de ~40 reglas curadas (yerba, leche, fideos por forma, aceite por tipo…) y, para el resto, de la descripción sin la marca: algunas variedades pueden quedar separadas. Se amplían en `REGLAS_TIPO` de `pipeline/sepa_import.py`.
- No compara presentaciones distintas (1 kg vs 500 g) por precio por kilo todavía.
- Las ofertas del súper son las del último día publicado; para otro día de la semana se asumen iguales.
- Topes de reintegro: se asumen sin usar (próximo paso: cargar cuánto ya usaste en el mes).

Datos: SEPA – Precios Claros, Secretaría de Comercio de la Nación (CC-BY 4.0).
