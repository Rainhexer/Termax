<script lang="ts">
  /** Compact "which branch or pull request is this?" label.
   *
   *  One component for the tab bar, the sidebar agent rows, and the PR list, so a
   *  given PR looks the same everywhere. It takes a root path and resolves
   *  everything else itself — callers should not each re-derive branch and PR.
   */
  import { branchByRoot, missingWorktrees } from "../worktrees";
  import { prByBranch } from "../pr";
  import { primaryRoot } from "../stores";

  let {
    root,
    /** Show the branch name when the root has no pull request. Off in tight
     *  places like the tab bar, where the tab title already carries meaning. */
     showBranch = true,
    compact = false,
  }: { root: string | null; showBranch?: boolean; compact?: boolean } = $props();

  const isPrimary = $derived(root !== null && root === $primaryRoot);
  const branch = $derived(root ? ($branchByRoot.get(root) ?? null) : null);
  const pr = $derived(branch ? ($prByBranch.get(branch) ?? null) : null);
  const missing = $derived(root !== null && $missingWorktrees.has(root));

  const tone = $derived.by(() => {
    if (missing) return "border-red-500/50 bg-red-950/50 text-red-300";
    if (!pr) return "border-zinc-700 bg-zinc-800/60 text-zinc-400";
    if (pr.state === "MERGED") return "border-purple-500/50 bg-purple-950/40 text-purple-300";
    if (pr.state === "CLOSED") return "border-red-500/50 bg-red-950/40 text-red-300";
    if (pr.isDraft) return "border-zinc-600 bg-zinc-800/60 text-zinc-400";
    return "border-emerald-500/50 bg-emerald-950/40 text-emerald-300";
  });

  const label = $derived.by(() => {
    if (missing) return "missing";
    if (pr) return `#${pr.number}`;
    if (showBranch && branch) return `⎇ ${branch}`;
    return null;
  });

  const hint = $derived.by(() => {
    const lines: string[] = [];
    if (pr) {
      lines.push(`PR #${pr.number}: ${pr.title}`);
      lines.push(`${pr.headRefName} → ${pr.baseRefName}`);
      if (pr.isDraft) lines.push("Draft");
      if (pr.state !== "OPEN") lines.push(pr.state === "MERGED" ? "Merged" : "Closed");
    } else if (branch) {
      lines.push(`On ${branch}`);
    }
    if (missing) lines.push("This worktree's directory no longer exists — see the Trees panel.");
    if (root && !isPrimary) lines.push(root);
    return lines.join("\n");
  });
</script>

<!-- The primary root is the default, so labelling every unbound tab with the main
     branch would be noise. Only worktrees and PR-bearing roots get a chip. -->
{#if label && (!isPrimary || pr)}
  <span
    class="shrink-0 truncate rounded border px-1 font-mono font-semibold {tone} {compact
      ? 'max-w-16 text-[9px] leading-4'
      : 'max-w-24 text-[10px] leading-[14px]'}"
    title={hint}
  >{label}</span>
{/if}
