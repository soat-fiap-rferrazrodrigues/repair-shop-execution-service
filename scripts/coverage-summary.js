#!/usr/bin/env node
// Prints coverage/coverage-summary.json as a Markdown table. Used by CI to
// publish coverage evidence in the GitHub Actions job summary.
const fs = require('node:fs');
const path = require('node:path');

const file = path.join(process.cwd(), 'coverage', 'coverage-summary.json');
if (!fs.existsSync(file)) {
  console.log('> coverage-summary.json not found (did `npm run test:cov` run?)');
  process.exit(0);
}

const { total } = JSON.parse(fs.readFileSync(file, 'utf8'));
const name = require(path.join(process.cwd(), 'package.json')).name;
const icon = (pct) => (pct >= 80 ? '🟢' : '🔴');

console.log(`### Cobertura de testes — \`${name}\`\n`);
console.log('| Métrica | Cobertos / Total | % |');
console.log('|---|---|---|');
for (const key of ['statements', 'branches', 'functions', 'lines']) {
  const m = total[key];
  console.log(`| ${key} | ${m.covered} / ${m.total} | ${icon(m.pct)} ${m.pct}% |`);
}
console.log('\nMínimo exigido: 80% (`coverageThreshold` no package.json).');
