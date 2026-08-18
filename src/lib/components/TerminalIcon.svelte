<script lang="ts">
  let { type = "shell", className = "" }: { type?: string; className?: string } = $props();

  // Custom launcher icons are stored as raw <svg> markup and injected via
  // {@html}. Sanitize before rendering: strip anything scriptable (script/
  // foreignObject tags, on* handlers, and javascript:/data:text URLs) so a
  // pasted icon can't execute JS in the app (which has invoke() access).
  function sanitizeSvg(markup: string): string | null {
    const trimmed = markup.trimStart();
    if (!trimmed.startsWith("<svg")) return null;
    let s = trimmed
      // drop <script> / <foreignObject> element blocks entirely
      .replace(/<\s*(script|foreignObject)[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
      // drop self-closing / unclosed variants of the same
      .replace(/<\s*(script|foreignObject)\b[^>]*>/gi, "")
      // strip on*="..." / on*='...' event handlers
      .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
      // neutralize javascript:/vbscript: and inline-script data: URLs in href/xlink:href/src
      .replace(
        /((?:xlink:)?(?:href|src))\s*=\s*("|')\s*(?:javascript:|vbscript:|data:text\/html)[^"']*\2/gi,
        '$1=$2#$2',
      );
    // force the svg to fill its wrapper like the built-ins
    return s.replace("<svg", '<svg style="width:100%;height:100%" ');
  }
  const customSvg = $derived(sanitizeSvg(type));
</script>

{#if customSvg}
  <span class="inline-block {className}">{@html customSvg}</span>
{:else if type === "claude"}
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class={className} fill="currentColor">
    <path clip-rule="evenodd" d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z" fill="currentColor" fill-rule="evenodd" />
  </svg>
{:else if type === "opencode"}
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 30" class={className} fill="currentColor">
    <path d="M0 0h24v30H0zM18 6H6v18h12z" fill-rule="evenodd" />
    <rect x="6" y="12" width="12" height="12" />
  </svg>
{:else if type === "pi"}
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800" class={className} fill="currentColor">
    <path fill-rule="evenodd" d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29Z M282.65 282.65V400H400V282.65Z" />
    <path d="M517.36 400H634.72V634.72H517.36Z" />
  </svg>
{:else if type === "robot"}
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class={className} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="4" y="8" width="16" height="12" rx="2" />
    <line x1="12" y1="4" x2="12" y2="8" />
    <circle cx="12" cy="3" r="1" />
    <circle cx="9" cy="13" r="1" fill="currentColor" stroke="none" />
    <circle cx="15" cy="13" r="1" fill="currentColor" stroke="none" />
    <line x1="9" y1="17" x2="15" y2="17" />
  </svg>
{:else if type === "sparkles"}
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class={className} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
    <path d="M19 15l.7 1.8 1.8.7-1.8.7L19 20l-.7-1.8-1.8-.7 1.8-.7z" />
  </svg>
{:else if type === "gear"}
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class={className} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5h.1a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </svg>
{:else if type === "shell-circle"}
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class={className} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="9 7 14 12 9 17" />
    <circle cx="17" cy="12" r="2" />
    <line x1="15" y1="17" x2="19" y2="17" />
  </svg>
{:else if type === "shell-face"}
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class={className} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="4 7 9 12 4 17" />
    <line x1="10" y1="17" x2="14" y2="17" />
    <circle cx="19" cy="12" r="3" />
  </svg>
{:else}
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class={className} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="9 7 14 12 9 17" />
    <line x1="15" y1="17" x2="19" y2="17" />
  </svg>
{/if}
