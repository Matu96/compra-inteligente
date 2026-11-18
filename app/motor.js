// motor.js — cálculo puro (sin DOM). Se usa en la app y en los tests.

export const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

export function km(a, b) {
  const R = 6371, r = x => x * Math.PI / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 +
    Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Celdas de la cuadrícula (tam en grados) que cubren un círculo de radio km. */
export function celdasCercanas(centro, radioKm, tam = 0.1) {
  const dLat = radioKm / 111, dLng = radioKm / (111 * Math.cos(centro.lat * Math.PI / 180));
  const out = [];
  for (let la = Math.floor((centro.lat - dLat) / tam); la <= Math.floor((centro.lat + dLat) / tam); la++)
    for (let lo = Math.floor((centro.lng - dLng) / tam); lo <= Math.floor((centro.lng + dLng) / tam); lo++)
      out.push(`${la}_${lo}`);
  return out;
}

/** Fila de precio del JSON → {lista, promo}. Fila: [lista] o [lista, precioPromo, spec|null, leyenda|null] */
export function interpretarFila(fila) {
  if (!fila) return null;
  const [lista, pPromo, spec, ley] = fila;
  if (!pPromo) return { lista, promo: null };
  return { lista, promo: spec ? { ...spec, precio: pPromo, ley } : { t: 'precio', precio: pPromo, ley } };
}

/** Total de una línea aplicando la promo del súper según la cantidad. */
export function lineaConPromo(precio, qty, promo) {
  if (!promo) return { total: precio * qty, txt: '', aplica: false };
  switch (promo.t) {
    case 'nxm': {
      const g = Math.floor(qty / promo.n);
      return { total: (qty - g * (promo.n - promo.m)) * precio, txt: `${promo.n}x${promo.m}` + (g ? '' : ` (llevando ${promo.n})`), aplica: g > 0 };
    }
    case '2da': {
      const pares = Math.floor(qty / 2);
      return { total: pares * precio * (2 - promo.v) + (qty % 2) * precio,
        txt: `2da al ${Math.round(100 - promo.v * 100)}%` + (pares ? '' : ' (llevando 2)'), aplica: pares > 0 };
    }
    case 'pct': {
      if (promo.min && qty < promo.min) return { total: precio * qty, txt: `${Math.round(promo.v * 100)}% llevando ${promo.min}`, aplica: false };
      // si el súper informa el precio en oferta, ese manda (el % de la leyenda suele estar redondeado)
      const unit = promo.precio || precio * (1 - promo.v);
      return { total: unit * qty, txt: `${Math.round(promo.v * 100)}% off`, aplica: true, unit };
    }
    case 'precio':
      return { total: promo.precio * qty, txt: (promo.ley || 'Precio promo') + ' · verificá la condición', aplica: true, unit: promo.precio };
  }
  return { total: precio * qty, txt: '', aplica: false };
}

/** Fecha (AAAA-MM-DD) del próximo día de la semana `dia` contando hoy. */
export function fechaDelDia(dia, hoy = new Date()) {
  const d = new Date(hoy); d.setDate(d.getDate() + ((dia - d.getDay() + 7) % 7));
  return d.toISOString().slice(0, 10);
}

function promoVigente(pr, cad, dia, fecha, medios) {
  return pr.cad === cad && pr.dias.includes(dia) && medios.has(pr.medio) &&
    (!pr.desde || fecha >= pr.desde) && (!pr.hasta || fecha <= pr.hasta);
}

/**
 * Cotiza una lista en una sucursal.
 * store: {id, cad, ...}; lista: [{eans:[...], qty}] (o {ean, qty}); getFila(store, ean) → fila JSON o null
 * ctx: {dia, fecha, medios:Set, promos:[...]}
 */
export function cotizar(store, lista, getFila, ctx) {
  let sub = 0, sinPromo = 0;
  const faltan = [], lineas = [];
  for (const it of lista) {
    // cada ítem trae las variantes aceptadas (EANs de las marcas elegidas, o de todas si es "cualquier marca"):
    // se elige la que da el menor total de línea con la oferta del súper aplicada a esa cantidad
    let mejor = null;
    for (const ean of it.eans || [it.ean]) {
      const f = interpretarFila(getFila(store, ean));
      if (!f) continue;
      const l = lineaConPromo(f.lista, it.qty, f.promo);
      if (!mejor || l.total < mejor.total) mejor = { it, ean, p: f.lista, total: l.total, promo: l.txt, aplica: l.aplica, unit: l.unit ?? (l.aplica ? l.total / it.qty : f.lista) };
    }
    if (!mejor) { faltan.push(it); lineas.push({ it, p: null }); continue; }
    sub += mejor.total; sinPromo += mejor.p * it.qty;
    lineas.push(mejor);
  }
  let pago = { medio: 'efectivo', desc: 0, nota: '' };
  const casi = [];
  for (const pr of ctx.promos) {
    if (!promoVigente(pr, store.cad, ctx.dia, ctx.fecha, ctx.medios)) continue;
    if (sub < (pr.min || 0)) { casi.push({ ...pr, falta: pr.min - sub }); continue; }
    // acumulable (default): el % se aplica sobre el total ya con las ofertas del súper (doble descuento).
    // acumulable: false → solo sobre los productos que no tienen oferta aplicada.
    const base = pr.acumulable === false ? lineas.reduce((a, l) => a + (l.p !== null && !l.aplica ? l.total : 0), 0) : sub;
    const bruto = base * pr.pct;
    const d = pr.tope == null ? bruto : Math.min(bruto, pr.tope);
    if (d > pago.desc) pago = { medio: pr.medio, desc: d, nota: pr.nota, topeado: pr.tope != null && bruto > pr.tope };
  }
  return { store, sub, promoSuper: sinPromo - sub, pago, total: sub - pago.desc, faltan, lineas, casi };
}

/** Ranking de sucursales en el radio: primero las que tienen todo, después por total. */
export function rankear(stores, centro, radio, lista, getFila, ctx) {
  return stores
    .map(s => ({ s, d: km(centro, s) }))
    .filter(x => x.d <= radio)
    .map(x => ({ ...cotizar(x.s, lista, getFila, ctx), dist: x.d }))
    .filter(r => r.faltan.length < lista.length)                 // descartar las que no tienen nada
    .sort((a, b) => (a.faltan.length - b.faltan.length) || (a.total - b.total) || (a.dist - b.dist));
}

/** ¿Conviene dividir la compra en dos súper? Solo si ahorra > 3% y > umbral pesos. */
export function mejorDivision(res, lista, getFila, ctx, umbral = 2000) {
  const completos = res.filter(r => !r.faltan.length);
  if (!completos.length || lista.length < 2) return null;
  const mejorUno = completos[0].total;
  const cand = res.slice(0, 10);
  const sinPago = { ...ctx, medios: new Set() };
  let best = null;
  for (let i = 0; i < cand.length; i++) for (let j = i + 1; j < cand.length; j++) {
    const A = cand[i].store, B = cand[j].store;
    if (A.cad === B.cad) continue;
    const la = [], lb = [];
    let ok = true;
    for (const it of lista) {
      const ca = cotizar(A, [it], getFila, sinPago), cb = cotizar(B, [it], getFila, sinPago);
      const fa = ca.faltan.length, fb = cb.faltan.length;
      if (fa && fb) { ok = false; break; }
      if (fb || (!fa && ca.sub <= cb.sub)) la.push(it); else lb.push(it);
    }
    if (!ok || !la.length || !lb.length) continue;
    const ra = cotizar(A, la, getFila, ctx), rb = cotizar(B, lb, getFila, ctx);
    const tot = ra.total + rb.total;
    if (!best || tot < best.tot) best = { tot, ra, rb, da: cand[i].dist, db: cand[j].dist };
  }
  if (!best) return null;
  const ahorro = mejorUno - best.tot;
  return ahorro > umbral && ahorro / mejorUno > 0.03 ? { ...best, ahorro } : null;
}

/** Mejor total posible para cada día de la semana. */
export function porDiaDeLaSemana(stores, centro, radio, lista, getFila, ctx, hoy = new Date()) {
  return DIAS.map((_, d) => {
    const r = rankear(stores, centro, radio, lista, getFila, { ...ctx, dia: d, fecha: fechaDelDia(d, hoy) })
      .filter(x => !x.faltan.length)[0];
    return r ? { dia: d, total: r.total, cad: r.store.cad, medio: r.pago.medio } : null;
  });
}
