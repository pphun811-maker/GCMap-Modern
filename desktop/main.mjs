// GCMap Modern — desktop shell.
//
// Serves the production web build (desktop/dist) from an HTTP server bound to
// 127.0.0.1 on an ephemeral port, then opens a single application window at
// that address. External links (SimBrief dispatch, map attribution, etc.)
// open in the system browser instead of inside the app.
//
// `electron . --smoke` (or GCMAP_SMOKE=1) runs an invisible self-check:
// the window is placed off-screen, kept out of the taskbar, the page loads a
// two-airport route, and DOM state is polled until the map and route pins are
// up (or a timeout). Exits 0 with "SMOKE-OK" on success, 1 on failure.

import { app, BrowserWindow, Menu, shell } from 'electron';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, extname, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SMOKE = process.env.GCMAP_SMOKE === '1' || process.argv.includes('--smoke');
const DEBUG = process.env.GCMAP_DEBUG === '1';

const APP_ID = 'io.github.pphun811-maker.gcmap-modern';

// Chromium's process sandboxes do not work reliably on this machine (the GPU
// process crashes on startup and the renderer can stall during window
// creation). With sandboxing disabled both run cleanly. The app only ever
// renders its own bundled content — remote map tiles and the SimBrief API —
// and sends every external link to the system browser, so the reduced
// isolation costs very little here. Must be set before app is ready.
app.commandLine.appendSwitch('no-sandbox');

