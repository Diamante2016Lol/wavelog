<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>Entrenador IA - 5 Ventanas</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
</head>
<body class="bg-slate-900 text-white p-8 font-mono">
  <div class="max-w-3xl mx-auto space-y-6">
    <h1 class="text-2xl text-teal-400 font-bold">🧠 Entrenador IA - WaveLog</h1>
    
    <div class="bg-slate-800 p-6 rounded-xl border border-slate-700">
      <h2 class="text-lg mb-4">Configuracion de Entrenamiento</h2>
      <label class="flex items-center gap-3 mb-6">
        <input type="checkbox" id="filtro-metro" checked class="w-5 h-5 accent-teal-500">
        <span>Filtro estricto: Solo entrenar con olas reales > 1.0m</span>
      </label>
      <button onclick="entrenar()" class="bg-teal-500 text-slate-900 px-6 py-3 rounded-lg font-bold hover:bg-teal-400">
        Iniciar Entrenamiento por Ventanas
      </button>
    </div>

    <div id="log" class="bg-black p-4 rounded-xl text-sm text-green-400 h-64 overflow-y-auto whitespace-pre">Esperando ordenes...</div>
  </div>

  <script>
    // PON AQUI TUS LLAVES
    const SB_URL = "TU_URL_SUPABASE";
    const SB_KEY = "TU_ANON_KEY";
    const supabase = supabase.createClient(SB_URL, SB_KEY);

    function printLog(msg) {
      const box = document.getElementById('log');
      box.textContent += `\n[${new Date().toLocaleTimeString()}] ${msg}`;
      box.scrollTop = box.scrollHeight;
    }

    function getVentana(dir) {
      if (dir >= 337.5 || dir < 67.5) return 'NE';
      if (dir >= 67.5 && dir < 112.5) return 'E';
      if (dir >= 112.5 && dir < 157.5) return 'SE';
      if (dir >= 157.5 && dir < 202.5) return 'S';
      return 'SW';
    }

    async function entrenar() {
      const usarFiltro = document.getElementById('filtro-metro').checked;
      printLog('Descargando historial de training_data...');

      const { data, error } = await supabase.from('training_data').select('*');
      if (error) return printLog('Error de lectura: ' + error.message);
      
      let validos = data;
      if (usarFiltro) {
        validos = data.filter(d => (d.buoy_hs && d.buoy_hs >= 1.0) || (d.ecmwf_hs && d.ecmwf_hs >= 1.0));
        printLog(`Filtro activado: Quedan ${validos.length} registros de temporales relevantes.`);
      }

      // Agrupar por ventanas
      const grupos = { NE: [], E: [], SE: [], S: [], SW: [] };
      validos.forEach(d => {
        const v = getVentana(d.buoy_dir || d.ecmwf_dir || 180);
        grupos[v].push(d);
      });

      const pesosFinales = {};

      for (const v of Object.keys(grupos)) {
        const muestras = grupos[v];
        printLog(`Ventana ${v}: Analizando ${muestras.length} muestras.`);
        
        if (muestras.length < 5) {
          printLog(`  -> Pocos datos en ${v}. Usando multiplicador basico (0.5/0.5).`);
          pesosFinales[v] = { hs_ecmwf: 0.5, hs_gfs: 0.5, bias: 0 };
          continue;
        }

        // Calcular ratio promedio (Boya / Modelo)
        let ratioEcmwf = 0, ratioGfs = 0, conteo = 0;
        
        muestras.forEach(m => {
          if (m.buoy_hs && m.ecmwf_hs && m.gfs_hs && m.ecmwf_hs > 0.1 && m.gfs_hs > 0.1) {
            ratioEcmwf += (m.buoy_hs / m.ecmwf_hs);
            ratioGfs += (m.buoy_hs / m.gfs_hs);
            conteo++;
          }
        });

        if (conteo > 0) {
          const multEcmwf = (ratioEcmwf / conteo) / 2; 
          const multGfs = (ratioGfs / conteo) / 2;
          pesosFinales[v] = { hs_ecmwf: multEcmwf, hs_gfs: multGfs, bias: 0 };
          printLog(`  -> Ajuste ${v}: ECMWF x${(multEcmwf*2).toFixed(2)} | GFS x${(multGfs*2).toFixed(2)}`);
        } else {
          pesosFinales[v] = { hs_ecmwf: 0.5, hs_gfs: 0.5, bias: 0 };
        }
      }

      printLog('Guardando matriz de pesos en ai_weights...');
      const { error: wError } = await supabase.from('ai_weights').insert([{
        weights: pesosFinales,
        training_samples: validos.length,
        bias: 0
      }]);

      if (wError) printLog('Error al guardar: ' + wError.message);
      else printLog('ENTRENAMIENTO COMPLETADO.');
    }
  </script>
</body>
</html>
