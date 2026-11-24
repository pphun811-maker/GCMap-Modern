// The accepted ancestor-coordinate transform, using browser Uint8Array instead of Buffer.
function concat(parts) {
 const result=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let offset=0;
 for(const p of parts){result.set(p,offset);offset+=p.length;}return result;
}
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
  return Uint8Array.from(out);
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
        parts.push(Uint8Array.from([0x22]), Uint8Array.from(encodeVarintBytes(geometry.length)), geometry);
      } else parts.push(buf.subarray(tagStart, p));
    } else if (wire === 0) { let v; [v, p] = readVarintAt(buf, p); parts.push(buf.subarray(tagStart, p)); }
    else if (wire === 1) { p += 8; parts.push(buf.subarray(tagStart, p)); }
    else if (wire === 5) { p += 4; parts.push(buf.subarray(tagStart, p)); }
    else throw Error(`mvt: unsupported feature wire type ${wire}`);
  }
  return concat(parts);
}
const decoder = new TextDecoder();
/** @param {Uint8Array} buf */
function layerName(buf) {
  let p = 0;
  while (p < buf.length) {
    let tag; [tag, p] = readVarintAt(buf, p);
    const field = tag >>> 3, wire = tag & 7;
    if (wire === 2) {
      let len; [len, p] = readVarintAt(buf, p);
      if (field === 1) return decoder.decode(buf.subarray(p, p + len));
      p += len;
    } else if (wire === 0) { [, p] = readVarintAt(buf, p); }
    else if (wire === 1) p += 8;
    else if (wire === 5) p += 4;
    else throw Error(`mvt: unsupported layer wire type ${wire}`);
  }
  return '';
}
/** Raw bytes of the named layer, or null when the tile has no such layer.
 * @param {Uint8Array} buf @param {string} wanted @returns {Uint8Array | null} */
function mvtLayerBytes(buf, wanted) {
  let p = 0;
  while (p < buf.length) {
    let tag; [tag, p] = readVarintAt(buf, p);
    const field = tag >>> 3, wire = tag & 7;
    if (wire === 2) {
      let len; [len, p] = readVarintAt(buf, p);
      const end = p + len;
      if (field === 3 && layerName(buf.subarray(p, end)) === wanted) return buf.subarray(p, end);
      p = end;
    } else if (wire === 0) { [, p] = readVarintAt(buf, p); }
    else if (wire === 1) p += 8;
    else if (wire === 5) p += 4;
    else throw Error(`mvt: unsupported tile wire type ${wire}`);
  }
  return null;
}
/** @param {Uint8Array} buf @param {number} scale @param {number} qx @param {number} qy */
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
        parts.push(Uint8Array.from([0x12]), Uint8Array.from(encodeVarintBytes(rewritten.length)), rewritten);
      } else parts.push(buf.subarray(tagStart, p));
    } else if (wire === 0) { let v; [v, p] = readVarintAt(buf, p); parts.push(buf.subarray(tagStart, p)); }
    else if (wire === 1) { p += 8; parts.push(buf.subarray(tagStart, p)); }
    else if (wire === 5) { p += 4; parts.push(buf.subarray(tagStart, p)); }
    else throw Error(`mvt: unsupported layer wire type ${wire}`);
  }
  return concat(parts);
}
function encodeVarintBytes(n) { const out = []; pushVarint(out, n); return out; }
/** @param {Uint8Array} buf @param {(layer: Uint8Array) => Uint8Array|null} rewriteLayer */
function rewriteMvt(buf, rewriteLayer) {
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
        const layer = rewriteLayer(payload);
        if (!layer) continue;
        parts.push(Uint8Array.from([0x1a]), Uint8Array.from(encodeVarintBytes(layer.length)), layer);
      } else parts.push(buf.subarray(tagStart, p));
    } else if (wire === 0) { let v; [v, p] = readVarintAt(buf, p); parts.push(buf.subarray(tagStart, p)); }
    else if (wire === 1) { p += 8; parts.push(buf.subarray(tagStart, p)); }
    else if (wire === 5) { p += 4; parts.push(buf.subarray(tagStart, p)); }
    else throw Error(`mvt: unsupported tile wire type ${wire}`);
  }
  return concat(parts);
}

/** @param {Uint8Array} buf @param {number} scale @param {number} qx @param {number} qy */
function overzoomMvt(buf, scale, qx, qy) {
  return rewriteMvt(buf, (layer) => overzoomLayer(layer, scale, qx, qy));
}

// Keep selected feature ordinals of one layer and preserve every other layer
// field byte-for-byte. Ordinals are used instead of MVT feature IDs because IDs
// are optional in the spec; a tile without IDs must still split correctly.
/** @param {Uint8Array} buf @param {string} wantedLayer @param {Set<number>} keep @param {boolean} [only] */
function filterMvtLayer(buf, wantedLayer, keep, only = false) {
  return rewriteMvt(buf, (layer) => {
    if (layerName(layer) !== wantedLayer) return only ? null : layer;
    const parts = [];
    let p = 0, index = 0, kept = 0;
    while (p < layer.length) {
      const tagStart = p;
      let tag; [tag, p] = readVarintAt(layer, p);
      const field = tag >>> 3, wire = tag & 7;
      if (wire === 2) {
        let len; [len, p] = readVarintAt(layer, p);
        const end = p + len;
        if (field === 2) {
          if (keep.has(index)) { parts.push(layer.subarray(tagStart, end)); kept++; }
          index++;
        } else parts.push(layer.subarray(tagStart, end));
        p = end;
      } else if (wire === 0) { [, p] = readVarintAt(layer, p); parts.push(layer.subarray(tagStart, p)); }
      else if (wire === 1) { p += 8; parts.push(layer.subarray(tagStart, p)); }
      else if (wire === 5) { p += 4; parts.push(layer.subarray(tagStart, p)); }
      else throw Error(`mvt: unsupported layer wire type ${wire}`);
    }
    // A layer with no remaining features is dropped; with only = true the
    // remaining layers are dropped too, so the tile is reduced to this one.
    return kept > 0 ? concat(parts) : null;
  });
}

// Keep only the named layers, preserving each kept layer byte-for-byte. Used
// for the shared near tile: protomaps ships layers no style layer draws (pois
// is 61% of a dense z15 tile), so they never need to reach the worker.
/** @param {Uint8Array} buf @param {Set<string>} keep @returns {Uint8Array | null} */
function keepMvtLayers(buf, keep) {
  let kept = 0;
  const out = rewriteMvt(buf, (layer) => {
    if (!keep.has(layerName(layer))) return null;
    kept++;
    return layer;
  });
  return kept > 0 ? out : null;
}

export {overzoomMvt, layerName, mvtLayerBytes, filterMvtLayer, keepMvtLayers};
