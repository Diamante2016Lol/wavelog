// Backtest de WaveLog: compara la boya de Barcelona con los modelos de Open-Meteo
// y con la combinación IA (pesos actuales de ai_weights) en los últimos ~90 días.
// Solo lee datos: no escribe nada en Supabase.
//
// Uso: node scripts/backtest.mjs   (necesita SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY)

import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const DIAS = 92;
const UMBRAL_IA = 0.8;
const UMBRAL_OLAS = 0.8; // para la tabla "solo horas con olas"

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }, realtime: { enabled: false },
});

function getVentana(dir) {
  if (dir == null) return null;
  if (dir >= 337.5 || dir < 67.5) return 'NE';
  if (dir < 112.5) return 'E';
  if (dir < 157.5) return 'SE';
  if (dir < 202.5) return 'S';
  return 'SW';
}
const hk = ms => Math.round(ms / 3600000);
const toMs = t => new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : t + 'Z').getTime();

// ── 1. Open-Meteo ────────────────────────────────────────────────────────────
const MODELOS = { ecmwf: 'ecmwf_wam025', gfs: 'ncep_gfswave016', mfwam: 'meteofrance_wave', ewam: 'dwd_ewam', best: 'best_match' };
const url = 'https://marine-api.open-meteo.com/v1/marine?latitude=41.38&longitude=2.15'
  + `&hourly=wave_height,wave_direction&models=${Object.values(MODELOS).join(',')}`
  + `&past_days=${DIAS}&forecast_days=1`;
const res = await fetch(url);
if (!res.ok) throw new Error(`Open-Meteo ${res.status}: ${await res.text()}`);
const h = (await res.json()).hourly;
const fc = new Map();
h.time.forEach((t, i) => {
  const row = {};
  for (const [k, m] of Object.entries(MODELOS)) {
    const v = h[`wave_height_${m}`]?.[i];
    row[k] = v == null || v <= 0 ? null : v;
  }
  row.dir = h.wave_direction_ecmwf_wam025?.[i] ?? h.wave_direction_best_match?.[i] ?? null;
  fc.set(hk(toMs(t)), row);
});

// ── 2. Boya ─────────────────────────────────────────────────────────────────
const since = new Date(Date.now() - DIAS * 86400000).toISOString();
const boya = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await supabase.from('boya_barcelona').select('fecha_oficial, hs')
    .gte('fecha_oficial', since).order('fecha_oficial').range(from, from + 999);
  if (error) throw error;
  boya.push(...data);
  if (data.length < 1000) break;
}
const obs = new Map();
boya.forEach(r => {
  if (r.hs == null) return;
  const k = hk(toMs(r.fecha_oficial)); const o = obs.get(k) || { s: 0, n: 0 };
  o.s += +r.hs; o.n++; obs.set(k, o);
});

// ── 3. Pesos actuales ───────────────────────────────────────────────────────
const { data: wData } = await supabase.from('ai_weights').select('*').order('id', { ascending: false }).limit(1);
const def = { hs_ibi: 0.25, hs_ecmwf: 0.35, hs_gfs: 0.25, hs_icon: 0.15, bias: 0 };
const pesos = wData?.[0]?.weights || { NE: def, E: def, SE: def, S: def, SW: def };
const modeloId = wData?.[0]?.id ?? 'default';

