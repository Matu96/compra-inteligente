// web.js — datos de las tiendas online (foto, enlace al producto, precio y promos de la web) por EAN.
// Vienen de pipeline/tiendas (workflow "Tiendas online"), partidos en data/web/NNN.json por los 3 últimos
// dígitos del EAN: la app baja solo la parte que necesita.
//   entrada = { f: [url de foto, ...], t: { coto: [product_url, precio_final, precio_lista, [[tipo, texto, precio_unitario], ...]], ... } }
export const TIENDAS_WEB = { carrefour: 'Carrefour', jumbo: 'Jumbo', disco: 'Disco', vea: 'Vea', dia: 'Día', coto: 'Coto Digital' };
export const ORDEN_FOTO = ['carrefour', 'jumbo', 'disco', 'vea', 'dia', 'coto'];    // igual que en main.py

const partes = new Map();            // 'NN' -> Promise<objeto>
const clave = ean => String(ean || '').replace(/^0+/, '');
const parteDe = e => e.slice(-3).padStart(3, '0');

function cargar(nn) {
  if (!partes.has(nn)) {
    partes.set(nn, fetch(`data/web/${nn}.json`).then(r => r.ok ? r.json() : {}).catch(() => ({})));
  }
  return partes.get(nn);
}

/** Datos web de un EAN (o null). Los códigos internos de los súper no tienen. */
export async function datosWeb(ean) {
  const e = clave(ean);
  if (!/^\d{6,14}$/.test(e)) return null;
  return (await cargar(parteDe(e)))[e] || null;
}

/** La tienda dueña de la primera foto (la que se abre al tocarla). */
export function tiendaDeFoto(d) {
  return d && ORDEN_FOTO.find(t => d.t[t]);
}
