// 夜间路网几何服务（主项目地图资源服务的一部分）。
//
// 算法逐字节沿用已验收候选 round-11 的 roads.cjs（round-03/04/07/09 证据链）：
// 从 PMTiles 的 roads 图层解码真实干道/街巷，按 ~1.2 km 晶格烘焙 DLL 复原的
// night_road / night_road_vertex 属性（density / lit / off / gain / led / 太阳门控），
// 客户端 nightRoads.ts 只负责把这些属性变成 line-opacity 表达式。
//
// 与候选的唯一差异是部署适配，不是算法改写：
//   - 磁盘数据（road_density_v1.*）改从主项目 server/map-assets 读取；
//   - 本地 z0-7 档案可能不存在（未配置游戏目录），此时 tz<8 也走远端 Range；
//   - ESM 导出 + 显式依赖（vector-tile / pbf 由 createRequire 从主项目 node_modules 取）。
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

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
// Round 12 P0：远端分支改为有界并发取瓦片，不再逐个 await。并发数仅为本地
// 基准可调，默认值对应实测 12 路拐点；每张瓦片最多尝试两次后记为失败。
const REMOTE_CONCURRENCY_DEFAULT = 12;
const REMOTE_CONCURRENCY_MAX = 32;
const REMOTE_TILE_ATTEMPTS = 2;
const MID_MIN_VIEW_Z = 3.5;
const NEAR_MIN_VIEW_Z = 5.9;
const MID_TZ_MIN = 4;
const MID_TZ_MAX = 7;
// Round 12 P2-wide LOD：近景（view z >= 8）的 z8+ 瓦片足迹超过本预算时，改用
// 能放下的最高较低数据缩放，让响应完整且快，而不是撞上 MAX_FEATURES 截断。
// 这是显式 LOD 策略，通过 metadata.dataZoom 暴露；小视野保留 z8+ 细节，宽视野
// 逐级回退到 z7/z6/…/z4。环境变量仅测试用。
const NEAR_TILE_BUDGET_DEFAULT = 24;
const NEAR_TILE_BUDGET_MAX = 64;
const NEAR_ADAPTIVE_MIN_TZ = 4;
function nearTileBudget() {
  const raw = process.env.FLIGHTLINE_NEAR_TILE_BUDGET;
  if (raw === undefined || String(raw).trim() === '') return NEAR_TILE_BUDGET_DEFAULT;
  const n = Number(raw);
  // 用普通 min/max：clamp 在本模块后面才声明，模块加载期调用会命中 TDZ。
  return Number.isFinite(n)
    ? Math.min(NEAR_TILE_BUDGET_MAX, Math.max(1, Math.floor(n)))
    : NEAR_TILE_BUDGET_DEFAULT;
}
const NEAR_TILE_BUDGET = nearTileBudget();
const CACHE_RESPONSES = 48;

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
// FLIGHTLINE_ROADS_CONCURRENCY：仅基准测试用。未设置或非数字保持默认；数值
// 向下取整并夹到 1..32，避免笔误打开无上限的上游 Range 请求。
function remoteConcurrency() {
  const raw = process.env.FLIGHTLINE_ROADS_CONCURRENCY;
  if (raw === undefined || String(raw).trim() === '') return REMOTE_CONCURRENCY_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) ? clamp(Math.floor(n), 1, REMOTE_CONCURRENCY_MAX) : REMOTE_CONCURRENCY_DEFAULT;
}
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

// Round 12 P2-wide：能放进近景预算的最高数据缩放。z8.5 宽视野要 49 张 z8 瓦片
//（撞上 60k 要素截断），会降到 z7（或更低）并返回完整响应。下限是 z4；若连
// z4 都超出不变的 MAX_TILES 守卫，请求维持原有 413。
// budget 参数只为跨实现等价校验保留，默认就是模块预算。
function nearDataZoom(z, w, s, e, n, budget = NEAR_TILE_BUDGET) {
  let tz = Math.min(Math.floor(z), 15);
  while (tz > NEAR_ADAPTIVE_MIN_TZ && tileFootprint(w, s, e, n, tz) > budget) tz--;
  return tz;
}

