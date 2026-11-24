// Real-MVT parity: static worker transport must preserve the accepted road baking and coordinates.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import zlib from 'node:zlib';
import {createServer} from 'vite';
import {VectorTile} from '@mapbox/vector-tile';
import {PbfReader} from 'pbf';
import {createRoadService as nodeService} from '../server/roads.mjs';
import {createRoadService as browserService} from '../src/map/flightline/staticRoadCore.mjs';
import {overzoomMvt, filterMvtLayer, keepMvtLayers, mvtLayerBytes} from '../src/map/flightline/overzoom.mjs';
import {WORLD_TILE_LAYERS} from '../src/map/flightline/worldLayers.mjs';
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
// Building/address splitting is a raw MVT rewrite. Feature ordinals are used
// instead of IDs because MVT IDs are optional; other layers and every
// non-feature field stay byte-for-byte.
const enc=n=>{const out=[];let v=n>>>0;do{let b=v&127;v>>>=7;if(v)b|=128;out.push(b);}while(v);return out;};
const sBytes=s=>[...Buffer.from(s)];
const ld=(field,payload)=>[(field<<3)|2,...enc(payload.length),...payload];
const vi=(field,n)=>[(field<<3)|0,...enc(n)];
const zig=n=>((n<<1)^(n>>31))>>>0;
const mvtFeature=({id,kind,x=0,y=0})=>{
 const out=[];
 if(id!==undefined)out.push(...vi(1,id));
 out.push(...ld(2,[0,...enc(kind)]));   // packed tags: key 0 ('kind') -> value index
 out.push(...vi(3,1));                  // POINT
 out.push(...ld(4,[9,...enc(zig(x)),...enc(zig(y))]));
 return out;
};
const mvtLayer=(name,features)=>{
 const out=[...ld(1,sBytes(name))];
 for(const f of features)out.push(...ld(2,f));
 out.push(...ld(3,sBytes('kind')));
 for(const value of ['building','address','county'])out.push(...ld(4,ld(1,sBytes(value))));
 out.push(...vi(5,4096),...vi(15,2));
 return out;
};
const mvtTile=(...layers)=>Uint8Array.from(layers.flatMap(l=>ld(3,l)));
const decode=b=>new VectorTile(new PbfReader(b));
const kinds=t=>Array.from({length:t.layers.buildings?.length??0},(_,i)=>t.layers.buildings.feature(i).properties.kind);
// The daily tile carries several layers and boundaries comes first. Picking IDs
// from the first layer (the earlier defect) would drop every building, so the
// split must be addressed by layer name and ordinal.
const multi=mvtTile(
 mvtLayer('boundaries',[mvtFeature({id:999,kind:2})]),
 mvtLayer('buildings',[mvtFeature({id:1,kind:0,x:10}),mvtFeature({id:2,kind:0,x:20}),mvtFeature({id:3,kind:1,x:30})]),
 mvtLayer('pois',[mvtFeature({id:7,kind:0,x:5})]));
