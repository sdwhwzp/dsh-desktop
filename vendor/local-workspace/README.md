# Local workspace companion source

Source: [sdwhwzp/dsh-passwords](https://github.com/sdwhwzp/dsh-passwords), commit `117fdc6` (runtime files last changed at or before `060fd94`). The original repository's `LICENSE` contains GPL version 3; that text is preserved in `COPYING`. The package manifest's different license label is not used to relabel these files.

The two TypeScript files are pinned source copies. The only changes to `local-workspace-cli.ts` remove automatic CLI startup and export `executeOperation`. `local-workspace-protocol.ts` is unchanged. Synchronize from that repository, reapply these two edits, and run the desktop remote tests and build before updating the pin.

`src/main/remote/filesystem-worker.ts` is the GPL companion entry. The worker is a separate Electron utility process; the desktop sends one relative-path file operation and receives a JSON result over process messaging. The remote client permits only read, write, edit, glob and grep. It does not authorize shell or Office commands. The process is stopped on cancellation and after a 30-second deadline.

Build: `npm ci && npm run build:remote` at the desktop repository root, with Node 22.21.1 or later. Electron Vite bundles the worker into `out/main/filesystem-worker.js`. Remote packages include this source directory, the worker entry, the build configuration and GPL text under `local-workspace-source`. The complete build source is available from the owned desktop fork's `dev` branch.
