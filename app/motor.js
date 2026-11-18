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

/** Fila de precio del JSON → {lista, promo, promos}.
 *  Fila: [lista] · [lista, p1, spec1, ley1] · [lista, p1, spec1, ley1, p2, spec2, ley2] (SEPA informa hasta 2 ofertas) */
export function interpretarFila(fila) {
  if (!fila) return null;
  const lista = fila[0], promos = [];
  for (let i = 1; i + 2 < fila.length && fila[i]; i += 3) {
    const [precio, spec, ley] = [fila[i], fila[i + 1], fila[i + 2]];
    promos.push(spec ? { ...spec, precio, ley } : { t: 'precio', precio, ley });
  }
  return { lista, promo: promos[0] || null, promos };
}

/** La mejor de las ofertas del súper para esa cantidad (o ninguna, si ninguna conviene). */
export function mejorLinea(f, qty) {
  let mejor = lineaConPromo(f.lista, qty, null);
  for (const p of f.promos || (f.promo ? [f.promo] : [])) {
    const l = lineaConPromo(f.lista, qty, p);
    if (l.total < mejor.total - 0.01) mejor = l;
  }
  return mejor;
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

/** ¿El producto está excluido de la promo bancaria? pr.excluye = {palabras: [regex], marcas: [texto], salvo: [regex]} */
const _norm = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const _re = new Map();
const _rx = src => { if (!_re.has(src)) _re.set(src, new RegExp(src, 'i')); return _re.get(src); };
export function excluida(pr, info) {
  const ex = pr.excluye;
  if (!ex || !info) return false;
  const txt = _norm(`${info.nombre} ${info.tipo || ''}`), marca = _norm(info.marca);
  if ((ex.salvo || []).some(r => _rx(r).test(txt))) return false;
  if ((ex.marcas || []).some(m => marca.includes(_norm(m)) || txt.includes(_norm(m)))) return true;
  return (ex.palabras || []).some(r => _rx(r).test(txt));
}
/** Líneas sobre las que se calcula la promo: sin las excluidas y, si no es acumulable, sin las que tienen oferta del súper. */
function lineasConPromo(pr, lineas, info) {
  return lineas.filter(l => l.p !== null && !(pr.acumulable === false && l.aplica) && !excluida(pr, info?.(l.ean)));
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
      const l = mejorLinea(f, it.qty);
      if (!mejor || l.total < mejor.total) mejor = { it, ean, p: f.lista, total: l.total, promo: l.txt, aplica: l.aplica, unit: l.unit ?? (l.aplica ? l.total / it.qty : f.lista) };
    }
    if (!mejor) { faltan.push(it); lineas.push({ it, p: null }); continue; }
    sub += mejor.total; sinPromo += mejor.p * it.qty;
    lineas.push(mejor);
  }
  let pago = { medio: 'efectivo', desc: 0, nota: '' };
  const casi = [], otrosMedios = [];
  for (const pr of ctx.promos) {
    if (!promoVigente(pr, store.cad, ctx.dia, ctx.fecha, ctx.medios)) {
      if (pr.cad === store.cad && pr.dias.includes(ctx.dia) && !ctx.medios.has(pr.medio) &&
          (!pr.desde || ctx.fecha >= pr.desde) && (!pr.hasta || ctx.fecha <= pr.hasta)) otrosMedios.push(pr);
      continue;
    }
    if (sub < (pr.min || 0)) { casi.push({ ...pr, falta: pr.min - sub }); continue; }
    // acumulable (default): el % se aplica sobre el total ya con las ofertas del súper (doble descuento).
    // acumulable: false → solo sobre los productos que no tienen oferta aplicada. Siempre sin los productos excluidos.
    const base = lineasConPromo(pr, lineas, ctx.info).reduce((a, l) => a + l.total, 0);
    const bruto = base * pr.pct;
    const d = pr.tope == null ? bruto : Math.min(bruto, pr.tope);
    if (d > pago.desc) pago = { medio: pr.medio, desc: d, nota: pr.nota, topeado: pr.tope != null && bruto > pr.tope, pr, base };
  }
  // qué productos quedaron afuera del descuento del medio de pago elegido, y por qué
  if (pago.pr) {
    const dentro = new Set(lineasConPromo(pago.pr, lineas, ctx.info));
    for (const l of lineas) if (l.p !== null && !dentro.has(l))
      l.sinPago = pago.pr.acumulable === false && l.aplica ? 'oferta' : 'excluido';
    pago.enOferta = lineas.filter(l => l.sinPago === 'oferta').length;
    pago.excluidos = lineas.filter(l => l.sinPago === 'excluido').length;
  }
  // cuánto descontaría cada promo que no se aplicó (por mínimo o por medio no marcado), si se cumpliera
  const potencial = pr => {
    const elegible = lineasConPromo(pr, lineas, ctx.info).reduce((a, l) => a + l.total, 0);
    const base = elegible + Math.max(0, (pr.min || 0) - sub);       // lo que falte para el mínimo, si se compra algo elegible
    const b = base * pr.pct; return pr.tope == null ? b : Math.min(b, pr.tope);
  };
  casi.forEach(c => { c.desc = potencial(c); c.totalSiLlega = (sub + c.falta) - c.desc; });
  otrosMedios.forEach(o => { o.descHoy = sub >= (o.min || 0) ? potencial(o) : 0; o.falta = Math.max(0, (o.min || 0) - sub); });
  return { store, sub, promoSuper: sinPromo - sub, pago, total: sub - pago.desc, faltan, lineas, casi, otrosMedios };
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
