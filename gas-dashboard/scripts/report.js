import ReportGenerator from '../src/reports/ReportGenerator.js';

async function main() {
  const month = process.argv[2] ? new Date(process.argv[2]) : new Date();
  
  console.log(`Generating report for ${month.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}...`);
  
  const generator = new ReportGenerator();
  const report = await generator.generateMonthlyReport(month);
  
  console.log('\n📊 Report Summary:');
  console.log(`  Avg Gas: ${report.executiveSummary.avgGasCost.toLocaleString()}`);
  console.log(`  Total Savings: ${report.executiveSummary.totalSavings}`);
  console.log(`  Optimizations: ${report.executiveSummary.optimizationsDeployed}`);
  console.log(`  User Impact: ${report.executiveSummary.userCostImpact}`);

  if (report.benchmarkCategories) {
    console.log('\n🧪 Benchmark Categories:');
    for (const [category, data] of Object.entries(report.benchmarkCategories)) {
      const avgGas = typeof data?.avgGasCost === 'number'
        ? data.avgGasCost.toLocaleString()
        : data?.avgGasCost ?? 'n/a';
      const count = data?.count ?? data?.samples ?? 'n/a';
      console.log(`  ${category}: avg gas ${avgGas}, samples ${count}`);
    }
  }

  if (report.ttlBenchmarks) {
    console.log('\n⏱️  TTL Extension Benchmarks:');
    const ttl = report.ttlBenchmarks;
    const bumpGas = typeof ttl.bumpGasCost === 'number'
      ? ttl.bumpGasCost.toLocaleString()
      : ttl.bumpGasCost ?? 'n/a';
    const adminBumpGas = typeof ttl.adminBumpGasCost === 'number'
      ? ttl.adminBumpGasCost.toLocaleString()
      : ttl.adminBumpGasCost ?? 'n/a';
    console.log(`  Access Bump Gas: ${bumpGas}`);
    console.log(`  Admin Bump Gas: ${adminBumpGas}`);
  }

  if (report.whitelistBenchmarks) {
    console.log('\n🔐 Whitelist Mode Benchmarks:');
    const wl = report.whitelistBenchmarks;
    const transferGas = typeof wl.transferGasCost === 'number'
      ? wl.transferGasCost.toLocaleString()
      : wl.transferGasCost ?? 'n/a';
    const mintGas = typeof wl.mintGasCost === 'number'
      ? wl.mintGasCost.toLocaleString()
      : wl.mintGasCost ?? 'n/a';
    console.log(`  Transfer Gas: ${transferGas}`);
    console.log(`  Mint Gas: ${mintGas}`);
  }

  if (report.feeQuoteBenchmarks) {
    console.log('\n💲 Fee Quote Benchmarks:');
    const fq = report.feeQuoteBenchmarks;
    const quoteGas = typeof fq.quoteGasCost === 'number'
      ? fq.quoteGasCost.toLocaleString()
      : fq.quoteGasCost ?? 'n/a';
    console.log(`  Quote Gas: ${quoteGas}`);
  }
  
  console.log('\n✅ Report generated successfully');
}

main().catch(console.error);