// 主项目地图资源服务（Vite dev / preview 同源中间件）。
//
// 来源：已验收候选 round-11 的 server.cjs（166 项 aggregate af308c34…，见
// .workbuddy/flightline-map-fidelity-20261023/main-integration/REVIEW-REQUEST.md）。
// 迁移原则：瓦片 Range / 对象身份缓存 / 祖先降级 / 夜路烘焙算法逐字节保留，
// 只把 demo 宿主换成主项目可维护的形态：
//   - 挂在主项目自己的 /map-res/ 前缀下（dev 与 preview 同一份中间件），不依赖 5211；
//   - 游戏资源目录只从服务端环境变量读取，浏览器只看到 /map-res/*；
//   - 不提供静态根目录，也没有任意 URL 代理、测试故障端点或 demo 控制台接口；
//     未命中白名单一律 404（.env / 服务器源码 / 路径穿越都拿不到内容）。
//
// 数据分档（与已验收候选一致）：
//   world      z0-7 本地 world_z0_z7.pmtiles（游戏目录；缺失时退回官方远端 z0-12）
//              z8-12 官方 world_z0_z12.pmtiles（Range）
//              z13-15 build.protomaps.com 固定日构建（Range；失败时官方 z12 祖先降级）
//   buildings  z11-14 官方 buildings_z11_z14.pmtiles；z15 日构建（祖先降级）
//   bathymetry / terrain  本地游戏档案（缺失时返回 204）
//   roads      roads.mjs 服务；远端几何与 world 同一分档
//   fonts      /game fonts 白名单字体；Bold 缺失时映射到 Medium（航线标签用）
//   planet     settlement_lights / global_elevation / planet_material / snow_climatology
//   support    assets 内的冰雪支撑掩膜（服务端 gzip 存储，响应时解压）

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { createRoadService } from './roads.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const GAME_DIR = process.env.FLIGHTLINE_GAME_DIR
  || 'E:/Game Logs/Flightline Airline Sim Demo ZH/run';
const GAME_MAPS = path.join(GAME_DIR, 'content/web/maps');
const GAME_FONTS = path.join(GAME_MAPS, 'fonts');
const CACHE_ROOT = process.env.FLIGHTLINE_MAP_CACHE
  || path.join(process.cwd(), '.cache', 'flightline-map', 'pmtiles');
const ASSETS_DIR = path.join(HERE, 'map-assets');

const DEFAULT_DAILY_URL = 'https://build.protomaps.com/20261026.pmtiles';
function dailyUrl() {
  const v = process.env.FLIGHTLINE_DAILY_URL;
  if (!v) return DEFAULT_DAILY_URL;
  if (!/^https:\/\/build\.protomaps\.com\/\d{8}\.pmtiles$/.test(v)) {
    console.warn(`[map-resources] ignoring FLIGHTLINE_DAILY_URL: only https://build.protomaps.com/YYYYMMDD.pmtiles is allowed`);
    return DEFAULT_DAILY_URL;
  }
  return v;
}
const DAILY_URL = dailyUrl();

const REMOTE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36';
const DISK_BUDGET_BYTES = 256 * 1024 * 1024;
const MAX_INFLIGHT = 6;
const REQUEST_TIMEOUT_MS = 30000;
const COOLDOWN_MS = 10000;
const MAX_DIR_CACHE = 512;

