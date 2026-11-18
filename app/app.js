import { aplicarFotos } from './fotos.js';
import { DIAS, celdasCercanas, rankear, mejorDivision, porDiaDeLaSemana, fechaDelDia, km, interpretarFila, mejorLinea } from './motor.js';

const $ = s => document.querySelector(s);
const fmt = n => '$' + Math.round(n).toLocaleString('es-AR');
const norm = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const titulo = s => /[a-záéíóúñ]/.test(s || '') ? s : (s || '').toLowerCase().replace(/(^|[\s(/-])\S/g, c => c.toUpperCase());
const INICIAL = ['D', 'L', 'M', 'M', 'J', 'V', 'S'];

const NOMBRES_CAD = { dia: 'Día', coto: 'Coto', carrefour: 'Carrefour', chango: 'Chango Más', jumbo: 'Jumbo', disco: 'Disco',
  vea: 'Vea', anonima: 'La Anónima', coope: 'Cooperativa Obrera', vital: 'Vital', diarco: 'Diarco', josimar: 'Josimar', nini: 'Nini' };
const ICONO = {
  pin: '<svg viewBox="0 0 24 24"><path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12Z"/><circle cx="12" cy="10" r="2.6"/></svg>',
  ruta: '<svg viewBox="0 0 24 24"><path d="M3 11 21 3l-8 18-2-8z"/></svg>',
  flecha: '<svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>',
  dos: '<svg viewBox="0 0 24 24"><path d="M4 7h11M4 7l3-3M4 7l3 3M20 17H9m11 0-3-3m3 3-3 3"/></svg>',
  marca: '<svg viewBox="0 0 24 24"><path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.3"/></svg>',
  falta: '<svg viewBox="0 0 24 24"><path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9"/></svg>',
  lista: '<svg viewBox="0 0 24 24"><path d="M3 5h2l2.2 10.2a1 1 0 0 0 1 .8H17a1 1 0 0 0 1-.8L19.5 8H6"/><circle cx="9" cy="20" r="1.4"/><circle cx="17" cy="20" r="1.4"/></svg>',
};

/* ------------------------------------------------------------ estado */
const guardado = (() => { try { return JSON.parse(localStorage.getItem('ci') || '{}'); } catch { return {}; } })();
const estado = {
  lista: (guardado.lista || []).filter(it => it.tipo),     // [{tipo: 'Yerba mate 1 kg', marcas: ['TARAGUI'], qty}]
  medios: new Set(guardado.medios || ['cuentadni']),
  radio: guardado.radio || 3,
  ubic: guardado.ubic || null,
  dia: new Date().getDay(),
  abiertos: new Set(), verTodos: false, hojaItem: null,
};
function guardar() {
  const lista = estado.lista.map(({ tipo, marcas, qty }) => ({ tipo, marcas, qty }));
  try { localStorage.setItem('ci', JSON.stringify({ lista, medios: [...estado.medios], radio: estado.radio, ubic: estado.ubic, vioTipIOS: guardado.vioTipIOS })); } catch {}
}

let INDEX = null, PROMOS = { medios: [], promos: [] };
let TIPOS = [], TIPO_NORM = [], TIPO_IDX = new Map(), PROD = [], PROD_NORM = [], POR_TIPO = [], POR_EAN = new Map();
const tiles = new Map();
let stores = [];
let ultimo = null;                      // último resultado (para la barra de la lista)

const nombreCad = k => NOMBRES_CAD[k] || titulo(INDEX?.cadenas?.[k] || k);
const nombreMedio = id => id === 'efectivo' ? 'efectivo o débito' : (PROMOS.medios.find(m => m.id === id)?.nombre || id);
const infoProd = ean => { const p = POR_EAN.get(ean); return p && { nombre: p[1], marca: p[2], tipo: TIPOS[p[4]] }; };
const ctxDe = dia => ({ dia, fecha: fechaDelDia(dia), medios: new Set(['efectivo', ...estado.medios]), promos: PROMOS.promos, info: infoProd });

function getFila(store, ean) {
  if (store.dif && Object.prototype.hasOwnProperty.call(store.dif, ean)) return store.dif[ean];
  return store.listas[store.lp]?.[ean] ?? null;
}
function marcasDe(ti) {
  const vistas = new Set(), out = [];
  for (const pi of POR_TIPO[ti]) { const m = PROD[pi][2] || 'Sin marca'; if (!vistas.has(m)) { vistas.add(m); out.push(m); } }
  return out;
}
function paraMotor(it) {
  const ti = TIPO_IDX.get(it.tipo);
  const eans = POR_TIPO[ti].filter(pi => !it.marcas.length || it.marcas.includes(PROD[pi][2] || 'Sin marca')).map(pi => PROD[pi][0]);
  return { ...it, eans, nombre: it.tipo + (it.marcas.length ? ` (${it.marcas.map(titulo).join(', ')})` : '') };
}
/** EANs representativos para la foto: los de las marcas elegidas o los más vendidos del producto genérico. */
function eansFoto(ti, marcas = []) {
  const ps = POR_TIPO[ti] || [];
  const elegidos = marcas.length ? ps.filter(pi => marcas.includes(PROD[pi][2] || 'Sin marca')) : ps;
  return elegidos.slice(0, 4).map(pi => PROD[pi][0]);
}
/** Tarjeta de producto: la foto de estudio si existe; si no, una etiqueta con la marca en un color propio de la marca. */
function tonoMarca(t) { let h = 0; for (const c of norm(t)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
function etiquetaMarca(marca, tipo) {
  const txt = titulo(marca && marca !== 'Sin marca' ? marca : (tipo || '').split(' ')[0]) || '·';
  const corto = txt.length > 22 ? txt.slice(0, 21) + '…' : txt;
  const palabra = Math.max(...corto.split(/\s+/).map(w => w.length));
  const k = Math.min(1, 7 / Math.max(palabra, 1)).toFixed(2);      // achica la letra para que ninguna palabra se corte
  return `<span class="et" style="--h:${tonoMarca(txt)};--k:${k}"><b>${esc(corto)}</b></span>`;
}
const foto = (eans, clase = '', marca = '', tipo = '') => `<span class="foto ${clase}" data-fotos="${esc(eans.join(','))}" aria-hidden="true">${etiquetaMarca(marca, tipo)}</span>`;
const marcaDe = ean => POR_EAN.get(ean)?.[2] || '';
/** Foto que abre la ficha del producto al tocarla. */
const fotoFicha = (eans, clase = '', marca = '', tipo = '') => `<button type="button" class="foto-btn" data-ficha="${esc(eans[0] || '')}" aria-label="Ver ficha del producto">${foto(eans, clase, marca, tipo)}</button>`;
const textoMarcas = it => !it.marcas.length ? 'Cualquier marca' : it.marcas.length === 1 ? titulo(it.marcas[0]) : `${titulo(it.marcas[0])} y ${it.marcas.length - 1} más`;
const cercanas = () => estado.ubic ? stores.filter(s => km(estado.ubic, s) <= estado.radio) : [];

function toast(msg, ms = 3500) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, ms);
}

/* ------------------------------------------------------------ datos */
async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}
async function cargarBase() {
  const [idx, cat, promos] = await Promise.all([getJSON('data/index.json'), getJSON('data/catalogo.json'), getJSON('promos.json')]);
  INDEX = idx; PROMOS = promos;
  TIPOS = cat.tipos; TIPO_NORM = TIPOS.map(norm); TIPO_IDX = new Map(TIPOS.map((t, i) => [t, i]));
  PROD = cat.productos; PROD_NORM = PROD.map(p => norm(`${p[1]} ${p[2]}`));
  POR_TIPO = TIPOS.map(() => []); PROD.forEach((p, i) => POR_TIPO[p[4]].push(i));
  POR_EAN = new Map(PROD.map(p => [p[0], p]));
  const f = new Date(idx.fecha + 'T12:00:00');
  const dias = Math.round((Date.now() - f) / 864e5);
  $('#datosInfo').textContent = `Precios del ${DIAS[f.getDay()].toLowerCase()} ${f.getDate()}/${f.getMonth() + 1} de ${idx.sucursales.toLocaleString('es-AR')} sucursales de todo el país.` + (dias > 2 ? ` Tienen ${dias} días: puede haber cambios.` : '');
  $('#promosInfo').textContent = `Promos bancarias revisadas el ${promos.actualizado.split('-').reverse().join('/')}.`;
  const antes = estado.lista.length;
  estado.lista = estado.lista.filter(it => TIPO_IDX.has(it.tipo));
  estado.lista.forEach(it => it.marcas ||= []);
  if (estado.lista.length < antes) toast('Algunos productos de tu lista ya no están en los precios de hoy.');
}
async function cargarCeldas() {
  if (!estado.ubic || !INDEX) return;
  const necesarias = celdasCercanas(estado.ubic, estado.radio, INDEX.tam).filter(c => INDEX.celdas[c]);
  const faltan = necesarias.filter(c => !tiles.has(c));
  if (faltan.length) {
    $('#resultado').innerHTML = '<div class="vacio"><div class="cargando"></div><p>Buscando supermercados cerca…</p></div>';
    await Promise.all(faltan.map(async c => { try { tiles.set(c, await getJSON(`data/tiles/${c}.json`)); } catch (e) { console.warn(e); } }));
  }
  stores = [];
  for (const c of necesarias) { const t = tiles.get(c); if (t) for (const s of t.sucursales) stores.push({ ...s, listas: t.listas }); }
}

