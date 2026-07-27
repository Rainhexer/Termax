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

// Inline: applied AFTER the text is already HTML-escaped, so no raw HTML injection.
function inline(text: string): string {
  return text
    // images: ![alt](src)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, src) => `<img alt="${alt}" src="${src}">`)
    // links: [text](href)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, txt, href) => `<a href="${href}" target="_blank" rel="noreferrer">${txt}</a>`)
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
 *  line in the raw text, so both views can be scrolled to the same place. */
export function renderMarkdown(src: string): string {
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
      out.push(`<p data-line="${paraStart + 1}">${inline(escapeHtml(para.join(" ")))}</p>`);
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
      out.push(`<h${level} data-line="${i + 1}">${inline(escapeHtml(h[2].trim()))}</h${level}>`);
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
      out.push(`<blockquote data-line="${i + 1}">${inline(escapeHtml(line.replace(/^\s*>\s?/, "")))}</blockquote>`);
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
      out.push(`<li data-line="${i + 1}">${inline(escapeHtml((ul ?? ol)![1]))}</li>`);
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

// Scroll bridge for html/svg previews.
//
// Those render in a sandboxed iframe without `allow-same-origin`, so its
// document lives in an opaque origin and the parent cannot touch
// `contentWindow.scrollY` at all — reading it throws. This script is appended
// to the srcdoc so the frame reports its own scroll position and accepts a
// position back, over postMessage.
const SCROLL_BRIDGE = `<script>(function(){
  function max(){return Math.max(0,document.documentElement.scrollHeight-window.innerHeight);}
  var pending=null;
  window.addEventListener("scroll",function(){
    if(pending)return;
    pending=setTimeout(function(){
      pending=null;
      parent.postMessage({__tmx:"scroll",pct:max()>0?window.scrollY/max():0},"*");
    },80);
  },{passive:true});
  window.addEventListener("message",function(e){
    var d=e.data;
    if(d&&d.__tmx==="scrollTo")window.scrollTo(0,d.pct*max());
  });
  parent.postMessage({__tmx:"ready"},"*");
})();</script>`;

/** Build the srcdoc for an html/svg preview: the file plus the scroll bridge. */
export function previewDocument(src: string): string {
  return src + SCROLL_BRIDGE;
}
