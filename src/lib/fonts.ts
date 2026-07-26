import { writable } from "svelte/store";
import { ipc } from "./ipc";
import { GENERIC_FONTS, fontStack } from "./theme";

/** Used when the platform has no font-listing tool (or it fails). */
const FALLBACK_FONTS = [
  "Arial",
  "Cascadia Code",
  "Consolas",
  "Courier New",
  "DejaVu Sans",
  "DejaVu Sans Mono",
  "Fira Code",
  "Georgia",
  "Hack",
  "Helvetica",
  "IBM Plex Mono",
  "IBM Plex Sans",
  "Inter",
  "JetBrains Mono",
  "Menlo",
  "Monaco",
  "Noto Sans",
  "Roboto",
  "Roboto Mono",
  "SF Mono",
  "Segoe UI",
  "Source Code Pro",
  "Ubuntu",
  "Ubuntu Mono",
  "Verdana",
];

/** Installed families, generics first. Empty until `loadFonts` resolves. */
export const systemFonts = writable<string[]>(GENERIC_FONTS);

let started = false;

export async function loadFonts() {
  if (started) return;
  started = true;
  let families: string[] = [];
  try {
    families = await ipc.listFonts();
  } catch (err) {
    console.error("list_fonts failed", err);
  }
  if (families.length === 0) families = FALLBACK_FONTS;
  systemFonts.set([...GENERIC_FONTS, ...families]);
}

// Family name → whether it renders monospaced. Measured once per family by
// comparing narrow and wide glyph runs; families the system can't resolve fall
// back to the default face and read as proportional.
const monoCache = new Map<string, boolean>();
let ctx: CanvasRenderingContext2D | null | undefined;

export function isMonospace(family: string): boolean {
  const cached = monoCache.get(family);
  if (cached !== undefined) return cached;
  if (ctx === undefined) ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return false;
  ctx.font = `16px ${fontStack(family, "sans")}`;
  const narrow = ctx.measureText("iiiiiiiiii").width;
  const wide = ctx.measureText("WWWWWWWWWW").width;
  const mono = Math.abs(narrow - wide) < 0.5;
  monoCache.set(family, mono);
  return mono;
}
