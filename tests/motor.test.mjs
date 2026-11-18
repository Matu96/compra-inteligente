// node tests/motor.test.mjs — pruebas del motor de cálculo (sin dependencias)
import assert from 'node:assert/strict';
import { lineaConPromo, cotizar, rankear, celdasCercanas, fechaDelDia, mejorDivision, interpretarFila } from '../app/motor.js';

// promos del súper
assert.equal(lineaConPromo(1000, 3, { t: 'nxm', n: 3, m: 2 }).total, 2000);
assert.equal(lineaConPromo(1000, 2, { t: 'nxm', n: 3, m: 2 }).total, 2000);          // no llega
assert.equal(lineaConPromo(1000, 2, { t: '2da', v: 0.7 }).total, 1300);               // 2da al 30%
assert.equal(lineaConPromo(1000, 3, { t: '2da', v: 0.5 }).total, 2500);
assert.equal(lineaConPromo(1000, 2, { t: 'pct', v: 0.25 }).total, 1500);
assert.equal(lineaConPromo(1000, 2, { t: 'pct', v: 0.2, min: 3 }).total, 2000);       // falta cantidad
assert.equal(lineaConPromo(1000, 2, { t: 'precio', precio: 800 }).total, 1600);

// celdas y fechas
assert.deepEqual(celdasCercanas({ lat: -34.62, lng: -58.44 }, 1), ['-347_-585']);
assert.equal(celdasCercanas({ lat: -34.6, lng: -58.4 }, 5).length >= 4, true);
assert.equal(fechaDelDia(3, new Date('2026-11-16T12:00:00')), '2026-11-18');        // lunes → miércoles

// cotización con medio de pago, mínimo y tope
const listas = [{ '1': [1000], '2': [2000, 1500, { t: 'pct', v: 0.25 }, '25% OFF'] }];
const A = { id: 'a', cad: 'dia', lat: -34.62, lng: -58.44, lp: 0, listas, dif: {} };
const B = { id: 'b', cad: 'coto', lat: -34.63, lng: -58.44, lp: 0, listas, dif: { '1': [800], '2': null } };
const getFila = (s, e) => (e in s.dif ? s.dif[e] : s.listas[s.lp][e] ?? null);
const lista = [{ ean: '1', qty: 2 }, { ean: '2', qty: 1 }];
const promos = [
  { cad: 'dia', medio: 'cuentadni', dias: [1], pct: 0.1, tope: null, min: 0, nota: 'lunes 10%' },
  { cad: 'dia', medio: 'mp', dias: [1], pct: 0.3, tope: 300, min: 0, nota: 'lunes 30% tope 300' },
  { cad: 'dia', medio: 'bna', dias: [1], pct: 0.5, tope: null, min: 999999, nota: 'mínimo alto' },
];
const ctx = { dia: 1, fecha: '2026-11-16', medios: new Set(['efectivo', 'cuentadni', 'mp', 'bna']), promos };
const ra = cotizar(A, lista, getFila, ctx);
assert.equal(ra.sub, 3500);
assert.equal(ra.pago.medio, 'cuentadni');      // 350 > tope 300 de MP
assert.equal(ra.total, 3150);
assert.equal(ra.casi.length, 1);
const rb = cotizar(B, lista, getFila, ctx);
assert.equal(rb.faltan.length, 1);
assert.equal(rb.total, 1600);

// vigencia: fuera de fecha no aplica
assert.equal(cotizar(A, lista, getFila, { ...ctx, promos: [{ ...promos[0], hasta: '2026-11-15' }] }).pago.desc, 0);

// ranking: primero las que tienen todo
const res = rankear([A, B], { lat: -34.62, lng: -58.44 }, 5, lista, getFila, ctx);
assert.equal(res[0].store.id, 'a');
assert.equal(mejorDivision(res, lista, getFila, ctx), null);   // ahorro chico → no recomienda dividir

console.log('✔ motor: todas las pruebas pasaron');

// marcas: elige la variante con menor total de línea (con la oferta aplicada a la cantidad)
{
  const L = [{ m1: [1000], m2: [1100, 550, { t: 'nxm', n: 2, m: 1 }, '2x1'], m3: [900] }];
  const S = { id: 's', cad: 'vea', lat: 0, lng: 0, lp: 0, listas: L, dif: { m3: null } };
  const c1 = cotizar(S, [{ eans: ['m1', 'm2', 'm3'], qty: 2 }], getFila, { ...ctx, promos: [] });
  assert.equal(c1.lineas[0].ean, 'm2');            // 2x1 de una marca más cara gana llevando 2
  assert.equal(c1.total, 1100);
  const c2 = cotizar(S, [{ eans: ['m1', 'm2'], qty: 1 }], getFila, { ...ctx, promos: [] });
  assert.equal(c2.lineas[0].ean, 'm1');
  const c3 = cotizar(S, [{ eans: ['m3'], qty: 1 }], getFila, { ...ctx, promos: [] });
  assert.equal(c3.faltan.length, 1);               // la marca elegida no está en esa sucursal
  console.log('✔ motor: marcas OK');
}

