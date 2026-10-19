import GasTracker from '../src/tracker/GasTracker.js';

const GOVERNANCE_OPERATIONS = ['propose', 'vote', 'queue', 'execute', 'delegate'];

async function measureGovernanceOperations(tracker) {
  const results = [];

  for (const operation of GOVERNANCE_OPERATIONS) {
    console.log(`Measuring governance operation: ${operation}...`);
    const measurement = await tracker.measureFunction(operation);
    results.push({
      function: operation,
      cpuInstructions: measurement.cpuInstructions,
    });
  }

  return results;
}

async function main() {
  console.log('Starting gas measurement...');
  
  const tracker = new GasTracker();
  const measurements = await tracker.measureAllFunctions();
  
  console.log('\nMeasurement Results:');
  measurements.forEach(m => {
    console.log(`  ${m.function}: ${m.cpuInstructions.toLocaleString()} instructions`);
  });

  console.log('\nGovernance Operation Measurements:');
  const governanceMeasurements = await measureGovernanceOperations(tracker);
  governanceMeasurements.forEach(m => {
    console.log(`  ${m.function}: ${m.cpuInstructions.toLocaleString()} instructions`);
  });

  const allMeasurements = [...measurements, ...governanceMeasurements];
  
  await tracker.saveMeasurements(allMeasurements);
  const metrics = await tracker.calculateMetrics(allMeasurements);
  
  console.log('\nMetrics:');
  console.log(`  Avg Gas/Tx: ${metrics.avgGasPerTx.toLocaleString()}`);
  console.log(`  Total Memory: ${metrics.totalMemory.toLocaleString()} bytes`);
  console.log(`  Functions Measured: ${metrics.functionCount}`);
  
  console.log('\n✅ Measurement complete');
}

main().catch(console.error);