# Continue (Custom) fork

A personal fork of the [Continue](https://github.com/continuedev/continue) VS Code
extension, based on the final upstream release (v1.3.40). It lives at
[github.com/Tommy270502/continue](https://github.com/Tommy270502/continue); the
customizations live on the `personal-fork-customizations` branch.

The extension is published as `tommy270502.continue-custom` (display name
"Continue (Custom)"). The ID is defined once in
`extensions/vscode/src/util/extensionId.ts`. If you change `publisher` or `name`
in `extensions/vscode/package.json`, update that file too, along with the
hard-coded copy in `core/autocomplete/templating/validation.ts`.

## It replaces the Marketplace Continue

Command IDs, view IDs and settings keys still use the upstream `continue.*`
namespace, so your existing settings and keybindings keep working. Because of
that, this build **cannot run next to** the Marketplace `Continue.continue`
extension: they would register the same commands and views. Uninstall or
disable the Marketplace version before installing this one.

Because the extension ID is different, VS Code's per-extension storage starts
empty. That covers `globalState` and secrets stored through `SecretStorage`, so
you may need to dismiss onboarding again or re-enter API keys you saved through
the UI. Anything kept under `~/.continue` carries over unchanged.

## One-time setup

From the repo root, using the Node version in `.nvmrc`:

```bash
./scripts/install-dependencies.sh
```

This installs dependencies for the root, `core`, `gui`, `extensions/vscode`,
`binary` and `docs`, builds the shared packages and the GUI, and packages the
extension once. You can also run it from VS Code with the task
`install-all-dependencies`.

## Dev loop

1. Open the repo root in VS Code.
2. Run the **Launch extension** debug configuration (Run and Debug, then F5).
   Its pre-launch task `vscode-extension:build-with-packages` builds
   `packages/*`, runs `prepackage.js`, and then starts these watchers:
   - `vscode-extension:esbuild` (`npm run esbuild-watch`), which rebuilds
     `extensions/vscode/out/extension.js`
   - `gui:dev` (the Vite dev server on `localhost:5173`). In development the
     webview loads the GUI from this server, so GUI edits hot-reload.
   - `tsc:watch` (root `npm run tsc:watch`), which typechecks gui, vscode, core
     and binary
3. An Extension Development Host opens on `manual-testing-sandbox/`. After you
   change extension-side code, reload that window (Developer: Reload Window).

The debug host sets `CONTINUE_GLOBAL_DIR=extensions/.continue-debug`, so while
debugging it reads config from `extensions/.continue-debug/config.yaml`, **not**
`~/.continue`.

Typecheck once without the watchers:

```bash
cd extensions/vscode && npx tsc --noEmit -p .
```

## Build and install a .vsix

```bash
scripts/build-vsix.sh             # build the GUI, then package; prints the .vsix path
scripts/build-vsix.sh --install   # ...and run: code --install-extension <vsix> --force
```

The output goes to `extensions/vscode/build/continue-custom-<version>.vsix`. By
default the script sets `SKIP_INSTALLS=true` so `prepackage` skips `npm install`.
Pass `--with-installs` to run the installs anyway, or `--skip-gui` to reuse the
existing `gui/dist`. Reload VS Code windows after installing.

## Configuration

The installed extension reads its config from `~/.continue/config.yaml`.
`CONTINUE_GLOBAL_DIR` overrides that location. Models, rules, prompts and so on
are set there. Sessions, logs and the index are also stored under `~/.continue/`.