// ---------------------------------------------------------------------------
// 本地 PMTiles（游戏档案）：只读、同步目录读取。
// ---------------------------------------------------------------------------
function varint(b, cursor) {
  let v = 0, mul = 1, x;
  do { x = b[cursor.p++]; if (x === undefined) throw Error('Truncated directory'); v += (x & 127) * mul; mul *= 128; } while (x & 128);
  return v;
}
function directory(b) {
  const c = { p: 0 }, n = varint(b, c), entries = []; let id = 0;
  for (let i = 0; i < n; i++) { id += varint(b, c); entries.push({ id }); }
  for (const e of entries) e.run = varint(b, c);
  for (const e of entries) e.length = varint(b, c);
  for (let i = 0; i < n; i++) { const o = varint(b, c); entries[i].offset = o === 0 && i ? entries[i - 1].offset + entries[i - 1].length : o - 1; }
  return entries;
}
function tileId(z, x, y) {
  let d = (4 ** z - 1) / 3;
  for (let s = 2 ** (z - 1); s >= 1; s /= 2) {
    const rx = (x & s) ? 1 : 0, ry = (y & s) ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) { if (rx === 1) { x = s - 1 - x; y = s - 1 - y; } [x, y] = [y, x]; }
  }
  return d;
}
function find(entries, id) {
  let lo = 0, hi = entries.length - 1;
  while (lo <= hi) { const mid = (lo + hi) >>> 1; if (entries[mid].id <= id) lo = mid + 1; else hi = mid - 1; }
  const e = entries[hi]; return e && (e.run === 0 || id < e.id + e.run) ? e : null;
}
class Archive {
  constructor(file) {
    this.fd = fs.openSync(file, 'r'); this.dirs = new Map();
    const b = this.read(0, 127);
    if (b.subarray(0, 8).toString('hex') !== '504d54696c657303') throw Error('Not PMTiles v3');
    this.header = Array.from({ length: 11 }, (_, i) => Number(b.readBigUInt64LE(8 + i * 8)));
    this.internal = b[97]; this.compression = b[98]; this.maxZoom = b[101];
    this.root = this.dir(this.header[0], this.header[1]);
  }
  read(offset, size) { const b = Buffer.alloc(size); const got = fs.readSync(this.fd, b, 0, size, offset); if (got !== size) throw Error('Short archive read'); return b; }
  dir(offset, size) {
    const key = offset + ':' + size;
    if (!this.dirs.has(key)) { let b = this.read(offset, size); if (this.internal === 2) b = zlib.gunzipSync(b); this.dirs.set(key, directory(b)); }
    return this.dirs.get(key);
  }
  tile(z, x, y) {
    if (z > this.maxZoom) return null;
    const id = tileId(z, x, y); let entries = this.root;
    for (let depth = 0; depth < 4; depth++) {
      const e = find(entries, id); if (!e) return null;
      if (e.run) return this.read(this.header[6] + e.offset, e.length);
      entries = this.dir(this.header[4] + e.offset, e.length);
    }
    throw Error('Directory nesting exceeded');
  }
}

// ---------------------------------------------------------------------------
// 远端 PMTiles over HTTPS Range（三个固定档案；无任意 URL 端点）。
// ---------------------------------------------------------------------------
function shortHash(s) { return crypto.createHash('sha256').update(s).digest('hex').slice(0, 8); }
function cacheIdentity(name, url, etag, total) {
  const stem = (path.basename(url).replace(/\.pmtiles$/i, '') || 'archive').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40);
  const tag = etag ? etag.replace(/[^A-Za-z0-9]/g, '').slice(0, 16) : `size${total || 'unknown'}`;
  return `${name}-${stem}-${tag}-${shortHash(url)}`;
}

