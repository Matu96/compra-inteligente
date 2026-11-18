// fotos.js — fotos de producto por código de barras, con caché en el teléfono.
// Solo fotos de estudio: el portal oficial Precios Claros. Open Food Facts quedó desactivado porque sus fotos son
// sacadas por usuarios (probado: 0-2 % de fondo blanco). Para sumar una fuente con licencia (GS1 Argentina, o el
// permiso de una cadena) basta con agregarla en FUENTES.
// Sin foto, se muestra una tarjeta con la marca (la arma app.js con data-marca).
const USAR_OFF = false;
const FUENTES = [e => `https://imagenes.preciosclaros.gob.ar/productos/${e.padStart(13, '0')}.jpg`];
// Uso: en el HTML, <span class="foto" data-fotos="ean1,ean2"></span>; después llamar aplicarFotos(raíz).
// Se muestra la primera foto disponible de la lista de EANs (sirve para "cualquier marca").

const API = 'https://world.openfoodfacts.org/api/v2/search';
const LOTE = 50;                 // EANs por consulta (la API de búsqueda admite ~10 consultas por minuto)
const CLAVE = 'ci-fotos-v1';
const VENCE = 14 * 864e5;
// Open Food Facts sirve la misma foto en 100, 200, 400 px y completa: para la ficha usamos 400
const aGrande = u => u.replace(/\.(100|200)\.jpg$/, '.400.jpg');
const PRECIOS_CLAROS = e => `https://imagenes.preciosclaros.gob.ar/productos/${e.padStart(13, '0')}.jpg`;        // se vuelven a consultar los "sin foto" cada 2 semanas

const cache = new Map();         // ean -> url ('' = sin foto)
let fechas = {};
try {
  const g = JSON.parse(localStorage.getItem(CLAVE) || '{}');
  fechas = g.f || {};
  for (const [e, u] of Object.entries(g.u || {})) if (u || Date.now() - (fechas[e] || 0) < VENCE) cache.set(e, u);
} catch {}

let pendientes = new Set(), enCurso = new Set(), timer = null, raices = new Set();

function guardar() {
  try {
    const u = {}; for (const [e, v] of cache) u[e] = v;
    localStorage.setItem(CLAVE, JSON.stringify({ u, f: fechas }));
  } catch {}
}

async function consultar(lote) {
  lote.forEach(e => enCurso.add(e));
  try {
    const r = await fetch(`${API}?code=${lote.join(',')}&fields=code,image_front_small_url,image_small_url&page_size=${lote.length}`);
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
    const vistos = new Set();
    for (const p of d.products || []) {
      const e = String(p.code).replace(/^0+/, '');
      cache.set(e, p.image_front_small_url || p.image_small_url || '');
      fechas[e] = Date.now(); vistos.add(e);
    }
    for (const e of lote) if (!vistos.has(e)) { cache.set(e, ''); fechas[e] = Date.now(); }
    guardar();
  } catch { /* sin conexión o límite: se reintenta la próxima vez */ }
  lote.forEach(e => enCurso.delete(e));
  raices.forEach(r => pintar(r));
}

function programar() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const todos = [...pendientes].filter(e => !cache.has(e) && !enCurso.has(e));
    pendientes = new Set();
    for (let i = 0; i < todos.length; i += LOTE) consultar(todos.slice(i, i + LOTE));
  }, 250);
}

function pintar(raiz) {
  raiz.querySelectorAll('.foto[data-fotos]').forEach(el => {
    if (el.dataset.ok) return;
    const eans = el.dataset.fotos.split(',').filter(e => /^\d{7,14}$/.test(e));   // los códigos internos no tienen foto pública
    if (USAR_OFF && eans.some(e => !cache.has(e))) {            // Open Food Facts (desactivado)
      eans.forEach(e => { if (!cache.has(e)) pendientes.add(e); });
      return programar();
    }
    // candidatas en orden: fotos de Open Food Facts y, si fallan o no hay, las de Precios Claros
    const grande = el.classList.contains('grande');
    const urls = [...eans.slice(0, 3).flatMap(e => FUENTES.map(f => f(e))),
      ...(USAR_OFF ? eans.map(e => cache.get(e)).filter(Boolean).map(u => grande ? aGrande(u) : u) : [])];
    el.dataset.ok = '1';
    if (!urls.length) return;
    el.classList.add('cargando');
    const img = new Image();
    img.alt = ''; img.loading = 'lazy'; img.decoding = 'async'; img.referrerPolicy = 'no-referrer';
    let i = 0;
    img.onload = () => { if (img.naturalWidth >= 120) { el.classList.remove('cargando'); el.classList.add('con-foto'); } else img.onerror(); };
    img.onerror = () => { if (++i < urls.length) img.src = urls[i]; else { img.remove(); el.classList.remove('cargando'); } };
    img.src = urls[0];
    el.appendChild(img);
  });
}

/** Busca y coloca las fotos de todos los .foto dentro de `raiz` (se puede llamar después de cada render). */
export function aplicarFotos(raiz = document) {
  raices.add(raiz);
  pintar(raiz);
}
