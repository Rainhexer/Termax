<script lang="ts">
  /** One language a project is written in: monogram chip plus its share.
   *
   *  Read-only by design — it is a label, not a control, so it takes no hover
   *  state and no cursor change. Colours come straight from the language table
   *  as inline style: they identify the language and must not shift with the
   *  app's theme. */
  import { sharePercent } from "../languages";
  import type { LanguageShare } from "../languages";

  let { lang, size = 22 }: { lang: LanguageShare; size?: number } = $props();
</script>

<div
  class="flex select-none flex-col items-center gap-1"
  title="{lang.name} · {sharePercent(lang.share)} of the code"
>
  <div
    class="flex items-center justify-center rounded-[5px] border font-mono font-bold leading-none"
    style="width: {size}px; height: {size}px;
           font-size: {lang.mono.length > 2 ? size * 0.34 : size * 0.42}px;
           color: {lang.color}; border-color: {lang.color}59;
           background-color: {lang.color}24"
  >{lang.mono}</div>
  <span class="font-mono text-[9px] leading-none text-zinc-500">
    {sharePercent(lang.share)}
  </span>
</div>
