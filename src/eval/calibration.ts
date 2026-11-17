import type { EvalResult } from './types.ts';
export const LABELS = ['clear', 'unclear', 'insufficient_evidence'] as const;
export type ClarityLabel = typeof LABELS[number];
export function calibrationStats(rows: { reference: ClarityLabel; predicted: ClarityLabel }[]) {
  const matrix = LABELS.map(() => LABELS.map(() => 0));
  rows.forEach(row => matrix[LABELS.indexOf(row.reference)][LABELS.indexOf(row.predicted)]++);
  const n = rows.length, matches = matrix.reduce((sum, row, i) => sum + row[i], 0);
  const support = matrix.map(row => row.reduce((a, b) => a + b, 0));
  return { n, matrix, labels: LABELS, agreement: n ? matches / n : null,
    majorityBaseline: n ? Math.max(...support) / n : null,
    classes: LABELS.map((label, i) => {
      const predicted = matrix.reduce((sum, row) => sum + row[i], 0);
      return { label, support: support[i], precision: predicted ? matrix[i][i] / predicted : null,
        recall: support[i] ? matrix[i][i] / support[i] : null };
    }) };
}
export function clarityLabel(result: EvalResult): ClarityLabel {
  const status = result.verdicts.find(v => v.metric === 'clarity')?.status;
  return status === 'pass' ? 'clear' : status === 'fail' ? 'unclear' : 'insufficient_evidence';
}
