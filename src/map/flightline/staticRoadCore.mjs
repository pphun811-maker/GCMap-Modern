// Browser transport adapter of server/roads.mjs; baking formulas and budgets retained.
import {VectorTile} from '@mapbox/vector-tile';
import {PbfReader} from 'pbf';

const EXTENT = 4096;
const ROAD_CELLS = 6371.0 / 1.2;
const ROAD_TOWN_CELLS = 6371.0 / 8.0;
const RURAL = [0.10, 0.02, 0.0, 0.0];
const TOWN_LO = [0.015, 0.02, 0.03, 0.04];
const TOWN_HI = [0.15, 0.20, 0.25, 0.20];
const NIGHT_OFF = [1.0, 0.5, 0.7, 1.0];
const NIGHT_KEEP = [0.25, 0.3, 0.4, 0.5];
const ROAD_LED = 0.75;
const CLASS_INDEX = { highway: 0, major_road: 1, medium_road: 2, minor_road: 3 };
// 达到该数据缩放后走远端 Range（与 server/mapResources.mjs 的 worldTile 分档一致）。
const REMOTE_MIN_TZ = 8;
const MAX_TILES = 64;
const MAX_FEATURES = 60000;
const CACHE_TILES = 192;
const MID_MIN_VIEW_Z = 3.5;
const NEAR_MIN_VIEW_Z = 5.9;
const MID_TZ_MIN = 4;
const MID_TZ_MAX = 7;
const CACHE_RESPONSES = 48;

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const fract = (x) => x - Math.floor(x);
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

function pcg3d(ix, iy, iz) {
  let vx = (Math.imul(ix | 0, 1664525) + 1013904223) >>> 0;
  let vy = (Math.imul(iy | 0, 1664525) + 1013904223) >>> 0;
  let vz = (Math.imul(iz | 0, 1664525) + 1013904223) >>> 0;
  vx = (vx + Math.imul(vy, vz)) >>> 0;
  vy = (vy + Math.imul(vz, vx)) >>> 0;
  vz = (vz + Math.imul(vx, vy)) >>> 0;
  vx ^= vx >>> 16; vy ^= vy >>> 16; vz ^= vz >>> 16;
  vx = (vx + Math.imul(vy, vz)) >>> 0;
  vy = (vy + Math.imul(vz, vx)) >>> 0;
  vz = (vz + Math.imul(vx, vy)) >>> 0;
  return [(vx >>> 8) / 16777216, (vy >>> 8) / 16777216, (vz >>> 8) / 16777216];
}

function simplify(points, tolerance) {
  const n = points.length;
  if (n <= 2) return points;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  const tol2 = tolerance * tolerance;
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = points[a].x, ay = points[a].y;
    const dx = points[b].x - ax, dy = points[b].y - ay;
    const len2 = dx * dx + dy * dy;
    let best = -1, bestD = tol2;
    for (let i = a + 1; i < b; i++) {
      const px = points[i].x - ax, py = points[i].y - ay;
      let d2;
      if (len2 === 0) d2 = px * px + py * py;
      else {
        const t = clamp((px * dx + py * dy) / len2, 0, 1);
        const ex = px - dx * t, ey = py - dy * t;
        d2 = ex * ex + ey * ey;
      }
      if (d2 > bestD) { bestD = d2; best = i; }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

// 在反经线处把未环绕的经纬线拆开，避免 MapLibre 画出一条绕全球的线。
function splitAntimeridian(points) {
  if (points.length < 2) return points.length ? [points] : [];
  const out = [];
  let current = [points[0]];
  let previous = points[0][0];
  for (let i = 1; i < points.length; i++) {
    let lon = points[i][0];
    while (lon - previous > 180) lon -= 360;
    while (lon - previous < -180) lon += 360;
    const before = Math.floor((previous + 180) / 360);
    const after = Math.floor((lon + 180) / 360);
    if (before !== after) {
      const boundary = after > before ? (before + 1) * 360 - 180 : before * 360 - 180;
      const t = (boundary - previous) / (lon - previous);
      const lat = points[i - 1][1] + (points[i][1] - points[i - 1][1]) * t;
      current.push([boundary, lat]);
      out.push(current);
      current = [[boundary, lat]];
    }
    current.push([lon, points[i][1]]);
    previous = lon;
  }
  if (current.length > 1) out.push(current);
  return out.map((part) => part.map(([lon, lat]) => [((lon + 180) % 360 + 360) % 360 - 180, lat]));
}

function tileLonLat(tz, x, y, px, py) {
  const n = 2 ** tz;
  const lon = ((x + px / EXTENT) / n) * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + py / EXTENT) / n))) * 180 / Math.PI;
  return [lon, lat];
}

