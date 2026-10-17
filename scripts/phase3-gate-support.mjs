export function skippedTestCount(output) {
  const normalized = output.replaceAll(/\u001B\[[0-9;]*m/g, "");
  const patterns = [
    /(?:^|\n)\s*Tests?\s+[^\r\n]*?\b(\d+)\s+skipped\b/giu,
    /\b(\d+)\s+tests?\s+skipped\b/giu,
    /\bSkipped:\s*(\d+)\b/giu,
  ];
  for (const pattern of patterns) {
    const counts = [...normalized.matchAll(pattern)].map((match) => Number(match[1]));
    if (counts.length > 0) return Math.max(...counts);
  }
  return 0;
}
