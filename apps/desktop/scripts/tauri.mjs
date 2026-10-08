// Runs the Tauri CLI with an environment that works on every OS.
//
// - Terminals opened before rustup was installed don't have cargo on PATH.
// - On Linux, terminals of VS Code installed as a snap inherit GTK/GIO
//   variables pointing into the snap; WebKitGTK then loads the snap's
//   incompatible libraries and the app dies with
//   "symbol lookup error ... __libc_pthread_init".

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const env = { ...process.env };
const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";

const hasCargo = spawnSync("cargo", ["--version"], { env, stdio: "ignore" }).status === 0;
const cargoBin = join(env.CARGO_HOME ?? join(homedir(), ".cargo"), "bin");
if (!hasCargo && existsSync(cargoBin)) {
  env[pathKey] = `${cargoBin}${delimiter}${env[pathKey] ?? ""}`;
}

if (process.platform === "linux" && env.SNAP) {
  for (const name of [
    "GTK_PATH",
    "GTK_EXE_PREFIX",
    "GTK_IM_MODULE_FILE",
    "GIO_MODULE_DIR",
    "GDK_PIXBUF_MODULE_FILE",
    "GDK_PIXBUF_MODULEDIR",
    "GDK_BACKEND",
    "LOCPATH",
    "GSETTINGS_SCHEMA_DIR",
    "SNAP",
  ]) {
    delete env[name];
  }
  if (env.XDG_DATA_DIRS_VSCODE_SNAP_ORIG) env.XDG_DATA_DIRS = env.XDG_DATA_DIRS_VSCODE_SNAP_ORIG;
  if (env.XDG_CONFIG_DIRS_VSCODE_SNAP_ORIG) env.XDG_CONFIG_DIRS = env.XDG_CONFIG_DIRS_VSCODE_SNAP_ORIG;
}

const cli = createRequire(import.meta.url).resolve("@tauri-apps/cli/tauri.js");
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