// Synchronous console writer: the smoke-check report must survive an
// immediate app.exit(), which drops buffered async stdout writes.
function report(line) {
  try {
    writeFileSync(1, `${line}\n`);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Static file server (loopback only)
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function startStaticServer(root) {
  const rootResolved = resolve(root);
  // Synchronous reads on purpose: all files served here are small, local and
  // read once per request, and synchronous fs avoids the async I/O pool which
  // has proven unreliable in this runtime.
  const server = createServer({ keepAlive: true }, (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const filePath = normalize(join(rootResolved, pathname));
    if (SMOKE) report(`REQ ${req.url} file=${filePath}`);
    try {
      if (!filePath.startsWith(rootResolved)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }
      const body = readFileSync(filePath);
      res.writeHead(200, {
        'Content-Type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(body);
      if (SMOKE) report(`RESP ${req.url} ${body.length}B`);
    } catch (error) {
      if (SMOKE) report(`REQ-ERR ${req.url} ${String(error)}`);
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  });
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolvePromise({ server, port: server.address().port });
    });
  });
}

// ---------------------------------------------------------------------------
// Window state (size/position persistence)
// ---------------------------------------------------------------------------

const statePath = () => join(app.getPath('userData'), 'window-state.json');

function loadBounds(fallback) {
  try {
    const raw = JSON.parse(readFileSync(statePath(), 'utf8'));
    if (
      Number.isFinite(raw?.width) && raw.width >= 960 &&
      Number.isFinite(raw?.height) && raw.height >= 600 &&
      Number.isFinite(raw?.x) && Number.isFinite(raw?.y)
    ) {
      return raw;
    }
  } catch {
    /* first run — use the fallback */
  }
  return fallback;
}

function saveBounds(win) {
  try {
    if (!win.isMinimized() && !win.isFullScreen()) {
      writeFileSync(statePath(), JSON.stringify(win.getBounds()));
    }
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// Smoke test
// ---------------------------------------------------------------------------

let smokeTileHits = 0;

function watchTiles(session) {
  session.webRequest.onCompleted(
    {
      urls: [
        'https://tiles-eu.stadiamaps.com/*',
        'https://server.arcgisonline.com/*',
        'https://tiles.openfreemap.org/*',
      ],
    },
    (details) => {
      if (details.statusCode >= 200 && details.statusCode < 300) smokeTileHits += 1;
    },
  );
}

function setupSmokeDiagnostics(win) {
  app.on('child-process-gone', (_event, details) => {
    report(`CHILD-GONE ${details.type} reason=${details.reason} exit=${details.exitCode}`);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    report(`RENDER-GONE reason=${details.reason} exit=${details.exitCode}`);
  });
  win.webContents.on('unresponsive', () => report('UNRESPONSIVE'));
  win.webContents.on('did-fail-load', (_event, code, desc, url) => {
    report(`DID-FAIL-LOAD ${code} ${desc} ${url}`);
  });
  win.webContents.on('console-message', (...args) => {
    try {
      const msg = args
        .map((a) => (a && typeof a === 'object' && 'message' in a ? a.message : String(a)))
        .join(' ');
      report(`CONSOLE ${msg.slice(0, 400)}`);
    } catch {
      /* ignore */
    }
  });
}

async function runSmoke(win) {
  const deadline = Date.now() + 40_000;
  let last = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    let probe;
    try {
      probe = await Promise.race([
        win.webContents.executeJavaScript(`(() => ({
          href: location.href,
          ready: document.readyState,
          title: document.title,
          bodyLen: document.body ? document.body.innerHTML.length : -1,
          err: !!document.querySelector('#err-hook') || !!document.querySelector('#err-hook-promise'),
          canvas: !!document.querySelector('.maplibregl-canvas'),
          pins: document.querySelectorAll('.ap-pin').length,
          brand: !!document.querySelector('.brand-name'),
          dark: document.documentElement.classList.contains('dark')
        }))()`),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('eval-timeout')), 5000)),
      ]);
      probe.tiles = smokeTileHits;
      last = probe;
    } catch (error) {
      last = { evalError: String(error), tiles: smokeTileHits };
      report(`POLL-ERR ${String(error)} tiles=${smokeTileHits}`);
      continue;
    }
    report(`POLL ${JSON.stringify({ ready: last.ready, canvas: last.canvas, pins: last.pins, brand: last.brand, tiles: last.tiles })}`);
    if (last.err) break;
    if (last.canvas && last.pins >= 2 && last.brand && last.tiles >= 1) break;
  }
  const ok = Boolean(
    last && !last.err && !last.evalError &&
    last.canvas && last.pins >= 2 && last.brand && last.tiles >= 1,
  );
  report(`${ok ? 'SMOKE-OK' : 'SMOKE-FAIL'} ${JSON.stringify(last)}`);
  app.exit(ok ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId(APP_ID);

  let mainWindow = null;

  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  // Safety net: if a child process stalls the shutdown sequence, terminate
  // hard after a grace period instead of leaving a zombie process behind.
  app.on('before-quit', () => {
    setTimeout(() => {
      process.kill(process.pid, 'SIGKILL');
    }, 5000).unref();
  });

  app.whenReady().then(async () => {
    if (!SMOKE && !DEBUG) Menu.setApplicationMenu(null);

    const { port } = await startStaticServer(join(__dirname, 'dist'));
    const appUrl = `http://127.0.0.1:${port}`;

    // Off-screen, taskbar-free window for the automated self-check; a normal
    // window for regular use. `backgroundThrottling: false` in smoke mode
    // keeps rendering active so the map reaches its loaded state quickly.
    const windowOptions = SMOKE
      ? { x: -32000, y: -32000, show: true, skipTaskbar: true }
      : { ...loadBounds({ width: 1440, height: 900 }), show: false };

    mainWindow = new BrowserWindow({
      ...windowOptions,
      width: windowOptions.width ?? 1440,
      height: windowOptions.height ?? 900,
      minWidth: 960,
      minHeight: 600,
      title: 'GCMap Modern',
      backgroundColor: '#101014',
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        ...(SMOKE ? { backgroundThrottling: false } : {}),
      },
    });

    // External links open in the system browser; nothing navigates the app
    // window away from the local server.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url) && !SMOKE) shell.openExternal(url);
      return { action: 'deny' };
    });
    mainWindow.webContents.on('will-navigate', (event, url) => {
      if (url.startsWith(appUrl)) return;
      event.preventDefault();
      if (/^https?:/i.test(url) && !SMOKE) shell.openExternal(url);
    });

    // F11 full screen / F12 devtools (the menu bar is removed in production).
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      if (input.key === 'F11') {
        mainWindow.setFullScreen(!mainWindow.isFullScreen());
        event.preventDefault();
      } else if (input.key === 'F12') {
        mainWindow.webContents.toggleDevTools();
        event.preventDefault();
      }
    });

    mainWindow.once('ready-to-show', () => {
      if (!SMOKE) mainWindow.show();
    });
    mainWindow.on('close', () => {
      if (!SMOKE) saveBounds(mainWindow);
    });

    const startUrl = SMOKE ? `${appUrl}/?route=PVG-NRT` : appUrl;
    if (SMOKE) {
      report('SMOKE-BEGIN');
      const heartbeat = setInterval(() => report(`HB tiles=${smokeTileHits}`), 3000);
      heartbeat.unref?.();
      watchTiles(mainWindow.webContents.session);
      setupSmokeDiagnostics(mainWindow);
      report('LOAD-BEGIN');
      await Promise.race([
        mainWindow.loadURL(startUrl).catch((error) => report(`LOAD-URL-ERR ${String(error)}`)),
        new Promise((r) => setTimeout(r, 15_000)),
      ]);
      report('LOAD-END');
      runSmoke(mainWindow).catch((error) => {
        report(`SMOKE-FAIL ${String(error)}`);
        app.exit(1);
      });
    } else {
      await mainWindow.loadURL(startUrl);
    }
  });
}
