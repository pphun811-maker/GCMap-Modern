let worker: Worker | null = null;
let nextId = 0;
const jobs = new Map<number,{resolve:(value:Response)=>void;reject:(reason:unknown)=>void;cleanup:()=>void}>();
export function fetchStaticRoads(url: string, signal: AbortSignal): Promise<Response> {
  if (signal.aborted) return Promise.reject(signal.reason);
  if (!worker) {
    worker = new Worker(new URL('./staticRoadWorker.ts', import.meta.url), {type:'module'});
    worker.onmessage = event => {
      const {id,status,body} = event.data;
      const job = jobs.get(id);if(!job)return;
      jobs.delete(id);job.cleanup();job.resolve(new Response(body,{status,headers:{'Content-Type':'application/json'}}));
    };
    worker.onerror = error => {
      for (const job of jobs.values()){job.cleanup();job.reject(error);}jobs.clear();worker?.terminate();worker=null;
    };
  }
  const id = ++nextId;
  return new Promise((resolve,reject) => {
    const abort = () => {jobs.delete(id);reject(signal.reason);};
    signal.addEventListener('abort',abort,{once:true});
    jobs.set(id,{resolve,reject,cleanup:()=>signal.removeEventListener('abort',abort)});
    worker!.postMessage({id,url});
  });
}
