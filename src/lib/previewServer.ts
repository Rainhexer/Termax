// Access to the backend's loopback preview server (src-tauri/src/preview.rs).
//
// The HTML/SVG preview is an iframe pointed at http://127.0.0.1:<port>/<token>/…
// rather than a `srcdoc`, which is what makes a previewed page behave like the
// same file opened in a browser: relative assets, module scripts, fetch, links,
// audio and video all resolve against a real origin.

import { ipc } from "./ipc";

export interface PreviewServerInfo {
  port: number;
  /** Random per-server secret; the first path segment of every preview URL. */
  token: string;
  /** Canonicalized root being served, as the backend keys it. */
  root: string;
}

/** One in-flight/settled promise per root: starting the server is idempotent
 *  backend-side, but a pane opening is no reason to make the round trip again. */
const servers = new Map<string, Promise<PreviewServerInfo>>();

export function previewServer(root: string | null): Promise<PreviewServerInfo> {
  const key = root ?? "";
  let pending = servers.get(key);
  if (!pending) {
    pending = ipc.previewServer(root ?? undefined).catch((err) => {
      // Don't cache a failure: the session may simply not have come up yet.
      servers.delete(key);
      throw err;
    });
    servers.set(key, pending);
  }
  return pending;
}

/** Forget every cached server. The backend drops them when a project closes,
 *  so a stale port here would point at nothing. */
export function clearPreviewServers() {
  servers.clear();
}

/** URL serving the project-relative `path` off `server`. */
export function previewUrl(server: PreviewServerInfo, path: string): string {
  const segments = path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return `http://127.0.0.1:${server.port}/${server.token}/${segments}`;
}

/** URL of the directory containing `path`, with a trailing slash — the base
 *  that relative references inside that file resolve against. */
export function previewBaseUrl(server: PreviewServerInfo, path: string): string {
  const url = previewUrl(server, path);
  return url.slice(0, url.lastIndexOf("/") + 1);
}
