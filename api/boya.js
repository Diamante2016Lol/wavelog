export default async function handler(req, res) {
  // 1. DESTRUCTORES DE CACHÉ Y CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { fecha, hora } = req.query;
  const modoHistorico = fecha && hora;

  try {
    // 2. CONEXIÓN CAMUFLADA COMO NAVEGADOR
    const response = await fetch('https://portus.puertos.es/portussvr/api/RTData/station/1731?locale=es', {
        headers: { 
            'Accept': 'application/json', 
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Referer': 'https://portus.puertos.es/',
            'Origin': 'https://portus.puertos.es'
        },
        cache: 'no-store'
    });

    if (!response.ok) throw new Error('Status: ' + response.status);

    const rawText = await response.text();
    let registros = JSON.parse(rawText);
    if (!Array.isArray(registros)) registros = [registros];

    // 3. PREPARACIÓN DE FECHAS (Transformando de GMT a Absoluto Z)
    registros = registros.map(reg => {
        let f = reg.fecha || "";
        f = f.replace(' ', 'T').replace('.0', '') + 'Z'; 
        return { ...reg, timestamp: new Date(f).getTime(), fechaISO: f };
    }).filter(r => !isNaN(r.timestamp)).sort((a, b) => b.timestamp - a.timestamp);

    let hs = null, hmax = null, tp = null, dirGrados = null, fechaFinal = null;

    // 4. PARSER DE FUERZA BRUTA
    const procesarBloque = (datosArray) => {
        let encontroHs = false;
        if (Array.isArray(datosArray)) {
            for (const d of datosArray) {
                let id = null, val = null;
                
                // Intento A: Leer por claves lógicas
                for (const key in d) {
                    const k = key.toLowerCase();
                    const v = d[key];
                    if (typeof v === 'number' || (typeof v === 'string' && !isNaN(Number(v)))) {
                        if (k === 'id' || k.includes('param') || k.includes('var') || k === 'codigo') {
                            id = Number(v);
                        } else if (k === 'valor' || k === 'value' || k === 'dato' || k === 'v' || k === 'medicion') {
                            val = Number(v);
                        }
                    }
                }

                // Intento B: Fuerza bruta por array de números
                if (id === null || val === null) {
                    const nums = Object.values(d).map(v => Number(v)).filter(n => !isNaN(n));
                    const maybeId = nums.find(n => [1,2,3,4,6].includes(n));
                    if (maybeId !== undefined) {
                        id = maybeId;
                        val = nums.find(n => n !== maybeId) ?? maybeId;
                    }
                }

                // Asignación de variables oficiales
                if (id === 1) { hs = val; encontroHs = true; }
                else if (id === 2) hmax = val;
                else if (id === 4) tp = val;
                else if (id === 6) dirGrados = val;
            }
        }
        return encontroHs;
    };

    // 5. ENRUTADOR: TIEMPO REAL VS HISTÓRICO
    if (modoHistorico) {
        // Transformar la hora introducida en España (+02:00) a milisegundos absolutos
        const targetTime = new Date(`${fecha}T${hora}:00+02:00`).getTime();
        let menorDiferencia = Infinity;
        let registroElegido = null;

        for (const reg of registros) {
            const diff = Math.abs(reg.timestamp - targetTime);
            if (diff < menorDiferencia && Array.isArray(reg.datos) && reg.datos.length > 0) {
                menorDiferencia = diff;
                registroElegido = reg;
            }
        }

        if (registroElegido) {
            procesarBloque(registroElegido.datos);
            fechaFinal = registroElegido.fechaISO;
        }
    } else {
        // Coger el bloque válido más reciente de la tabla
        for (const reg of registros) {
            if (procesarBloque(reg.datos)) {
                fechaFinal = reg.fechaISO;
                break;
            }
        }
    }

    // 6. RESPUESTA FINAL SI TODO HA IDO BIEN
    if (hs !== null) {
        return res.status(200).json({
            modo: modoHistorico ? 'historico_puertos' : 'live_puertos',
            hs: Number(hs.toFixed(2)),
            hmax: hmax !== null ? Number(hmax.toFixed(2)) : null,
            tp: tp !== null ? Number(tp.toFixed(1)) : null,
            dir: gradosACardinal(dirGrados),
            diferenciaMinutos: modoHistorico ? Math.round(Math.abs(new Date(`${fecha}T${hora}:00+02:00`).getTime() - new Date(fechaFinal).getTime()) / 60000) : 0,
            fechaHora: fechaFinal
        });
    }

    throw new Error('Variables vacias en JSON');

  } catch (error) {
    // 7. MODO DEPURACIÓN VISUAL
    // Si algo falla, lo mostramos en el frontend con valores 9.99 para cazar el error instantáneamente.
    return res.status(200).json({
        modo: 'error_critico',
        hs: 9.99,
        hmax: 9.99,
        tp: 99.9,
        dir: error.message.substring(0, 15),
        diferenciaMinutos: 0,
        fechaHora: new Date().toISOString()
    });
  }
}

function gradosACardinal(grados) {
  if (grados === null || isNaN(grados)) return '--';
  const rumbos = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
  let calc = grados / 360;
  let normalized = (calc - Math.floor(calc)) * 360;
  let idx = Math.round(normalized / 45);
  if (idx === 8) idx = 0;
  return rumbos[idx];
}
