import GasTracker from '../src/tracker/GasTracker.js';

async function main() {
  console.log('Starting gas measurement...');

  const tracker = new GasTracker();
  const measurements = await tracker.measureAllFunctions();

  console.log('\nMeasurement Results:');
  measurements.forEach(m => {
    console.log(`  ${m.function}: ${m.cpuInstructions.toLocaleString()} instructions`);
  });

  // Measure TTL bump operations (issue #2242)
  console.log('\nMeasuring TTL bump operations...');
  const ttlMeasurements = await tracker.measureTtlBumpOperations();
  ttlMeasurements.forEach(m => {
    console.log(`  ${m.function}: ${m.cpuInstructions.toLocaleString()} instructions`);
  });

  // Measure fee quote operations (issue #2244)
  console.log('\nMeasuring fee quote operations...');
  const feeQuoteMeasurements = await tracker.measureFeeQuoteOperations();
  feeQuoteMeasurements.forEach(m => {
    console.log(`  ${m.function}: ${m.cpuInstructions.toLocaleString()} instructions`);
  });

  // Measure allowlist-enforced operations (issue #2245)
  console.log('\nMeasuring allowlist-enforced operations...');
  const allowlistMeasurements = await tracker.measureAllowlistOperations();
  allowlistMeasurements.forEach(m => {
    console.log(`  ${m.function}: ${m.cpuInstructions.toLocaleString()} instructions`);
  });

  const allMeasurements = [
    ...measurements,
    ...ttlMeasurements,
    ...feeQuoteMeasurements,
    ...allowlistMeasurements,
  ];

  await tracker.saveMeasurements(allMeasurements);
  const metrics = await tracker.calculateMetrics(allMeasurements);

  console.log('\nMetrics:');
  console.log(`  Avg Gas/Tx: ${metrics.avgGasPerTx.toLocaleString()}`);
  console.log(`  Total Memory: ${metrics.totalMemory.toLocaleString()} bytes`);
  console.log(`  Functions Measured: ${metrics.functionCount}`);

  console.log('\n✅ Measurement complete');
}

main().catch(console.error);