assert.deepEqual(Object.keys(decode(multi).layers),['boundaries','buildings','pois']);
assert.ok(mvtLayerBytes(multi,'buildings'));
assert.equal(mvtLayerBytes(multi,'landuse'),null);
const footprintTile=decode(filterMvtLayer(multi,'buildings',new Set([0,1])));
assert.deepEqual(kinds(footprintTile),['building','building']);
assert.equal(footprintTile.layers.boundaries.length,1);
const addressTile=decode(filterMvtLayer(multi,'buildings',new Set([2])));
assert.deepEqual(kinds(addressTile),['address']);
assert.equal(addressTile.layers.boundaries.length,1);
// only=true drops the layers the buildings source never draws.
const onlyBuildings=decode(filterMvtLayer(multi,'buildings',new Set([0,1]),true));
assert.deepEqual(kinds(onlyBuildings),['building','building']);
assert.equal(onlyBuildings.layers.boundaries,undefined);
// A spec-valid tile without IDs must still split by ordinal.
const noIds=mvtTile(mvtLayer('buildings',[mvtFeature({kind:0,x:1}),mvtFeature({kind:1,x:2})]));
assert.equal(decode(noIds).layers.buildings.feature(1).id,undefined);
assert.deepEqual(kinds(decode(filterMvtLayer(noIds,'buildings',new Set([1])))),['address']);
// An empty keep set removes the layer but leaves every other layer intact.
const noFeatures=decode(filterMvtLayer(multi,'buildings',new Set()));
assert.equal(noFeatures.layers.buildings,undefined);
assert.equal(noFeatures.layers.boundaries.length,1);
// Layers no style layer draws are dropped before the tile leaves the server.
const worldKept=decode(keepMvtLayers(multi,WORLD_TILE_LAYERS));
assert.deepEqual(Object.keys(worldKept.layers),['boundaries','buildings']);
assert.equal(worldKept.layers.pois,undefined);
assert.equal(keepMvtLayers(mvtTile(mvtLayer('pois',[mvtFeature({id:1,kind:0})])),WORLD_TILE_LAYERS),null);
// The keep set must cover every world source-layer either style draws.
for(const file of ['dark','light']){
 const style=JSON.parse(fs.readFileSync(`src/map/flightline/styles/${file}.json`,'utf8'));
 const used=new Set(style.layers.filter(l=>l.source==='world'&&l['source-layer']).map(l=>l['source-layer']));
 assert.deepEqual([...used].sort(),[...WORLD_TILE_LAYERS].sort(),`${file}: world keep-set is stale`);
}
console.log('PASS world tile keep-set matches both styles and drops unused layers');
// Real fixture: filtering the road layer keeps it valid and other layers whole.
const roadLayer=parent.layers.roads;
if(roadLayer&&roadLayer.length){
 const onlyFirst=decode(filterMvtLayer(raw,'roads',new Set([0])));
 assert.ok(onlyFirst.layers.roads.length>=1);
 assert.equal(onlyFirst.layers.roads.feature(0).id,roadLayer.feature(0).id);
 assert.equal(onlyFirst.layers.water?.length,parent.layers.water?.length);
 assert.deepEqual(Object.keys(onlyFirst.layers).sort(),Object.keys(parent.layers).sort());
}
console.log('PASS building/address split is ordinal-based and preserves other layers');
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
 // The real static glue must split by layer name, not by the tile's first layer.
 const {filterBuildingLayer}=await vite.ssrLoadModule('/src/map/flightline/staticTiles.ts');
 const gluedFootprints=decode(filterBuildingLayer(multi,false));
 assert.deepEqual(kinds(gluedFootprints),['building','building']);
 assert.equal(gluedFootprints.layers.boundaries,undefined);
 assert.equal(gluedFootprints.layers.pois,undefined);
 const gluedAddresses=decode(filterBuildingLayer(multi,true));
 assert.deepEqual(kinds(gluedAddresses),['address']);
 assert.equal(gluedAddresses.layers.boundaries.length,1);
 assert.equal(gluedAddresses.layers.pois,undefined);
 const allFootprints=mvtTile(mvtLayer('buildings',[mvtFeature({kind:0,x:1})]));
 assert.deepEqual(Object.keys(decode(filterBuildingLayer(allFootprints,false)).layers),['buildings']);
 const noBuildings=mvtTile(mvtLayer('boundaries',[mvtFeature({id:1,kind:2})]));
 assert.deepEqual(Object.keys(decode(filterBuildingLayer(noBuildings,true)).layers),['boundaries']);
 console.log('PASS static tile split keeps the layer its source draws');
 // Execute the actual controller method without constructing a DOM/WebGL MapLibre instance.
 const source=fs.readFileSync('src/map/MapController.ts','utf8');
 const start=source.indexOf('  onReady(cb: () => void): void {');
 assert.ok(start>=0,'Controller readiness method must be present');
 const method=source.slice(start,source.indexOf('\n  }',start)+4).replace('onReady(cb: () => void): void {','onReady(cb) {');
 const Harness=vm.runInNewContext(`class ReadinessHarness { ${method} }; ReadinessHarness;`,{console});
 const controller=new Harness();
 let fired = 0, subscribed = '';
 controller.map = {isStyleLoaded:()=>false, once:(event,cb)=>{subscribed=event;cb();}};
 controller.onReady(()=>fired++);
 assert.equal(subscribed,'style.load');assert.equal(fired,1);
 controller.styleReady=true;controller.map.once=()=>assert.fail('Already parsed style must be ready even with pending tiles');
 controller.onReady(()=>fired++);assert.equal(fired,2);
 console.log('PASS business readiness does not wait for all remote tiles');
}finally{await vite.close();}
