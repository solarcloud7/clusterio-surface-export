import { posix } from "node:path";

const stores = ["data", "mods", "logs", "tokens", "static"].map(name => `/clusterio/${name}`);
export function preservesInstalledCode(mount) {
  const path = posix.normalize(mount.destination);
  if (path === "/" || path === "/clusterio") return false;
  if (!path.startsWith("/clusterio/")) return true;
  return stores.includes(path) && mount.type === "volume";
}