class RemotePMTiles {
  constructor(name, url, cacheRoot) {
    this.name = name;
    this.url = url;
    this.cacheRoot = path.join(cacheRoot, name);
    this.cacheDir = null;
    this.identity = null;
    this.etag = null;
    this.header = null;
    this.root = null;
    this.ready = null;
    this.dirs = new Map();
    this.inflight = new Map();
    this.semaphore = 0;
    this.waiters = [];
    this.cooldownUntil = 0;
    this.consecutiveFailures = 0;
    this.stats = {
      diskBytes: 0, dirFetches: 0, errors: 0, lastError: null,
      bytesFromCache: 0, bytesFromNet: 0,
      fallbackTiles: 0, fallbackFailures: 0, fallbackActive: false, lastFallbackAt: 0,
    };
  }
  initDiskCache() {
    if (!this.cacheDir) throw Error(`${this.name}: cache identity not resolved`);
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      let total = 0; const files = [];
      for (const name of fs.readdirSync(this.cacheDir)) {
        const p = path.join(this.cacheDir, name);
        try { const st = fs.statSync(p); if (st.isFile()) { total += st.size; files.push({ p, size: st.size, mtime: st.mtimeMs }); } } catch { /* raced eviction */ }
      }
      files.sort((a, b) => a.mtime - b.mtime);
      for (const f of files) {
        if (total <= DISK_BUDGET_BYTES) break;
        try { fs.unlinkSync(f.p); total -= f.size; } catch { /* best effort */ }
      }
      this.stats.diskBytes = total;
    } catch (e) { this.stats.lastError = String(e.message || e); }
  }
  cachePath(offset, length) {
    if (!this.cacheDir) throw Error(`${this.name}: cache identity not resolved`);
    return path.join(this.cacheDir, `${offset}-${length}.bin`);
  }
  readDisk(offset, length) {
    const p = this.cachePath(offset, length);
    try {
      const b = fs.readFileSync(p);
      const now = Date.now();
      try { fs.utimesSync(p, now / 1000, now / 1000); } catch { /* recency best effort */ }
      return b;
    } catch { return null; }
  }
  writeDisk(offset, length, data) {
    const p = this.cachePath(offset, length);
    try {
      let before = 0;
      try { before = fs.statSync(p).size; } catch { /* first write */ }
      fs.writeFileSync(p, data);
      this.stats.diskBytes += data.length - before;
      if (this.stats.diskBytes > DISK_BUDGET_BYTES) {
        const files = [];
        for (const name of fs.readdirSync(this.cacheDir)) {
          const fp = path.join(this.cacheDir, name);
          try { const st = fs.statSync(fp); if (st.isFile()) files.push({ fp, size: st.size, mtime: st.mtimeMs }); } catch { /* raced */ }
        }
        files.sort((a, b) => a.mtime - b.mtime);
        for (const f of files) {
          if (this.stats.diskBytes <= DISK_BUDGET_BYTES) break;
          try { fs.unlinkSync(f.fp); this.stats.diskBytes -= f.size; } catch { /* raced */ }
        }
      }
    } catch (e) { this.stats.lastError = String(e.message || e); }
  }
  acquire() {
    if (this.semaphore < MAX_INFLIGHT) { this.semaphore++; return; }
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  release() {
    const next = this.waiters.shift();
    if (next) next(); else this.semaphore--;
  }
  httpRange(offset, length) {
    return new Promise((resolve, reject) => {
      const req = https.request(this.url, {
        method: 'GET',
        headers: { Range: `bytes=${offset}-${offset + length - 1}`, 'User-Agent': REMOTE_UA, 'Accept-Encoding': 'identity' },
        timeout: REQUEST_TIMEOUT_MS,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(Error(`${this.name} range timeout`)));
      req.on('error', reject);
      req.end();
    });
  }
  async rangeBytes(offset, length) {
    const res = await this.httpRange(offset, length);
    if (!res || res.status !== 206) throw Error(`${this.name} range ${offset}+${length}: HTTP ${res && res.status}`);
    if (!Buffer.isBuffer(res.body) || res.body.length !== length) throw Error(`${this.name} range ${offset}+${length}: short body ${res.body && res.body.length}`);
    const etag = res.headers && res.headers.etag;
    // 观测对象已变化：拒绝把新对象字节写进启动时命名的命名空间。
    if (this.etag && etag && etag !== this.etag) throw Error(`${this.name}: archive identity changed (${this.etag} -> ${etag}); restart the server`);
    return res;
  }
  async initIdentity() {
    if (this.identity) return;
    const res = await this.rangeBytes(0, 16384);
    const head = res.body;
    if (head.subarray(0, 7).toString() !== 'PMTiles') throw Error(`${this.name}: not PMTiles`);
    if (head[7] > 3) throw Error(`${this.name}: spec ${head[7]} unsupported`);
    const range = String((res.headers && res.headers['content-range']) || '');
    const total = /^\d+$/.test(range.split('/')[1] || '') ? Number(range.split('/')[1]) : null;
    this.etag = (res.headers && res.headers.etag) || null;
    this.identity = cacheIdentity(this.name, this.url, this.etag, total);
    this.cacheDir = path.join(this.cacheRoot, this.identity);
    this.initDiskCache();
    this.writeDisk(0, 16384, head);
  }
  async getBytes(offset, length) {
    const cached = this.readDisk(offset, length);
    if (cached && cached.length === length) { this.stats.bytesFromCache += cached.length; return cached; }
    const key = `${offset}:${length}`;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const job = (async () => {
      await this.acquire();
      try {
        const res = await this.rangeBytes(offset, length);
        const data = res.body;
        this.stats.bytesFromNet += data.length;
        this.consecutiveFailures = 0;
        this.writeDisk(offset, length, data);
        return data;
      } catch (e) {
        this.stats.errors++;
        this.stats.lastError = String(e.message || e);
        if (++this.consecutiveFailures >= 3) this.cooldownUntil = Date.now() + COOLDOWN_MS;
        throw e;
      } finally { this.release(); }
    })();
    const settled = job.finally(() => { if (this.inflight.get(key) === settled) this.inflight.delete(key); });
    this.inflight.set(key, settled);
    return settled;
  }
  decompress(b, compression) {
    if (compression === 0 || compression === 1) return b;
    if (compression === 2) return zlib.gunzipSync(b);
    throw Error(`${this.name}: unsupported compression ${compression}`);
  }
  async init() {
    if (!this.ready) {
      this.ready = (async () => {
        await this.initIdentity();
        const head = (await this.getBytes(0, 16384)).subarray(0, 127);
        if (head.subarray(0, 7).toString() !== 'PMTiles') throw Error(`${this.name}: not PMTiles`);
        if (head[7] > 3) throw Error(`${this.name}: spec ${head[7]} unsupported`);
        const u64 = (o) => Number(head.readBigUInt64LE(o));
        this.header = {
          rootOffset: u64(8), rootLength: u64(16), jsonOffset: u64(24), jsonLength: u64(32),
          leafOffset: u64(40), leafLength: u64(48), dataOffset: u64(56), dataLength: u64(64),
        };
        this.internal = head[97]; this.compression = head[98]; this.tileType = head[99];
        this.minZoom = head[100]; this.maxZoom = head[101];
        this.root = directory(this.decompress(await this.getBytes(this.header.rootOffset, this.header.rootLength), this.internal));
      })().catch((e) => { this.ready = null; throw e; });
    }
    return this.ready;
  }
  loadDir(offset, length) {
    const key = `${offset}:${length}`;
    if (this.dirs.has(key)) {
      const v = this.dirs.get(key);
      this.dirs.delete(key); this.dirs.set(key, v);
      return Promise.resolve(v);
    }
    return this.getBytes(offset, length).then((b) => {
      const entries = directory(this.decompress(b, this.internal));
      if (this.dirs.size >= MAX_DIR_CACHE) this.dirs.delete(this.dirs.keys().next().value);
      this.dirs.set(key, entries);
      this.stats.dirFetches++;
      return entries;
    });
  }
  degraded() { return Date.now() < this.cooldownUntil; }
  async tile(z, x, y) {
    if (z > this.maxZoom) return null;
    await this.init();
    if (this.degraded()) throw Error(`${this.name} cooling down after failures`);
    const id = tileId(z, x, y);
    let offset = this.header.rootOffset, length = this.header.rootLength;
    for (let depth = 0; depth < 5; depth++) {
      const entries = depth === 0 ? this.root : await this.loadDir(offset, length);
      const e = find(entries, id);
      if (!e) return null;
      if (e.run) return await this.getBytes(this.header.dataOffset + e.offset, e.length);
      offset = this.header.leafOffset + e.offset; length = e.length;
    }
    throw Error(`${this.name}: directory nesting exceeded`);
  }
}

// ---------------------------------------------------------------------------
// 祖先降级：把官方 z12（或 building z14）瓦片几何变换成请求的子瓦片。
// ---------------------------------------------------------------------------
function pushVarint(out, n) {
  n >>>= 0;
  do { let b = n & 127; n >>>= 7; if (n) b |= 128; out.push(b); } while (n);
}
function readVarintAt(buf, p) {
  let v = 0, mul = 1, x;
  do { x = buf[p++]; if (x === undefined) throw Error('varint truncated'); v += (x & 127) * mul; mul *= 128; } while (x & 128);
  return [v, p];
}
const zigzagDecode = (v) => (v >>> 1) ^ -(v & 1);
const zigzagEncode = (n) => ((n << 1) ^ (n >> 31)) >>> 0;
function rewriteGeometry(vals, scale, offsetX, offsetY) {
  const out = [];
  let i = 0, first = true;
  while (i < vals.length) {
    const cmd = vals[i++];
    const id = cmd & 7, count = cmd >>> 3;
    pushVarint(out, cmd);
    if (id === 1 || id === 2) {
      for (let k = 0; k < count; k++) {
        const dx = zigzagDecode(vals[i++]), dy = zigzagDecode(vals[i++]);
        let nx = dx * scale, ny = dy * scale;
        if (first) { nx -= offsetX; ny -= offsetY; first = false; }
        pushVarint(out, zigzagEncode(nx));
        pushVarint(out, zigzagEncode(ny));
      }
    } else if (id !== 7) throw Error(`mvt: unknown geometry command ${id}`);
  }
  return Buffer.from(out);
}
function overzoomFeature(buf, scale, offsetX, offsetY) {
  const parts = [];
  let p = 0;
  while (p < buf.length) {
    const tagStart = p;
    let tag, np; [tag, np] = readVarintAt(buf, p); p = np;
    const field = tag >>> 3, wire = tag & 7;
    if (wire === 2) {
      let len; [len, p] = readVarintAt(buf, p);
      const payload = buf.subarray(p, p + len); p += len;
      if (field === 4) {
        const vals = []; let q = 0;
        while (q < payload.length) { const [v, nq] = readVarintAt(payload, q); vals.push(v); q = nq; }
        const geometry = rewriteGeometry(vals, scale, offsetX, offsetY);
        parts.push(Buffer.from([0x22]), Buffer.from(encodeVarintBytes(geometry.length)), geometry);
      } else parts.push(buf.subarray(tagStart, p));
    } else if (wire === 0) { let v; [v, p] = readVarintAt(buf, p); parts.push(buf.subarray(tagStart, p)); }
    else if (wire === 1) { p += 8; parts.push(buf.subarray(tagStart, p)); }
    else if (wire === 5) { p += 4; parts.push(buf.subarray(tagStart, p)); }
    else throw Error(`mvt: unsupported feature wire type ${wire}`);
  }
  return Buffer.concat(parts);
}
function overzoomLayer(buf, scale, qx, qy) {
  let extent = 4096;
  {
    let p = 0;
    while (p < buf.length) {
      let tag, np; [tag, np] = readVarintAt(buf, p); p = np;
      const field = tag >>> 3, wire = tag & 7;
      if (wire === 2) { let len; [len, p] = readVarintAt(buf, p); p += len; }
      else if (wire === 0) { let v; [v, p] = readVarintAt(buf, p); if (field === 5) extent = v; }
      else if (wire === 1) p += 8;
      else if (wire === 5) p += 4;
      else throw Error(`mvt: unsupported layer wire type ${wire}`);
    }
  }
  const parts = [];
  let p = 0;
  while (p < buf.length) {
    const tagStart = p;
    let tag, np; [tag, np] = readVarintAt(buf, p); p = np;
    const field = tag >>> 3, wire = tag & 7;
    if (wire === 2) {
      let len; [len, p] = readVarintAt(buf, p);
      const payload = buf.subarray(p, p + len); p += len;
      if (field === 2) {
        const rewritten = overzoomFeature(payload, scale, qx * extent, qy * extent);
        parts.push(Buffer.from([0x12]), Buffer.from(encodeVarintBytes(rewritten.length)), rewritten);
      } else parts.push(buf.subarray(tagStart, p));
    } else if (wire === 0) { let v; [v, p] = readVarintAt(buf, p); parts.push(buf.subarray(tagStart, p)); }
    else if (wire === 1) { p += 8; parts.push(buf.subarray(tagStart, p)); }
    else if (wire === 5) { p += 4; parts.push(buf.subarray(tagStart, p)); }
    else throw Error(`mvt: unsupported layer wire type ${wire}`);
  }
  return Buffer.concat(parts);
}
function encodeVarintBytes(n) { const out = []; pushVarint(out, n); return out; }
function overzoomMvt(buf, scale, qx, qy) {
  const parts = [];
  let p = 0;
  while (p < buf.length) {
    const tagStart = p;
    let tag, np; [tag, np] = readVarintAt(buf, p); p = np;
    const field = tag >>> 3, wire = tag & 7;
    if (wire === 2) {
      let len; [len, p] = readVarintAt(buf, p);
      const payload = buf.subarray(p, p + len); p += len;
      if (field === 3) {
        const layer = overzoomLayer(payload, scale, qx, qy);
        parts.push(Buffer.from([0x1a]), Buffer.from(encodeVarintBytes(layer.length)), layer);
      } else parts.push(buf.subarray(tagStart, p));
    } else if (wire === 0) { let v; [v, p] = readVarintAt(buf, p); parts.push(buf.subarray(tagStart, p)); }
    else if (wire === 1) { p += 8; parts.push(buf.subarray(tagStart, p)); }
    else if (wire === 5) { p += 4; parts.push(buf.subarray(tagStart, p)); }
    else throw Error(`mvt: unsupported tile wire type ${wire}`);
  }
  return Buffer.concat(parts);
}
class AncestorOverzoom {
  constructor(source) { this.source = source; }
  async tile(z, x, y) {
    const src = this.source;
    await src.init();
    const base = src.maxZoom;
    if (z <= base) return src.tile(z, x, y);
    const factor = 2 ** (z - base);
    const ax = Math.floor(x / factor), ay = Math.floor(y / factor);
    const qx = x - ax * factor, qy = y - ay * factor;
    const raw = await src.tile(base, ax, ay);
    if (!raw) return null;
    const decoded = raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw) : raw;
    return zlib.gzipSync(overzoomMvt(decoded, factor, qx, qy));
  }
  get maxZoom() { return this.source.maxZoom; }
}

