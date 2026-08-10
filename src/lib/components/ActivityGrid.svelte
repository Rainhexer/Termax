<script lang="ts">
  /** Commit-activity heat grid: weeks as columns, weekdays as rows.
   *
   *  Same shape as a contribution graph because that shape is already read
   *  fluently — the point is "is this project alive, and did I touch it this
   *  week", answered without reading a number. */
  import { ACCENT_CLASSES, activityAxis, heatLevel } from "../home";
  import type { Accent } from "../home";

  let {
    series,
    accent = "emerald",
    cell = 7,
    gap = 2,
    days = 28,
  }: {
    /** Commits per day, oldest first, aligned to {@link activityAxis}. */
    series: number[];
    accent?: Accent;
    /** Square edge in px. */
    cell?: number;
    gap?: number;
    days?: number;
  } = $props();

  const heat = $derived(ACCENT_CLASSES[accent].heat);
  const axis = $derived(activityAxis(days));

  /** Column-major so that each column is one week and the newest week sits on
   *  the right, matching every other contribution grid on earth. */
  const columns = $derived.by(() => {
    const out: { date: string; count: number }[][] = [];
    for (let i = 0; i < series.length; i += 7) {
      out.push(
        series.slice(i, i + 7).map((count, j) => ({ date: axis[i + j] ?? "", count })),
      );
    }
    return out;
  });
</script>

<div class="flex" style="gap: {gap}px" role="img" aria-label="Commit activity, last {days} days">
  {#each columns as week, wi (wi)}
    <div class="flex flex-col" style="gap: {gap}px">
      {#each week as day (day.date)}
        <div
          class="rounded-[1px] {heat[heatLevel(day.count)]}"
          style="width: {cell}px; height: {cell}px"
          title={day.date ? `${day.date}: ${day.count} commit${day.count === 1 ? "" : "s"}` : ""}
        ></div>
      {/each}
    </div>
  {/each}
</div>