function yOfLat(lat, n) {
  const r = clamp(lat, -85.05112878, 85.05112878) * Math.PI / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n;
}

function tileFootprint(w, s, e, n, tz) {
  const tileN = 2 ** tz;
  const x0 = Math.floor((w + 180) / 360 * tileN);
  const x1 = Math.floor((e + 180) / 360 * tileN);
  const y0 = Math.floor(yOfLat(n, tileN));
  const y1 = Math.floor(yOfLat(s, tileN));
  return (x1 - x0 + 1) * (y1 - y0 + 1);
}

// 中尺度真实 LOD：跟随视图缩放，仅在 64 张瓦片预算超限时逐级下调。
function midDataZoom(z, w, s, e, n) {
  let tz = clamp(Math.round(z), MID_TZ_MIN, MID_TZ_MAX);
  while (tz > 3 && tileFootprint(w, s, e, n, tz) > MAX_TILES) tz--;
  return tz;
}

function haversineKm(a, b) {
  const dLat = (b[1] - a[1]) * Math.PI / 180;
  const dLon = (b[0] - a[0]) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(a[1] * Math.PI / 180) * Math.cos(b[1] * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(s)));
}

// 线段中点（按长度，不是顶点平均）：属性不会被源数据顶点密度带偏。
function midpointOf(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += haversineKm(points[i - 1], points[i]);
  let walked = 0;
  for (let i = 1; i < points.length; i++) {
    const km = haversineKm(points[i - 1], points[i]);
    if (walked + km >= total / 2 && km > 0) {
      const t = (total / 2 - walked) / km;
      return [
        points[i - 1][0] + (points[i][0] - points[i - 1][0]) * t,
        points[i - 1][1] + (points[i][1] - points[i - 1][1]) * t,
      ];
    }
    walked += km;
  }
  return points[Math.floor(points.length / 2)];
}

/**
 * @param {object} options
 * @param {object|null} options.archive  本地 world_z0_z7 PMTiles Archive（可为 null）
 * @param {(tz:number,x:number,y:number)=>Promise<Buffer|null|undefined>} options.remote
 *        远端 Range 取瓦片：Buffer=成功、null=瓦片不存在、undefined=取数失败（可恢复）
 * @param {string} [options.assetsDir]   含 road_density_v1.json/.bin.gz 的目录
 */
