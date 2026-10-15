// Summary statistics for one hyperfine command result (hyperfine reports seconds).

export function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Nearest-rank percentile. With 10 runs, p95 is the slowest run. */
export function percentile(values, p) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

export function summarize(hfResult) {
  const ms = hfResult.times.map((t) => t * 1000);
  const med = median(ms);
  const mad = median(ms.map((t) => Math.abs(t - med)));
  const mean = ms.reduce((a, b) => a + b, 0) / ms.length;
  const cpuMs = (hfResult.user + hfResult.system) * 1000;
  return {
    command: hfResult.command,
    runs: ms.length,
    medianMs: med,
    p95Ms: percentile(ms, 95),
    minMs: Math.min(...ms),
    maxMs: Math.max(...ms),
    meanMs: mean,
    madMs: mad,
    // Flagged when the median absolute deviation exceeds 5% of the median (docs/methodology.md).
    noisy: mad / med > 0.05,
    userMs: hfResult.user * 1000,
    systemMs: hfResult.system * 1000,
    cpuMs,
    // CPU time over wall time: 1.0 means one core busy on average.
    parallelism: cpuMs / mean,
    timesMs: ms,
    exitCodes: hfResult.exit_codes,
  };
}
