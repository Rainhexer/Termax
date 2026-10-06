<script lang="ts">
  /** One issue, in full: read it, edit it, discuss it, close it.
   *
   *  A modal rather than an inline expansion, which is where this differs from
   *  the pull-request panel. A PR's expanded row answers one question — can this
   *  merge — in four lines. An issue is prose plus a conversation, and a 256px
   *  sidebar column cannot show that without becoming unreadable. So the panel
   *  row stays a summary and everything else happens here, at a width where a
   *  paragraph is a paragraph.
   *
   *  Every mutation refetches rather than patching the local copy: GitHub is the
   *  authority, edits can be rejected by permissions, and a locally-applied
   *  change that the server refused is worse than a moment's wait.
   */
  import { ipc } from "../ipc";
  import { activeRoot, flashGitMessage } from "../stores";
  import { ago, loadIssueDetail, refreshIssues, repoMeta } from "../issues";
  import type { CloseReason, IssueDetail, LockReason } from "../types";
  import LabelChip from "./LabelChip.svelte";

  let {
    number,
    onclose,
    onstartwork = null,
  }: {
    number: number;
    onclose: () => void;
    /** Handing off to an agent replaces this modal with the start-work one. */
    onstartwork?: (() => void) | null;
  } = $props();

  let detail = $state<IssueDetail | null>(null);
  let busy = $state(false);
  let error = $state<string | null>(null);

  let editingTitle = $state(false);
  let draftTitle = $state("");
  let editingBody = $state(false);
  let draftBody = $state("");
  let comment = $state("");
  let showLabels = $state(false);
  let showAssignees = $state(false);
  let showDanger = $state(false);
  let closeReason = $state<CloseReason>("completed");
  let duplicateOf = $state("");

  const meta = $derived($repoMeta);
  const root = $derived($activeRoot ?? undefined);
  const isOpen = $derived(detail?.state === "OPEN");

  $effect(() => {
    void reload(number);
  });

  async function reload(n: number) {
    const loaded = await loadIssueDetail(n);
    // Guard against a slower earlier request landing after the user moved on.
    if (n === number) detail = loaded;
  }

  /** Run a mutation, then refetch both this issue and the list behind it. */
  async function mutate(action: () => Promise<unknown>, message?: string) {
    if (busy) return;
    busy = true;
    error = null;
    try {
      await action();
      if (message) flashGitMessage(message);
      await reload(number);
      await refreshIssues(true);
    } catch (err) {
      error = String(err);
    } finally {
      busy = false;
    }
  }

  function saveTitle() {
    const title = draftTitle.trim();
    editingTitle = false;
    if (!title || title === detail?.title) return;
    void mutate(() => ipc.ghIssueEdit(number, { title }, root), "Title updated");
  }

  function saveBody() {
    const body = draftBody;
    editingBody = false;
    if (body === detail?.body) return;
    void mutate(() => ipc.ghIssueEdit(number, { body }, root), "Description updated");
  }

  function toggleLabel(name: string) {
    const has = detail?.labels.some((l) => l.name === name);
    void mutate(() =>
      ipc.ghIssueEdit(number, has ? { removeLabels: [name] } : { addLabels: [name] }, root),
    );
  }

  function toggleAssignee(login: string) {
    const has = detail?.assignees.some((a) => a.login === login);
    void mutate(() =>
      ipc.ghIssueEdit(
        number,
        has ? { removeAssignees: [login] } : { addAssignees: [login] },
        root,
      ),
    );
  }

  function setMilestone(title: string) {
    // "" is meaningful here rather than absent: it detaches the milestone.
    void mutate(() => ipc.ghIssueEdit(number, { milestone: title }, root));
  }

  function postComment() {
    const body = comment.trim();
    if (!body) return;
    void mutate(async () => {
      await ipc.ghIssueComment(number, body, root);
      comment = "";
    }, "Comment posted");
  }

  function closeIssue() {
    if (closeReason === "duplicate" && !duplicateOf.trim()) {
      error = "Closing as a duplicate needs the issue it duplicates.";
      return;
    }
    void mutate(
      () =>
        ipc.ghIssueClose(
          number,
          closeReason,
          comment.trim() || undefined,
          closeReason === "duplicate" ? duplicateOf.trim() : undefined,
          root,
        ),
      `Closed #${number}`,
    ).then(() => (comment = ""));
  }

  function reopenIssue() {
    void mutate(
      () => ipc.ghIssueReopen(number, comment.trim() || undefined, root),
      `Reopened #${number}`,
    ).then(() => (comment = ""));
  }

  function togglePin() {
    const pinned = !detail?.isPinned;
    void mutate(
      () => ipc.ghIssuePin(number, pinned, root),
      pinned ? `Pinned #${number}` : `Unpinned #${number}`,
    );
  }

  function lock(reason: LockReason) {
    void mutate(() => ipc.ghIssueLock(number, true, reason, root), "Conversation locked");
  }

  function unlock() {
    void mutate(() => ipc.ghIssueLock(number, false, undefined, root), "Conversation unlocked");
  }

  function transfer() {
    const destination = prompt("Transfer this issue to which repository?\n\nowner/repo");
    if (!destination?.trim()) return;
    void mutate(async () => {
      const url = await ipc.ghIssueTransfer(number, destination.trim(), root);
      flashGitMessage(`Transferred #${number}`);
      if (url) void ipc.openUrl(url).catch(() => {});
      onclose();
    });
  }

  function remove() {
    // Deletion is the one action here GitHub itself cannot undo, so it asks for
    // the number rather than a yes — a misclick cannot produce "1234".
    const typed = prompt(
      `Permanently delete issue #${number}?\n\nThis cannot be undone, and needs admin rights on the repository.\nType the issue number to confirm.`,
    );
    if (typed?.trim() !== String(number)) return;
    void mutate(async () => {
      await ipc.ghIssueDelete(number, root);
      flashGitMessage(`Deleted #${number}`);
      onclose();
    });
  }

  function stateLabel(): { text: string; color: string } {
    if (isOpen) return { text: "Open", color: "bg-emerald-600/25 text-emerald-300" };
    if (detail?.stateReason === "NOT_PLANNED")
      return { text: "Closed as not planned", color: "bg-zinc-700/50 text-zinc-300" };
    if (detail?.stateReason === "DUPLICATE")
      return { text: "Closed as duplicate", color: "bg-zinc-700/50 text-zinc-300" };
    return { text: "Closed as completed", color: "bg-purple-600/25 text-purple-300" };
  }

  function onKey(e: KeyboardEvent) {
    // Escape closes the modal, but not while an inline editor has focus — there
    // it cancels the edit, which is what the user means by it.
    if (e.key !== "Escape") return;
    if (editingTitle) {
      editingTitle = false;
      return;
    }
    if (editingBody) {
      editingBody = false;
      return;
    }
    onclose();
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
  <button class="absolute inset-0 cursor-default" aria-label="Close dialog" onclick={onclose}></button>
  <div
    class="relative flex max-h-[90vh] w-[720px] max-w-full flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl"
  >
    <!-- Header -->
    <div class="flex items-start gap-2 border-b border-zinc-800 px-4 py-3">
      <div class="min-w-0 flex-1">
        {#if editingTitle}
          <input
            class="w-full rounded bg-zinc-900 px-2 py-1 text-sm text-zinc-100 outline-none ring-1 ring-emerald-500/50"
            bind:value={draftTitle}
            onkeydown={(e) => e.key === "Enter" && saveTitle()}
            onblur={saveTitle}
          />
        {:else}
          <button
            class="w-full text-left text-sm font-semibold text-zinc-100 hover:text-emerald-300"
            title="Click to rename"
            onclick={() => {
              draftTitle = detail?.title ?? "";
              editingTitle = true;
            }}
          >
            {detail?.title ?? "Loading…"}
            <span class="font-normal text-zinc-600">#{number}</span>
          </button>
        {/if}
        {#if detail}
          {@const badge = stateLabel()}
          <div class="mt-1 flex flex-wrap items-center gap-1.5">
            <span class="rounded-full px-2 py-0.5 text-[10px] font-semibold {badge.color}">{badge.text}</span>
            <span class="text-[10px] text-zinc-500">
              {detail.author.login} opened this {ago(detail.createdAt)}
            </span>
            {#if detail.isPinned}
              <span class="text-[10px] text-amber-400" title="Pinned in this repository">📌 pinned</span>
            {/if}
          </div>
        {/if}
      </div>
      <button class="shrink-0 rounded px-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" onclick={onclose}>✕</button>
    </div>

    {#if !detail}
      <p class="p-4 text-[12px] text-zinc-500">Loading issue…</p>
    {:else}
      <div class="flex min-h-0 flex-1 gap-0 overflow-hidden">
        <!-- Conversation -->
        <div class="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          <!-- Body -->
          <div class="rounded-md border border-zinc-800 bg-zinc-900/40">
            <div class="flex items-center justify-between border-b border-zinc-800 px-2 py-1">
              <span class="font-mono text-[10px] text-zinc-500">{detail.author.login}</span>
              {#if !editingBody}
                <button
                  class="rounded px-1 text-[10px] text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300"
                  onclick={() => {
                    draftBody = detail?.body ?? "";
                    editingBody = true;
                  }}
                >Edit</button>
              {/if}
            </div>
            {#if editingBody}
              <div class="flex flex-col gap-1 p-2">
                <textarea
                  class="h-48 resize-none rounded bg-zinc-900 px-2 py-1.5 font-mono text-[11px] text-zinc-200 outline-none ring-1 ring-zinc-800 focus:ring-emerald-500/50"
                  bind:value={draftBody}
                ></textarea>
                <div class="flex justify-end gap-2">
                  <button class="text-[11px] text-zinc-500 hover:text-zinc-300" onclick={() => (editingBody = false)}>
                    Cancel
                  </button>
                  <button
                    class="rounded bg-emerald-600 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
                    disabled={busy}
                    onclick={saveBody}
                  >Save</button>
                </div>
              </div>
            {:else}
              <!-- Plain text, not rendered markdown: Termax has no markdown
                   renderer in this path, and showing the source is honest and
                   preserves code fences, which is most of what issue bodies
                   contain. -->
              <p class="whitespace-pre-wrap break-words px-2 py-1.5 font-mono text-[11px] leading-relaxed text-zinc-300">
                {detail.body.trim() || "No description."}
              </p>
            {/if}
          </div>

          <!-- Comments -->
          {#each detail.comments as c (c.id)}
            <div class="rounded-md border border-zinc-800 bg-zinc-900/40">
              <div class="flex items-center gap-1.5 border-b border-zinc-800 px-2 py-1">
                <span class="font-mono text-[10px] text-zinc-400">{c.author.login}</span>
                {#if c.authorAssociation && c.authorAssociation !== "NONE"}
                  <span class="rounded bg-zinc-800 px-1 text-[9px] uppercase text-zinc-500">
                    {c.authorAssociation}
                  </span>
                {/if}
                {#if meta.me && c.author.login === meta.me}
                  <span class="text-[9px] text-emerald-500">you</span>
                {/if}
                <span class="ml-auto text-[10px] text-zinc-600">{ago(c.createdAt)}</span>
              </div>
              {#if c.isMinimized}
                <p class="px-2 py-1.5 text-[11px] italic text-zinc-600">
                  Hidden{c.minimizedReason ? ` as ${c.minimizedReason.toLowerCase()}` : ""}.
                </p>
              {:else}
                <p class="whitespace-pre-wrap break-words px-2 py-1.5 font-mono text-[11px] leading-relaxed text-zinc-300">
                  {c.body.trim()}
                </p>
              {/if}
            </div>
          {/each}

          <!-- Comment box, which doubles as the close/reopen comment -->
          <div class="flex flex-col gap-1.5">
            <textarea
              class="h-20 resize-none rounded bg-zinc-900 px-2 py-1.5 font-mono text-[11px] text-zinc-200 outline-none ring-1 ring-zinc-800 focus:ring-emerald-500/50"
              bind:value={comment}
              placeholder="Leave a comment…"
            ></textarea>
            <div class="flex flex-wrap items-center justify-end gap-2">
              {#if isOpen}
                <select
                  class="rounded bg-zinc-900 px-1.5 py-1 text-[11px] text-zinc-300 outline-none ring-1 ring-zinc-800"
                  bind:value={closeReason}
                >
                  <option value="completed">as completed</option>
                  <option value="not planned">as not planned</option>
                  <option value="duplicate">as duplicate</option>
                </select>
                {#if closeReason === "duplicate"}
                  <input
                    class="w-24 rounded bg-zinc-900 px-1.5 py-1 font-mono text-[11px] text-zinc-200 outline-none ring-1 ring-zinc-800 focus:ring-emerald-500/50"
                    bind:value={duplicateOf}
                    placeholder="#123"
                  />
                {/if}
                <button
                  class="rounded-md px-2 py-1 text-[11px] text-zinc-400 ring-1 ring-zinc-700 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40"
                  disabled={busy}
                  onclick={closeIssue}
                >{comment.trim() ? "Comment and close" : "Close issue"}</button>
              {:else}
                <button
                  class="rounded-md px-2 py-1 text-[11px] text-emerald-300 ring-1 ring-emerald-600/40 hover:bg-emerald-600/20 disabled:opacity-40"
                  disabled={busy}
                  onclick={reopenIssue}
                >{comment.trim() ? "Comment and reopen" : "Reopen issue"}</button>
              {/if}
              <button
                class="rounded-md bg-emerald-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
                disabled={busy || !comment.trim()}
                onclick={postComment}
              >Comment</button>
            </div>
          </div>

          {#if error}
            <div class="flex items-start gap-1 rounded-md border border-red-500/40 bg-red-950/40 px-2 py-1.5">
              <p class="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[10px] text-red-300">{error}</p>
              <button
                class="shrink-0 rounded px-1 text-[10px] text-red-300/70 hover:bg-red-500/20"
                onclick={() => (error = null)}
              >✕</button>
            </div>
          {/if}
        </div>

        <!-- Sidebar -->
        <div class="flex w-52 shrink-0 flex-col gap-3 overflow-y-auto border-l border-zinc-800 p-3">
          <button
            class="rounded-md bg-emerald-600/20 px-2 py-1.5 text-[11px] font-semibold text-emerald-300 hover:bg-emerald-600/30 disabled:opacity-40"
            title="Create a linked branch and open an agent on it"
            disabled={busy || !onstartwork}
            onclick={() => onstartwork?.()}
          >Start work →</button>

          <!-- Assignees -->
          <div class="flex flex-col gap-1">
            <button
              class="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-zinc-500 hover:text-zinc-300"
              onclick={() => (showAssignees = !showAssignees)}
            >
              Assignees <span class="text-[8px]">{showAssignees ? "▾" : "▸"}</span>
            </button>
            {#if detail.assignees.length}
              <p class="break-words font-mono text-[10px] text-zinc-300">
                {detail.assignees.map((a) => a.login).join(", ")}
              </p>
            {:else}
              <p class="text-[10px] text-zinc-600">No one assigned.</p>
            {/if}
            {#if showAssignees}
              <div class="flex max-h-40 flex-col gap-0.5 overflow-y-auto rounded border border-zinc-800 p-1">
                {#if meta.me}
                  <button
                    class="rounded px-1 py-0.5 text-left font-mono text-[10px] hover:bg-zinc-800 {detail.assignees.some((a) => a.login === meta.me)
                      ? 'text-emerald-300'
                      : 'text-zinc-400'}"
                    disabled={busy}
                    onclick={() => toggleAssignee(meta.me!)}
                  >{detail.assignees.some((a) => a.login === meta.me) ? "✓ " : ""}{meta.me} (you)</button>
                {/if}
                {#each meta.assignees.filter((a) => a.login !== meta.me) as user (user.login)}
                  {@const on = detail.assignees.some((a) => a.login === user.login)}
                  <button
                    class="rounded px-1 py-0.5 text-left font-mono text-[10px] hover:bg-zinc-800 {on
                      ? 'text-emerald-300'
                      : 'text-zinc-400'}"
                    disabled={busy}
                    onclick={() => toggleAssignee(user.login)}
                  >{on ? "✓ " : ""}{user.login}</button>
                {/each}
              </div>
            {/if}
          </div>

          <!-- Labels -->
          <div class="flex flex-col gap-1">
            <button
              class="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-zinc-500 hover:text-zinc-300"
              onclick={() => (showLabels = !showLabels)}
            >
              Labels <span class="text-[8px]">{showLabels ? "▾" : "▸"}</span>
            </button>
            {#if detail.labels.length}
              <div class="flex flex-wrap gap-1">
                {#each detail.labels as label (label.name)}
                  <LabelChip name={label.name} color={label.color} />
                {/each}
              </div>
            {:else}
              <p class="text-[10px] text-zinc-600">None yet.</p>
            {/if}
            {#if showLabels}
              <div class="flex max-h-40 flex-wrap gap-1 overflow-y-auto rounded border border-zinc-800 p-1">
                {#each meta.labels as label (label.name)}
                  <LabelChip
                    name={label.name}
                    color={label.color}
                    active={detail.labels.some((l) => l.name === label.name)}
                    title={label.description || label.name}
                    onclick={() => toggleLabel(label.name)}
                  />
                {/each}
              </div>
            {/if}
          </div>

          <!-- Milestone -->
          <div class="flex flex-col gap-1">
            <span class="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Milestone</span>
            {#if meta.milestones.length}
              <select
                class="rounded bg-zinc-900 px-1 py-0.5 text-[10px] text-zinc-300 outline-none ring-1 ring-zinc-800"
                value={detail.milestone?.title ?? ""}
                disabled={busy}
                onchange={(e) => setMilestone((e.currentTarget as HTMLSelectElement).value)}
              >
                <option value="">None</option>
                {#each meta.milestones as m (m.number)}
                  <option value={m.title}>{m.title}</option>
                {/each}
              </select>
            {:else}
              <p class="text-[10px] text-zinc-600">{detail.milestone?.title ?? "None"}</p>
            {/if}
          </div>

          <div class="mt-auto flex flex-col gap-1 border-t border-zinc-800 pt-2">
            <button
              class="text-left text-[10px] text-emerald-400 hover:underline"
              onclick={() => ipc.openUrl(detail!.url)}
            >Open on GitHub ↗</button>
            <button
              class="text-left text-[10px] text-zinc-500 hover:text-zinc-300 disabled:opacity-40"
              disabled={busy}
              onclick={togglePin}
            >{detail.isPinned ? "Unpin" : "Pin to repository"}</button>
            <button
              class="text-left text-[10px] text-zinc-500 hover:text-zinc-300"
              onclick={() => (showDanger = !showDanger)}
            >More…</button>
            {#if showDanger}
              <button
                class="text-left text-[10px] text-zinc-500 hover:text-zinc-300 disabled:opacity-40"
                title="Stop non-collaborators from commenting"
                disabled={busy}
                onclick={() => lock("resolved")}
              >Lock as resolved</button>
              <button
                class="text-left text-[10px] text-zinc-500 hover:text-zinc-300 disabled:opacity-40"
                disabled={busy}
                onclick={() => lock("too_heated")}
              >Lock as too heated</button>
              <button
                class="text-left text-[10px] text-zinc-500 hover:text-zinc-300 disabled:opacity-40"
                disabled={busy}
                onclick={unlock}
              >Unlock conversation</button>
              <button
                class="text-left text-[10px] text-zinc-500 hover:text-zinc-300 disabled:opacity-40"
                disabled={busy}
                onclick={transfer}
              >Transfer to another repo…</button>
              <button
                class="text-left text-[10px] text-red-400/80 hover:text-red-300 disabled:opacity-40"
                title="Permanent, and needs admin rights"
                disabled={busy}
                onclick={remove}
              >Delete issue…</button>
            {/if}
          </div>
        </div>
      </div>
    {/if}
  </div>
</div>
