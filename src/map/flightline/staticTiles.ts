import {PMTiles, FetchSource} from 'pmtiles';
import {overzoomMvt} from './overzoom.mjs';
import {staticAssetUrl} from './resourceMode';
class TimedSource extends FetchSource {
  override getBytes(offset: number, length: number, signal?: AbortSignal, etag?: string) {
    const timeout = AbortSignal.timeout(15000);
    return super.getBytes(offset, length, signal ? AbortSignal.any([signal, timeout]) : timeout, etag);
  }
}
const archives = new Map<string, PMTiles>();
const cache = new Map<string, {data: Uint8Array | null; reduced: boolean}>();
let dailyRetryAt = 0;
const urls: Record<string, string> = {
  world: 'https://maps.playflightline.com/maps/world_z0_z12.pmtiles',
  buildings: 'https://maps.playflightline.com/maps/buildings_z11_z14.pmtiles',
  daily: 'https://build.protomaps.com/20261026.pmtiles',
};
function archive(name: string): PMTiles {
  const url = urls[name] || staticAssetUrl(`archives/${name === 'terrain' ? 'terrain_dem_z0_z5' : 'bathymetry_z0_z8'}.pmtiles`);
  let pm = archives.get(url);
  if (!pm) {pm = new PMTiles(new TimedSource(url)); archives.set(url, pm);}
  return pm;
}
export async function getStaticTile(kind: string, z: number, x: number, y: number, signal?: AbortSignal): Promise<{data:Uint8Array|null;reduced:boolean}> {
  const key = `${kind}/${z}/${x}/${y}`;
  const hit = cache.get(key); if (hit) return hit;
  let data: Uint8Array | null = null;
  let reduced = false;
  const parentMax = kind === 'buildings' ? 14 : 12;
  if ((kind === 'world' || kind === 'buildings') && z > parentMax) {
    try {
      if (Date.now() < dailyRetryAt) throw Error('Daily cooldown');
      const tile = await archive('daily').getZxy(z, x, y, signal);
      data = tile ? new Uint8Array(tile.data) : null;
    } catch (error) {
      if (signal?.aborted) throw error;
      dailyRetryAt = Date.now() + 10000;
      const scale = 2 ** (z - parentMax);
      const tile = await archive(kind).getZxy(parentMax, Math.floor(x / scale), Math.floor(y / scale), signal);
      data = tile ? overzoomMvt(new Uint8Array(tile.data), scale, x % scale, y % scale) : null;
      reduced = true;
    }
  } else {
    const tile = await archive(kind).getZxy(z, x, y, signal);
    data = tile ? new Uint8Array(tile.data) : null;
  }
  const result = {data, reduced};
  if (!reduced) {if (cache.size >= 192) cache.delete(cache.keys().next().value!); cache.set(key, result);}
  return result;
}
