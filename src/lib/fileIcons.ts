/** What a tree row looks like: a glyph and the colour it is drawn in.
 *
 *  The explorer's job is to be scannable, and a column of identical grey rows
 *  is not. Two signals do the work, the same way VS Code's icon themes do:
 *  the *glyph* separates kinds of thing (a picture, an archive, a lock file, a
 *  script), and the *colour* separates languages inside the one kind that
 *  dominates a source tree — a `.ts` and a `.rs` are both "some code", and
 *  telling them apart at a glance is a colour problem, not a shape one.
 *
 *  Colours are literal hex, not theme tokens, for the same reason
 *  {@link ./languages.ts} uses literal hex: they identify the file, not the
 *  app's chrome, and must not move when the user switches theme. Where a
 *  language has a Linguist colour it is used, except for the handful that are
 *  too dark to read on the sidebar's near-black background (C's `#555555`),
 *  which are lightened rather than dropped.
 */

/** Glyphs {@link ../components/FileIcon.svelte} knows how to draw. */
export type Glyph =
  | "folder"
  | "folder-open"
  | "file"
  | "code"
  | "braces"
  | "list"
  | "markdown"
  | "text"
  | "image"
  | "media"
  | "archive"
  | "lock"
  | "key"
  | "terminal"
  | "database"
  | "font"
  | "book"
  | "gear"
  | "git"
  | "container"
  | "flask"
  | "chip"
  | "hash";

export interface FileIcon {
  glyph: Glyph;
  /** Literal hex, with the '#'. */
  color: string;
}

const GREY = "#8b8b93";
const STEEL = "#6d8086";

/** Whole filenames, matched case-insensitively before any extension is. These
 *  are the files whose *name* is the type — `Dockerfile` has no extension and
 *  `package-lock.json` is not a JSON file anyone reads. */
const BY_NAME: Record<string, FileIcon> = {
  dockerfile: { glyph: "container", color: "#2496ed" },
  containerfile: { glyph: "container", color: "#2496ed" },
  ".dockerignore": { glyph: "container", color: "#2496ed" },
  "compose.yaml": { glyph: "container", color: "#2496ed" },
  "compose.yml": { glyph: "container", color: "#2496ed" },
  "docker-compose.yml": { glyph: "container", color: "#2496ed" },
  "docker-compose.yaml": { glyph: "container", color: "#2496ed" },

  makefile: { glyph: "gear", color: STEEL },
  justfile: { glyph: "gear", color: STEEL },
  "cmakelists.txt": { glyph: "gear", color: STEEL },
  ".editorconfig": { glyph: "gear", color: STEEL },
  "cargo.toml": { glyph: "gear", color: "#dea584" },
  "tsconfig.json": { glyph: "gear", color: "#3178c6" },
  "package.json": { glyph: "braces", color: "#cb3837" },

  "package-lock.json": { glyph: "lock", color: STEEL },
  "yarn.lock": { glyph: "lock", color: STEEL },
  "pnpm-lock.yaml": { glyph: "lock", color: STEEL },
  "bun.lockb": { glyph: "lock", color: STEEL },
  "cargo.lock": { glyph: "lock", color: STEEL },
  "poetry.lock": { glyph: "lock", color: STEEL },
  "composer.lock": { glyph: "lock", color: STEEL },
  "gemfile.lock": { glyph: "lock", color: STEEL },

  ".gitignore": { glyph: "git", color: "#f14e32" },
  ".gitattributes": { glyph: "git", color: "#f14e32" },
  ".gitmodules": { glyph: "git", color: "#f14e32" },
  ".gitkeep": { glyph: "git", color: "#f14e32" },

  license: { glyph: "book", color: "#d9b310" },
  "license.md": { glyph: "book", color: "#d9b310" },
  "license.txt": { glyph: "book", color: "#d9b310" },
  copying: { glyph: "book", color: "#d9b310" },
  "readme.md": { glyph: "markdown", color: "#4ea1ff" },
};