/* ------------------------------------------------------------ ubicación */
function setUbic(lat, lng, label) {
  estado.ubic = { lat, lng, label };
  guardar(); pintarUbic();
  cargarCeldas().then(() => renderTodo());
}
function pintarUbic() {
  const l = estado.ubic?.label || 'Elegí tu ubicación';
  $('#chipUbicTxt').textContent = estado.ubic ? l.replace(/^Tu ubicación actual.*/, 'Cerca tuyo') : l;
  $('#ubicInfo').textContent = estado.ubic ? l : 'Todavía no elegiste dónde estás.';
  $('#btnGPS').textContent = estado.ubic ? 'Actualizar mi ubicación' : 'Usar mi ubicación';
}
function pedirGPS(silencioso = false) {
  if (!navigator.geolocation) { if (!silencioso) toast('Este navegador no comparte la ubicación. Escribí una dirección.'); return; }
  document.querySelectorAll('[data-gps]').forEach(b => { b.disabled = true; b.textContent = 'Buscando tu ubicación…'; });
  $('#btnGPS').disabled = true;
  navigator.geolocation.getCurrentPosition(p => {
    $('#btnGPS').disabled = false;
    setUbic(p.coords.latitude, p.coords.longitude, `Tu ubicación actual (precisión ${Math.round(p.coords.accuracy)} m)`);
  }, err => {
    $('#btnGPS').disabled = false; pintarUbic(); renderAhorro();
    if (!silencioso) toast(err.code === 1 ? 'Sin permiso de ubicación. Podés escribir una dirección en “Dónde y cómo”.' : 'No se pudo obtener la ubicación. Probá con una dirección.');
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 300000 });
}
async function buscarDireccion(q) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=ar&accept-language=es&q=${encodeURIComponent(q)}`);
    const [hit] = await r.json();
    if (!hit) return toast('No encontré esa dirección. Agregá el barrio o la localidad.');
    setUbic(+hit.lat, +hit.lon, hit.display_name.split(',').slice(0, 2).join(','));
    location.hash = '#ahorro';
  } catch { toast('No se pudo buscar la dirección. Revisá la conexión.'); }
}

/* ------------------------------------------------------------ navegación */
function irA() {
  const v = ['ahorro', 'lista', 'ajustes'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'ahorro';
  document.querySelectorAll('.vista').forEach(s => s.classList.toggle('activa', s.id === 'v-' + v));
  document.querySelectorAll('.tabs a').forEach(a => a.dataset.v === v ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'));
  pintarBarraTotal();
  window.scrollTo({ top: 0 });
}

/* ------------------------------------------------------------ controles */
function initControles() {
  const hoy = new Date().getDay();
  $('#dias').innerHTML = DIAS.map((d, i) => `<button type="button" role="radio" data-d="${i}" class="${i === hoy ? 'hoy' : ''}" aria-label="${d}${i === hoy ? ', hoy' : ''}">${i === hoy ? 'Hoy' : '&nbsp;'}<b>${INICIAL[i]}</b></button>`).join('');
  $('#dias').onclick = e => { const b = e.target.closest('[data-d]'); if (b) { estado.dia = +b.dataset.d; renderAhorro(); } };
  $('#radio').value = estado.radio;
  $('#radioLbl').textContent = estado.radio + ' km';
  let tRadio;
  $('#radio').oninput = e => {
    estado.radio = +e.target.value; $('#radioLbl').textContent = estado.radio + ' km'; guardar();
    clearTimeout(tRadio); tRadio = setTimeout(() => cargarCeldas().then(() => renderTodo()), 250);
  };
  $('#btnGPS').onclick = () => pedirGPS(false);
  $('#chipUbic').onclick = () => { location.hash = '#ajustes'; };
  $('#formDir').onsubmit = e => { e.preventDefault(); const q = $('#dir').value.trim(); if (q) buscarDireccion(q); };
  $('#vaciar').onclick = () => { estado.lista = []; renderTodo(); };
  window.addEventListener('hashchange', irA);

  // buscador
  const b = $('#buscar'), sg = $('#sugg');
  let act = 0, opts = [];
  const pintar = () => {
    sg.innerHTML = opts.map((o, i) => `<div role="option" data-i="${i}" class="${i === act ? 'act' : ''}" aria-selected="${i === act}">${foto(eansFoto(o.ti, o.marca ? [o.marca] : []), '', o.marca || '', TIPOS[o.ti])}<span>${esc(TIPOS[o.ti])}${o.marca ? `, ${esc(titulo(o.marca))}` : ''}<small>${o.marca ? 'Solo esta marca' : `Cualquier marca, la más barata de ${marcasDe(o.ti).length}`}</small></span></div>`).join('');
    sg.style.display = opts.length ? 'block' : 'none';
    aplicarFotos(sg);
  };
  b.oninput = () => {
    const toks = norm(b.value).split(/\s+/).filter(Boolean);
    opts = [];
    if (toks.length) {
      for (let t = 0; t < TIPOS.length && opts.length < 8; t++) if (toks.every(k => TIPO_NORM[t].includes(k))) opts.push({ ti: t });
      const vistos = new Set();
      for (let i = 0; i < PROD.length && opts.length < 16; i++) {
        const p = PROD[i], clave = p[4] + '|' + p[2];
        if (vistos.has(clave) || !toks.every(k => PROD_NORM[i].includes(k) || TIPO_NORM[p[4]].includes(k))) continue;
        if (!toks.some(k => norm(p[2]).includes(k))) continue;
        vistos.add(clave); opts.push({ ti: p[4], marca: p[2] || 'Sin marca' });
      }
    }
    act = 0; pintar();
  };
  const agregar = o => {
    const tipo = TIPOS[o.ti], marcas = o.marca ? [o.marca] : [];
    const ex = estado.lista.find(i => i.tipo === tipo && i.marcas.join() === marcas.join());
    if (ex) ex.qty++; else estado.lista.push({ tipo, marcas, qty: 1 });
    b.value = ''; opts = []; pintar(); renderTodo();
    toast(`Agregaste ${tipo}`, 1800);
  };
  b.onkeydown = e => {
    if (e.key === 'Enter' && opts[act]) { agregar(opts[act]); e.preventDefault(); }
    if (e.key === 'ArrowDown') { act = Math.min(act + 1, opts.length - 1); pintar(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { act = Math.max(act - 1, 0); pintar(); e.preventDefault(); }
    if (e.key === 'Escape') { opts = []; pintar(); }
  };
  sg.onmousedown = e => { const d = e.target.closest('[data-i]'); if (d) { e.preventDefault(); agregar(opts[+d.dataset.i]); } };
  b.onblur = () => setTimeout(() => sg.style.display = 'none', 150);
  $('#sugerencias').onclick = e => { const c = e.target.closest('[data-ti]'); if (c) agregar({ ti: +c.dataset.ti }); };

  // hoja de marcas
  $('#velo').onclick = () => { if (!$('#ficha').hidden) cerrarFicha(); else cerrarHoja(); };
  $('#hojaListo').onclick = cerrarHoja; $('#fichaCerrar').onclick = cerrarFicha;
  document.addEventListener('keydown', e => { if (e.key !== 'Escape') return; if (!$('#ficha').hidden) cerrarFicha(); else if (!$('#hoja').hidden) cerrarHoja(); });
  $('#hojaFiltro').oninput = e => {
    const q = norm(e.target.value);
    $('#hojaMarcas').querySelectorAll('li[data-m]').forEach(li => li.hidden = !!q && !norm(li.dataset.m).includes(q));
  };
  $('#hojaMarcas').onchange = e => {
    const it = estado.lista[estado.hojaItem]; if (!it) return;
    const m = e.target.dataset.m;
    if (m === '') it.marcas = [];
    else it.marcas = e.target.checked ? [...new Set([...it.marcas, m])] : it.marcas.filter(x => x !== m);
    pintarHoja(); renderTodo(false);
  };
}

/* ------------------------------------------------------------ lista */
function pintarCuenta() {
  const n = estado.lista.reduce((a, it) => a + it.qty, 0);
  $('#cuenta').hidden = !n; $('#cuenta').textContent = n;
}
function renderLista() {
  pintarCuenta();
  $('#vaciar').hidden = !estado.lista.length;
  const populares = [];
  for (let t = 0; t < TIPOS.length && populares.length < 10; t++) if (!estado.lista.some(i => i.tipo === TIPOS[t])) populares.push(t);
  $('#sugerencias').innerHTML = estado.lista.length < 6 && populares.length
    ? `<h2>${estado.lista.length ? 'Sumá algo más' : 'Lo que más se compra'}</h2><div class="chips">${populares.map(t => `<button type="button" class="chip" data-ti="${t}">${esc(TIPOS[t])}</button>`).join('')}</div>` : '';
  $('#lista').innerHTML = estado.lista.map((it, i) => `
    <li class="item">${fotoFicha(eansFoto(TIPO_IDX.get(it.tipo), it.marcas), 'f-item', it.marcas.length === 1 ? it.marcas[0] : '', it.tipo)}<span class="n">${esc(it.tipo)}</span>
      <span class="paso"><button type="button" data-a="-" data-i="${i}" aria-label="Uno menos de ${esc(it.tipo)}">−</button><b aria-live="polite">${it.qty}</b><button type="button" data-a="+" data-i="${i}" aria-label="Uno más de ${esc(it.tipo)}">+</button></span>
      <button type="button" class="marca-btn" data-a="m" data-i="${i}" aria-haspopup="dialog"><span>${esc(textoMarcas(it))}</span>${ICONO.flecha}</button></li>`).join('');
  aplicarFotos($('#lista'));
  $('#lista').querySelectorAll('button[data-a]').forEach(btn => btn.onclick = () => {
    const i = +btn.dataset.i, a = btn.dataset.a;
    if (a === 'm') return abrirHoja(i);
    if (a === '+') estado.lista[i].qty++;
    if (a === '-' && !--estado.lista[i].qty) estado.lista.splice(i, 1);
    renderTodo();
  });
}

function abrirHoja(i) {
  estado.hojaItem = i; $('#hojaFiltro').value = '';
  pintarHoja();
  $('#velo').hidden = false; $('#hoja').hidden = false;
  setTimeout(() => $('#hojaFiltro').focus({ preventScroll: true }), 50);
}
function cerrarHoja() { $('#velo').hidden = true; $('#hoja').hidden = true; estado.hojaItem = null; }
function pintarHoja() {
  const it = estado.lista[estado.hojaItem]; if (!it) return;
  const ti = TIPO_IDX.get(it.tipo);
  $('#hojaTitulo').textContent = it.tipo;
  // por marca: precio más bajo (con oferta, 1 unidad) y en cuántos súper cercanos está
  const cerca = cercanas(), info = new Map();
  for (const pi of POR_TIPO[ti]) {
    const [ean, , marca] = PROD[pi], m = marca || 'Sin marca';
    const x = info.get(m) || { min: Infinity, sucs: new Set() };
    for (const s of cerca) {
      const f = interpretarFila(getFila(s, ean)); if (!f) continue;
      x.min = Math.min(x.min, mejorLinea(f, 1).total); x.sucs.add(s.id);
    }
    info.set(m, x);
  }
  const marcas = marcasDe(ti).sort((a, b) => (info.get(b).sucs.size > 0) - (info.get(a).sucs.size > 0) || info.get(a).min - info.get(b).min);
  const linea = m => { const x = info.get(m); return x.sucs.size ? `Desde ${fmt(x.min)} en ${x.sucs.size} súper cerca` : 'No está en los súper cercanos'; };
  const filtro = norm($('#hojaFiltro').value);
  $('#hojaMarcas').innerHTML = `<li class="cualquiera"><label><input type="checkbox" data-m="" ${it.marcas.length ? '' : 'checked'}><span>Cualquier marca<small>Se elige la más barata en cada súper</small></span></label></li>` +
    marcas.map(m => `<li data-m="${esc(m)}" ${filtro && !norm(m).includes(filtro) ? 'hidden' : ''}><label><input type="checkbox" data-m="${esc(m)}" ${it.marcas.includes(m) ? 'checked' : ''}>${fotoFicha(eansFoto(ti, [m]), '', m, TIPOS[ti])}<span>${esc(titulo(m))}<small>${linea(m)}</small></span></label></li>`).join('');
  aplicarFotos($('#hojaMarcas'));
}

function pintarBarraTotal() {
  const bt = $('#barraTotal');
  if (!ultimo || location.hash !== '#lista') { bt.hidden = true; return; }
  bt.hidden = false;
  bt.innerHTML = `<span><small>Lo más barato ${estado.dia === new Date().getDay() ? 'hoy' : 'el ' + DIAS[estado.dia].toLowerCase()}, en ${esc(nombreCad(ultimo.store.cad))}</small><b>${fmt(ultimo.total)}</b></span><a class="ir" href="#ahorro">Ver ticket</a>`;
}

/* ------------------------------------------------------------ ficha de producto */
function abrirFicha(ean) {
  const p = POR_EAN.get(ean); if (!p) return;
  const [, nombre, marca, pres, ti] = p;
  const interno = ean.startsWith('i');
  // precio de este producto (1 unidad, con la mejor oferta) en cada súper cercano
  const ctx = ctxDe(estado.dia);
  const filas = [];
  for (const s of cercanas()) {
    const f = interpretarFila(getFila(s, ean)); if (!f) continue;
    const l = mejorLinea(f, 1);
    filas.push({ s, l, f, d: km(estado.ubic, s) });
  }
  filas.sort((a, b) => a.l.total - b.l.total || a.d - b.d);
  const min = filas[0]?.l.total, max = filas[filas.length - 1]?.l.total;
  const enLista = estado.lista.some(it => it.tipo === TIPOS[ti] && (!it.marcas.length || it.marcas.includes(marca || 'Sin marca')));
  $('#fichaCuerpo').innerHTML = `
    <div class="ficha-foto">${foto([ean], 'grande', marca, TIPOS[ti])}</div>
    <h2 id="fichaNombre">${esc(titulo(nombre))}</h2>
    <p class="ficha-meta">${[marca && `<b>${esc(titulo(marca))}</b>`, pres && esc(pres), esc(TIPOS[ti])].filter(Boolean).join('<span aria-hidden="true"> / </span>')}</p>
    <p class="ficha-ean">${interno ? 'Código interno del súper' : `EAN ${esc(ean)}`}</p>
    ${filas.length ? `<div class="ficha-rango"><span>Cerca tuyo</span><b>${fmt(min)}</b>${max - min >= 1 ? `<span>a ${fmt(max)}</span>` : ''}</div>
    <ul class="ficha-precios">${filas.slice(0, 12).map((x, i) => `<li class="${i === 0 ? 'min' : ''}">
        <span><b>${esc(nombreSuc(x.s))}</b><small>${esc(titulo(x.s.dir))}, a ${kmTxt(x.d)}</small></span>
        <span class="r">${x.l.aplica && Math.round(x.l.unit) < Math.round(x.f.lista) ? `<s>${fmt(x.f.lista)}</s>` : ''}<b>${fmt(x.l.total)}</b>${x.l.promo ? `<span class="of">${esc(x.l.promo)}</span>` : ''}</span></li>`).join('')}</ul>`
      : '<p class="ayuda">No lo encontramos en los súper cercanos.</p>'}
    <button class="btn grande" type="button" id="fichaAgregar" ${enLista ? 'disabled' : ''}>${enLista ? 'Ya está en tu lista' : 'Agregar a la lista'}</button>`;
  aplicarFotos($('#ficha'));
  $('#fichaAgregar').onclick = () => {
    const tipo = TIPOS[ti], marcas = [marca || 'Sin marca'];
    const ex = estado.lista.find(i => i.tipo === tipo && i.marcas.join() === marcas.join());
    if (ex) ex.qty++; else estado.lista.push({ tipo, marcas, qty: 1 });
    cerrarFicha(); renderTodo(); toast(`Agregaste ${titulo(nombre)}`, 2000);
  };
  $('#velo').hidden = false; $('#ficha').hidden = false;
  $('#ficha').scrollTop = 0;
  setTimeout(() => $('#fichaCerrar').focus({ preventScroll: true }), 50);
}
function cerrarFicha() {
  $('#ficha').hidden = true;
  if ($('#hoja').hidden) $('#velo').hidden = true;
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-ficha]');
  if (!b || !b.dataset.ficha) return;
  e.preventDefault(); e.stopPropagation();
  abrirFicha(b.dataset.ficha);
}, true);

/* ------------------------------------------------------------ ahorro */
function vacio(icono, tituloTxt, texto, boton = '') {
  return `<div class="vacio"><div class="ilus">${icono}</div><h2>${tituloTxt}</h2><p>${texto}</p>${boton}</div>`;
}
const mapa = s => `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}`;
const nombreSuc = s => {
  if (!NOMBRES_CAD[s.cad]) return titulo(s.b) || nombreCad(s.cad);
  const f = norm(s.b).match(/\b(market|express|maxi|hiper|mini|super|mayorista|cerca)\b/);
  return NOMBRES_CAD[s.cad] + (f && !(s.cad === 'chango' && f[1] === 'mas') ? ' ' + f[1][0].toUpperCase() + f[1].slice(1) : '');
};
const kmTxt = d => d.toFixed(1).replace('.', ',') + ' km';

function lineasTicket(r) {
  return r.lineas.map(l => l.p === null
    ? `<div class="tl falta">${foto(eansFoto(TIPO_IDX.get(l.it.tipo), l.it.marcas), '', l.it.marcas[0] || '', l.it.tipo)}<span class="n">${esc(l.it.tipo)}</span><span class="t">—</span><span class="d">${l.it.marcas.length ? 'No tiene la marca que elegiste' : 'No lo tiene'}</span></div>`
    : `<div class="tl">${fotoFicha([l.ean], '', marcaDe(l.ean), l.it.tipo)}<span class="n">${esc(l.it.tipo)}</span><span class="t">${fmt(l.total)}</span>
        <span class="d">${esc(titulo(POR_EAN.get(l.ean)?.[1] || ''))}</span>
        <span class="d">${l.it.qty} × ${fmt(l.unit)}${l.aplica && Math.round(l.unit) < Math.round(l.p) ? ` <span class="tachado">${fmt(l.p)}</span>` : ''}${l.promo ? ` <span class="of">${esc(l.promo)}</span>` : ''}${l.sinPago ? ` <span class="sinpago">${l.sinPago === 'oferta' ? 'Sin descuento por pago: ya tiene oferta' : 'Excluido de la promo de pago'}</span>` : ''}</span></div>`).join('');
}

function renderAhorro() {
  $('#dias').querySelectorAll('[data-d]').forEach(b => b.setAttribute('aria-checked', +b.dataset.d === estado.dia));
  const out = $('#resultado');
  ultimo = null;
  if (!INDEX) return;
  if (!estado.ubic) {
    out.innerHTML = vacio(ICONO.pin, 'Primero, ¿dónde estás?', 'Con tu ubicación buscamos los supermercados cercanos. Queda solo en tu teléfono.',
      '<button class="btn grande" type="button" data-gps>Usar mi ubicación</button><p style="margin-top:12px"><a class="link" href="#ajustes">Prefiero escribir una dirección</a></p>');
    out.querySelector('[data-gps]').onclick = () => pedirGPS(false);
    return pintarBarraTotal();
  }
  const cerca = cercanas().length;
  if (!estado.lista.length) {
    out.innerHTML = vacio(ICONO.lista, 'Armá tu lista', `Hay ${cerca} ${cerca === 1 ? 'supermercado' : 'supermercados'} a menos de ${estado.radio} km. Agregá lo que vas a comprar y te mostramos dónde sale menos.`,
      '<a class="btn grande" href="#lista">Agregar productos</a>');
    return pintarBarraTotal();
  }
  const ctx = ctxDe(estado.dia);
  const lista = estado.lista.map(paraMotor);
  const res = rankear(stores, estado.ubic, estado.radio, lista, getFila, ctx);
  if (!res.length) {
    out.innerHTML = vacio(ICONO.pin, 'No hay súper con estos productos cerca', `Probá ampliar la distancia (ahora es ${estado.radio} km) o cambiar alguna marca.`, '<a class="btn grande" href="#ajustes">Ampliar la distancia</a>');
    return pintarBarraTotal();
  }
  const comp = res.filter(r => !r.faltan.length);
  const top = comp[0] || res[0];
  ultimo = top;
  const prom = comp.length ? comp.reduce((a, r) => a + r.total, 0) / comp.length : top.total;
  const ahorro = prom - top.total;
  const cuando = estado.dia === new Date().getDay() ? 'hoy' : 'el ' + DIAS[estado.dia].toLowerCase();

  let h = `<article class="ticket" aria-label="Ticket estimado en ${esc(nombreCad(top.store.cad))}">
    <div class="ticket-cab"><div><h2>${esc(nombreSuc(top.store))}</h2>
      <p>${esc(titulo(top.store.dir))}${top.store.loc ? ', ' + esc(top.store.loc) : ''}. A ${kmTxt(top.dist)}</p>
      <a class="como-llegar" href="${mapa(top.store)}" target="_blank" rel="noopener">${ICONO.ruta}Cómo llegar</a></div>
      ${comp.length > 1 && ahorro >= 1 ? `<div class="etiqueta"><small>Ahorrás frente al promedio de la zona</small><b>${fmt(ahorro)}</b></div>` : ''}</div>
    <div class="ticket-lineas">${lineasTicket(top)}</div>
    <div class="ticket-sum">
      ${top.promoSuper > 0 ? `<div class="ts"><span>Sin ofertas</span><span>${fmt(top.sub + top.promoSuper)}</span></div><div class="ts desc"><span>Ofertas del súper</span><span>−${fmt(top.promoSuper)}</span></div>` : ''}
      ${top.pago.desc ? `<div class="ts desc"><span>Pagando con ${esc(nombreMedio(top.pago.medio))}<small>${esc(top.pago.nota)}${top.promoSuper > 0 && top.pago.pr?.acumulable !== false ? '. Se suma a las ofertas del súper' : ''}${top.pago.enOferta || top.pago.excluidos ? `. Se aplica sobre ${fmt(top.pago.base)}: quedan afuera ${[top.pago.enOferta ? `${top.pago.enOferta} con oferta del súper (no es acumulable)` : '', top.pago.excluidos ? `${top.pago.excluidos} excluido${top.pago.excluidos > 1 ? 's' : ''} por las bases` : ''].filter(Boolean).join(' y ')}` : ''}${top.pago.topeado ? '. Llega al tope' : ''}</small></span><span>−${fmt(top.pago.desc)}</span></div>`
        : `<div class="ts"><span>Pago<small>${top.casi.length ? `${esc(nombreMedio(top.casi[0].medio))} no se aplica: pide una compra mínima de ${fmt(top.casi[0].min)}` : `Ninguno de tus medios tiene promo acá ${cuando}`}</small></span><span>$0</span></div>`}
      <div class="ticket-total"><span>Total ${cuando}</span><b>${fmt(top.total)}</b></div>
      ${top.faltan.length ? `<p class="aviso-faltan">Ningún súper cercano tiene toda la lista. Acá faltan ${top.faltan.length}.</p>` : ''}
    </div></article>`;

  // ideas para ahorrar más
  const ideas = [];
  if (comp.length && estado.lista.some(it => it.marcas.length)) {
    const libre = estado.lista.map(it => paraMotor({ ...it, marcas: [] }));
    const mejorLibre = rankear(stores, estado.ubic, estado.radio, libre, getFila, ctx).find(r => !r.faltan.length);
    if (mejorLibre && top.total - mejorLibre.total > 500)
      ideas.push(`<div class="idea"><span class="ic">${ICONO.marca}</span><div><p>Las marcas que elegiste suman <b>${fmt(top.total - mejorLibre.total)}</b>. Con la más barata de cada producto pagarías ${fmt(mejorLibre.total)} en ${esc(nombreCad(mejorLibre.store.cad))}.</p><button class="btn sec" type="button" id="sinMarcas">Usar la más barata en todo</button></div></div>`);
  }
  // promos de tus medios que no se aplican por el mínimo de compra
  const conCasi = [top, ...comp.filter(r => r !== top).slice(0, 4)].find(r => r.casi.length);
  if (conCasi) {
    const c = conCasi.casi.sort((a, b) => b.desc - a.desc)[0];
    ideas.push(`<div class="idea"><span class="ic">${ICONO.falta}</span><p>En ${esc(nombreCad(conCasi.store.cad))} la promo de ${esc(nombreMedio(c.medio))} (${Math.round(c.pct * 100)}%${c.tope != null ? `, tope ${fmt(c.tope)}` : ''}) se aplica desde ${fmt(c.min)} y tu compra suma ${fmt(conCasi.sub)}. Te faltan <b>${fmt(c.falta)}</b>; si llegás, te descuentan ${fmt(c.desc)}${conCasi.promoSuper > 0 ? ', además de las ofertas del súper' : ''}.</p></div>`);
  }
  // promos de medios que no marcaste
  const sinMarcar = new Map();
  for (const r of [top, ...comp.filter(r => r !== top).slice(0, 6)])
    for (const o of r.otrosMedios) {
      const ahorro = o.descHoy;
      const prev = sinMarcar.get(o.medio);
      if (!prev || ahorro > prev.ahorro) sinMarcar.set(o.medio, { o, r, ahorro, total: r.total - ahorro });
    }
  const mejorSin = [...sinMarcar.values()].filter(x => x.ahorro > 0 && x.total < top.total).sort((a, b) => a.total - b.total)[0]
    || [...sinMarcar.values()].filter(x => x.r === top).sort((a, b) => b.o.pct - a.o.pct)[0];
  if (mejorSin) {
    const { o, r } = mejorSin;
    ideas.push(`<div class="idea"><span class="ic">${ICONO.marca}</span><div><p>${cuando.charAt(0).toUpperCase() + cuando.slice(1)} ${esc(nombreCad(r.store.cad))} tiene ${Math.round(o.pct * 100)}% con ${esc(nombreMedio(o.medio))}${o.min ? ` desde ${fmt(o.min)}` : ''}${r.promoSuper > 0 ? ', y se suma a las ofertas del súper' : ''}. ${mejorSin.ahorro > 0 ? `Con tu lista pagarías <b>${fmt(mejorSin.total)}</b>.` : `Con tu lista te faltan ${fmt(o.falta)} para el mínimo.`}</p><button class="btn sec" type="button" data-activar="${esc(o.medio)}">Tengo ${esc(nombreMedio(o.medio))}</button></div></div>`);
  }
  const div = mejorDivision(res, lista, getFila, ctx);
  if (div) ideas.push(`<div class="idea"><span class="ic">${ICONO.dos}</span><p>Si dividís la compra, ${div.ra.lineas.length} productos en ${esc(nombreCad(div.ra.store.cad))} y ${div.rb.lineas.length} en ${esc(nombreCad(div.rb.store.cad))}, pagás <b>${fmt(div.tot)}</b>: ${fmt(div.ahorro)} menos.</p></div>`);
  h += ideas.join('');

  // semana
  const porDia = porDiaDeLaSemana(stores, estado.ubic, estado.radio, lista, getFila, ctx);
  const vals = porDia.filter(Boolean).map(x => x.total);
  if (vals.length > 1) {
    const mx = Math.max(...vals), mn = Math.min(...vals), best = porDia.find(x => x && x.total === mn), sel = porDia[estado.dia];
    const otroDia = best.dia !== estado.dia && sel && sel.total - mn > 1;
    h += `<section class="semana"><h2>${otroDia ? `El ${DIAS[best.dia].toLowerCase()} pagás ${fmt(sel.total - mn)} menos` : `${cuando.charAt(0).toUpperCase() + cuando.slice(1)} es el mejor día para esta lista`}</h2>
      <p>${otroDia ? `En ${esc(nombreCad(best.cad))} con ${esc(nombreMedio(best.medio))}: ${fmt(mn)}. Tocá un día para ver su ticket.` : 'Mejor total posible cada día con tus medios de pago. Tocá un día para ver su ticket.'}</p>
      <div class="barras">${porDia.map((x, d) => x
        ? `<button type="button" class="barra ${x.total === mn ? 'mejor' : ''} ${d === estado.dia ? 'sel' : ''}" data-d="${d}" aria-label="${DIAS[d]}: ${fmt(x.total)}"><b>${'$' + (x.total / 1000).toFixed(1).replace('.', ',')}k</b><i style="height:${mx === mn ? 60 : 22 + 66 * (x.total - mn) / (mx - mn)}%"></i>${INICIAL[d]}</button>`
        : `<span class="barra">${INICIAL[d]}</span>`).join('')}</div></section>`;
  }

  // otras opciones
  const otras = res.filter(r => r !== top);
  if (otras.length) {
    const vis = estado.verTodos ? otras : otras.slice(0, 8);
    h += `<section class="opciones"><h2>Otras opciones cerca</h2>${vis.map((r, i) => {
      const s = r.store, open = estado.abiertos.has(s.id);
      return `<div class="op"><button type="button" class="op-cab" data-id="${esc(s.id)}" aria-expanded="${open}">
        <span class="op-n">${i + 2}</span>
        <span><span class="nom">${esc(nombreSuc(s))}</span><span class="sub">${esc(titulo(s.dir))}, a ${kmTxt(r.dist)}</span>
          <span class="pagos">${r.pago.desc ? `<span class="pill">${esc(nombreMedio(r.pago.medio))} −${fmt(r.pago.desc)}</span>` : r.casi.length ? `<span class="pill aviso">${esc(nombreMedio(r.casi[0].medio))} desde ${fmt(r.casi[0].min)}</span>` : ''}${r.faltan.length ? `<span class="pill aviso">Faltan ${r.faltan.length}</span>` : ''}</span></span>
        <span class="tot">${fmt(r.total)}${!r.faltan.length && comp.length && r.total - top.total >= 1 ? `<small>+${fmt(r.total - top.total)}</small>` : ''}</span></button>
        ${open ? `<div class="op-det">${lineasTicket(r)}<p><a class="como-llegar" href="${mapa(s)}" target="_blank" rel="noopener">${ICONO.ruta}Cómo llegar</a></p></div>` : ''}</div>`;
    }).join('')}${otras.length > vis.length ? `<button class="btn sec mas" type="button" id="verTodos">Ver las ${otras.length} opciones</button>` : ''}</section>`;
  }
  out.innerHTML = h;
  aplicarFotos(out);
  out.querySelectorAll('.op-cab').forEach(b => b.onclick = () => { const id = b.dataset.id; estado.abiertos.has(id) ? estado.abiertos.delete(id) : estado.abiertos.add(id); renderAhorro(); });
  out.querySelectorAll('.barra[data-d]').forEach(b => b.onclick = () => { estado.dia = +b.dataset.d; renderAhorro(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
  $('#verTodos')?.addEventListener('click', () => { estado.verTodos = true; renderAhorro(); });
  out.querySelectorAll('[data-activar]').forEach(b => b.onclick = () => { estado.medios.add(b.dataset.activar); guardar(); renderMedios(); renderAhorro(); toast(`Listo, ${nombreMedio(b.dataset.activar)} quedó en tus medios de pago.`); });
  $('#sinMarcas')?.addEventListener('click', () => { estado.lista.forEach(it => it.marcas = []); renderTodo(); toast('Ahora se elige la marca más barata en cada producto.'); });
  pintarBarraTotal();
}

/* ------------------------------------------------------------ medios de pago */
function renderMedios() {
  const dc = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
  const hoyF = fechaDelDia(new Date().getDay());
  const vigentes = id => PROMOS.promos.filter(p => p.medio === id && (!p.hasta || p.hasta >= hoyF));
  const orden = [...PROMOS.medios].sort((a, b) => (vigentes(b.id).length > 0) - (vigentes(a.id).length > 0));
  $('#medios').innerHTML = orden.map(m => {
    const ps = vigentes(m.id);
    const resumen = ps.slice(0, 3).map(p => `${nombreCad(p.cad)} ${p.dias.length === 7 ? 'todos los días' : p.dias.map(d => dc[d]).join(' y ')} ${Math.round(p.pct * 100)}%`).join(', ');
    return `<label class="medio"><span class="txt"><b>${esc(m.nombre)}</b><small>${ps.length ? esc(resumen) + (ps.length > 3 ? ` y ${ps.length - 3} más` : '') : 'Sin promos cargadas este mes'}</small></span>
      <span class="switch"><input type="checkbox" data-m="${m.id}" ${estado.medios.has(m.id) ? 'checked' : ''} aria-label="Tengo ${esc(m.nombre)}"><i></i></span></label>`;
  }).join('');
  $('#medios').onchange = e => { const id = e.target.dataset.m; e.target.checked ? estado.medios.add(id) : estado.medios.delete(id); guardar(); renderAhorro(); };
}

function renderTodo(conLista = true) {
  if (conLista) renderLista();
  else { pintarCuenta(); $('#lista').querySelectorAll('.marca-btn span').forEach((s, i) => s.textContent = textoMarcas(estado.lista[i])); }
  renderAhorro(); guardar();
}

/* ------------------------------------------------------------ PWA */
let eventoInstalar = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); eventoInstalar = e; $('#btnInstalar').hidden = false; });
$('#btnInstalar').onclick = async () => { if (!eventoInstalar) return; eventoInstalar.prompt(); await eventoInstalar.userChoice; eventoInstalar = null; $('#btnInstalar').hidden = true; };
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
const esIOS = /iphone|ipad|ipod/i.test(navigator.userAgent), standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
if (esIOS && !standalone && !guardado.vioTipIOS) { setTimeout(() => toast('Para instalarla: tocá Compartir y después “Agregar a inicio”.', 6000), 2500); guardado.vioTipIOS = true; guardar(); }

/* ------------------------------------------------------------ inicio */
(async () => {
  initControles(); pintarUbic(); irA();
  try { await cargarBase(); }
  catch (e) { $('#resultado').innerHTML = vacio(ICONO.falta, 'No se pudieron cargar los precios', 'Revisá la conexión y volvé a abrir la app.'); console.error(e); return; }
  renderMedios(); renderLista();
  if (estado.ubic) await cargarCeldas();
  renderAhorro();
  try { const p = await navigator.permissions?.query({ name: 'geolocation' }); if (p?.state === 'granted') pedirGPS(true); } catch {}
})();

export { estado, getFila };
