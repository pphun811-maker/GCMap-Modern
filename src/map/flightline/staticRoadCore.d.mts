export function createRoadService(options: {
  remote: {getTile(z: number,x: number,y: number): Promise<Uint8Array | null | undefined>};
  densityData: {width:number,height:number,bytes:Uint8Array};
  concurrency?: number;
  nearTileBudget?: number;
}): {handle(req:any,res:any,url:URL):void; propertiesAt(...args:any[]):any; stats(): {cachedTiles:number;densityLoaded:boolean;cachedResponses:number;remote:boolean;localArchive:boolean;remoteConcurrency:number}};
