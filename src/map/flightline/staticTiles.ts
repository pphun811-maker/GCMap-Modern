import {PMTiles, FetchSource} from 'pmtiles';
import {VectorTileLayer} from '@mapbox/vector-tile';
import {PbfReader} from 'pbf';
import {overzoomMvt, filterMvtLayer, keepMvtLayers, mvtLayerBytes} from './overzoom.mjs';
import {WORLD_TILE_LAYERS} from './worldLayers.mjs';
import {staticAssetUrl} from './resourceMode';
class TimedSource extends FetchSource {
  override getBytes(offset: number, length: number, signal?: AbortSignal, etag?: string) {
    const timeout = AbortSignal.timeout(15000);
    return super.getBytes(offset, length, signal ? AbortSignal.any([signal, timeout]) : timeout, etag);
  }
}
const archives = new Map<string, PMTiles>();
type TileResult = {data: Uint8Array | null; reduced: boolean; savedAt?: number};
const cache = new Map<string, TileResult>();
const pending = new Map<string, Promise<TileResult>>();
const REDUCED_CACHE_MS = 10_000;
let dailyRetryAt = 0;
const urls: Record<string, string> = {
  world: 'https://maps.playflightline.com/maps/world_z0_z12.pmtiles',
  buildings: 'https://maps.playflightline.com/maps/buildings_z11_z14.pmtiles',
  daily: 'https://build.protomaps.com/20261123.pmtiles',
};
function archive(name: string): PMTiles {
  const url = urls[name] || staticAssetUrl(`archives/${name === 'terrain' ? 'terrain_dem_z0_z5' : 'bathymetry_z0_z8'}.pmtiles`);
  let pm = archives.get(url);
  if (!pm) {pm = new PMTiles(new TimedSource(url)); archives.set(url, pm);}
  return pm;
}
/** Near tiles are shared by two sources: `world` needs the address points for
 *  z18 labels, `buildings` needs the footprints drawn from z11. Split the one
 *  decoded layer by feature ordinal (MVT IDs are optional) and, for the
 *  buildings source, drop every layer it does not render. Absent layer or a
 *  decode failure returns the tile untouched: filtering is an optimisation and
 *  must never blank a tile that MapLibre could draw. */
export function filterBuildingLayer(tile: Uint8Array, keepAddress: boolean): Uint8Array | null {
  try {
    const raw = mvtLayerBytes(tile, 'buildings');
    // No buildings layer: world still drops layers the style never draws; the
    // buildings source has nothing to render here at all.
    if (!raw) return keepAddress ? keepMvtLayers(tile, WORLD_TILE_LAYERS) : null;
    const layer = new VectorTileLayer(new PbfReader(raw));
    const keep = new Set<number>();
    for (let i = 0; i < layer.length; i++) {
      const feature = layer.feature(i);
      if ((feature.properties.kind === 'address') === keepAddress) keep.add(i);
    }
    if (keepAddress) {
      const filtered = keep.size === layer.length ? tile : filterMvtLayer(tile, 'buildings', keep);
      return keepMvtLayers(filtered, WORLD_TILE_LAYERS);
    }
    // Buildings source: footprints only, and none of the other layers.
    return filterMvtLayer(tile, 'buildings', keep, true);
  } catch {
    return tile;
  }
}

export async function getStaticTile(kind: string, z: number, x: number, y: number, _signal?: AbortSignal): Promise<TileResult> {
  const key = `${kind}/${z}/${x}/${y}`;
  const hit = cache.get(key);
  if (hit && (!hit.reduced || (hit.savedAt ?? 0) + REDUCED_CACHE_MS > Date.now())) return hit;
  // MapLibre and the road worker can request the same MVT concurrently. One
  // fetch/decode is enough; no request inherits another caller's AbortSignal.
  const running = pending.get(key);
  if (running) return running;
  const job = fetchTile(kind, z, x, y).then((result) => {
    cache.delete(key);
    if (cache.size >= 192) cache.delete(cache.keys().next().value!);
    cache.set(key, {...result, savedAt: Date.now()});
    return result;
  });
  pending.set(key, job);
  try { return await job; }
  finally { if (pending.get(key) === job) pending.delete(key); }
}

async function fetchTile(kind: string, z: number, x: number, y: number): Promise<TileResult> {
  let data: Uint8Array | null = null;
  let reduced = false;
  const parentMax = kind === 'buildings' ? 14 : 12;
  if ((kind === 'world' || kind === 'buildings') && z > parentMax) {
    try {
      if (Date.now() < dailyRetryAt) throw Error('Daily cooldown');
      const tile = await archive('daily').getZxy(z, x, y);
      data = tile ? new Uint8Array(tile.data) : null;
    } catch {
      dailyRetryAt = Date.now() + 10000;
      const scale = 2 ** (z - parentMax);
      const tile = await archive(kind).getZxy(parentMax, Math.floor(x / scale), Math.floor(y / scale));
      data = tile ? overzoomMvt(new Uint8Array(tile.data), scale, x % scale, y % scale) : null;
      reduced = true;
    }
  } else {
    const tile = await archive(kind).getZxy(z, x, y);
    data = tile ? new Uint8Array(tile.data) : null;
  }
  // Both near sources share the same daily tile, so split it for each one:
  // buildings keeps footprints and drops the layers it never draws, world keeps
  // the address points used by the z18 labels.
  if (data && kind === 'buildings' && z < 18) data = filterBuildingLayer(data, false);
  if (data && kind === 'world' && z >= 11 && z < 18) data = filterBuildingLayer(data, true);
  return {data, reduced};
}
