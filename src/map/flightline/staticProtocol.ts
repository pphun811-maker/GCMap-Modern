import {addProtocol} from 'maplibre-gl';
import {STATIC_MAP} from './resourceMode';
let registered = false;
export function ensureStaticMapProtocol(): void {
  if (!STATIC_MAP || registered) return;
  registered = true;
  addProtocol('flmap', async (params, abort) => {
    const m = /^flmap:\/\/(world|buildings|bathymetry|terrain)\/(\d+)\/(\d+)\/(\d+)\.(?:pbf|png)$/.exec(params.url);
    if (!m) throw Error('Unknown static map resource');
    const {getStaticTile} = await import('./staticTiles');
    const result = await getStaticTile(m[1], +m[2], +m[3], +m[4], abort.signal);
    const bytes = result.data || new Uint8Array();
    return {data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      cacheControl: result.reduced ? 'max-age=10' : 'max-age=3600'};
  });
}
