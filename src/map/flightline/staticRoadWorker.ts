import {createRoadService} from './staticRoadCore.mjs';
import {getStaticTile} from './staticTiles';
import {staticAssetUrl} from './resourceMode';
let ready: Promise<ReturnType<typeof createRoadService>> | null = null;
function service() {
  if (!ready) ready = (async () => {
    const response = await fetch(staticAssetUrl('road-density/bin.gz'));
    if (!response.ok) throw Error(`Road density ${response.status}`);
    const bytes = new Uint8Array(await new Response(response.body!.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    if (bytes.length !== 4096 * 2048) throw Error('Road density size mismatch');
    return createRoadService({densityData:{width:4096,height:2048,bytes},remote:{getTile:async (z,x,y) => {
      try {return (await getStaticTile('world',z,x,y)).data;} catch {return undefined;}
    }}});
  })().catch(error => {ready=null;throw error;});
  return ready;
}
const scope = self as unknown as {onmessage: ((event: MessageEvent) => void) | null; postMessage(message: unknown): void};
scope.onmessage = async event => {
  const {id,url} = event.data;
  try {
    const roads = await service();
    let status = 200;
    roads.handle({headers:{},method:'GET'}, {
      headersSent:false, setHeader() {},
      writeHead(code:number) {status=code;this.headersSent=true;},
      end(body:string) {scope.postMessage({id,status,body});},
    },new URL(url));
  } catch(error) {scope.postMessage({id,status:502,body:JSON.stringify({error:String(error)})});}
};
