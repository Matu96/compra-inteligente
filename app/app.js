import { DIAS, celdasCercanas, rankear, mejorDivision, porDiaDeLaSemana, fechaDelDia, km } from './motor.js';

const $ = s => document.querySelector(s);
const fmt = n => '$' + Math.round(n).toLocaleString('es-AR');
const norm = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const titulo = s => /[a-z]/.test(s) ? s : (s || '').toLowerCase().replace(/(^|\s)\S/g, c => c.toUpperCase());

const NOMBRES_CAD = { dia: 'Día', coto: 'Coto', carrefour: 'Carrefour', chango: 'Chango Más', jumbo: 'Jumbo', disco: 'Disco',
  vea: 'Vea', anonima: 'La Anónima', coope: 'Cooperativa Obrera', vital: 'Vital', diarco: 'Diarco', josimar: 'Josimar', nini: 'Nini' };

/* ------------------------------------------------------------ estado */
const guardado = (() => { try { return JSON.parse(localStorage.getItem('ci') || '{}'); } catch { return {}; } })();
const estado = {
  lista: (guardado.lista || []).filter(it => it.tipo),   // [{tipo: 'Yerba mate 1 kg', marcas: ['PLAYADITO'], qty}]
  medios: new Set(guardado.medios || ['cuentadni']),
  radio: guardado.radio || 3,
  ubic: guardado.ubic || null,                    // {lat, lng, label}
  dia: new Date().getDay(),
  abiertos: new Set(), verTodos: false, marcaAbierta: null,
};
function guardar() {
  const lista = estado.lista.map(({ tipo, marcas, qty }) => ({ tipo, marcas, qty }));
  try { localStorage.setItem('ci', JSON.stringify({ lista, medios: [...estado.medios], radio: estado.radio, ubic: estado.ubic, vioTipIOS: guardado.vioTipIOS })); } catch {}
}

let INDEX = null, PROMOS = { medios: [], promos: [] };
// catálogo: TIPOS = productos genéricos; PROD = variantes [ean, nombre, marca, presentación, tipo]
let TIPOS = [], TIPO_NORM = [], TIPO_IDX = new Map(), PROD = [], PROD_NORM = [], POR_TIPO = [], POR_EAN = new Map();
const tiles = new Map();          // celda -> {sucursales, listas}
let stores = [];

const nombreCad = k => NOMBRES_CAD[k] || INDEX?.cadenas?.[k] || k;
const nombreMedio = id => id === 'efectivo' ? 'efectivo o débito' : (PROMOS.medios.find(m => m.id === id)?.nombre || id);

/** Marcas de un producto genérico, en orden de popularidad. */
function marcasDe(ti) {
  const vistas = new Set(), out = [];
  for (const pi of POR_TIPO[ti]) { const m = PROD[pi][2] || 'Sin marca'; if (!vistas.has(m)) { vistas.add(m); out.push(m); } }
  return out;
}
/** Ítem de la lista → ítem para el motor, con los EANs aceptados. */
function paraMotor(it) {
  const ti = TIPO_IDX.get(it.tipo);
  const eans = POR_TIPO[ti].filter(pi => !it.marcas.length || it.marcas.includes(PROD[pi][2] || 'Sin marca')).map(pi => PROD[pi][0]);
  return { ...it, eans, nombre: it.tipo + (it.marcas.length ? ` (${it.marcas.map(titulo).join(', ')})` : '') };
}
const textoMarcas = it => it.marcas.length ? it.marcas.map(titulo).join(', ') : 'cualquiera, la más barata';

function getFila(store, ean) {
  if (store.dif && Object.prototype.hasOwnProperty.call(store.dif, ean)) return store.dif[ean];
  return store.listas[store.lp]?.[ean] ?? null;
}

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
  $('#datosInfo').textContent = `Precios del ${DIAS[f.getDay()].toLowerCase()} ${f.getDate()}/${f.getMonth() + 1} · ${idx.sucursales.toLocaleString('es-AR')} sucursales` + (dias > 2 ? ` · ⚠ datos de hace ${dias} días` : '');
  $('#promosInfo').textContent = `Promos bancarias actualizadas al ${promos.actualizado}.`;
  // la lista se guarda por nombre de producto genérico (los índices cambian cada día)
  const antes = estado.lista.length;
  estado.lista = estado.lista.filter(it => TIPO_IDX.has(it.tipo));
  estado.lista.forEach(it => it.marcas ||= []);
  if (estado.lista.length < antes) toast('Algunos productos de tu lista ya no están en el catálogo de hoy.');
}

