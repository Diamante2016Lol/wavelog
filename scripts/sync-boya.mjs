// scripts/sync-boya.mjs — WaveLog · Sync Boya 1731 → Supabase (GitHub Actions)
// La lógica está en lib/boya.mjs (la misma que usa la web al darle a "actualizar").
import { sincronizarBoya } from '../lib/boya.mjs';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error('[sync-boya] ERROR: Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

console.log(`[sync-boya] Iniciando sync — ${new Date().toISOString()}`);
try {
  const { guardadas, ultima } = await sincronizarBoya({ supabaseUrl, supabaseKey });
  console.log(`[sync-boya] ${guardadas} horas guardadas · último: ${ultima.fecha_oficial} `
    + `Hs=${ultima.hs}m Hmax=${ultima.hmax}m Tp=${ultima.tp}s Dir=${ultima.dir_grados}°`);
} catch (err) {
  console.error('[sync-boya] ERROR:', err.message);
  process.exit(1);
}
