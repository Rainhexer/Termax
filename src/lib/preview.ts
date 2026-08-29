// File preview rendering: interpret a file's content instead of showing raw text.
// Markdown -> formatted HTML, HTML -> live website (iframe), images/SVG -> shown inline.

export type PreviewKind = "markdown" | "html" | "svg" | "image" | "none";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"]);

export function previewKindForPath(path: string): PreviewKind {
  const ext = (path.split(".").pop() ?? "").toLowerCase();
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "svg") return "svg";
  if (IMAGE_EXTS.has(ext)) return "image";
  return "none";
}

/** Whether a "Preview" tab makes sense for this file. */
export function hasPreview(path: string): boolean {
  return previewKindForPath(path) !== "none";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Resolve a Markdown reference against the preview server, so a relative
 *  image or link in a note points at the file next to it on disk. Absolute
 *  URLs, protocol-relative URLs and in-page anchors are left alone. */
function resolveRef(url: string, base: string): string {
  if (!base || /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//") || url.startsWith("#")) {
    return url;
  }
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

// Inline: applied AFTER the text is already HTML-escaped, so no raw HTML injection.
function inline(text: string, base: string): string {
  return text
    // images: ![alt](src)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, src) => `<img alt="${alt}" src="${resolveRef(src, base)}">`)
    // links: [text](href)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, txt, href) => `<a href="${resolveRef(href, base)}" target="_blank" rel="noreferrer">${txt}</a>`)
    // inline code
    .replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`)
    // bold
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    // strikethrough
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    // italic
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/(^|\s)_([^_]+)_/g, "$1<em>$2</em>");
}

/** Minimal block-level Markdown -> HTML. Input is escaped first (safe).
 *
 *  Every block carries `data-line` with the 1-based source line it came from.
 *  EditorPane uses those to map a scroll position in the preview back to a
 *  line in the raw text, so both views can be scrolled to the same place.
 *
 *  `baseUrl` is the preview server URL of the directory holding the file;
 *  relative images and links are resolved against it so they actually load. */
export function renderMarkdown(src: string, baseUrl = ""): string {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  let inCode = false;
  let codeStart = 0;
  let codeBuf: string[] = [];
  let listType: "ul" | "ol" | null = null;
  let para: string[] = [];
  let paraStart = 0;

  const flushPara = () => {
    if (para.length) {
      out.push(`<p data-line="${paraStart + 1}">${inline(escapeHtml(para.join(" ")), baseUrl)}</p>`);
      para = [];
    }
  };
  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // fenced code
    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      if (inCode) {
        out.push(`<pre data-line="${codeStart + 1}"><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        flushPara();
        closeList();
        inCode = true;
        codeStart = i;
      }
      i++;
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      i++;
      continue;
    }

    // blank line
    if (/^\s*$/.test(line)) {
      flushPara();
      closeList();
      i++;
      continue;
    }

    // heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      closeList();
      const level = h[1].length;
      out.push(`<h${level} data-line="${i + 1}">${inline(escapeHtml(h[2].trim()), baseUrl)}</h${level}>`);
      i++;
      continue;
    }

    // hr
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      flushPara();
      closeList();
      out.push(`<hr data-line="${i + 1}">`);
      i++;
      continue;
    }

    // blockquote
    if (/^\s*>\s?/.test(line)) {
      flushPara();
      closeList();
      out.push(`<blockquote data-line="${i + 1}">${inline(escapeHtml(line.replace(/^\s*>\s?/, "")), baseUrl)}</blockquote>`);
      i++;
      continue;
    }

    // lists
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const want: "ul" | "ol" = ul ? "ul" : "ol";
      if (listType && listType !== want) closeList();
      if (!listType) {
        listType = want;
        out.push(`<${want} data-line="${i + 1}">`);
      }
      out.push(`<li data-line="${i + 1}">${inline(escapeHtml((ul ?? ol)![1]), baseUrl)}</li>`);
      i++;
      continue;
    }

    // paragraph text
    closeList();
    if (!para.length) paraStart = i;
    para.push(line.trim());
    i++;
  }

  if (inCode) out.push(`<pre data-line="${codeStart + 1}"><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
  flushPara();
  closeList();
  return out.join("\n");
}
