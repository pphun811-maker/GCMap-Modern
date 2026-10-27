// Real-MVT parity: static worker transport must preserve the accepted road baking and coordinates.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import {createServer} from 'vite';
import {VectorTile} from '@mapbox/vector-tile';
import {PbfReader} from 'pbf';
import {createRoadService as nodeService} from '../server/roads.mjs';
import {createRoadService as browserService} from '../src/map/flightline/staticRoadCore.mjs';
import {overzoomMvt} from '../src/map/flightline/overzoom.mjs';
const raw = fs.readFileSync(new URL('./fixtures/roads-shanghai-z6.pbf',import.meta.url));
const density = new Uint8Array(zlib.gunzipSync(fs.readFileSync('server/map-assets/road_density_v1.bin.gz')));
const remote = {getTile:async (z,x,y)=>z===6&&x===53&&y===26?raw:null};
const request=service=>new Promise(resolve=>{
 let status=200;
 service.handle({headers:{},method:'GET'}, {headersSent:false,setHeader(){},writeHead(code){status=code;this.headersSent=true;},end(body){resolve({status,data:JSON.parse(body)})}},new URL('http://static/roads.geojson?z=6&w=120&s=30&e=123&n=33'));
});
const [original,staticResult]=await Promise.all([request(nodeService({archive:null,remote})),request(browserService({remote,densityData:{width:4096,height:2048,bytes:density}}))]);
assert.equal(original.status,200);assert.equal(staticResult.status,200);
assert.ok(original.data.features.length>0);assert.deepEqual(staticResult.data.features,original.data.features);
assert.equal(staticResult.data.metadata.failedTiles,0);
console.log('PASS static road baking equals Node output:',staticResult.data.features.length,'features');
const child=new VectorTile(new PbfReader(overzoomMvt(raw,2,1,0)));
const parent=new VectorTile(new PbfReader(raw));
let compared=0;
for(const [name,layer] of Object.entries(parent.layers))for(let i=0;i<layer.length;i++){
 const a=layer.feature(i).toGeoJSON(53,26,6),b=child.layers[name].feature(i).toGeoJSON(107,52,7);
 assert.deepEqual(a.properties,b.properties);
 const coordinatesA=JSON.stringify(a.geometry.coordinates),coordinatesB=JSON.stringify(b.geometry.coordinates);
 // Compare numeric coordinates, allowing only floating-point roundoff.
 const numsA=coordinatesA.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/g).map(Number);
 const numsB=coordinatesB.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/g).map(Number);
 assert.equal(numsA.length,numsB.length);numsA.forEach((n,j)=>assert.ok(Math.abs(n-numsB[j])<1e-9));compared++;
}
console.log('PASS ancestor fallback preserves coordinates/properties:',compared,'features');
for(const name of ['bathymetry_z0_z8','terrain_dem_z0_z5']){
 const fd=fs.openSync(`public/map-static/archives/${name}.pmtiles`,'r');const header=Buffer.alloc(127);fs.readSync(fd,header);fs.closeSync(fd);
 assert.equal(header.subarray(0,7).toString(),'PMTiles');assert.equal(header[7],3);
}
assert.equal(fs.statSync('public/map-static/snow-support/bin').size,8388608);
assert.deepEqual(fs.readFileSync('public/map-static/fonts/Noto Sans Bold/0-255.pbf'),fs.readFileSync('public/map-static/fonts/Noto Sans Medium/0-255.pbf'));
console.log('PASS static archives, snow support and Bold font alias');
process.env.VITE_STATIC_MAP='1';
const vite=await createServer({configFile:'vite.config.ts',server:{middlewareMode:true},appType:'custom',logLevel:'error'});
try{
 const {mapResourceUrl,buildStyle}=await vite.ssrLoadModule('/src/map/styleFactory.ts');
 assert.equal(mapResourceUrl('tiles/world/{z}/{x}/{y}.pbf'),'flmap://world/{z}/{x}/{y}.pbf');
 const style=buildStyle('latin','vector',true);
 assert.ok(style.glyphs.includes('map-static/fonts/'));
 assert.ok(!JSON.stringify(style).includes('/map-res/'));
 console.log('PASS static build routes resources without Node endpoints');
}finally{await vite.close();}
