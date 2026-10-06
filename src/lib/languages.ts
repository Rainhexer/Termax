/** What a project is written in, from the extension mix the backend measured.
 *
 *  The home screen's job is to tell two dozen checkouts apart at a glance, and
 *  the fastest signal for that is what language they are in — a Rust service
 *  and a Svelte app should not look identical from across the room.
 *
 *  Colours are GitHub Linguist's, which is the palette a developer has already
 *  learned to read; they are literal hex rather than theme tokens on purpose,
 *  because they identify the *language*, not the app's chrome. Monograms are
 *  two or three characters because a card has room for a chip, not a wordmark.
 */

import type { ExtBytes } from "./types";

export interface Language {
  name: string;
  /** 2–3 characters. Sized to a 22px chip. */
  mono: string;
  /** Linguist hex, with the '#'. */
  color: string;
}

/** Extension → language. Being absent from this table is meaningful: it is how
 *  data, prose and assets (json, md, lock, png, …) stay out of the mix, so a
 *  project full of fixtures still reads as the language it is written in. */
const BY_EXT: Record<string, Language> = {
  rs: { name: "Rust", mono: "RS", color: "#dea584" },
  ts: { name: "TypeScript", mono: "TS", color: "#3178c6" },
  tsx: { name: "TypeScript", mono: "TS", color: "#3178c6" },
  mts: { name: "TypeScript", mono: "TS", color: "#3178c6" },
  cts: { name: "TypeScript", mono: "TS", color: "#3178c6" },
  js: { name: "JavaScript", mono: "JS", color: "#f1e05a" },
  jsx: { name: "JavaScript", mono: "JS", color: "#f1e05a" },
  mjs: { name: "JavaScript", mono: "JS", color: "#f1e05a" },
  cjs: { name: "JavaScript", mono: "JS", color: "#f1e05a" },
  svelte: { name: "Svelte", mono: "SV", color: "#ff3e00" },
  vue: { name: "Vue", mono: "VU", color: "#41b883" },
  py: { name: "Python", mono: "PY", color: "#3572a5" },
  pyi: { name: "Python", mono: "PY", color: "#3572a5" },
  go: { name: "Go", mono: "GO", color: "#00add8" },
  rb: { name: "Ruby", mono: "RB", color: "#701516" },
  java: { name: "Java", mono: "JA", color: "#b07219" },
  kt: { name: "Kotlin", mono: "KT", color: "#a97bff" },
  kts: { name: "Kotlin", mono: "KT", color: "#a97bff" },
  swift: { name: "Swift", mono: "SW", color: "#f05138" },
  c: { name: "C", mono: "C", color: "#555555" },
  h: { name: "C", mono: "C", color: "#555555" },
  cpp: { name: "C++", mono: "C++", color: "#f34b7d" },
  cc: { name: "C++", mono: "C++", color: "#f34b7d" },
  cxx: { name: "C++", mono: "C++", color: "#f34b7d" },
  hpp: { name: "C++", mono: "C++", color: "#f34b7d" },
  cs: { name: "C#", mono: "C#", color: "#178600" },
  php: { name: "PHP", mono: "PHP", color: "#4f5d95" },
  sh: { name: "Shell", mono: "SH", color: "#89e051" },
  bash: { name: "Shell", mono: "SH", color: "#89e051" },
  zsh: { name: "Shell", mono: "SH", color: "#89e051" },
  fish: { name: "fish", mono: "FI", color: "#4aae47" },
  ps1: { name: "PowerShell", mono: "PS", color: "#012456" },
  lua: { name: "Lua", mono: "LU", color: "#000080" },
  nix: { name: "Nix", mono: "NX", color: "#7e7eff" },
  zig: { name: "Zig", mono: "ZG", color: "#ec915c" },
  dart: { name: "Dart", mono: "DA", color: "#00b4ab" },
  ex: { name: "Elixir", mono: "EX", color: "#6e4a7e" },
  exs: { name: "Elixir", mono: "EX", color: "#6e4a7e" },
  erl: { name: "Erlang", mono: "ER", color: "#b83998" },
  hs: { name: "Haskell", mono: "HS", color: "#5e5086" },
  ml: { name: "OCaml", mono: "ML", color: "#ef7a08" },
  scala: { name: "Scala", mono: "SC", color: "#c22d40" },
  clj: { name: "Clojure", mono: "CL", color: "#db5855" },
  r: { name: "R", mono: "R", color: "#198ce7" },
  jl: { name: "Julia", mono: "JL", color: "#a270ba" },
  pl: { name: "Perl", mono: "PL", color: "#0298c3" },
  sql: { name: "SQL", mono: "SQL", color: "#e38c00" },
  html: { name: "HTML", mono: "HT", color: "#e34c26" },
  css: { name: "CSS", mono: "CS", color: "#663399" },
  scss: { name: "SCSS", mono: "SA", color: "#c6538c" },
  vim: { name: "Vim Script", mono: "VI", color: "#199f4b" },
  tf: { name: "HCL", mono: "TF", color: "#844fba" },
  proto: { name: "Protobuf", mono: "PB", color: "#3f51b5" },
};

export interface LanguageShare extends Language {
  /** 0–1 of the *recognized* bytes, so the shares of one project sum to 1. */
  share: number;
}

/** The languages a project is actually made of, biggest first.
 *
 *  Extensions of the same language are summed before ranking (`.ts` and `.tsx`
 *  are one answer, not two), and shares are taken over recognized bytes only —
 *  a repository that is 90% JSON fixtures is still a Rust project. */
export function topLanguages(extensions: ExtBytes[], limit = 3): LanguageShare[] {
  const totals = new Map<string, { lang: Language; bytes: number }>();
  let known = 0;
  for (const { ext, bytes } of extensions) {
    const lang = BY_EXT[ext];
    if (!lang || bytes <= 0) continue;
    known += bytes;
    const entry = totals.get(lang.name);
    if (entry) entry.bytes += bytes;
    else totals.set(lang.name, { lang, bytes });
  }
  if (!known) return [];
  return [...totals.values()]
    .sort((a, b) => b.bytes - a.bytes || a.lang.name.localeCompare(b.lang.name))
    .slice(0, limit)
    .map(({ lang, bytes }) => ({ ...lang, share: bytes / known }));
}

/** "62%" — and "<1%" rather than "0%", which would read as "none of it". */
export function sharePercent(share: number): string {
  const percent = share * 100;
  if (percent > 0 && percent < 1) return "<1%";
  return `${Math.round(percent)}%`;
}
