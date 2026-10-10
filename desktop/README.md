# GCMap Modern — Desktop

An Electron shell that wraps the production web build into a Windows desktop
application. It is a thin wrapper: everything you see is the same app deployed
at <https://pphun811-maker.github.io/GCMap-Modern/>.

## What the shell does

- Builds the web app (project root) into `desktop/dist` and serves it over a
  loopback HTTP server on a random ephemeral port; the app window loads that
  address. Nothing is exposed to the network.
- Opens external links (SimBrief dispatch, map attribution links) in your
  system browser; the app window never navigates away from the local server.
- Remembers window size and position between launches.
- `F11` toggles full screen, `F12` opens devtools.

## Build (Windows)

Prerequisites: install the web app dependencies in the project root first.

```bash
cd ..
npm install
```

Then, from this directory:

```bash
npm install     # installs Electron and electron-builder
                # (set ELECTRON_MIRROR to use a download mirror if needed)
npm run dist    # builds the web bundle, then packs the NSIS installer
```

The installer is written to `release/GCMap-Modern-Setup-<version>.exe`. It is a
per-user install (no admin rights required) with Start-menu and desktop
shortcuts.

## Stadia satellite key

The web build picks up `VITE_STADIA_KEY` from the project root's `.env.local`
(never committed — see the main README). With a key, the desktop app uses
Stadia satellite imagery and the in-browser ocean tint; without one it falls
back to key-free Esri World Imagery. A fresh checkout builds and runs without
any key.

## Self-check

```bash
npm run smoke
```

Loads a two-airport route in an off-screen window and prints `SMOKE-OK` or
`SMOKE-FAIL` before exiting on its own. Used for automated verification.
