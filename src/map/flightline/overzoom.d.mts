export function overzoomMvt(data: Uint8Array, scale: number, x: number, y: number): Uint8Array;
export function layerName(data: Uint8Array): string;
export function mvtLayerBytes(data: Uint8Array, layer: string): Uint8Array | null;
export function filterMvtLayer(data: Uint8Array, layer: string, keep: Set<number>, only?: boolean): Uint8Array;
export function keepMvtLayers(data: Uint8Array, keep: Set<string>): Uint8Array | null;
