// node tests/motor.test.mjs — pruebas del motor de cálculo (sin dependencias)
import assert from 'node:assert/strict';
import { lineaConPromo, cotizar, rankear, celdasCercanas, fechaDelDia, mejorDivision } from '../app/motor.js';

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