function combinar(vals, conf) {
  const [ibi, ecmwf, gfs, icon] = vals.map(v => v || 0);
  if (Math.max(ecmwf, gfs) > UMBRAL_IA) {   // misma lógica que oracle.mjs
    return Math.max(0, ibi * (conf.hs_ibi || 0) + ecmwf * (conf.hs_ecmwf || 0)
      + gfs * (conf.hs_gfs || 0) + icon * (conf.hs_icon || 0) + (conf.bias || 0));
  }
  if (ecmwf > 0) return ecmwf;
  const v = [ibi, ecmwf, gfs, icon].filter(x => x > 0);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

// ── 4. Emparejar ────────────────────────────────────────────────────────────
const pares = [];
for (const [k, o] of [...obs.entries()].sort((a, b) => a[0] - b[0])) {
  const f = fc.get(k); if (!f) continue;
  const conf = pesos[getVentana(f.dir)] || def;
  pares.push({
    k, y: o.s / o.n, ven: getVentana(f.dir),
    p: {
      ia_actual: combinar([f.best, f.ecmwf, f.gfs, f.best], conf),   // como corría hasta hoy
      ia_nueva:  combinar([f.mfwam, f.ecmwf, f.gfs, f.ewam], conf),  // como corre ahora (mismos pesos)
      ecmwf: f.ecmwf, gfs: f.gfs, mfwam: f.mfwam, ewam: f.ewam, best_match: f.best,
      media_ec_gfs: f.ecmwf && f.gfs ? (f.ecmwf + f.gfs) / 2 : null,
    },
  });
}
if (!pares.length) throw new Error('No hay horas con boya y modelo a la vez');

const NOMBRES = {
  ia_actual: 'IA (pesos actuales, best_match)', ia_nueva: 'IA (mismos pesos, MFWAM/EWAM)',
  ecmwf: 'ECMWF WAM', gfs: 'GFS-Wave', mfwam: 'MFWAM', ewam: 'DWD EWAM', best_match: 'best_match',
  media_ec_gfs: 'Media ECMWF+GFS',
};

function stats(lista) {
  const out = {};
  for (const m of Object.keys(NOMBRES)) {
    let n = 0, e = 0, ae = 0, se = 0;
    for (const r of lista) { const p = r.p[m]; if (p == null) continue; const d = p - r.y; n++; e += d; ae += Math.abs(d); se += d * d; }
    if (n) out[m] = { n, bias: e / n, mae: ae / n, rmse: Math.sqrt(se / n) };
  }
  return out;
}

function tabla(titulo, lista) {
  const s = stats(lista);
  const filas = Object.entries(s).sort((a, b) => a[1].mae - b[1].mae);
  let md = `\n### ${titulo} (${lista.length} h)\n\n| Modelo | Horas | Sesgo (m) | MAE (m) | RMSE (m) |\n|---|---:|---:|---:|---:|\n`;
  for (const [m, v] of filas) md += `| ${NOMBRES[m]} | ${v.n} | ${v.bias.toFixed(3)} | ${v.mae.toFixed(3)} | ${v.rmse.toFixed(3)} |\n`;
  return md;
}

const mdTodas = tabla('Todas las horas', pares);
const mdOlas = tabla(`Solo horas con olas (boya ≥ ${UMBRAL_OLAS} m)`, pares.filter(r => r.y >= UMBRAL_OLAS));

// ── 5. Reajuste rápido: mínimos cuadrados ECMWF+GFS+bias (60 días entreno / resto test)
function ajustar(lista) {
  // Normal equations 3x3 para y = a*ecmwf + b*gfs + c
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], B = [0, 0, 0];
  for (const r of lista) {
    const x = [r.p.ecmwf, r.p.gfs, 1]; if (x[0] == null || x[1] == null) continue;
    for (let i = 0; i < 3; i++) { B[i] += x[i] * r.y; for (let j = 0; j < 3; j++) A[i][j] += x[i] * x[j]; }
  }
  // Gauss
  const M = A.map((row, i) => [...row, B[i]]);
  for (let i = 0; i < 3; i++) {
    let piv = i; for (let r = i + 1; r < 3; r++) if (Math.abs(M[r][i]) > Math.abs(M[piv][i])) piv = r;
    [M[i], M[piv]] = [M[piv], M[i]];
    for (let r = 0; r < 3; r++) if (r !== i) { const f = M[r][i] / M[i][i]; for (let c = i; c < 4; c++) M[r][c] -= f * M[i][c]; }
  }
  return M.map((row, i) => row[3] / row[i]);
}
const corte = pares[0].k + 60 * 24;
const train = pares.filter(r => r.k < corte), test = pares.filter(r => r.k >= corte);
let mdAjuste = '';
if (train.length > 200 && test.length > 50) {
  const [a, b, c] = ajustar(train);
  test.forEach(r => { r.p.ajuste = r.p.ecmwf != null && r.p.gfs != null ? Math.max(0, a * r.p.ecmwf + b * r.p.gfs + c) : null; });
  NOMBRES.ajuste = `Reajuste lineal (${a.toFixed(2)}·ECMWF + ${b.toFixed(2)}·GFS ${c >= 0 ? '+' : '−'} ${Math.abs(c).toFixed(2)})`;
  mdAjuste = `\n## Prueba fuera de muestra\nAjuste por mínimos cuadrados con los primeros 60 días y evaluado solo en los días siguientes (que el ajuste no ha visto).\n`
    + tabla('Periodo de test', test)
    + `\n_(Comparar con las IA de arriba en el mismo periodo: si el reajuste gana claramente, los pesos actuales tienen margen de mejora.)_\n`;
}

// ── 6. Por ventana (MAE) ────────────────────────────────────────────────────
const vens = ['NE', 'E', 'SE', 'S', 'SW'];
const cols = ['ia_actual', 'ia_nueva', 'ecmwf', 'gfs', 'mfwam', 'ewam'];
let mdVen = `\n### MAE (m) por ventana direccional\n\n| Ventana | Horas | ${cols.map(c => NOMBRES[c]).join(' | ')} |\n|---|---:|${cols.map(() => '---:').join('|')}|\n`;
for (const v of vens) {
  const l = pares.filter(r => r.ven === v); if (!l.length) continue;
  const s = stats(l);
  mdVen += `| ${v} | ${l.length} | ${cols.map(c => s[c] ? s[c].mae.toFixed(3) : '—').join(' | ')} |\n`;
}

const d0 = new Date(pares[0].k * 3600000).toISOString().slice(0, 10);
const d1 = new Date(pares.at(-1).k * 3600000).toISOString().slice(0, 10);
const md = `# Backtest WaveLog\n\nPeriodo: **${d0} → ${d1}** · Modelo IA activo: **#${modeloId}** · Boya: ${obs.size} horas\n\n`
  + `> Open-Meteo con \`past_days\` devuelve el pronóstico de **corto plazo** de cada pasada (primeras horas), no el de 24-48 h.\n`
  + mdTodas + mdOlas + mdVen + mdAjuste;

console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