export function createRoadService({ remote, densityData }) {
  const archive = null;
  const tileCache = new Map();
  let density = densityData;
  function loadDensity() { return density; }
  function densityAt(lon, lat) {
    const { width, height, bytes } = loadDensity();
    let u = (lon / 360 + 0.5) % 1;
    if (u < 0) u += 1;
    const v = clamp((85 - lat) / 170, 0, 1);
    const x = u * width - 0.5;
    const y = v * height - 0.5;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const xi = (i) => ((i % width) + width) % width;
    const yi = (j) => clamp(j, 0, height - 1);
    const at = (i, j) => bytes[yi(j) * width + xi(i)];
    const a = at(x0, y0) * (1 - fx) * (1 - fy);
    const b = at(x0 + 1, y0) * fx * (1 - fy);
    const c = at(x0, y0 + 1) * (1 - fx) * fy;
    const d = at(x0 + 1, y0 + 1) * fx * fy;
    return (a + b + c + d) / 255;
  }

  function decodeTileLocal() { return null; }

  async function decodeTileRemote(tz, x, y) {
    const key = `${tz}/${x}/${y}`;
    if (tileCache.has(key)) return tileCache.get(key);
    let raw = await remote.getTile(tz, x, y);
    if (raw === undefined) return { failed: true, parts: [] };
    if (!raw) return null;
    const tile = new VectorTile(new PbfReader(raw));
    const layer = tile.layers.roads;
    const parts = [];
    if (layer) {
      for (let i = 0; i < layer.length; i++) {
        const feature = layer.feature(i);
        if (feature.type !== 2) continue;
        const kind = feature.properties.kind;
        if (!(kind in CLASS_INDEX)) continue;
        for (const line of feature.loadGeometry()) {
          if (line.length > 1) parts.push({ kind, line });
        }
      }
    }
    const entry = { parts, bytes: raw.length };
    if (tileCache.size >= CACHE_TILES) tileCache.delete(tileCache.keys().next().value);
    tileCache.set(key, entry);
    return entry;
  }

  function buildFeature(chunk, kind, props, tz) {
    const coords = chunk.map(([lon, lat]) => [Number(lon.toFixed(5)), Number(lat.toFixed(5))]);
    return {
      type: 'Feature',
      properties: {
        k: kind,
        d: Number(props.d.toFixed(4)),
        lit: Number(props.lit.toFixed(4)),
        off: Number(props.off.toFixed(4)),
        gain: Number(props.gain.toFixed(4)),
        led: Number(props.led.toFixed(4)),
        oa: Number(props.oa.toFixed(3)),
        on: Number(props.on.toFixed(3)),
        ln: Number(props.ln.toFixed(3)),
        lr: Number((props.ln * Math.PI / 180).toFixed(5)),
        br: Number((props.lat * Math.PI / 180).toFixed(5)),
        tz,
      },
      geometry: { type: 'LineString', coordinates: coords },
    };
  }

  function propertiesAt(kind, lon, lat, sharp) {
    const i = CLASS_INDEX[kind];
    const d = densityAt(lon, lat);
    const latR = lat * Math.PI / 180, lonR = lon * Math.PI / 180;
    const nx = Math.cos(latR) * Math.sin(lonR);
    const ny = Math.sin(latR);
    const nz = Math.cos(latR) * Math.cos(lonR);
    const h = pcg3d(Math.floor(nx * ROAD_CELLS), Math.floor(ny * ROAD_CELLS), Math.floor(nz * ROAD_CELLS));
    const town = pcg3d(Math.floor(nx * ROAD_TOWN_CELLS), Math.floor(ny * ROAD_TOWN_CELLS), Math.floor(nz * ROAD_TOWN_CELLS));
    const share = RURAL[i] + (1 - RURAL[i]) * smoothstep(TOWN_LO[i], TOWN_HI[i], d);
    const lit = share + ((share >= h[0] ? 1 : 0) - share) * sharp;
    const offShare = NIGHT_OFF[i] * (1 - smoothstep(NIGHT_KEEP[i] * 0.3, NIGHT_KEEP[i], d));
    // 部分夜间熄灯：用哈希第三分量的 fract(h.z*64)，不是原始哈希（night-road-shader.txt:110-112）。
    const off = offShare + ((fract(h[2] * 64) <= offShare ? 1 : 0) - offShare) * sharp;
    // night_road 的 lamps = mix(0.85, mix(0.7, 1.0, h.z), sharp)；sharp=1 时保留 0.7..1。
    const lampBase = 0.85 + ((0.7 + 0.3 * h[2]) - 0.85) * sharp;
    const gain = (0.4 + 0.6 * smoothstep(0.002, 0.27, d)) * 0.65 * lampBase;
    // LED 占比：ROAD_LED * smoothstep(0.1, 0.8, d)，按 step(h.y, ledShare) 逐段决定。
    const ledShare = ROAD_LED * smoothstep(0.1, 0.8, d);
    const led = ledShare + ((ledShare >= h[1] ? 1 : 0) - ledShare) * sharp;
    return {
      d, lit, off, gain, led,
      oa: 23 + 1.5 * town[0],
      on: 29 + 0.5 * town[1],
      ln: lon, lat,
    };
  }

  const responseCache = new Map();

  // 段计时放进响应头：响应体在 serialize/gzip 前已冻结，头里可带完整分段耗时
  //（缓存命中也回放原构建的数字）。
  function sendBody(req, res, entry, cache) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Roads-Cache': cache });
    res.end(entry.body);
  }

  function handle(req, res, url) {
    const timing = { start: Date.now(), decodeMs: 0, buildMs: 0, serializeMs: 0, gzipMs: 0, cache: 'miss' };
    try {
      const z = clamp(Number(url.searchParams.get('z') || 7), 0, 24);
      const w = Number(url.searchParams.get('w')), s = Number(url.searchParams.get('s'));
      const e = Number(url.searchParams.get('e')), n = Number(url.searchParams.get('n'));
      if (![z, w, s, e, n].every(Number.isFinite) || s >= n || e <= w) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'z/w/s/e/n required, s < n, w < e (split at the antimeridian)' }));
        return;
      }
      if (z < MID_MIN_VIEW_Z - 0.05) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ type: 'FeatureCollection', features: [], metadata: { z, skipped: 'below mid-scale minzoom' } }));
        return;
      }
      const cacheKey = `${z.toFixed(2)}|${w.toFixed(4)}|${s.toFixed(4)}|${e.toFixed(4)}|${n.toFixed(4)}`;
      const cached = responseCache.get(cacheKey);
      if (cached) {
        responseCache.delete(cacheKey);
        responseCache.set(cacheKey, cached);
        sendBody(req, res, cached, 'hit');
        return;
      }
      const tz = z >= 8 ? Math.min(Math.floor(z), 15)
        : z >= 7 ? 7
        : z >= NEAR_MIN_VIEW_Z ? 6
        : midDataZoom(z, w, s, e, n);
      const viewBand = z >= NEAR_MIN_VIEW_Z ? 'near' : 'mid';
      const remoteMode = !!remote && (!archive || tz >= REMOTE_MIN_TZ);
      const tileN = 2 ** tz;
      const x0 = Math.floor((w + 180) / 360 * tileN);
      const x1 = Math.floor((e + 180) / 360 * tileN);
      const y0 = Math.floor(yOfLat(n, tileN));
      const y1 = Math.floor(yOfLat(s, tileN));
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_TILES) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'too many tiles', z, tz, viewBand,
          tiles: (x1 - x0 + 1) * (y1 - y0 + 1),
        }));
        return;
      }
      const sharp = smoothstep(6.5, 8.5, z);
      const midLat = (s + n) / 2;
      const metresPerPixel = 156543.03392 * Math.cos(midLat * Math.PI / 180) / 2 ** z;
      const chunkKm = viewBand === 'mid'
        ? clamp(24 * metresPerPixel / 1000, 30, 120)
        : clamp(8 * metresPerPixel / 1000, 4, 22);
      const tolerance = 4 * 2 ** (tz - z);
      const features = [];
      let tiles = 0, vertices = 0, truncated = false, failedTiles = 0;
      const classes = {};

      const pushTile = (entry, x, y) => {
        if (!entry) return;
        if (entry.failed) { failedTiles++; return; }
        tiles++;
        for (const part of entry.parts) {
          const t0 = Date.now();
          const points = simplify(part.line, tolerance);
          const lonLat = points.map((p) => tileLonLat(tz, x, y, p.x, p.y));
          const pieces = splitAntimeridian(lonLat);
          for (const piece of pieces) {
            let pminLon = Infinity, pmaxLon = -Infinity, pminLat = Infinity, pmaxLat = -Infinity;
            for (const [lon, lat] of piece) {
              pminLon = Math.min(pminLon, lon); pmaxLon = Math.max(pmaxLon, lon);
              pminLat = Math.min(pminLat, lat); pmaxLat = Math.max(pmaxLat, lat);
            }
            if (pmaxLon < w - 1 || pminLon > e + 1 || pmaxLat < s - 1 || pminLat > n + 1) continue;
            let chunk = [piece[0]];
            let chunkKmLen = 0;
            for (let i = 1; i < piece.length; i++) {
              const a = piece[i - 1], b = piece[i];
              const km = haversineKm(a, b);
              if (chunkKmLen + km > chunkKm && chunk.length > 1) {
                const last = chunk[chunk.length - 1];
                const mid = midpointOf(chunk);
                const props = propertiesAt(part.kind, mid[0], mid[1], sharp);
                features.push(buildFeature(chunk, part.kind, props, tz));
                classes[part.kind] = (classes[part.kind] || 0) + 1;
                vertices += chunk.length;
                if (features.length >= MAX_FEATURES) { truncated = true; break; }
                chunk = [last, b];
                chunkKmLen = km;
              } else {
                chunk.push(b);
                chunkKmLen += km;
              }
            }
            if (truncated) break;
            if (chunk.length > 1) {
              const mid = midpointOf(chunk);
              const props = propertiesAt(part.kind, mid[0], mid[1], sharp);
              features.push(buildFeature(chunk, part.kind, props, tz));
              classes[part.kind] = (classes[part.kind] || 0) + 1;
              vertices += chunk.length;
              if (features.length >= MAX_FEATURES) { truncated = true; break; }
            }
          }
          if (truncated) break;
          timing.buildMs += Date.now() - t0;
        }
      };

      const finish = () => {
        const metadata = {
          z, tz, w, s, e, n,
          viewBand,
          dataZoom: tz,
          tiles, features: features.length, vertices,
          classes, truncated, failedTiles,
          remote: !!remoteMode,
          sharp: Number(sharp.toFixed(3)),
          chunkKm: Number(chunkKm.toFixed(2)),
          tolerance: Number(tolerance.toFixed(2)),
          density: 'settlement_lights_v1 red x alpha, bilinear, 4096x2048',
          source: remoteMode
            ? `remote Range tiles tz=${tz} (official world z8-12 / protomaps daily z13-15), kinds highway/major/medium/minor`
            : `local world_z0_z7.pmtiles roads tz=${tz} (highway/major_road present in data)`,
          elapsedMs: Date.now() - timing.start,
          timing,
        };
        let body;
        {
          const t0 = Date.now();
          body = JSON.stringify({ type: 'FeatureCollection', features, metadata });
          timing.serializeMs = Date.now() - t0;
        }
        let gz = null;
        timing.totalMs = Date.now() - timing.start;
        const summary = {
          decodeMs: timing.decodeMs, buildMs: timing.buildMs,
          serializeMs: timing.serializeMs, gzipMs: timing.gzipMs,
          totalMs: timing.totalMs, features: features.length, vertices, tiles,
        };
        // 只缓存完整成功；failedTiles>0 的响应不能当命中回放（FND-16）。
        if (!truncated && failedTiles === 0) {
          if (!responseCache.has(cacheKey) && responseCache.size >= CACHE_RESPONSES) {
            responseCache.delete(responseCache.keys().next().value);
          }
          responseCache.set(cacheKey, { body, gz, summary });
        }
        sendBody(req, res, { body, gz, summary }, 'miss');
      };

      if (remoteMode) {
        (async () => {
          for (let x = x0; x <= x1 && !truncated; x++) {
            for (let y = y0; y <= y1 && !truncated; y++) {
              let entry;
              {
                const t0 = Date.now();
                try {
                  entry = await decodeTileRemote(tz, ((x % tileN) + tileN) % tileN, y);
                } catch {
                  entry = { failed: true, parts: [] };
                }
                timing.decodeMs += Date.now() - t0;
              }
              pushTile(entry, ((x % tileN) + tileN) % tileN, y);
            }
          }
          finish();
        })().catch((error) => {
          console.error('roads service:', error);
          if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(error && error.message || error) }));
        });
        return;
      }
      for (let x = x0; x <= x1 && !truncated; x++) {
        for (let y = y0; y <= y1 && !truncated; y++) {
          let entry;
          {
            const t0 = Date.now();
            try {
              entry = decodeTileLocal(tz, ((x % tileN) + tileN) % tileN, y);
            } catch {
              entry = { failed: true, parts: [] };
            }
            timing.decodeMs += Date.now() - t0;
          }
          pushTile(entry, ((x % tileN) + tileN) % tileN, y);
        }
      }
      finish();
    } catch (error) {
      console.error('roads service:', error);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(error && error.message || error) }));
    }
  }

  return {
    handle,
    // 原公式 oracle（验证脚本）用，主项目当前不调用。
    propertiesAt,
    stats: () => ({
      cachedTiles: tileCache.size,
      densityLoaded: !!density,
      cachedResponses: responseCache.size,
      remote: !!remote,
      localArchive: !!archive,
    }),
  };
}

export { simplify, splitAntimeridian, pcg3d };
