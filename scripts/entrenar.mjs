// Entrenador de pesos WaveLog (sustituye a Entrenador_Definitivo.html).
//
// Cambios respecto al entrenador anterior:
//  1. Filtra por lo que dicen los MODELOS (ECMWF o GFS > 0.8 m), igual que el oracle,
//     no por lo que midió la boya (eso sesgaba los pesos hacia arriba).
//  2. Agrupa por la dirección de ECMWF en 8 sectores de 45° (N…NO), igual que el oracle.
//  3. Solo 3 parámetros (ECMWF, GFS, bias), con regularización hacia "ECMWF tal cual",
//     y una ventana necesita >= MIN_VENTANA muestras; si no, usa el ajuste global.
//  4. Valida con el último tramo de datos (que el ajuste no ha visto) y compara con
//     ECMWF a secas. Guarda la opción que gane; si gana ECMWF a secas, guarda pesos
//     identidad (1·ECMWF) para que el oracle deje de empeorarlo.
//
// Datos: tabla training_data (histórico inyectado con el CSV) + boya_barcelona cruzada
// con Open-Meteo de los últimos 92 días.
//
// MODO=probar  -> solo informe.   MODO=guardar -> además inserta en ai_weights.

import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const MODO = process.env.MODO || 'probar';
const UMBRAL = 0.8;
const MIN_VENTANA = 30;
const LAMBDA = 5;          // fuerza de la regularización hacia [1, 0, 0]
const DIAS_TEST = 30;
const VENTANAS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }, realtime: { enabled: false },
});

function getVentana(dir) {
  // 8 sectores de 45°, igual que la boya: N NE E SE S SO O NO (sin mezclar vecinas)
  if (dir == null || isNaN(dir)) return null;
  const d = ((dir % 360) + 360) % 360;
  return ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'][Math.round(d / 45) % 8];
}
const hk = ms => Math.round(ms / 3600000);
const toMs = t => new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : t + 'Z').getTime();
const pos = v => (v == null || isNaN(v) || v <= 0) ? null : +v;

