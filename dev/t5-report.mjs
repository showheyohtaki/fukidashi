export function t5SeriesReport(results) {
  const runs = results.map((result, i) => ({
    run: i + 1,
    status: result?.tests?.T5?.status || "not-run",
    medianMs: result?.metrics?.roundTripMedianMs ?? null,
    p90Ms: result?.metrics?.roundTripP90Ms ?? null,
    draftReuse: result?.metrics?.draftReuse || { reused: 0, total: 0 },
    rounds: (result?.metrics?.rounds || []).map((round) => {
      const request = result.metrics.candidateRequests?.find(
        (r) => r.id === round.requestId,
      );
      return {
        round: round.round,
        roundTripMs: round.roundTripMs,
        reusedDraft: round.reusedDraft,
        draftText: request?.draftText,
        finalText: request?.finalText,
        replies: request?.replies || round.replies || [],
      };
    }),
  }));
  const cell = (text) =>
    String(text ?? "未実施")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\|/g, "&#124;")
      .replace(/\n/g, "<br>");
  const markdown = [
    "# T5 3回の通し試験",
    "",
    "各回は新しいプロファイル・同じ10本のWAV。未実施／不合格を平均に混ぜません。",
    "",
    "| 回 | 判定 | 中央値 ms | p90 ms | 仮生成再利用 |",
    "|---|---|---:|---:|---:|",
    ...runs.map(
      (r) =>
        `| ${r.run} | ${r.status} | ${cell(r.medianMs)} | ${cell(r.p90Ms)} | ${r.draftReuse.reused}/${r.draftReuse.total} |`,
    ),
    "",
    "| 回・ターン | 往復 ms | 仮生成 | 途中字幕 → 確定字幕 | 候補1／2／3 |",
    "|---|---:|---|---|---|",
    ...runs.flatMap((r) =>
      r.rounds.map(
        (t) =>
          `| ${r.run}・${t.round} | ${t.roundTripMs} | ${t.reusedDraft ? "再利用" : "確定から生成"} | ${cell(t.draftText || "対象外")} → ${cell(t.finalText || "対象外")} | ${t.replies.map(cell).join("<br>")} |`,
      ),
    ),
    "",
  ].join("\n");
  return { runs, markdown };
}
