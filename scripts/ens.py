"""
WaveLog — ECMWF ENS de olas (WAM ensemble, 50 miembros) para Barcelona.

Baja del open data de ECMWF (espejo de AWS) solo la Hs (swh) de los miembros
perturbados del último run 00z/12z, saca el punto de rejilla frente a Barcelona
y guarda en Supabase (tabla ens_waves) los 50 valores + percentiles por hora.

Open-Meteo acepta el modelo ecmwf_wam025_ensemble pero hoy devuelve todo null,
por eso se va a la fuente.

Variables de entorno: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
Uso local sin Supabase: python scripts/ens.py --dry-run
"""
import json
import os
import sys
import tempfile
import urllib.request
from datetime import timedelta

import eccodes
import numpy as np
from ecmwf.opendata import Client

# Mismo punto de rejilla 0.25° que usa Open-Meteo para el ECMWF determinista del oracle
LAT, LON = 41.25, 2.25
# 3 h los 3 primeros días (cuadra con las tarjetas horarias), 6 h hasta el día 7
STEPS = list(range(0, 73, 3)) + list(range(78, 169, 6))


def descargar(path):
    client = Client(source="aws")
    req = dict(stream="waef", type="pf", param="swh", step=STEPS)
    # +168 h solo existe en los runs 00z/12z y es el último paso en publicarse
    run = client.latest(stream="waef", type="pf", param="swh", step=STEPS[-1])
    print(f"Run ENS: {run:%Y-%m-%d %H}z · {len(STEPS)} pasos")
    client.retrieve(date=run.strftime("%Y%m%d"), time=run.hour, target=path, **req)
    return run


def extraer(path):
    """{step: [hs de cada miembro]} en el punto LAT/LON."""
    por_paso, idx = {}, None
    with open(path, "rb") as f:
        while True:
            gid = eccodes.codes_grib_new_from_file(f)
            if gid is None:
                break
            try:
                if idx is None:
                    near = eccodes.codes_grib_find_nearest(gid, LAT, LON)[0]
                    idx = near["index"]
                    print(f"Punto de rejilla: {near['lat']:.2f}, {near['lon']:.2f}")
                v = eccodes.codes_get_double_element(gid, "values", idx)
                missing = eccodes.codes_get_double(gid, "missingValue")
                step = eccodes.codes_get_long(gid, "step")
                if v != missing and not np.isnan(v):
                    por_paso.setdefault(step, []).append(round(float(v), 3))
            finally:
                eccodes.codes_release(gid)
    return por_paso


def filas(run, por_paso):
    out = []
    for step in sorted(por_paso):
        m = por_paso[step]
        if len(m) < 10:
            continue
        p10, p25, p50, p75, p90 = (round(float(x), 3) for x in np.percentile(m, [10, 25, 50, 75, 90]))
        out.append({
            "valid_time": (run + timedelta(hours=step)).strftime("%Y-%m-%dT%H:00:00Z"),
            "run_time": run.strftime("%Y-%m-%dT%H:00:00Z"),
            "lead_hours": step,
            "n": len(m),
            "p10": p10, "p25": p25, "p50": p50, "p75": p75, "p90": p90,
            "miembros": m,
        })
    return out


def guardar(rows):
    url = os.environ["SUPABASE_URL"].rstrip("/") + "/rest/v1/ens_waves?on_conflict=valid_time"
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    req = urllib.request.Request(url, data=json.dumps(rows).encode(), method="POST", headers={
        "apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    })
    with urllib.request.urlopen(req) as r:
        print(f"Supabase: HTTP {r.status}")


def main():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "ens.grib2")
        run = descargar(path)
        print(f"Descargado: {os.path.getsize(path) / 1e6:.0f} MB")
        rows = filas(run, extraer(path))
    if not rows:
        sys.exit("Sin datos en el punto: ¿celda de tierra?")
    print(f"{len(rows)} pasos · {rows[0]['n']} miembros · "
          f"ej. +{rows[8]['lead_hours']}h: P10 {rows[8]['p10']} · P50 {rows[8]['p50']} · P90 {rows[8]['p90']}")
    if "--dry-run" in sys.argv:
        return
    guardar(rows)


if __name__ == "__main__":
    main()