/** Extension → icon. Absence is meaningful: an unknown extension gets the
 *  plain page glyph rather than a wrong guess. */
const BY_EXT: Record<string, FileIcon> = {
  // Source
  ts: { glyph: "code", color: "#3178c6" },
  tsx: { glyph: "code", color: "#3178c6" },
  mts: { glyph: "code", color: "#3178c6" },
  cts: { glyph: "code", color: "#3178c6" },
  js: { glyph: "code", color: "#f1e05a" },
  jsx: { glyph: "code", color: "#f1e05a" },
  mjs: { glyph: "code", color: "#f1e05a" },
  cjs: { glyph: "code", color: "#f1e05a" },
  svelte: { glyph: "code", color: "#ff3e00" },
  vue: { glyph: "code", color: "#41b883" },
  astro: { glyph: "code", color: "#ff5d01" },
  rs: { glyph: "code", color: "#dea584" },
  py: { glyph: "code", color: "#3572a5" },
  pyi: { glyph: "code", color: "#3572a5" },
  ipynb: { glyph: "code", color: "#f37626" },
  go: { glyph: "code", color: "#00add8" },
  rb: { glyph: "code", color: "#d3564b" },
  java: { glyph: "code", color: "#b07219" },
  kt: { glyph: "code", color: "#a97bff" },
  kts: { glyph: "code", color: "#a97bff" },
  swift: { glyph: "code", color: "#f05138" },
  c: { glyph: "code", color: "#a8b9cc" },
  h: { glyph: "code", color: "#a8b9cc" },
  cpp: { glyph: "code", color: "#f34b7d" },
  cc: { glyph: "code", color: "#f34b7d" },
  cxx: { glyph: "code", color: "#f34b7d" },
  hpp: { glyph: "code", color: "#f34b7d" },
  cs: { glyph: "code", color: "#68d391" },
  php: { glyph: "code", color: "#7377ad" },
  lua: { glyph: "code", color: "#6f8ede" },
  nix: { glyph: "code", color: "#7e7eff" },
  zig: { glyph: "code", color: "#ec915c" },
  dart: { glyph: "code", color: "#00b4ab" },
  ex: { glyph: "code", color: "#a074c4" },
  exs: { glyph: "code", color: "#a074c4" },
  erl: { glyph: "code", color: "#b83998" },
  hs: { glyph: "code", color: "#8f6fbc" },
  ml: { glyph: "code", color: "#ef7a08" },
  mli: { glyph: "code", color: "#ef7a08" },
  scala: { glyph: "code", color: "#c22d40" },
  clj: { glyph: "code", color: "#91dc47" },
  cljs: { glyph: "code", color: "#91dc47" },
  el: { glyph: "code", color: "#c0c0c0" },
  r: { glyph: "code", color: "#198ce7" },
  jl: { glyph: "code", color: "#a270ba" },
  pl: { glyph: "code", color: "#0298c3" },
  pm: { glyph: "code", color: "#0298c3" },
  vim: { glyph: "code", color: "#199f4b" },
  graphql: { glyph: "code", color: "#e535ab" },
  gql: { glyph: "code", color: "#e535ab" },
  proto: { glyph: "code", color: "#4f8fd1" },
  patch: { glyph: "code", color: "#8dc891" },
  diff: { glyph: "code", color: "#8dc891" },
  html: { glyph: "code", color: "#e34c26" },
  htm: { glyph: "code", color: "#e34c26" },
  xml: { glyph: "code", color: "#e37933" },

  // Shells
  sh: { glyph: "terminal", color: "#89e051" },
  bash: { glyph: "terminal", color: "#89e051" },
  zsh: { glyph: "terminal", color: "#89e051" },
  fish: { glyph: "terminal", color: "#4aae47" },
  ps1: { glyph: "terminal", color: "#5391fe" },
  bat: { glyph: "terminal", color: "#c1c1c1" },
  cmd: { glyph: "terminal", color: "#c1c1c1" },

  // Styles
  css: { glyph: "hash", color: "#a78bfa" },
  scss: { glyph: "hash", color: "#c6538c" },
  sass: { glyph: "hash", color: "#c6538c" },
  less: { glyph: "hash", color: "#5b8cc7" },
  styl: { glyph: "hash", color: "#b3d107" },

  // Data and config
  json: { glyph: "braces", color: "#cbcb41" },
  jsonc: { glyph: "braces", color: "#cbcb41" },
  json5: { glyph: "braces", color: "#cbcb41" },
  yaml: { glyph: "list", color: "#cb4b16" },
  yml: { glyph: "list", color: "#cb4b16" },
  toml: { glyph: "gear", color: "#9c9c9c" },
  ini: { glyph: "gear", color: "#9c9c9c" },
  cfg: { glyph: "gear", color: "#9c9c9c" },
  conf: { glyph: "gear", color: "#9c9c9c" },
  properties: { glyph: "gear", color: "#9c9c9c" },
  tf: { glyph: "gear", color: "#844fba" },
  tfvars: { glyph: "gear", color: "#844fba" },
  hcl: { glyph: "gear", color: "#844fba" },
  csv: { glyph: "list", color: "#1d6f42" },
  tsv: { glyph: "list", color: "#1d6f42" },
  sql: { glyph: "database", color: "#e38c00" },
  db: { glyph: "database", color: "#a8b9cc" },
  sqlite: { glyph: "database", color: "#a8b9cc" },
  sqlite3: { glyph: "database", color: "#a8b9cc" },

  // Prose
  md: { glyph: "markdown", color: "#4ea1ff" },
  mdx: { glyph: "markdown", color: "#4ea1ff" },
  markdown: { glyph: "markdown", color: "#4ea1ff" },
  txt: { glyph: "text", color: "#a1a1aa" },
  text: { glyph: "text", color: "#a1a1aa" },
  log: { glyph: "text", color: "#7d8590" },
  rst: { glyph: "text", color: "#a1a1aa" },
  pdf: { glyph: "book", color: "#e74c3c" },
  doc: { glyph: "book", color: "#4a80c8" },
  docx: { glyph: "book", color: "#4a80c8" },
  odt: { glyph: "book", color: "#4a80c8" },
  ppt: { glyph: "book", color: "#d24726" },
  pptx: { glyph: "book", color: "#d24726" },
  xls: { glyph: "list", color: "#1d6f42" },
  xlsx: { glyph: "list", color: "#1d6f42" },

  // Media
  png: { glyph: "image", color: "#a074c4" },
  jpg: { glyph: "image", color: "#a074c4" },
  jpeg: { glyph: "image", color: "#a074c4" },
  gif: { glyph: "image", color: "#a074c4" },
  webp: { glyph: "image", color: "#a074c4" },
  bmp: { glyph: "image", color: "#a074c4" },
  tiff: { glyph: "image", color: "#a074c4" },
  avif: { glyph: "image", color: "#a074c4" },
  ico: { glyph: "image", color: "#c8a2e0" },
  svg: { glyph: "image", color: "#ffb13b" },
  mp4: { glyph: "media", color: "#f472b6" },
  mkv: { glyph: "media", color: "#f472b6" },
  webm: { glyph: "media", color: "#f472b6" },
  mov: { glyph: "media", color: "#f472b6" },
  avi: { glyph: "media", color: "#f472b6" },
  mp3: { glyph: "media", color: "#34d399" },
  wav: { glyph: "media", color: "#34d399" },
  flac: { glyph: "media", color: "#34d399" },
  ogg: { glyph: "media", color: "#34d399" },
  m4a: { glyph: "media", color: "#34d399" },

  // Bundles and binaries
  zip: { glyph: "archive", color: "#c9a26d" },
  tar: { glyph: "archive", color: "#c9a26d" },
  gz: { glyph: "archive", color: "#c9a26d" },
  tgz: { glyph: "archive", color: "#c9a26d" },
  bz2: { glyph: "archive", color: "#c9a26d" },
  xz: { glyph: "archive", color: "#c9a26d" },
  zst: { glyph: "archive", color: "#c9a26d" },
  "7z": { glyph: "archive", color: "#c9a26d" },
  rar: { glyph: "archive", color: "#c9a26d" },
  exe: { glyph: "chip", color: GREY },
  dll: { glyph: "chip", color: GREY },
  so: { glyph: "chip", color: GREY },
  dylib: { glyph: "chip", color: GREY },
  bin: { glyph: "chip", color: GREY },
  wasm: { glyph: "chip", color: "#654ff0" },
  jar: { glyph: "chip", color: "#b07219" },
  class: { glyph: "chip", color: "#b07219" },
  lock: { glyph: "lock", color: STEEL },

  // Secrets and fonts
  pem: { glyph: "key", color: "#ecd53f" },
  crt: { glyph: "key", color: "#ecd53f" },
  cer: { glyph: "key", color: "#ecd53f" },
  key: { glyph: "key", color: "#ecd53f" },
  gpg: { glyph: "key", color: "#ecd53f" },
  ttf: { glyph: "font", color: "#f2c94c" },
  otf: { glyph: "font", color: "#f2c94c" },
  woff: { glyph: "font", color: "#f2c94c" },
  woff2: { glyph: "font", color: "#f2c94c" },
  eot: { glyph: "font", color: "#f2c94c" },
};

