// fotos.js — foto de cada producto por código de barras. No se descarga ni se guarda ninguna imagen:
// se muestra enlazada desde su origen, en este orden:
//   1. fotos propias de la app (app/fotos/<EAN>.jpg, ver fotos/lista.js)
//   2. la foto del producto en la tienda online de un súper (data/web, ver web.js), que al tocarla en la
//      ficha lleva a esa tienda
//   3. el portal oficial Precios Claros
// Sin ninguna, queda la tarjeta con la marca que arma app.js.
// Uso: <span class="foto" data-fotos="ean1,ean2"></span> y después aplicarFotos(raíz).
import LOCALES from './fotos/lista.js';
import { datosWeb } from './web.js';

const PROPIAS = new Set(LOCALES);
const precioClaros = e => `https://imagenes.preciosclaros.gob.ar/productos/${e.padStart(13, '0')}.jpg`;
const raices = new Set();

async function candidatas(eans) {
  const web = await Promise.all(eans.map(datosWeb));
  return [
    ...eans.filter(e => PROPIAS.has(e)).map(e => `fotos/${e}.jpg`),
    ...web.flatMap(d => (d?.f || []).slice(0, 2)),
    ...eans.map(precioClaros),
  ];
}

function pintar(raiz) {
  raiz.querySelectorAll('.foto[data-fotos]').forEach(async el => {
    if (el.dataset.ok) return;
    el.dataset.ok = '1';
    const eans = el.dataset.fotos.split(',').filter(e => /^\d{7,14}$/.test(e)).slice(0, 3);   // los códigos internos no tienen foto
    if (!eans.length) return;
    el.classList.add('cargando');
    const urls = await candidatas(eans);
    const img = new Image();
    img.alt = ''; img.decoding = 'async'; img.referrerPolicy = 'no-referrer';
    let i = 0;
    img.onload = () => { if (img.naturalWidth >= 120) { el.classList.remove('cargando'); el.classList.add('con-foto'); el.dataset.src = img.src; } else img.onerror(); };
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
