// GCMap Modern — desktop shell.
//
// Serves the production web build (desktop/dist) from an HTTP server bound to
// 127.0.0.1 on a preferred fixed port (falling back to an ephemeral one only
// if the preferred ports are taken), then opens a single application window
// at that address. External links (SimBrief dispatch, map attribution, etc.)
// open in the system browser instead of inside the app.
//
// `electron . --smoke` (or GCMAP_SMOKE=1) runs an invisible self-check:
// the window is placed off-screen, kept out of the taskbar, the page loads a
// two-airport route, and DOM state is polled until the map and route pins are
// up (or a timeout). Exits 0 with "SMOKE-OK" on success, 1 on failure.

import { app, BrowserWindow, Menu, net, protocol, screen, shell } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

// 2026-10-15: after a Windows/driver change the GPU process now crash-loops on
// this machine (exit_code=0xC0000005, "GPU process isn't usable"), and modern
// Chromium no longer falls back to SwiftShader WebGL on its own — maplibre's
// WebGL2 context request then deadlocks the renderer main thread and the whole
// window freezes (looks like "satellite basemap never loads"). Rendering fully
// on the CPU (SwiftShader) sidesteps the broken GPU process entirely; WebGL2
// stays available via the unsafe-swiftshader opt-in. Slightly slower panning,
// but a working map. Remove both switches once the GPU driver situation is
// fixed on this machine.
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');

// Synchronous console writer: the smoke-check report must survive an
// immediate app.exit(), which drops buffered async stdout writes.
function report(line) {
  try {
    writeFileSync(1, `${line}\n`);
  } catch {
    /* ignore */
  }
}

// Startup diagnostics: every significant step is appended to main.log inside
// the user-data directory, together with child-process and renderer health
// events, plus a short heartbeat over the first minute. If a window ever
// freezes, this file shows exactly how far startup got.
const logPath = () => join(app.getPath('userData'), 'main.log');

