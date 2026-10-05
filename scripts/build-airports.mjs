// OurAirports CSV -> src/data/airports.json
// 过滤：保留 large/medium/small 机场且有 IATA 代码的条目（另保留有 ICAO 的大型机场，如部分军民合用）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const csv = readFileSync(join(root, 'scripts', 'airports.csv'), 'utf8');

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const lines = csv.split(/\r?\n/);
const header = parseCsvLine(lines[0]).map((h) => h.trim());
const col = (name) => header.indexOf(name);
const C = {
  type: col('type'), name: col('name'), lat: col('latitude_deg'), lon: col('longitude_deg'),
  country: col('iso_country'), city: col('municipality'), sched: col('scheduled_service'),
  icao: col('icao_code'), iata: col('iata_code'),
};

const SIZE_RANK = { large_airport: 0, medium_airport: 1, small_airport: 2 };
const airports = new Map(); // key: iata || icao

for (let i = 1; i < lines.length; i++) {
  const line = lines[i];
  if (!line.trim()) continue;
  const f = parseCsvLine(line);
  const type = f[C.type];
  const size = SIZE_RANK[type];
  if (size === undefined) continue;
  const iata = f[C.iata];
  const icao = f[C.icao] || '';
  if (!iata && !(type === 'large_airport' && icao)) continue;
  const lat = parseFloat(f[C.lat]);
  const lon = parseFloat(f[C.lon]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
  const a = {
    iata: iata || '',
    icao,
    name: f[C.name],
    city: f[C.city] || '',
    country: f[C.country] || '',
    lat,
    lon,
    size,
    sched: f[C.sched] === 'yes' ? 1 : 0,
  };
  const key = a.iata || a.icao;
  const prev = airports.get(key);
  if (!prev || a.size < prev.size || (a.size === prev.size && a.sched > prev.sched)) {
    airports.set(key, a);
  }
}

const list = [...airports.values()].sort((x, y) => x.size - y.size || y.sched - x.sched || x.name.localeCompare(y.name));
mkdirSync(join(root, 'src', 'data'), { recursive: true });
writeFileSync(join(root, 'src', 'data', 'airports.json'), JSON.stringify(list));
console.log(`airports.json: ${list.length} entries (${list.filter((a) => a.iata).length} with IATA)`);