// doble descuento: promo bancaria sobre el precio ya rebajado por la oferta del súper
{
  const L = [{ y: [3790, 2843, { t: 'pct', v: 0.25 }, '25% OFF'], z: [1000] }];
  const S = { id: 'd', cad: 'dia', lat: 0, lng: 0, lp: 0, listas: L, dif: {} };
  const pr = { cad: 'dia', medio: 'modo', dias: [5], pct: 0.2, tope: 20000, min: 0, nota: 'vie 20%' };
  const c = { dia: 5, fecha: '2026-11-20', medios: new Set(['modo']), promos: [pr] };
  const r = cotizar(S, [{ eans: ['y'], qty: 1 }, { eans: ['z'], qty: 1 }], getFila, c);
  assert.equal(Math.round(r.sub), 3843);                       // 3790 × 0,75 + 1000
  assert.equal(Math.round(r.pago.desc), 769);                  // 20% sobre 3842,5
  const r2 = cotizar(S, [{ eans: ['y'], qty: 1 }, { eans: ['z'], qty: 1 }], getFila, { ...c, promos: [{ ...pr, acumulable: false }] });
  assert.equal(Math.round(r2.pago.desc), 200);                 // solo sobre lo que no tiene oferta
  console.log('✔ motor: doble descuento OK');
}

// el precio en oferta informado por el súper manda sobre el % redondeado de la leyenda (Taragüi 1 kg en Día)
{
  const f = interpretarFila([5369, 3790, { t: 'pct', v: 0.29 }, '29% de descuento']);
  assert.equal(lineaConPromo(f.lista, 1, f.promo).total, 3790);
  assert.equal(lineaConPromo(f.lista, 2, f.promo).total, 7580);
  console.log('✔ motor: precio en oferta exacto OK');
}

// dos ofertas del súper sobre el mismo producto: se elige la mejor según la cantidad, y la del banco se suma encima
{
  const L = [{ p: [1000, 800, { t: 'pct', v: 0.2 }, '20% off', 650, { t: '2da', v: 0.7 }, 'Llevando 2, 2da al 30%'] }];
  const S = { id: 'x', cad: 'dia', lat: 0, lng: 0, lp: 0, listas: L, dif: {} };
  const c0 = { dia: 5, fecha: '2026-11-20', medios: new Set(['modo']), promos: [{ cad: 'dia', medio: 'modo', dias: [5], pct: 0.2, tope: null, min: 1500, nota: 'vie 20%' }] };
  const r1 = cotizar(S, [{ eans: ['p'], qty: 1 }], getFila, c0);
  assert.equal(r1.sub, 800);                                  // 1 unidad: gana el 20% off
  assert.equal(r1.casi.length, 1); assert.equal(r1.casi[0].falta, 700);
  const r2 = cotizar(S, [{ eans: ['p'], qty: 2 }], getFila, c0);
  assert.equal(r2.sub, 1300);                                 // 2 unidades: 1000 + 300 (2da al 30%) gana a 1600
  const r3 = cotizar(S, [{ eans: ['p'], qty: 4 }], getFila, c0);
  assert.equal(r3.sub, 2600); assert.equal(r3.pago.desc, 520); // y MODO 20% sobre el total ya rebajado
  const r4 = cotizar(S, [{ eans: ['p'], qty: 4 }], getFila, { ...c0, medios: new Set() });
  assert.equal(r4.otrosMedios.length, 1); assert.equal(r4.otrosMedios[0].descHoy, 520);
  console.log('✔ motor: dos ofertas + promo bancaria OK');
}

// Coto + Mercado Pago: no acumulable con ofertas y con productos excluidos
{
  const { excluida } = await import('../app/motor.js');
  const promos = JSON.parse((await import('node:fs')).readFileSync(new URL('../app/promos.json', import.meta.url))).promos;
  const pr = promos.find(p => p.cad === 'coto' && p.medio === 'mp' && p.dias.includes(5));
  const info = { yerba: { nombre: 'YERBA MATE TARAGUI 1 KG', marca: 'TARAGUI', tipo: 'Yerba mate 1 kg' },
    coca: { nombre: 'GASEOSA COCA COLA 2.25 L', marca: 'COCA COLA', tipo: 'Gaseosa cola 2,25 L' },
    pollo: { nombre: 'POLLO ENTERO FRESCO', marca: '', tipo: 'Pollo entero 1 kg' },
    caldo: { nombre: 'CALDO DE POLLO KNORR X12', marca: 'KNORR', tipo: 'Caldo pollo 114 g' },
    vino: { nombre: 'VINO TINTO MALBEC 750 ML', marca: 'X', tipo: 'Vino tinto malbec 750 ml' },
    aceite: { nombre: 'ACEITE GIRASOL NATURA 1.5 L', marca: 'NATURA', tipo: 'Aceite de girasol 1,5 L' } };
  assert.equal(excluida(pr, info.yerba), false);
  assert.equal(excluida(pr, info.coca), true);
  assert.equal(excluida(pr, info.pollo), true);
  assert.equal(excluida(pr, info.caldo), false);
  assert.equal(excluida(pr, info.vino), true);
  const L = [{ yerba: [4000], coca: [3000], aceite: [5000, 4000, { t: 'pct', v: 0.2 }, '20% off'] }];
  const S = { id: 'c', cad: 'coto', lat: 0, lng: 0, lp: 0, listas: L, dif: {} };
  const ctxC = { dia: 5, fecha: '2026-11-20', medios: new Set(['mp']), promos: [pr], info: e => info[e] };
  const r = cotizar(S, [{ eans: ['yerba'], qty: 1 }, { eans: ['coca'], qty: 1 }, { eans: ['aceite'], qty: 1 }], getFila, ctxC);
  assert.equal(r.sub, 11000);
  assert.equal(r.pago.desc, 1000);                 // 25% solo sobre la yerba: la coca está excluida y el aceite ya tiene oferta
  assert.equal(r.pago.enOferta, 1); assert.equal(r.pago.excluidos, 1);
  console.log('✔ motor: Coto + Mercado Pago (no acumulable y exclusiones) OK');
}
