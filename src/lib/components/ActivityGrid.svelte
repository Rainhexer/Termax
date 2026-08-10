<script lang="ts">
  /** Commit-activity heat grid: four weeks of days, one square each.
   *
   *  Same shape as a contribution graph because that shape is already read
   *  fluently — the point is "is this project alive, and did I touch it this
   *  week", answered without reading a number.
   *
   *  Two layouts, because 4×7 is a tall sliver and 7×4 is a wide band, and a
   *  card and a stats tile want opposite ones. Both draw the same days in the
   *  same order: oldest at the top-left, today at the bottom-right. */
  import { ACCENT_CLASSES, activityAxis, heatLevel } from "../home";
  import type { Accent } from "../home";

  let {
    series,
    accent = "emerald",
    cell = 7,
    gap = 2,
    days = 28,
    layout = "weeks-as-rows",
    weekdays = false,
    legend = false,
    empty,
  }: {
    /** Commits per day, oldest first, aligned to {@link activityAxis}. */
    series: number[];
    accent?: Accent;
    /** Square edge in px. */
    cell?: number;
    gap?: number;
    days?: number;
    /** `weeks-as-rows` is wide (7 across, 4 down); `weeks-as-columns` is the
     *  tall contribution-graph shape (4 across, 7 down). */
    layout?: "weeks-as-rows" | "weeks-as-columns";
    /** Weekday initials along the top. Only meaningful in the wide layout. */
    weekdays?: boolean;
    /** "less → more" scale under the grid, so the shading has a key. */
    legend?: boolean;
    /** Class for a day with no commits. The default reads as an empty cell on a
     *  dark tile; on the lighter top of a project card it disappears, so the
     *  card hands in a recessed one instead. */
    empty?: string;
  } = $props();

  const heat = $derived([empty ?? ACCENT_CLASSES[accent].heat[0], ...ACCENT_CLASSES[accent].heat.slice(1)]);
  const axis = $derived(activityAxis(days));

  /** Weeks, oldest first; within a week, oldest first. The last cell of the
   *  last week is today. */
  const weeks = $derived.by(() => {
    const out: { date: string; count: number }[][] = [];
    for (let i = 0; i < series.length; i += 7) {
      out.push(series.slice(i, i + 7).map((count, j) => ({ date: axis[i + j] ?? "", count })));
    }
    return out;
  });

  /** Initials for the seven day-slots, read off the most recent week so they
   *  are the real weekdays rather than a fixed Mon–Sun that would be wrong six
   *  days out of seven. */
  const dayNames = $derived(
    (weeks.at(-1) ?? []).map((day) =>
      day.date ? new Date(`${day.date}T12:00:00`).toLocaleDateString(undefined, { weekday: "narrow" }) : "",
    ),
  );

  function tip(day: { date: string; count: number }): string {
    if (!day.date) return "";
    return `${day.date}: ${day.count} commit${day.count === 1 ? "" : "s"}`;
  }
</script>

<div class="flex flex-col" style="gap: {gap * 2}px">
  <div
    class="flex {layout === 'weeks-as-rows' ? 'flex-col' : 'flex-row'}"
    style="gap: {gap}px"
    role="img"
    aria-label="Commit activity, last {days} days"
  >
    {#if weekdays && layout === "weeks-as-rows"}
      <div class="flex" style="gap: {gap}px">
        {#each dayNames as name, i (i)}
          <span
            class="text-center font-mono text-[8px] leading-none text-zinc-600"
            style="width: {cell}px">{name}</span
          >
        {/each}
      </div>
    {/if}

    {#each weeks as week, wi (wi)}
      <div class="flex {layout === 'weeks-as-rows' ? 'flex-row' : 'flex-col'}" style="gap: {gap}px">
        {#each week as day (day.date)}
          <div
            class="rounded-[2px] {heat[heatLevel(day.count)]}"
            style="width: {cell}px; height: {cell}px"
            title={tip(day)}
          ></div>
        {/each}
      </div>
    {/each}
  </div>

  {#if legend}
    <div class="flex items-center gap-1 font-mono text-[9px] text-zinc-600">
      <span>less</span>
      {#each heat as level (level)}
        <span class="rounded-[2px] {level}" style="width: {cell}px; height: {cell}px"></span>
      {/each}
      <span>more</span>
    </div>
  {/if}
</div>
