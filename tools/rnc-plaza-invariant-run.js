'use strict';
// Invierte el indice por ID_RED y comprueba el invariante sobre la revision
// nacional completa. No modifica nada: escribe un reporte de solo lectura.
const fs = require('node:fs');
const { indexByCode, checkChain, summarize, VERDICTS } = require('./rnc-plaza-invariant');

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function main(argv) {
  const positional = argv.filter(a => !a.startsWith('--'));
  const [reviewFile, verificationFile, outFile] = positional;
  if (!reviewFile || !verificationFile || !outFile) {
    console.error('Usage: node tools/rnc-plaza-invariant.js review.json plaza-verification.json out.json');
    return 1;
  }
  const review = loadJson(reviewFile);
  const verification = loadJson(verificationFile);
  const entries = Array.isArray(verification) ? verification : verification.entries || [];
  const byCode = indexByCode(entries);

  const results = review.chains.map(chain => checkChain(chain, byCode));
  const report = {
    status: 'review_required',
    policy: 'El invariante de plaza nunca aprueba ni corrige una cadena; solo separa coincidencia de desacuerdo.',
    source: { review: reviewFile, plazaVerification: verificationFile },
    verdicts: VERDICTS,
    summary: summarize(results),
    chains: results
  };
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report.summary));
  return 0;
}

module.exports = { main, loadJson };

if (require.main === module) process.exit(main(process.argv.slice(2)));