async function cargarCeldas() {
  if (!estado.ubic || !INDEX) return;
  const necesarias = celdasCercanas(estado.ubic, estado.radio, INDEX.tam).filter(c => INDEX.celdas[c]);
  const faltan = necesarias.filter(c => !tiles.has(c));
  if (faltan.length) {
    $('#out').innerHTML = '<div class="card empty">Buscando supermercados cerca…</div>';
    await Promise.all(faltan.map(async c => {
      try { tiles.set(c, await getJSON(`data/tiles/${c}.json`)); } catch (e) { console.warn(e); }
    }));
  }
  stores = [];
  for (const c of necesarias) {
    const t = tiles.get(c); if (!t) continue;
    for (const s of t.sucursales) stores.push({ ...s, listas: t.listas });
  }
}

/* ------------------------------------------------------------ ubicación */
function setUbic(lat, lng, label) {
  estado.ubic = { lat, lng, label };
  $('#ubicInfo').textContent = '📍 ' + label;
  guardar();
  cargarCeldas().then(renderOut);
}

function pedirGPS(silencioso = false) {
  if (!navigator.geolocation) { if (!silencioso) toast('Tu navegador no permite ubicación. Escribí una dirección.'); return; }
  const b = $('#btnGPS'); b.disabled = true; b.textContent = 'Ubicando…';
  navigator.geolocation.getCurrentPosition(p => {
    b.disabled = false; b.textContent = 'Actualizar ubicación';
    setUbic(p.coords.latitude, p.coords.longitude, `Tu ubicación actual (±${Math.round(p.coords.accuracy)} m)`);
  }, err => {
    b.disabled = false; b.textContent = 'Usar mi ubicación';
    if (!silencioso) toast(err.code === 1 ? 'No diste permiso de ubicación. Podés escribir una dirección.' : 'No pude obtener tu ubicación. Probá con una dirección.');
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 300000 });
}

