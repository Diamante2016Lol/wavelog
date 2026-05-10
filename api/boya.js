export default async function handler(req, res) {
  // Destructores de caché
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { fecha, hora } = req.query;
  const modoHistorico = fecha && hora;

  try {
    const headersConfig = { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' };
    const urlRT = 'https://portus.puertos.es/portussvr/api/RTData/station/1731';
    
    // Intento 1: Llamada estandar (GET)
    let response = await fetch(urlRT, { method: 'GET', headers: headersConfig, cache: 'no-store' });
    
    // Intento 2: Si el Gobierno nos bloquea con el error 405, tiramos la puerta con un POST
    if (response.status === 405) {
        response = await fetch(urlRT, { method: 'POST', headers: headersConfig, cache: 'no-store' });
    }

    // Intento 3: Vía de escape al enlace antiguo que sabemos 100% que devuelve estado 200
    if (!response.ok) {
        const urlLast = 'https://portus.puertos.es/portussvr/api/lastData/positions/1731';
        response = await fetch(urlLast, { method: 'GET', headers: headersConfig, cache: 'no-store' });
    }

    if (!response.ok) throw new Error('Status: ' + response.status);

    const rawText = await response.text();
    let registros = JSON.parse(rawText);
    
    // Normalizar la estructura sea cual sea la que mande el Gobierno hoy
    if (registros.data) registros = registros.data;
    if (registros.measurements) registros = registros.measurements;
    if (!Array.isArray(registros)) registros = [registros];

    // Limpiar fechas y ordenar de la mas nueva a la mas vieja
    registros = registros.map(reg => {
        let f = reg.fecha || reg.date || reg.dateTime || "";
        f = f.replace(' ', 'T').replace('.0', ''); 
        if (f && !f.includes('Z') && !f.includes('+')) f += 'Z'; 
        return { ...reg, timestamp: new Date(f).getTime(), fechaISO: f };
    }).filter(r => !isNaN(r.timestamp)).sort((a, b) => b.timestamp - a.timestamp);

    let hs = null, hmax = null, tp = null, dirGrados = null, fechaFinal = null;

    // Escáner indestructible de variables
    const procesarBloque = (datosArray) => {
        let encontroHs = false;
        const lista = Array.isArray(datosArray) ? datosArray : (datosArray?.measurements || []);
        
        for (const d of lista) {
            let id = Number(d.paramId || d.idVariable || d.id || d.param);
            let val = Number(d.valor || d.value || d.v || d.dato);
            
            if (isNaN(id) || isNaN(val)) {
                const nums = Object.values(d).map(v => Number(v)).filter(n => !isNaN(n));
                const maybeId = nums.find(n => [1,2,4,6,32,33,34,36].includes(n));
                if (maybeId !== undefined) {
                    id = maybeId;
                    val = nums.find(n => n !== maybeId) ?? maybeId;
                }
            }

            if (id === 1 || id === 32) { hs = val; encontroHs = true; }
            else if (id === 2 || id === 33) hmax = val;
            else if (id === 4 || id === 34) tp = val;
            else if (id === 6 || id === 36) dirGrados = val;
        }
        return encontroHs;
    };

    if (modoHistorico) {
        const targetTime = new Date(`${fecha}T${hora}:00+02:00`).getTime();
        let menorDiferencia = Infinity;
        let registroElegido = null;

        for (const reg of registros) {
            const diff = Math.abs(reg.timestamp - targetTime);
            const info = reg.datos || reg.measurements || reg.data || (Array.isArray(reg) ? reg : []);
            let tieneOlas = Array.isArray(info) && info.length > 0;
            
            if (tieneOlas && diff < menorDiferencia) {
                menorDiferencia = diff;
                registroElegido = reg;
            }
        }

        if (registroElegido) {
            procesarBloque(registroElegido.datos || registroElegido.measurements || registroElegido);
            fechaFinal = registroElegido.fechaISO;
        }
    } else {
        for (const reg of registros) {
            if (procesarBloque(reg.datos || reg.measurements || reg)) {
                fechaFinal = reg.fechaISO;
                break;
            }
        }
    }

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

    throw new Error('Estructura sin olas');

  } catch (error) {
    // Si algo pasa, te sacará un error pero NUNCA MÁS Open-Meteo
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
