// meruntime ui: abre la interfaz de escritorio (servidor local + ventana de aplicación del navegador).

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { startUiServer } from "../../ui/src/server.js";

function findOnPath(names: string[]): string | undefined {
    for (const dir of (process.env.PATH ?? "").split(delimiter)) {
        for (const name of names) {
            const candidate = join(dir, name);
            if (existsSync(candidate)) return candidate;
        }
    }
    return undefined;
}

function appBrowser(): string | undefined {
    if (process.platform === "win32") {
        const roots = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter((r): r is string => Boolean(r));
        const relative = ["Microsoft\\Edge\\Application\\msedge.exe", "Google\\Chrome\\Application\\chrome.exe"];
        return roots.flatMap((root) => relative.map((rel) => join(root, rel))).find(existsSync);
    }
    if (process.platform === "darwin") {
        return [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ].find(existsSync);
    }
    return findOnPath(["google-chrome", "chromium", "chromium-browser", "microsoft-edge"]);
}

function launch(command: string, args: string[]): void {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => undefined);
    child.unref();
}

/** Ventana sin barra de navegador si hay Edge/Chrome; si no, el navegador por defecto. */
function openWindow(url: string): void {
    const browser = appBrowser();
    if (browser) return launch(browser, [`--app=${url}`, "--window-size=1040,820"]);
    if (process.platform === "win32") return launch("cmd", ["/c", "start", "", url]);
    launch(process.platform === "darwin" ? "open" : "xdg-open", [url]);
}

/** Devuelve un código de salida solo si no arranca; si arranca, el servidor mantiene vivo el proceso. */
export async function runUi(args: string[]): Promise<number | undefined> {
    const noOpen = args.includes("--no-open");
    const portIndex = args.indexOf("--port");
    const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 0;
    const unknown = args.some((a, i) => a !== "--no-open" && a !== "--port" && i !== portIndex + 1);
    if (!Number.isInteger(port) || port < 0 || port > 65535 || unknown) {
        console.error("Usage: meruntime ui [--no-open] [--port N]");
        return 1;
    }

    const server = await startUiServer({ port });
    // El token va en el fragmento (#t=...): no se envía al servidor ni queda en logs.
    const fullUrl = `${server.url}#t=${server.token}`;
    console.log(`Me Runtime UI running at ${server.url} (Ctrl+C to stop)`);
    if (noOpen) {
        console.log(`Open this URL in a browser: ${fullUrl}`);
    } else {
        openWindow(fullUrl);
        console.log("Opening the window... if nothing appears, run again with --no-open.");
    }
    return undefined;
}