// Round 12 P3 截断重试决策：首次构建撞上 MAX_FEATURES 时丢弃，并在 tz-1（最低
// z4）重试一次；重试计划仍须通过 64 张瓦片守卫。返回 null 表示不重试。
function truncationRetryZoom(truncated, tz, w, s, e, n) {
  if (!truncated || tz <= NEAR_ADAPTIVE_MIN_TZ) return null;
  const next = tz - 1;
  return tileFootprint(w, s, e, n, next) > MAX_TILES ? null : next;
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
export function createRoadService({ archive, remote, assetsDir = path.join(HERE, 'map-assets') }) {
  const { VectorTile } = require('@mapbox/vector-tile');
  const { PbfReader } = require('pbf');
  const tileCache = new Map();
  const fetchConcurrency = remoteConcurrency();
  let density = null;

  function loadDensity() {
    if (density) return density;
    const metaPath = path.join(assetsDir, 'road_density_v1.json');
    const binPath = path.join(assetsDir, 'road_density_v1.bin.gz');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const bytes = fs.existsSync(binPath)
      ? zlib.gunzipSync(fs.readFileSync(binPath))
      : fs.readFileSync(path.join(assetsDir, 'road_density_v1.bin'));
    if (bytes.length !== meta.output.width * meta.output.height) throw Error('road density size mismatch');
    density = { width: meta.output.width, height: meta.output.height, bytes };
    return density;
  }

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

  function decodeTileLocal(tz, x, y) {
    if (!archive) return null;
    const key = `${tz}/${x}/${y}`;
    if (tileCache.has(key)) return tileCache.get(key);
    let raw = archive.tile(tz, x, y);
    if (!raw) return null;
    if (archive.compression === 2) raw = zlib.gunzipSync(raw);
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

  async function decodeTileRemote(tz, x, y) {
    const key = `${tz}/${x}/${y}`;
    if (tileCache.has(key)) return tileCache.get(key);
    let raw = await remote.getTile(tz, x, y);
    if (raw === undefined) return { failed: true, parts: [] };
    if (!raw) return null;
    if (raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b) raw = zlib.gunzipSync(raw);
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
    const accept = String(req.headers['accept-encoding'] || '');
    const headers = {
      'Cache-Control': 'no-cache',
      'X-Roads-Cache': cache,
      // Round 12 P2：客户端会通过另一个 loopback 主机名（localhost <-> 127.0.0.1）
      // 请求渐进式低细节回退，以避开底图已占满的六条 HTTP/1.1 连接。那是一次
      // 跨源简单 GET，因此响应需要此头；无凭据、无预检。
      'Access-Control-Allow-Origin': '*',
      // 自定义测量头不属于 CORS 安全列表；暴露它们，让跨源回退仍能读到同样的
      // 耗时诊断（content-length 本来就可读）。
      'Access-Control-Expose-Headers': 'X-Roads-Timing, X-Roads-Cache',
    };
    if (entry.summary) headers['X-Roads-Timing'] = JSON.stringify({ ...entry.summary, cache });
    if (accept.includes('gzip')) {
      if (!entry.gz) {
        const t0 = Date.now();
        entry.gz = zlib.gzipSync(entry.body, { level: 6 });
        if (entry.summary) entry.summary.gzipMs = Date.now() - t0;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Encoding': 'gzip',
        'Content-Length': entry.gz.length,
        ...headers,
      });
      res.end(req.method === 'HEAD' ? undefined : entry.gz);
    } else {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(entry.body),
        ...headers,
      });
      res.end(req.method === 'HEAD' ? undefined : entry.body);
    }
  }

  function handle(req, res, url) {
    const timing = { start: Date.now(), decodeMs: 0, buildMs: 0, serializeMs: 0, gzipMs: 0, cache: 'miss' };
    // Round 12：响应已提交或远端周期被放弃后置位；连接关闭会停止调度新瓦片。
    let cancelled = false;
    let finished = false;
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
      // Round 12 P2-wide LOD：近景视野的 z8+ 瓦片足迹超过 NEAR_TILE_BUDGET
      // 时，改用能放下的最高较低数据缩放；选中的 tz 通过 metadata.dataZoom
      // 暴露，小视野仍保留 z8+ 细节。
      const defaultTz = z >= 8 ? Math.min(Math.floor(z), 15)
        : z >= 7 ? 7
        : z >= NEAR_MIN_VIEW_Z ? 6
        : midDataZoom(z, w, s, e, n);
      const tz0 = z >= 8 ? nearDataZoom(z, w, s, e, n) : defaultTz;
      const viewBand = z >= NEAR_MIN_VIEW_Z ? 'near' : 'mid';
      const sharp = smoothstep(6.5, 8.5, z);
      const midLat = (s + n) / 2;
      const metresPerPixel = 156543.03392 * Math.cos(midLat * Math.PI / 180) / 2 ** z;
      const chunkKm = viewBand === 'mid'
        ? clamp(24 * metresPerPixel / 1000, 30, 120)
        : clamp(8 * metresPerPixel / 1000, 4, 22);

      // 每个数据缩放一份计划。构建计划很便宜；真正的瓦片枚举/取数在
      // runLocal/runRemote 里做。
      const planFor = (planTz) => {
        const nTiles = 2 ** planTz;
        const px0 = Math.floor((w + 180) / 360 * nTiles);
        const px1 = Math.floor((e + 180) / 360 * nTiles);
        const py0 = Math.floor(yOfLat(n, nTiles));
        const py1 = Math.floor(yOfLat(s, nTiles));
        return {
          tz: planTz,
          // 主项目部署适配：本地 z0-7 档案可能不存在，此时 tz<8 也走远端。
          remoteMode: !!(remote && (!archive || planTz >= REMOTE_MIN_TZ)),
          tileN: nTiles,
          x0: px0, x1: px1, y0: py0, y1: py1,
          tiles: (px1 - px0 + 1) * (py1 - py0 + 1),
        };
      };

      let plan = planFor(tz0);
      if (plan.tiles > MAX_TILES) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'too many tiles', z, tz: plan.tz, viewBand, tiles: plan.tiles,
        }));
        return;
      }

      // 尝试状态。applyPlan 会重置全部累加器，截断重试因此丢弃未完成的
      // 尝试，而不是把两次结果混在一起。
      let tz = plan.tz;
      let tolerance = 4 * 2 ** (plan.tz - z);
      let features = [];
      let tiles = 0, vertices = 0, truncated = false, failedTiles = 0;
      let classes = {};

      const applyPlan = (next) => {
        plan = next;
        tz = next.tz;
        tolerance = 4 * 2 ** (next.tz - z);
        features = [];
        tiles = 0;
        vertices = 0;
        truncated = false;
        failedTiles = 0;
        classes = {};
      };

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

      const runLocal = (next) => {
        applyPlan(next);
        for (let x = next.x0; x <= next.x1 && !truncated; x++) {
          for (let y = next.y0; y <= next.y1 && !truncated; y++) {
            const tx = ((x % next.tileN) + next.tileN) % next.tileN;
            let entry;
            {
              const t0 = Date.now();
              try {
                entry = decodeTileLocal(next.tz, tx, y);
              } catch {
                entry = { failed: true, parts: [] };
              }
              timing.decodeMs += Date.now() - t0;
            }
            pushTile(entry, tx, y);
          }
        }
      };

      const runRemote = async (next) => {
        applyPlan(next);
        // Round 07：远端周期是异步的（真实 Range 请求）。下面的本地 tz<8 路径
        // 保持完全同步——Round 04 状态机审计会用 mock 响应对象调用 handle()
        // 并立即读回响应体。
        //
        // Round 12 P0：串行 await 就是全部延迟（网络等待占主导；烘焙只要
        // 28-221ms）。按原来的 x→y 顺序构造精确瓦片表，用有界 worker 池取数
        //（每张瓦片重试一次），按索引存 entry，再按同一顺序烘焙。因此执行顺序
        // 确定，且与串行路径的要素顺序一致。响应关闭后不再调度新瓦片；已在途
        // 瓦片允许自然结束。
        const coords = [];
        for (let x = next.x0; x <= next.x1; x++) {
          const tx = ((x % next.tileN) + next.tileN) % next.tileN;
          for (let y = next.y0; y <= next.y1; y++) coords.push([tx, y]);
        }
        const entries = new Array(coords.length);
        const fetchStart = Date.now();
        let nextIndex = 0;
        const worker = async () => {
          while (!cancelled) {
            const i = nextIndex++;
            if (i >= coords.length) return;
            const [tx, ty] = coords[i];
            let entry = null;
            for (let attempt = 0; attempt < REMOTE_TILE_ATTEMPTS; attempt++) {
              try {
                entry = await decodeTileRemote(next.tz, tx, ty);
              } catch {
                entry = { failed: true, parts: [] };
              }
              // 只有取数/解码失败才重试；瓦片不存在（null）是确定答案，不进缓存。
              if (!entry || !entry.failed) break;
            }
            entries[i] = entry;
          }
        };
        const lanes = Math.min(fetchConcurrency, coords.length);
        await Promise.all(Array.from({ length: lanes }, worker));
        timing.decodeMs += Date.now() - fetchStart;
        if (cancelled) return false;
        for (let i = 0; i < coords.length && !truncated; i++) {
          pushTile(entries[i], coords[i][0], coords[i][1]);
        }
        return true;
      };

      const finish = () => {
        finished = true;
        const metadata = {
          z, tz, w, s, e, n,
          viewBand,
          dataZoom: tz,
          tiles, features: features.length, vertices,
          classes, truncated, failedTiles,
          remote: !!plan.remoteMode,
          // 仅远端字段：本地 tz<8 响应体与已验收形态逐字节一致。
          ...(plan.remoteMode ? { remoteConcurrency: fetchConcurrency } : {}),
          // 近景 LOD 策略（P2-wide）：显式暴露，客户端据此报告较粗的数据缩放，
          // 而不是看起来像静默降质。
          ...(z >= 8 ? { nearTileBudget: NEAR_TILE_BUDGET, nearTzLowered: tz < Math.min(Math.floor(z), 15) } : {}),
          ...(timing.retry ? { retry: timing.retry } : {}),
          sharp: Number(sharp.toFixed(3)),
          chunkKm: Number(chunkKm.toFixed(2)),
          tolerance: Number(tolerance.toFixed(2)),
          density: 'settlement_lights_v1 red x alpha, bilinear, 4096x2048',
          source: plan.remoteMode
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
        if (String(req.headers['accept-encoding'] || '').includes('gzip')) {
          const t0 = Date.now();
          gz = zlib.gzipSync(body, { level: 6 });
          timing.gzipMs = Date.now() - t0;
        }
        timing.totalMs = Date.now() - timing.start;
        const summary = {
          decodeMs: timing.decodeMs, buildMs: timing.buildMs,
          serializeMs: timing.serializeMs, gzipMs: timing.gzipMs,
          totalMs: timing.totalMs, features: features.length, vertices, tiles,
          dataZoom: tz,
          ...(timing.retry ? { retry: timing.retry } : {}),
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

      // 截断守卫：首次构建撞上 MAX_FEATURES 时丢弃，并在 tz-1（最低 z4）
      // 重试一次。重试按重试计划走本地或远端；本地路径保持同步。
      const retryPlan = () => {
        const nextTz = truncationRetryZoom(truncated, tz, w, s, e, n);
        if (nextTz === null) return null;
        const retry = planFor(nextTz);
        timing.retry = {
          fromTz: tz, toTz: retry.tz,
          fromFeatures: features.length, fromTruncated: true,
        };
        return retry;
      };

      if (plan.remoteMode) {
        if (typeof res.on === 'function') {
          res.on('close', () => {
            if (!finished && !res.writableEnded) cancelled = true;
          });
        }
        (async () => {
          const built = await runRemote(plan);
          if (!built || cancelled) return;
          const retry = retryPlan();
          if (retry) {
            if (retry.remoteMode) {
              const ok = await runRemote(retry);
              if (!ok || cancelled) return;
            } else {
              runLocal(retry);
            }
          }
          finish();
        })().catch((error) => {
          console.error('roads service:', error);
          if (cancelled) return;
          if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(error && error.message || error) }));
        });
        return;
      }
      runLocal(plan);
      const retry = retryPlan();
      if (retry) runLocal(retry);
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
      remoteConcurrency: fetchConcurrency,
    }),
  };
}

export { simplify, splitAntimeridian, pcg3d, tileFootprint, midDataZoom, nearDataZoom, truncationRetryZoom };
