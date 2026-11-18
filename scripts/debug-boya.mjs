const U='https://portus.puertos.es/portussvr/api/RTData/station/1731?locale=es&_ts='+Date.now();
const H={'Accept':'application/json, text/plain, */*','Origin':'https://portus.puertos.es','Referer':'https://portus.puertos.es/','User-Agent':'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'};
for (const [nom,opt] of [['POST',{method:'POST',headers:{...H,'Content-Type':'application/json'},body:JSON.stringify([20,34,32,17,13])}],['GET',{headers:H}]]) {
  const r=await fetch(U,opt); console.log('===',nom,r.status);
  let d=await r.json(); d=Array.isArray(d)?d:[d]; d.sort((a,b)=>(a.fecha||'').localeCompare(b.fecha||''));
  console.log(d.length,'registros; claves', Object.keys(d[0]));
  const sel=[...d.filter(x=>(x.fecha||'').startsWith('2026-11-17 0')).slice(0,1), ...d.slice(-2)];
  for (const x of sel){ console.log(x.fecha); for (const y of (x.datos||[])) console.log('   ',JSON.stringify(y).slice(0,260)); }
}
