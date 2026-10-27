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
        parts.push(Uint8Array.from([0x1a]), Uint8Array.from(encodeVarintBytes(layer.length)), layer);
      } else parts.push(buf.subarray(tagStart, p));
    } else if (wire === 0) { let v; [v, p] = readVarintAt(buf, p); parts.push(buf.subarray(tagStart, p)); }
    else if (wire === 1) { p += 8; parts.push(buf.subarray(tagStart, p)); }
    else if (wire === 5) { p += 4; parts.push(buf.subarray(tagStart, p)); }
    else throw Error(`mvt: unsupported tile wire type ${wire}`);
  }
  return concat(parts);
}

export {overzoomMvt};