// ---------------------------------------------------------------------------
// 运行时单例（每个 dev/preview 进程一份）。
// ---------------------------------------------------------------------------
let runtime = null;
function openArchive(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return new Archive(file);
  } catch (e) {
    console.warn(`[map-resources] could not open ${path.basename(file)}: ${e.message || e}`);
    return null;
  }
}

function getRuntime() {
  if (runtime) return runtime;
  const archives = {
    world: openArchive(path.join(GAME_MAPS, 'world_z0_z7.pmtiles')),
    bathymetry: openArchive(path.join(GAME_MAPS, 'bathymetry_z0_z8.pmtiles')),
    terrain: openArchive(path.join(GAME_MAPS, 'terrain_dem_z0_z5.pmtiles')),
  };
  const remotes = {
    'official-world': new RemotePMTiles('official-world', 'https://maps.playflightline.com/maps/world_z0_z12.pmtiles', CACHE_ROOT),
    'official-buildings': new RemotePMTiles('official-buildings', 'https://maps.playflightline.com/maps/buildings_z11_z14.pmtiles', CACHE_ROOT),
    daily: new RemotePMTiles('daily', DAILY_URL, CACHE_ROOT),
  };
  const worldAncestor = new AncestorOverzoom(remotes['official-world']);
  const buildingsAncestor = new AncestorOverzoom(remotes['official-buildings']);
  let roadsRemoteFailures = 0;
  const roads = createRoadService({
    archive: archives.world,
    assetsDir: ASSETS_DIR,
    remote: {
      async getTile(tz, x, y) {
        const source = tz <= 12 ? remotes['official-world'] : remotes.daily;
        try {
          await source.init();
          return await source.tile(Math.min(tz, source.maxZoom), x, y);
        } catch (e) {
          roadsRemoteFailures++;
          if (source === remotes.daily) {
            try { return await worldAncestor.tile(tz, x, y); } catch { /* both sources down */ }
          }
          return undefined;
        }
      },
    },
  });
  const counts = { requests: 0, tiles: 0, empty: 0, errors: 0, bytes: 0 };
  runtime = { archives, remotes, worldAncestor, buildingsAncestor, roads, counts, roadsFailures: () => roadsRemoteFailures };
  console.log(`[map-resources] local archives: world=${!!archives.world} bathymetry=${!!archives.bathymetry} terrain=${!!archives.terrain}`);
  return runtime;
}

