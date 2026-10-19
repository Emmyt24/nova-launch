const fs = require('fs/promises');
const path = require('path');

const REQUIRED_OPERATIONS = [
  'create',
  'mint',
  'burn',
  'claim',
  'propose',
  'vote',
  'execute',
  'bump_ttl',
  'quote_fee',
  'transfer_allowlist',
  'mint_allowlist'
];
const DEFAULT_THRESHOLD_PERCENT = 10;

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const value = argv[i + 1];
    args[key] = value;
    i += 1;
  }
  return args;
}

function percentDelta(current, baseline) {
  if (!baseline) return 0;
  return ((current - baseline) / baseline) * 100;
}

function formatMetricResult(operation, metric, baselineValue, currentValue, thresholdPercent) {
  const allowed = Math.round(baselineValue * (1 + thresholdPercent / 100));
  const deltaPercent = percentDelta(currentValue, baselineValue);
  const breached = currentValue > allowed;
  return {
    operation,
    metric,
    baselineValue,
    currentValue,
    allowed,
    thresholdPercent,
    deltaPercent,
    breached
  };
}

function toMarkdownTable(results) {
  const header = [
    '| Operation | Metric | Baseline | Current | Allowed | Delta | Status |',
    '|---|---:|---:|---:|---:|---:|---|'
  ];

  const rows = results.map((r) => {
    const status = r.breached ? 'FAIL' : 'PASS';
    const delta = `${r.deltaPercent >= 0 ? '+' : ''}${r.deltaPercent.toFixed(2)}%`;
    return `| ${r.operation} | ${r.metric} | ${r.baselineValue} | ${r.currentValue} | ${r.allowed} | ${delta} | ${status} |`;
  });

  return [...header, ...rows].join('\n');
}

async function main() {
  const args = parseArgs(process.argv);
  const cwd = process.cwd();

  const baselinePath = path.resolve(
    cwd,
    args.baseline || 'gas-dashboard/data/snapshots/gas-baseline.json'
  );
  const currentPath = path.resolve(
    cwd,
    args.current || 'gas-dashboard/data/snapshots/gas-current.json'
  );
  const reportPath = path.resolve(
    cwd,
    args.report || 'gas-dashboard/data/reports/gas-threshold-diff.md'
  );

  const baseline = JSON.parse(await fs.readFile(baselinePath, 'utf-8'));
  const current = JSON.parse(await fs.readFile(currentPath, 'utf-8'));

  const results = [];
  const missing = [];

  for (const operation of REQUIRED_OPERATIONS) {
    const baselineOp = baseline.operations?.[operation];
    const currentOp = current.operations?.[operation];

    if (!baselineOp || !currentOp) {
      missing.push(operation);
      continue;
    }

    const thresholdPercent = baselineOp.thresholdPercent ?? DEFAULT_THRESHOLD_PERCENT;

    results.push(
      formatMetricResult(operation, 'cpu', baselineOp.cpu, currentOp.cpu, thresholdPercent)
    );
    results.push(
      formatMetricResult(operation, 'memory', baselineOp.memory, currentOp.memory, thresholdPercent)
    );
  }

  if (missing.length > 0) {
    console.error(`Missing operation snapshots: ${missing.join(', ')}`);
    process.exit(1);
  }

  const breaches = results.filter((r) => r.breached);
  const markdown = [
    '# Gas Regression Diff Report',
    '',
    `- Baseline: \`${baselinePath}\``,
    `- Current: \`${currentPath}\``,
    `- Required operations: ${REQUIRED_OPERATIONS.join(', ')}`,
    '',
    toMarkdownTable(results),
    '',
    breaches.length > 0
      ? `## Result: FAIL (${breaches.length} threshold breach${breaches.length > 1 ? 'es' : ''})`
      : '## Result: PASS (no threshold breaches)'
  ].join('\n');

  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${markdown}\n`);

  console.log(markdown);
  console.log(`\nReport written to ${reportPath}`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  }

  if (breaches.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
