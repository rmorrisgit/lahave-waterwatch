// Headless sanity check of the browser-side data transforms.
const fs = require('fs');
const path = require('path');
const d = JSON.parse(fs.readFileSync(path.join(__dirname, 'static', 'data.json'), 'utf8'));

// 1) pkeys map builds
const pkeys = {}; d.params.forEach(p => pkeys[p.key] = p);
console.log('params:', d.params.length, '| sample keys:', Object.keys(pkeys).slice(0,5).join(','));

// 2) default station = worst WQI
const worst = Object.values(d.wqi).sort((a,b)=>a.score-b.score)[0];
console.log('default station (worst WQI):', worst.station, worst.score, worst.rating);

// 3) trend transform for default station + DO (the fixed path)
const key = `${worst.station_id}|do`;
const series = d.series[key] || [];
const pts = series.map(([dt,v]) => ({ x: Date.parse(dt), y: v }));
const bad = pts.filter(p => Number.isNaN(p.x));
console.log('DO series points:', pts.length, '| NaN timestamps:', bad.length);
console.log('first/last pt:', JSON.stringify(pts[0]), JSON.stringify(pts[pts.length-1]));

// 4) longitudinal present for salinity (profile default)
const sal = d.longitudinal['salinity'] || [];
console.log('salinity profile stations:', sal.length, '| ordered?',
  sal.every((r,i,a)=> i===0 || a[i-1].river_order <= r.river_order));

// 5) every series key parses to valid timestamps
let total=0, nan=0;
for (const k of Object.keys(d.series)) for (const [dt] of d.series[k]) { total++; if(Number.isNaN(Date.parse(dt))) nan++; }
console.log('all series points:', total, '| unparseable dates:', nan);
console.log(nan===0 && bad.length===0 ? 'PASS ✅' : 'FAIL ❌');