async function buscarDireccion(q) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=ar&accept-language=es&q=${encodeURIComponent(q)}`);
    const [hit] = await r.json();
    if (!hit) return toast('No encontré esa dirección. Probá agregando barrio o localidad.');
    setUbic(+hit.lat, +hit.lon, hit.display_name.split(',').slice(0, 3).join(','));
  } catch { toast('No pude buscar la dirección (¿sin conexión?).'); }
}

/* ------------------------------------------------------------ controles */
function initControles() {
  $('#dia').innerHTML = DIAS.map((d, i) => `<option value="${i}">${d}${i === new Date().getDay() ? ' (hoy)' : ''}</option>`).join('');
  $('#dia').value = estado.dia;
  $('#dia').onchange = e => { estado.dia = +e.target.value; renderOut(); };
  $('#radio').value = estado.radio;
  $('#radioLbl').textContent = estado.radio + ' km';
  let tRadio;
  $('#radio').oninput = e => {
    estado.radio = +e.target.value; $('#radioLbl').textContent = estado.radio + ' km'; guardar();
    clearTimeout(tRadio); tRadio = setTimeout(() => cargarCeldas().then(renderOut), 250);
  };
  $('#btnGPS').onclick = () => pedirGPS(false);
  $('#formDir').onsubmit = e => { e.preventDefault(); const q = $('#dir').value.trim(); if (q) buscarDireccion(q); };
  if (estado.ubic) $('#ubicInfo').textContent = '📍 ' + estado.ubic.label;

  // buscador: productos genéricos ("Yerba mate 1 kg") y, si escribís una marca, ese genérico con esa marca
  const b = $('#buscar'), sg = $('#sugg');
  let act = 0, opts = [];
  const pintar = () => {
    sg.innerHTML = opts.map((o, i) => `<div data-i="${i}" class="${i === act ? 'act' : ''}">${esc(TIPOS[o.ti])}${o.marca ? ` · <b>${esc(titulo(o.marca))}</b>` : ''}<br><span class="note">${o.marca ? 'solo esta marca' : `cualquier marca, la más barata · ${marcasDe(o.ti).length} marcas`}</span></div>`).join('');
    sg.style.display = opts.length ? 'block' : 'none';
  };
  b.oninput = () => {
    const toks = norm(b.value).split(/\s+/).filter(Boolean);
    opts = [];
    if (toks.length) {
      for (let t = 0; t < TIPOS.length && opts.length < 8; t++)
        if (toks.every(k => TIPO_NORM[t].includes(k))) opts.push({ ti: t });
      const vistos = new Set();
      for (let i = 0; i < PROD.length && opts.length < 16; i++) {
        const p = PROD[i], clave = p[4] + '|' + p[2];
        if (vistos.has(clave) || !toks.every(k => PROD_NORM[i].includes(k) || TIPO_NORM[p[4]].includes(k))) continue;
        if (!toks.some(k => norm(p[2]).includes(k))) continue;       // solo si escribió (parte de) la marca
        vistos.add(clave); opts.push({ ti: p[4], marca: p[2] || 'Sin marca' });
      }
    }
    act = 0; pintar();
  };
  const agregar = o => {
    const tipo = TIPOS[o.ti], marcas = o.marca ? [o.marca] : [];
    const ex = estado.lista.find(i => i.tipo === tipo && i.marcas.join() === marcas.join());
    if (ex) ex.qty++; else estado.lista.push({ tipo, marcas, qty: 1 });
    b.value = ''; opts = []; pintar(); render();
  };
  b.onkeydown = e => {
    if (e.key === 'Enter' && opts[act]) { agregar(opts[act]); e.preventDefault(); }
    if (e.key === 'ArrowDown') { act = Math.min(act + 1, opts.length - 1); pintar(); }
    if (e.key === 'ArrowUp') { act = Math.max(act - 1, 0); pintar(); }
  };
  sg.onmousedown = e => { const d = e.target.closest('[data-i]'); if (d) { e.preventDefault(); agregar(opts[+d.dataset.i]); } };
  b.onblur = () => setTimeout(() => sg.style.display = 'none', 150);
}

function renderSide() {
  $('#medios').innerHTML = PROMOS.medios.map(m => `<span class="chip ${estado.medios.has(m.id) ? 'on' : ''}" data-m="${m.id}">${esc(m.nombre)}</span>`).join('');
  $('#medios').querySelectorAll('.chip').forEach(c => c.onclick = () => {
    const id = c.dataset.m; estado.medios.has(id) ? estado.medios.delete(id) : estado.medios.add(id); render();
  });
  $('#lista').innerHTML = estado.lista.length ? estado.lista.map((it, i) => {
    const abierta = estado.marcaAbierta === i;
    const marcas = abierta ? marcasDe(TIPO_IDX.get(it.tipo)) : [];
    return `<div class="item"><span class="n">${esc(it.tipo)}<button class="marca" data-a="m" data-i="${i}">Marca: ${esc(textoMarcas(it))} ${abierta ? '▴' : '▾'}</button></span>
      <span class="qty"><button data-a="-" data-i="${i}" aria-label="menos">−</button><b style="min-width:20px;text-align:center">${it.qty}</b><button data-a="+" data-i="${i}" aria-label="más">+</button></span>
      <button class="x" data-a="x" data-i="${i}" aria-label="quitar">×</button></div>
      ${abierta ? `<div class="marcas"><input type="text" class="filtroMarca" placeholder="Filtrar ${marcas.length} marcas…">
        <div class="chips"><span class="chip ${it.marcas.length ? '' : 'on'}" data-mc="">Cualquiera (la más barata)</span>
        ${marcas.map(m => `<span class="chip ${it.marcas.includes(m) ? 'on' : ''}" data-mc="${esc(m)}">${esc(titulo(m))}</span>`).join('')}</div>
        <p class="note" style="margin:6px 0 0">Podés elegir varias: en cada súper se usa la más barata de las que marques.</p></div>` : ''}`;
  }).join('') : '<p class="note">Buscá productos y agregalos a tu lista. Después podés elegir marcas o dejar “la más barata”.</p>';
  $('#lista').querySelectorAll('button[data-a]').forEach(btn => btn.onclick = () => {
    const i = +btn.dataset.i, a = btn.dataset.a;
    if (a === 'm') { estado.marcaAbierta = estado.marcaAbierta === i ? null : i; renderSide(); return; }
    if (a === '+') estado.lista[i].qty++;
    if (a === '-' && !--estado.lista[i].qty) { estado.lista.splice(i, 1); estado.marcaAbierta = null; }
    if (a === 'x') { estado.lista.splice(i, 1); estado.marcaAbierta = null; }
    render();
  });
  const panel = $('#lista .marcas');
  if (panel) {
    const it = estado.lista[estado.marcaAbierta];
    panel.querySelectorAll('[data-mc]').forEach(ch => ch.onclick = () => {
      const m = ch.dataset.mc;
      if (!m) it.marcas = [];
      else it.marcas = it.marcas.includes(m) ? it.marcas.filter(x => x !== m) : [...it.marcas, m];
      render();
    });
    panel.querySelector('.filtroMarca').oninput = e => {
      const q = norm(e.target.value);
      panel.querySelectorAll('[data-mc]').forEach(ch => { if (ch.dataset.mc) ch.hidden = q && !norm(ch.dataset.mc).includes(q); });
    };
  }
}

/* ------------------------------------------------------------ resultados */
function renderOut() {
  const out = $('#out');
  if (!INDEX) return;
  if (!estado.ubic) { out.innerHTML = '<div class="card empty">📍 Tocá <b>Usar mi ubicación</b> o escribí una dirección para buscar supermercados cerca.</div>'; return; }
  if (!estado.lista.length) { out.innerHTML = `<div class="card empty">Hay ${stores.filter(s => km(estado.ubic, s) <= estado.radio).length} sucursales a menos de ${estado.radio} km.<br>Agregá productos a tu lista para ver dónde conviene comprar.</div>`; return; }

  const ctx = { dia: estado.dia, fecha: fechaDelDia(estado.dia), medios: new Set(['efectivo', ...estado.medios]), promos: PROMOS.promos };
  const lista = estado.lista.map(paraMotor);
  const res = rankear(stores, estado.ubic, estado.radio, lista, getFila, ctx);
  if (!res.length) { out.innerHTML = `<div class="card empty">No encontré supermercados con estos productos a menos de ${estado.radio} km. Probá ampliar la distancia.</div>`; return; }

  const comp = res.filter(r => !r.faltan.length);
  const top = comp[0] || res[0];
  const prom = comp.length ? comp.reduce((a, r) => a + r.total, 0) / comp.length : top.total;
  const caro = comp.length ? comp[comp.length - 1].total : top.total;
  const mapa = s => `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}`;
  const nom = s => esc(nombreCad(s.cad));
  const hoyTxt = estado.dia === new Date().getDay() ? 'hoy' : 'el ' + DIAS[estado.dia].toLowerCase();

  let h = `<div class="hero"><div class="k">Mejor opción ${hoyTxt}</div>
    <div class="big">${fmt(top.total)}</div>
    <div>Comprá en <b>${nom(top.store)}</b> · ${esc(titulo(top.store.dir))} (${top.dist.toFixed(1)} km) pagando con <b>${esc(nombreMedio(top.pago.medio))}</b>. <a href="${mapa(top.store)}" target="_blank" rel="noopener">Cómo llegar →</a></div>
    <div class="note" style="margin-top:4px">Ofertas del súper: −${fmt(top.promoSuper)} · Descuento por medio de pago: −${fmt(top.pago.desc)}${top.pago.nota ? ' (' + esc(top.pago.nota) + ')' : ''}</div>
    ${top.faltan.length ? `<div class="miss" style="margin-top:6px">Ningún súper cercano tiene toda tu lista. Acá faltan: ${top.faltan.map(f => esc(f.nombre)).join(', ')}.</div>` : ''}
    ${comp.length > 1 ? `<span class="save">Ahorrás ${fmt(prom - top.total)} vs. el promedio · ${fmt(caro - top.total)} vs. el más caro</span>` : ''}</div>`;

  if (comp.length && estado.lista.some(it => it.marcas.length)) {
    const libre = estado.lista.map(it => paraMotor({ ...it, marcas: [] }));
    const mejorLibre = rankear(stores, estado.ubic, estado.radio, libre, getFila, ctx).find(r => !r.faltan.length);
    if (mejorLibre && top.total - mejorLibre.total > 500)
      h += `<div class="tip">🏷️ <b>Tus marcas te cuestan ${fmt(top.total - mejorLibre.total)} de más.</b> Con la más barata de cada producto pagarías ${fmt(mejorLibre.total)} en ${nom(mejorLibre.store)}. <button class="btn ghost" id="sinMarcas" style="margin-top:6px">Usar la más barata en todo</button></div>`;
  }

  for (const r of comp.slice(0, 3)) {
    const c = r.casi.map(c => { const pot = r.sub + c.falta; return { c, tot: pot - (c.tope == null ? pot * c.pct : Math.min(pot * c.pct, c.tope)) }; })
      .find(x => x.tot < top.total + x.c.falta * 0.5);
    if (c) { h += `<div class="tip">💡 En <b>${nom(r.store)}</b> te faltan <b>${fmt(c.c.falta)}</b> para activar “${esc(c.c.nota)}” con ${esc(nombreMedio(c.c.medio))}. Si igual ibas a comprar algo más, ahí te conviene.</div>`; break; }
  }

  const div = mejorDivision(res, lista, getFila, ctx);
  if (div) h += `<div class="tip">🛒 <b>¿Te da para ir a dos súper?</b> Si comprás ${div.ra.lineas.length} productos en <b>${nom(div.ra.store)}</b> (${div.da.toFixed(1)} km) y ${div.rb.lineas.length} en <b>${nom(div.rb.store)}</b> (${div.db.toFixed(1)} km) pagás ${fmt(div.tot)}: <b>${fmt(div.ahorro)} menos</b>.</div>`;

  const porDia = porDiaDeLaSemana(stores, estado.ubic, estado.radio, lista, getFila, ctx);
  const vals = porDia.filter(Boolean).map(x => x.total);
  if (vals.length) {
    const mx = Math.max(...vals), mn = Math.min(...vals), best = porDia.find(x => x && x.total === mn);
    const sel = porDia[estado.dia];
    h += `<div class="card"><h2>¿Y si comprás otro día?</h2>
      <p style="margin:0 0 4px">${best.dia !== estado.dia && sel && sel.total - mn > 1
        ? `El <b>${DIAS[best.dia].toLowerCase()}</b> en ${esc(nombreCad(best.cad))} con ${esc(nombreMedio(best.medio))} pagarías <b>${fmt(mn)}</b>: ${fmt(sel.total - mn)} menos que ${hoyTxt}.`
        : `${hoyTxt[0].toUpperCase() + hoyTxt.slice(1)} ya es el mejor día de la semana para esta lista.`}</p>
      <div class="days">${porDia.map((x, d) => x ? `<div class="bar ${x.total === mn ? 'best' : ''} ${d === estado.dia ? 'sel' : ''}"><b>${Math.round(x.total / 1000)}k</b><i style="height:${mx === mn ? 60 : 25 + 75 * (x.total - mn) / (mx - mn)}%"></i><span>${DIAS[d].slice(0, 3)}</span></div>` : `<div class="bar"><span>${DIAS[d].slice(0, 3)}</span></div>`).join('')}</div>
      <p class="note" style="margin:6px 0 0">Usa los precios y ofertas del súper de la última publicación y las promos bancarias de cada día.</p></div>`;
  }

  const visibles = estado.verTodos ? res : res.slice(0, 12);
  h += `<div class="card"><h2>Supermercados a menos de ${estado.radio} km (${res.length})</h2>`;
  visibles.forEach((r, i) => {
    const s = r.store, open = estado.abiertos.has(s.id);
    h += `<div class="store ${i === 0 && !r.faltan.length ? 'best' : ''} ${open ? 'open' : ''}" data-id="${esc(s.id)}">
      <div class="top"><span class="rank">${i + 1}</span>
        <div style="min-width:0"><div class="name">${esc(titulo(s.b) || nombreCad(s.cad))} <span class="meta">· ${r.dist.toFixed(1)} km</span></div>
        <div class="meta">${esc(titulo(s.dir))}${s.loc ? ', ' + esc(s.loc) : ''}</div>
        <div>${r.pago.desc ? `<span class="badge">${esc(nombreMedio(r.pago.medio))} −${fmt(r.pago.desc)}</span>` : ''}${r.promoSuper > 0 ? `<span class="badge">Ofertas −${fmt(r.promoSuper)}</span>` : ''}${r.pago.topeado ? '<span class="badge warn">llega al tope</span>' : ''}${r.faltan.length ? `<span class="badge warn">faltan ${r.faltan.length}</span>` : ''}</div></div>
        <div class="tot"><b>${fmt(r.total)}</b><div class="meta">${i && !r.faltan.length && comp.length ? '+' + fmt(r.total - top.total) : '&nbsp;'}</div></div></div>
      <div class="detail"><table><tr><th>Producto</th><th class="r">Cant.</th><th class="r">Unit.</th><th class="r">Total</th></tr>
      ${r.lineas.map(l => l.p === null
        ? `<tr><td class="miss">${esc(l.it.nombre)}</td><td class="r">${l.it.qty}</td><td class="r miss" colspan="2">${l.it.marcas.length ? 'no tiene esa marca' : 'no disponible'}</td></tr>`
        : `<tr><td>${esc(l.it.tipo)}<div class="note">${esc(titulo(POR_EAN.get(l.ean)?.[1] || ''))}</div>${l.promo ? `<div class="promo">${esc(l.promo)}</div>` : ''}</td><td class="r">${l.it.qty}</td><td class="r">${fmt(l.unit)}${l.aplica && Math.round(l.unit) < Math.round(l.p) ? `<div class="tachado">${fmt(l.p)}</div>` : ''}</td><td class="r">${fmt(l.total)}</td></tr>`).join('')}
      <tr><td colspan="3">Subtotal con ofertas del súper</td><td class="r">${fmt(r.sub)}</td></tr>
      <tr><td colspan="3">${r.pago.desc ? esc(nombreMedio(r.pago.medio) + ' · ' + r.pago.nota) + (r.promoSuper > 0 ? '<div class="promo">se suma a las ofertas del súper</div>' : '') : 'Sin promo bancaria con tus medios'}</td><td class="r">−${fmt(r.pago.desc)}</td></tr>
      <tr><td colspan="3"><b>Total a pagar</b></td><td class="r"><b>${fmt(r.total)}</b></td></tr></table>
      <p style="margin:8px 0 0"><a href="${mapa(s)}" target="_blank" rel="noopener">Cómo llegar →</a></p></div></div>`;
  });
  if (res.length > visibles.length) h += `<button class="btn ghost" id="verTodos" style="width:100%">Ver las ${res.length} sucursales</button>`;
  h += '</div>';
  out.innerHTML = h;
  out.querySelectorAll('.store .top').forEach(t => t.onclick = () => {
    const el = t.parentElement, id = el.dataset.id;
    estado.abiertos.has(id) ? estado.abiertos.delete(id) : estado.abiertos.add(id); el.classList.toggle('open');
  });
  $('#verTodos')?.addEventListener('click', () => { estado.verTodos = true; renderOut(); });
  $('#sinMarcas')?.addEventListener('click', () => { estado.lista.forEach(it => it.marcas = []); render(); });
}

function render() { renderSide(); renderOut(); guardar(); }

/* ------------------------------------------------------------ PWA */
let eventoInstalar = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); eventoInstalar = e; $('#btnInstalar').hidden = false; });
$('#btnInstalar').onclick = async () => { if (!eventoInstalar) return; eventoInstalar.prompt(); await eventoInstalar.userChoice; eventoInstalar = null; $('#btnInstalar').hidden = true; };
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
const esIOS = /iphone|ipad|ipod/i.test(navigator.userAgent), standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
if (esIOS && !standalone && !guardado.vioTipIOS) { setTimeout(() => toast('Para instalarla: tocá Compartir → “Agregar a inicio”.', 6000), 2500); guardado.vioTipIOS = true; guardar(); }

/* ------------------------------------------------------------ inicio */
(async () => {
  initControles();
  try { await cargarBase(); }
  catch (e) { $('#out').innerHTML = '<div class="card empty">No pude cargar los precios. Revisá tu conexión y volvé a intentar.</div>'; console.error(e); return; }
  renderSide();
  if (estado.ubic) { await cargarCeldas(); }
  renderOut();
  try { const p = await navigator.permissions?.query({ name: 'geolocation' }); if (p?.state === 'granted') pedirGPS(true); } catch {}
})();

export { estado, getFila };   // para pruebas
