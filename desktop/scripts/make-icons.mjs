// Renders desktop/assets/icon.svg into desktop/build/icon.png (1024x1024).
// electron-builder turns that PNG into the multi-size Windows .ico that gets
// embedded in the executable and the installer.
//
// Run from the desktop/ directory:  npm run icons

import { Resvg } from '@resvg/resvg-js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const svgPath = join(here, '..', 'assets', 'icon.svg');
const outPath = join(here, '..', 'build', 'icon.png');

const svg = await readFile(svgPath);
const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: 1024 } });
const png = resvg.render().asPng();

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, png);
console.log(`icon.png written (${png.length} bytes) -> ${outPath}`);