function worldTile(z, x, y) {
  const { archives, remotes, worldAncestor } = getRuntime();
  if (archives.world && z <= archives.world.maxZoom) return { local: archives.world, from: 'local' };
  if (z <= 12) return { remote: remotes['official-world'], from: 'official-world' };
  if (z <= 15) return { remote: remotes.daily, from: 'daily', ancestor: worldAncestor };
  return { from: 'beyond-max' };
}
function buildingsTile(z, x, y) {
  const { remotes, buildingsAncestor } = getRuntime();
  if (z >= 11 && z <= 14) return { remote: remotes['official-buildings'], from: 'official-buildings' };
  if (z === 15) return { remote: remotes.daily, from: 'daily', ancestor: buildingsAncestor };
  return { from: 'beyond-max' };
}

const MIME = {
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.pbf': 'application/x-protobuf',
};

function sendBuffer(req, res, buffer, type, cache = 'public, max-age=3600') {
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', cache);
  res.setHeader('Content-Length', buffer.length);
  if (req.method === 'HEAD') res.end();
  else res.end(buffer);
}

function sendFile(req, res, file, type) {
  let st;
  try { st = fs.statSync(file); } catch { res.writeHead(404).end(); return; }
  if (!st.isFile()) { res.writeHead(404).end(); return; }
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('Accept-Ranges', 'bytes');
  const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
  let start = 0, end = st.size - 1;
  if (match) {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), end) : end;
    if (start > end) { res.writeHead(416).end(); return; }
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
  }
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Length', end - start + 1);
  if (req.method === 'HEAD') res.end();
  else fs.createReadStream(file, { start, end }).pipe(res);
}