/** Directory names worth colouring. A folder is a folder, so the glyph never
 *  changes — but `src` and `dist` are not the same place, and the tree reads
 *  faster when the eye can tell them apart without reading. */
const DIR_COLORS: Record<string, string> = {
  src: "#4ea1ff",
  lib: "#4ea1ff",
  app: "#4ea1ff",
  components: "#34d399",
  scripts: "#89e051",
  bin: "#89e051",
  test: "#c678dd",
  tests: "#c678dd",
  __tests__: "#c678dd",
  spec: "#c678dd",
  docs: "#f0c674",
  doc: "#f0c674",
  assets: "#f472b6",
  static: "#f472b6",
  public: "#f472b6",
  images: "#f472b6",
  img: "#f472b6",
  media: "#f472b6",
  styles: "#a78bfa",
  css: "#a78bfa",
  config: "#9c9c9c",
  ".github": "#a1a1aa",
  ".git": "#6b7280",
  node_modules: "#6b7280",
  dist: "#6b7280",
  build: "#6b7280",
  out: "#6b7280",
  target: "#6b7280",
  ".next": "#6b7280",
  ".svelte-kit": "#6b7280",
};

const DIR_DEFAULT = "#7d8590";
const FILE_DEFAULT: FileIcon = { glyph: "file", color: "#8b8b93" };

/** `.spec.ts` / `.test.tsx` and friends. Matched on the *name*, so a file in a
 *  `src/` folder still reads as a test the moment it is named like one. */
const TEST_FILE = /\.(test|spec)\.[a-z0-9]+$/i;

/** The last dot-segment of a name, lowercased. `""` for a dotfile with no
 *  extension (`.gitignore`), which BY_NAME has already answered for. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

export function iconForFile(name: string): FileIcon {
  const named = BY_NAME[name.toLowerCase()];
  if (named) return named;
  const base = BY_EXT[extensionOf(name)] ?? FILE_DEFAULT;
  // A test keeps its language's colour and trades its glyph: which language it
  // is written in still matters, but that it is a test matters more.
  return TEST_FILE.test(name) ? { glyph: "flask", color: base.color } : base;
}

export function iconForDir(name: string, open: boolean): FileIcon {
  return {
    glyph: open ? "folder-open" : "folder",
    color: DIR_COLORS[name.toLowerCase()] ?? DIR_DEFAULT,
  };
}

/** The icon for a tree row. `open` only matters for directories. */
export function iconFor(entry: { name: string; isDir: boolean }, open = false): FileIcon {
  return entry.isDir ? iconForDir(entry.name, open) : iconForFile(entry.name);
}
