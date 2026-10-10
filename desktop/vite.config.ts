// Builds the web app (project root) into desktop/dist, which is what the
// Electron shell serves. Kept separate from the root config so the two builds
// stay independent: `vite build` here always targets the desktop bundle.
//
// The environment for VITE_STADIA_KEY is the project root's .env.local, so a
// local build picks up the key while a fresh checkout (no .env.local) falls
// back to key-free Esri imagery — exactly like the web deployment.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const outDir = fileURLToPath(new URL('./dist', import.meta.url));

export default defineConfig({
  root: projectRoot,
  plugins: [react()],
  build: {
    outDir,
    emptyOutDir: true,
  },
});