async function serveRemoteTile(req, res, plan) {
  const rt = getRuntime();
  rt.counts.tiles++;
  if (!plan.local && !plan.remote) {
    rt.counts.empty++; res.writeHead(204).end(); return;
  }
  if (plan.local) {
    const data = plan.local.tile(plan.tileZ, plan.tileX, plan.tileY);
    if (!data) { rt.counts.empty++; res.writeHead(204).end(); return; }
    res.setHeader('Content-Type', 'application/x-protobuf');
    if (plan.local.compression === 2) res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('X-Tile-Source', 'local');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Content-Length', data.length);
    if (req.method === 'HEAD') res.end(); else res.end(data);
    return;
  }
  let data = null, primaryFailed = false, failure = '';
  try { data = await plan.remote.tile(plan.tileZ, plan.tileX, plan.tileY); }
  catch (e) {
    primaryFailed = true;
    failure = String(e.message || e);
    rt.counts.errors++;
  }
  if (primaryFailed && plan.ancestor) {
    try {
      const adapted = await plan.ancestor.tile(plan.tileZ, plan.tileX, plan.tileY);
      if (adapted) {
        plan.remote.stats.fallbackTiles++;
        plan.remote.stats.fallbackActive = true;
        plan.remote.stats.lastFallbackAt = Date.now();
        res.setHeader('Content-Type', 'application/x-protobuf');
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('X-Tile-Source', `${plan.from}-ancestor-${plan.ancestor.maxZoom}`);
        res.setHeader('X-Tile-Detail', 'reduced');
        res.setHeader('X-Tile-Fallback', 'ancestor');
        res.setHeader('Cache-Control', 'public, max-age=10');
        res.setHeader('Content-Length', adapted.length);
        if (req.method === 'HEAD') res.end(); else res.end(adapted);
        return;
      }
      failure += '; ancestor empty';
    } catch (e) {
      plan.remote.stats.fallbackFailures++;
      failure += `; ancestor ${String(e.message || e)}`;
    }
  }
  if (primaryFailed) {
    // 上游失败不是空瓦片：204 会被 MapLibre 当成成功空白。返回 502，
    // 客户端按有界 refreshTiles 重试静止视野（FND-16）。
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'remote tile unavailable', from: plan.from, fallback: plan.ancestor ? 'ancestor-failed' : 'none', detail: failure }));
    return;
  }
  if (!data) {
    rt.counts.empty++; res.writeHead(204).end(); return;
  }
  plan.remote.stats.fallbackActive = false;
  res.setHeader('Content-Type', 'application/x-protobuf');
  res.setHeader('Content-Encoding', 'gzip');
  res.setHeader('X-Tile-Source', plan.from);
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('Content-Length', data.length);
  if (req.method === 'HEAD') res.end(); else res.end(data);
}

