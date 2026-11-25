/**
 * Builds a factual Evidence Ledger markdown block from observed check outcomes.
 * Missing checks are marked NOT RUN rather than inferred.
 */

export function formatEvidenceLedger({ stack, harness, model, checks = [] } = {}) {
  const rows = checks.length
    ? checks.map((c) => {
        const status = c.passed === true ? 'PASS' : c.passed === false ? 'FAIL' : 'NOT RUN';
        const command = c.command ? `\`${c.command}\`` : '—';
        const detail = c.detail ?? '—';
        return `| ${c.name} | ${status} | ${command} | ${detail} |`;
      })
    : ['| Verification | NOT RUN | — | No check results recorded |'];

  return [
    '## ProductionLine (`mogra`) Evidence Ledger',
    '',
    `- **Stack:** \`${stack ?? 'unknown'}\``,
    `- **Harness / Model:** \`${harness ?? 'unknown'}\` / \`${model ?? 'unknown'}\``,
    '',
    '| Gate | Status | Command | Observed Output |',
    '| :--- | :--- | :--- | :--- |',
    ...rows,
  ].join('\n');
}
