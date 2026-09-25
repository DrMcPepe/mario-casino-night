import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const config = {
  rootDir,
  publicDir: path.join(rootDir, "public"),
  dataDir: path.join(rootDir, "data"),
  stateFile: path.join(rootDir, "data", "event-state.json"),
  port: Number(process.env.PORT || 5000),
  adminPin: String(process.env.ADMIN_PIN || "2468"),
  publicUrl: String(process.env.PUBLIC_URL || "").replace(/\/$/, ""),
  checkpoint: String(process.env.STATE_CHECKPOINT || "true").toLowerCase() !== "false"
};

export function localUrls(port = config.port) {
  const urls = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const address of interfaces || []) {
      if (address.family !== "IPv4" || address.internal) continue;
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address.address)) {
        urls.push(`http://${address.address}:${port}`);
      }
    }
  }
  return [...new Set(urls)];
}

export function advertisedUrl() {
  return config.publicUrl || localUrls()[0] || `http://localhost:${config.port}`;
}