const PLANET_TEXTURES = new Set([
  'settlement_lights_v1.png',
  'global_elevation_v1.png',
  'planet_material_v1.png',
  'snow_climatology_v1.png',
]);
const FONT_STACKS = new Set(['Noto Sans Regular', 'Noto Sans Medium', 'Noto Sans Italic', 'Noto Sans Bold']);
const FONT_ALIASES = { 'Noto Sans Bold': 'Noto Sans Medium' };

let supportCache = null;
function supportData() {
  if (supportCache) return supportCache;
  const meta = JSON.parse(fs.readFileSync(path.join(ASSETS_DIR, 'snow_support_v1.json'), 'utf8'));
  const bin = zlib.gunzipSync(fs.readFileSync(path.join(ASSETS_DIR, 'snow_support_v1.bin.gz')));
  const { width, height } = meta.output;
  if (bin.length !== width * height) throw Error(`snow support size ${bin.length} != ${width * height}`);
  supportCache = { meta, bin };
  return supportCache;
}

function fail(res, e) {
  console.error('[map-resources]', e);
  if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'map resource error' }));
}

function statusJson() {  const rt = getRuntime();
  return {
    ok: true,
    localArchives: {
      world: !!rt.archives.world,
      bathymetry: !!rt.archives.bathymetry,
      terrain: !!rt.archives.terrain,
    },
    counts: rt.counts,
    roadsRemoteFailures: rt.roadsFailures(),
    roads: rt.roads.stats(),
    remotes: Object.fromEntries(Object.entries(rt.remotes).map(([k, v]) => [k, {
      ready: v.ready instanceof Promise ? 'pending' : !!v.ready,
      identity: v.identity,
      minZoom: v.minZoom ?? null,
      maxZoom: v.maxZoom ?? null,
      degraded: v.degraded(),
      diskBytes: v.stats.diskBytes || 0,
      dirFetches: v.stats.dirFetches,
      errors: v.stats.errors,
      bytesFromCache: v.stats.bytesFromCache,
      bytesFromNet: v.stats.bytesFromNet,
      fallbackTiles: v.stats.fallbackTiles,
      fallbackFailures: v.stats.fallbackFailures,
      fallbackActive: v.stats.fallbackActive,
      lastFallbackAt: v.stats.lastFallbackAt || null,
    }])),
  };
}

/**
 * 创建地图资源中间件。
 * @param {string} base Vite base（'/' 或 '/GCMap-Modern/'）
 */
