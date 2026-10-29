// Desenvolvimento: sobe o Vite (hot reload) e abre o Electron apontando para ele.
import { spawn } from "node:child_process";
import { createServer } from "vite";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const server = await createServer();
await server.listen();
const url = server.resolvedUrls.local[0];
console.log("Vite em", url);

const electron = require("electron"); // caminho do executavel
const child = spawn(electron, ["."], { stdio: "inherit", env: { ...process.env, WINSABER_DEV_URL: url } });
child.on("exit", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