async function leerTodo(tabla, cols, filtro = q => q) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await filtro(supabase.from(tabla).select(cols)).range(from, from + 999);
    if (error) throw new Error(`${tabla}: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

// ── 1. Datos ─────────────────────────────────────────────────────────────────
const muestras = new Map(); // hk -> {k, y, ecmwf, gfs, dir, fuente}

let td = [];
try { td = await leerTodo('training_data', 'timestamp, buoy_hs, ecmwf_hs, gfs_hs, ecmwf_dir'); }
catch (e) { console.warn('Aviso: no se pudo leer training_data:', e.message); }
for (const r of td) {
  const y = pos(r.buoy_hs), ecmwf = pos(r.ecmwf_hs), gfs = pos(r.gfs_hs);
  if (y == null || ecmwf == null || gfs == null) continue;
  const k = hk(toMs(r.timestamp));
  muestras.set(k, { k, y, ecmwf, gfs, dir: r.ecmwf_dir, fuente: 'training_data' });
}

const om = await fetch('https://marine-api.open-meteo.com/v1/marine?latitude=41.38&longitude=2.15'
  + '&hourly=wave_height,wave_direction&models=ecmwf_wam025,ncep_gfswave016&past_days=92&forecast_days=1');
if (!om.ok) throw new Error(`Open-Meteo ${om.status}`);
const h = (await om.json()).hourly;
const fc = new Map();
h.time.forEach((t, i) => fc.set(hk(toMs(t)), {
  ecmwf: pos(h.wave_height_ecmwf_wam025?.[i]), gfs: pos(h.wave_height_ncep_gfswave016?.[i]),
  dir: h.wave_direction_ecmwf_wam025?.[i],
}));

const since = new Date(Date.now() - 92 * 86400000).toISOString();
const boya = await leerTodo('boya_barcelona', 'fecha_oficial, hs', q => q.gte('fecha_oficial', since));
const obs = new Map();
for (const r of boya) {
  const y = pos(r.hs); if (y == null) continue;
  const k = hk(toMs(r.fecha_oficial)); const o = obs.get(k) || { s: 0, n: 0 };
  o.s += y; o.n++; obs.set(k, o);
}
let nuevas = 0;
for (const [k, o] of obs) {
  const f = fc.get(k);
  if (!f || f.ecmwf == null || f.gfs == null) continue;
  if (!muestras.has(k)) nuevas++;
  muestras.set(k, { k, y: o.s / o.n, ecmwf: f.ecmwf, gfs: f.gfs, dir: f.dir, fuente: 'boya+open-meteo' });
}

const todas = [...muestras.values()].sort((a, b) => a.k - b.k);
const conOlas = todas.filter(m => Math.max(m.ecmwf, m.gfs) > UMBRAL && m.dir != null && !isNaN(m.dir));
conOlas.forEach(m => { m.ven = getVentana(m.dir); });

let md = `# Entrenamiento WaveLog\n\nModo: **${MODO}** · Muestras totales: ${todas.length} `
  + `(training_data: ${td.length}, nuevas de boya+Open-Meteo: ${nuevas}) · `
  + `**Con modelos > ${UMBRAL} m: ${conOlas.length}**\n`;
if (todas.length) md += `\nPeriodo: ${new Date(todas[0].k * 3600000).toISOString().slice(0, 10)} → ${new Date(todas.at(-1).k * 3600000).toISOString().slice(0, 10)}\n`;

if (conOlas.length < 60) {
  md += `\n⚠ Muy pocas muestras con olas para entrenar con garantías. No se guarda nada.\n`;
  console.log(md); if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  process.exit(0);
}

// ── 2. Ajuste ────────────────────────────────────────────────────────────────
function resolver(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let i = 0; i < n; i++) {
    let p = i; for (let r = i + 1; r < n; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r;
    [M[i], M[p]] = [M[p], M[i]];
    for (let r = 0; r < n; r++) if (r !== i) { const f = M[r][i] / M[i][i]; for (let c = i; c <= n; c++) M[r][c] -= f * M[i][c]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}
// Ridge hacia w0: (XᵀX + λI) w = Xᵀy + λ w0
function ridge(lista, feats, w0) {
  const p = feats.length, A = Array.from({ length: p }, () => Array(p).fill(0)), b = Array(p).fill(0);
  for (const m of lista) {
    const x = feats.map(f => f(m));
    for (let i = 0; i < p; i++) { b[i] += x[i] * m.y; for (let j = 0; j < p; j++) A[i][j] += x[i] * x[j]; }
  }
  for (let i = 0; i < p; i++) { A[i][i] += LAMBDA; b[i] += LAMBDA * w0[i]; }
  return resolver(A, b);
}

const CANDIDATOS = {
  ecmwf:          { nombre: 'ECMWF tal cual', fit: () => ({ ecmwf: 1, gfs: 0, bias: 0 }) },
  ecmwf_bias:     { nombre: 'ECMWF + corrección', fit: l => { const [a, c] = ridge(l, [m => m.ecmwf, () => 1], [1, 0]); return { ecmwf: a, gfs: 0, bias: c }; } },
  ecmwf_gfs_bias: { nombre: 'ECMWF + GFS + corrección', fit: l => { const [a, b, c] = ridge(l, [m => m.ecmwf, m => m.gfs, () => 1], [1, 0, 0]); return { ecmwf: a, gfs: b, bias: c }; } },
};

function entrenar(cand, lista) {
  const global = cand.fit(lista), porVen = {}, usado = {};
  for (const v of VENTANAS) {
    const l = lista.filter(m => m.ven === v);
    porVen[v] = l.length >= MIN_VENTANA ? cand.fit(l) : global;
    usado[v] = l.length >= MIN_VENTANA ? `propio (${l.length})` : `global (${l.length} < ${MIN_VENTANA})`;
  }
  return { porVen, usado };
}
const predecir = (w, m) => Math.max(0, w.ecmwf * m.ecmwf + w.gfs * m.gfs + w.bias);
function evaluar(pesos, lista) {
  let n = 0, e = 0, ae = 0, se = 0;
  for (const m of lista) { const d = predecir(pesos[m.ven], m) - m.y; n++; e += d; ae += Math.abs(d); se += d * d; }
  return { n, bias: e / n, mae: ae / n, rmse: Math.sqrt(se / n) };
}

// ── 3. Validación: últimos DIAS_TEST días como test ─────────────────────────
let corte = conOlas.at(-1).k - DIAS_TEST * 24;
let train = conOlas.filter(m => m.k < corte), test = conOlas.filter(m => m.k >= corte);
if (test.length < 40 || train.length < 60) {         // poco test: usar el último 25 %
  const i = Math.floor(conOlas.length * 0.75);
  train = conOlas.slice(0, i); test = conOlas.slice(i);
}

md += `\n## Validación (entrena con ${train.length} h, prueba con ${test.length} h que no ha visto)\n\n`
  + '| Opción | Sesgo (m) | MAE (m) | RMSE (m) |\n|---|---:|---:|---:|\n';
const resultados = {};
for (const [id, c] of Object.entries(CANDIDATOS)) {
  const { porVen } = entrenar(c, train);
  resultados[id] = evaluar(porVen, test);
  const r = resultados[id];
  md += `| ${c.nombre} | ${r.bias.toFixed(3)} | ${r.mae.toFixed(3)} | ${r.rmse.toFixed(3)} |\n`;
}

// Gana el menor MAE; una opción más compleja tiene que mejorar al menos 1 cm para elegirse.
let ganador = 'ecmwf';
for (const id of ['ecmwf_bias', 'ecmwf_gfs_bias']) {
  if (resultados[id].mae < resultados[ganador].mae - 0.01) ganador = id;
}
md += `\n**Ganador: ${CANDIDATOS[ganador].nombre}**\n`;

// ── 4. Reentrenar con todo y guardar ────────────────────────────────────────
const final = entrenar(CANDIDATOS[ganador], conOlas);
const weights = {};
md += `\n## Pesos finales (entrenados con las ${conOlas.length} h)\n\n| Ventana | Datos | ECMWF | GFS | Corrección (m) |\n|---|---|---:|---:|---:|\n`;
for (const v of VENTANAS) {
  const w = final.porVen[v];
  weights[v] = { hs_ibi: 0, hs_ecmwf: +w.ecmwf.toFixed(4), hs_gfs: +w.gfs.toFixed(4), hs_icon: 0, bias: +w.bias.toFixed(4) };
  md += `| ${v} | ${final.usado[v]} | ${w.ecmwf.toFixed(2)} | ${w.gfs.toFixed(2)} | ${w.bias >= 0 ? '+' : ''}${w.bias.toFixed(2)} |\n`;
}

if (MODO === 'guardar') {
  const { data, error } = await supabase.from('ai_weights').insert({
    weights, bias: 0, feature_names: ['hs_ibi', 'hs_ecmwf', 'hs_gfs', 'hs_icon'], training_samples: conOlas.length,
  }).select('id');
  if (error) throw error;
  md += `\n✅ Guardado en ai_weights como modelo **#${data?.[0]?.id}**. El oracle lo usará en su próxima ejecución.\n`;
} else {
  md += `\n_(Modo probar: no se ha guardado nada.)_\n`;
}

console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