export function createMapResourceMiddleware(base = '/') {
  const prefix = `${base.replace(/\/+$/, '')}/map-res`;
  // 服务端文件/密钥黑名单：即使 Vite 的 SPA fallback 在预览时对未知路径回 index.html，
  // 这里也明确 404，避免任何 .env / 服务器源码 / 构建配置以任何形式出现在响应里。
  const SENSITIVE = /^\/(?:\.env(?:\.[^/]*)?|\.git(?:\/|$)|server\/|scripts\/|desktop\/|package(?:-lock)?\.json$|vite\.config\.[^/]+$|tsconfig(?:\.[^/]+)?\.json$)/;
  return function mapResourceMiddleware(req, res, next) {
    const rawUrl = req.url || '/';
    let requestPath;
    try {
      // URL 构造会归一化 ..（例如 /map-res/../.env.local → /.env.local）。
      requestPath = new URL(rawUrl, 'http://127.0.0.1').pathname;
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (SENSITIVE.test(requestPath)) { res.writeHead(404).end(); return; }
    if (!requestPath.startsWith(prefix)) { next(); return; }
    const rt = getRuntime();
    rt.counts.requests++;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const url = new URL(rawUrl, 'http://127.0.0.1');
    if (!url.pathname.startsWith(prefix + '/')) { res.writeHead(404).end(); return; }
    const sub = url.pathname.slice(prefix.length);
    let p;
    try { p = decodeURIComponent(sub); } catch { res.writeHead(400).end(); return; }

    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }

      if (p === '/status') {
        sendBuffer(req, res, Buffer.from(JSON.stringify(statusJson())), MIME['.json'], 'no-store');
        return;
      }

      if (p === '/roads.geojson') {
        rt.roads.handle(req, res, url);
        return;
      }

      let m = /^\/tiles\/world\/(\d+)\/(\d+)\/(\d+)\.pbf$/.exec(p);
      if (m) {
        const z = +m[1], x = +m[2], y = +m[3];
        if (z > 18 || x >= 2 ** z || y >= 2 ** z) { res.writeHead(400).end(); return; }
        serveRemoteTile(req, res, { ...worldTile(z, x, y), tileZ: z, tileX: x, tileY: y })
          .catch((e) => fail(res, e));
        return;
      }
      m = /^\/tiles\/buildings\/(\d+)\/(\d+)\/(\d+)\.pbf$/.exec(p);
      if (m) {
        const z = +m[1], x = +m[2], y = +m[3];
        if (z > 18 || x >= 2 ** z || y >= 2 ** z) { res.writeHead(400).end(); return; }
        serveRemoteTile(req, res, { ...buildingsTile(z, x, y), tileZ: z, tileX: x, tileY: y })
          .catch((e) => fail(res, e));
        return;
      }
      m = /^\/tiles\/(bathymetry|terrain)\/(\d+)\/(\d+)\/(\d+)\.(pbf|png)$/.exec(p);
      if (m) {
        const [, kind, zs, xs, ys] = m, z = +zs, x = +xs, y = +ys;
        if (z > 18 || x >= 2 ** z || y >= 2 ** z) { res.writeHead(400).end(); return; }
        const a = rt.archives[kind];
        if (!a) { res.writeHead(204).end(); return; }
        rt.counts.tiles++;
        const data = a.tile(z, x, y);
        if (!data) { rt.counts.empty++; res.writeHead(204).end(); return; }
        res.setHeader('Content-Type', kind === 'terrain' ? 'image/png' : 'application/x-protobuf');
        if (a.compression === 2) res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.setHeader('Content-Length', data.length);
        if (req.method === 'HEAD') res.end(); else res.end(data);
        return;
      }

      m = /^\/fonts\/([^/]+)\/(\d+-\d+\.pbf)$/.exec(p);
      if (m) {
        const requested = m[1];
        if (!FONT_STACKS.has(requested)) { res.writeHead(404).end(); return; }
        const dirName = FONT_ALIASES[requested] && !fs.existsSync(path.join(GAME_FONTS, requested))
          ? FONT_ALIASES[requested]
          : requested;
        const file = path.join(GAME_FONTS, dirName, m[2]);
        sendFile(req, res, file, MIME['.pbf']);
        return;
      }

      m = /^\/planet\/([a-z0-9_]+\.png)$/.exec(p);
      if (m) {
        if (!PLANET_TEXTURES.has(m[1])) { res.writeHead(404).end(); return; }
        sendFile(req, res, path.join(GAME_MAPS, m[1]), MIME['.png']);
        return;
      }

      if (p === '/snow-support/meta.json') {
        const { meta } = supportData();
        sendBuffer(req, res, Buffer.from(JSON.stringify(meta)), MIME['.json']);
        return;
      }
      if (p === '/snow-support/bin') {
        const { bin } = supportData();
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.setHeader('Content-Length', bin.length);
        if (req.method === 'HEAD') res.end(); else res.end(bin);
        return;
      }

      // 白名单之外一律 404：不暴露项目根目录、服务器源码或 .env。
      res.writeHead(404).end();
    } catch (e) {
      rt.counts.errors++;
      fail(res, e);
    }
  };
}
