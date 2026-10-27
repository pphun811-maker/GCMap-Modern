// Vite dev / preview 同源地图资源中间件的类型声明（实现见 mapResources.mjs）。
import type { IncomingMessage, ServerResponse } from 'node:http';

export function createMapResourceMiddleware(
  base?: string,
): (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
