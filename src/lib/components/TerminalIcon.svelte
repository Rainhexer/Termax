<script lang="ts">
  let { type = "shell", className = "" }: { type?: string; className?: string } = $props();
</script>

{#if type === "claude"}
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class={className} fill="currentColor">
    <path clip-rule="evenodd" d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z" fill="currentColor" fill-rule="evenodd" />
  </svg>
{:else if type === "opencode"}
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 30" class={className} fill="currentColor">
    <path d="M0 0h24v30H0zM18 6H6v18h12z" fill-rule="evenodd" />
    <rect x="6" y="12" width="12" height="12" />
  </svg>
{:else}
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class={className} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="9 7 14 12 9 17" />
    <line x1="15" y1="17" x2="19" y2="17" />
  </svg>
{/if}
