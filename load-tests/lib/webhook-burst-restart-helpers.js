export function computeReconciliation(sent, delivered, deadLettered) {
  const accounted = delivered + deadLettered;
  const lost = sent - accounted;
  return { sent, delivered, deadLettered, accounted, lost, passed: lost === 0 };
}

export function formatReconciliationSummary(result, timestamp = new Date().toISOString()) {
  const status = result.passed ? 'PASSED' : 'FAILED';
  return [
    '',
    `=== Webhook Burst Restart — Post-Run Reconciliation ${status} ===`,
    `  Timestamp        : ${timestamp}`,
    '',
    '  Events:',
    `    Triggering events sent : ${result.sent}`,
    `    Webhooks delivered     : ${result.delivered}`,
    `    Dead-lettered          : ${result.deadLettered}`,
    `    Accounted total        : ${result.accounted}`,
    `    Silently lost          : ${result.lost}`,
    '',
  ].join('\n');
}
