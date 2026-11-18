// api/save-data.js — WaveLog · Sync Boya 1731 → Supabase bajo demanda
// Lo llama la web al cargar y al darle a "↻ actualizar" (y cron-job.org, si sigue configurado).
// La lógica está en lib/boya.mjs, la misma que usa el robot de GitHub.
import { sincronizarBoya } from '../lib/boya.mjs';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');          // la web también vive en github.io
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ ok: false, error: 'Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en Vercel' });
  }
  try {
    const { guardadas, ultima } = await sincronizarBoya({ supabaseUrl, supabaseKey });
    return res.status(200).json({ ok: true, guardadas, ultima });
  } catch (err) {
    return res.status(502).json({ ok: false, error: err.message });
  }
}