function log(msg) {
  if (SMOKE) {
    report(msg);
    return;
  }
  try {
    writeFileSync(logPath(), `[${new Date().toISOString()}] ${msg}\n`, { flag: 'a' });
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// Content location: the custom `app://` scheme.
// The previous design served dist over a loopback HTTP server, but the user's
// proxy client started refusing loopback requests (502) around 2026-10-13 and
// Chromium does not honour the Windows-style `127.*` proxy-bypass wildcard, so
// every renderer request for http://127.0.0.1:39187 was hijacked to the proxy
// and the window froze. `app://` is handled in-process (protocol.handle) and
// never touches the network stack — no proxy, no port, no CORS exposure beyond
// what the map tiles already need. A standard+secure scheme keeps ES modules
// and fetch working (plain file:// would block module loading), and the origin
// `app://gcmap` is stable across launches, so localStorage (SimBrief username
// etc.) survives restarts without depending on a port number at all.
// ---------------------------------------------------------------------------

const DIST_ROOT = resolve(join(__dirname, 'dist'));

// Must run before app ready.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

function appPageUrl() {
  return SMOKE ? 'app://gcmap/index.html?route=PVG-NRT' : 'app://gcmap/index.html';
}

function registerAppProtocol() {
  protocol.handle('app', (request) => {
    const u = new URL(request.url);
    let pathname = decodeURIComponent(u.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const filePath = resolve(join(DIST_ROOT, pathname));
    // Path traversal defense: must be a real subpath of dist/ (2026-10-11 review).
    const rel = relative(DIST_ROOT, filePath);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return new Response('Forbidden', { status: 403 });
    }
    if (SMOKE) report(`APP-REQ ${pathname}`);
    // net.fetch over a file URL reads through Electron's asar support and
    // sets the MIME type from the extension automatically.
    return net.fetch(pathToFileURL(filePath).toString());
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
      // 恢复前校验窗口与某台显示器的可视区相交（拔掉外接显示器后 state 会指向屏外）
      try {
        const wa = screen.getDisplayMatching(raw).workArea;
        const intersects =
          raw.x < wa.x + wa.width && raw.x + raw.width > wa.x &&
          raw.y < wa.y + wa.height && raw.y + raw.height > wa.y;
        if (intersects) return raw;
      } catch {
        /* screen 未就绪等异常：按有效处理（调用点在 whenReady 之后，罕见） */
        return raw;
      }
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

function watchRendererHealth(win) {
  win.webContents.on('render-process-gone', (_event, details) => {
    log(`RENDER-GONE reason=${details.reason} exit=${details.exitCode}`);
  });
  win.webContents.on('unresponsive', () => log('RENDERER-UNRESPONSIVE'));
  win.webContents.on('responsive', () => log('RENDERER-RESPONSIVE-AGAIN'));
  win.webContents.on('did-fail-load', (_event, code, desc, url) => {
    log(`DID-FAIL-LOAD ${code} ${desc} ${url}`);
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
          dark: document.documentElement.classList.contains('dark'),
          timeRow: !!document.querySelector('.time-row'),
          timeNote: document.querySelector('.time-note')?.textContent ?? null
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
    report(`POLL ${JSON.stringify({ ready: last.ready, canvas: last.canvas, pins: last.pins, brand: last.brand, timeRow: last.timeRow, tiles: last.tiles })}`);
    if (last.err) break;
    if (last.canvas && last.pins >= 2 && last.brand && last.timeRow && last.tiles >= 1) break;
  }
  const ok = Boolean(
    last && !last.err && !last.evalError &&
    last.canvas && last.pins >= 2 && last.brand && last.timeRow && last.tiles >= 1,
  );
  report(`${ok ? 'SMOKE-OK' : 'SMOKE-FAIL'} ${JSON.stringify(last)}`);
  // SIGKILL, not app.exit/process.exit: on this machine both can hang the
  // shutdown (same family as the close-path stall), leaving a zombie that
  // holds the single-instance lock so the NEXT launch exits silently with no
  // output. All smoke output is written synchronously, so nothing is lost.
  process.kill(process.pid, 'SIGKILL');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  // Hard exit: app.quit() can hang on this machine (see close handler below).
  process.kill(process.pid, 'SIGKILL');
} else {
  app.setAppUserModelId(APP_ID);

  let mainWindow = null;

  app.on('second-instance', () => {
    log('second-instance');
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.on('window-all-closed', () => {
    log('window-all-closed');
    app.quit();
  });

  // Safety net: if a child process stalls the shutdown sequence, terminate
  // hard after a grace period instead of leaving a zombie process behind.
  app.on('before-quit', () => {
    log('before-quit');
    setTimeout(() => {
      process.kill(process.pid, 'SIGKILL');
    }, 5000).unref();
  });

  app.on('child-process-gone', (_event, details) => {
    log(`CHILD-GONE ${details.type} reason=${details.reason} exit=${details.exitCode}`);
  });

  app.whenReady().then(async () => {
    log(`boot: pid=${process.pid} smoke=${SMOKE} debug=${DEBUG}`);
    log('whenReady');

    if (!SMOKE && !DEBUG) Menu.setApplicationMenu(null);
    log('menu configured');

    registerAppProtocol();
    const appUrl = appPageUrl();
    log(`page url=${appUrl.slice(0, 80)}`);

    // Both modes show the window from birth. On this machine a deferred
    // win.show() (the usual show:false + ready-to-show pattern) can stall the
    // main process, so the window is visible right away; the dark
    // backgroundColor prevents a white flash while the page renders.
    const windowOptions = SMOKE
      ? { x: 20, y: 20, width: 500, height: 400, show: true, skipTaskbar: true }
      : { ...loadBounds({ width: 1440, height: 900 }), show: true };

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
    log(`window created show=${Boolean(windowOptions.show)}`);

    watchRendererHealth(mainWindow);

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
      log('ready-to-show');
    });
    mainWindow.on('close', () => {
      log('close');
      if (SMOKE || DEBUG) return;
      saveBounds(mainWindow);
      // Hard exit: on this machine the regular Electron shutdown sequence can
      // stall forever - the main loop stops inside the quit path (confirmed
      // via main.log), leaving zombie processes that hold the single-instance
      // lock. State is saved and there is nothing else to clean up, so exit
      // immediately; Chromium's child processes shut themselves down when the
      // parent process disappears.
      log('hard-exit');
      process.kill(process.pid, 'SIGKILL');
    });

    // appPageUrl() already bakes the smoke query parameter in.
    const startUrl = appUrl;
    if (SMOKE) {
      const heartbeat = setInterval(() => report(`HB tiles=${smokeTileHits}`), 3000);
      heartbeat.unref?.();
      watchTiles(mainWindow.webContents.session);
      log('loadURL begin');
      await Promise.race([
        mainWindow.loadURL(startUrl).catch((error) => log(`LOAD-URL-ERR ${String(error)}`)),
        new Promise((r) => setTimeout(r, 15_000)),
      ]);
      log('loadURL end');
      runSmoke(mainWindow).catch((error) => {
        report(`SMOKE-FAIL ${String(error)}`);
        app.exit(1);
      });
    } else {
      log('loadURL begin');
      await mainWindow.loadURL(startUrl);
      log('loadURL done');
      // Heartbeat for the first minute of a normal session: if the process
      // ever freezes, the log shows how far the main loop got.
      let beats = 0;
      const hb = setInterval(() => {
        log(`tick ${++beats}`);
        if (beats >= 12) {
          clearInterval(hb);
          log('heartbeat finished');
        }
      }, 5000);
    }
  });
}
