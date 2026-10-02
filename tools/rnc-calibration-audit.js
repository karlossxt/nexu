'use strict';

// Port a Node de tools/rnc-calibration-audit.py. Audita una calibración propuesta
// contra las cadenas conservadoras de la revisión nacional. Nunca aprueba ni
// publica coordenadas.

const fs = require('node:fs');
const path = require('node:path');

// Windows guarda JSON con BOM; rompe JSON.parse sin motivo aparente.
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

// isalnum() de Python cubre letras y dígitos Unicode, no solo [a-z0-9].
function key(value) {
  return String(value ?? '')
    .toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

function audit(calibration, national, maxGap = 3, minPosts = 4) {
  const chains = national.chains;
  const output = [];

  for (const corridor of calibration.corredores) {
    const name = corridor.nombre;
    const matching = chains.filter(c => key(c.name) === key(name) && c.toll === true);
    const proposed = new Set((corridor.detalleAnclas || []).map(a => a.idKm));
    const segments = [];

    for (const chain of matching) {
      let current = [];
      const finish = () => {
        // Los postes excluidos por la revisión nacional (duplicados, ambiguos)
        // no se rehabilitan por estar cerca de la polilínea.
        if (current.length >= minPosts) {
          segments.push({
            code: chain.code, name: chain.name,
            fromKm: current[0].km, toKm: current[current.length - 1].km,
            posts: current.map(p => ({ id: p.id, km: p.km })),
            status: 'review_required'
          });
        }
        current = [];
      };
      for (const post of chain.posts) {
        if (!proposed.has(post.id) || (current.length && post.km - current[current.length - 1].km > maxGap)) finish();
        if (proposed.has(post.id)) current.push(post);
      }
      finish();
    }

    output.push({
      corridor: name,
      calibrationState: corridor.estado,
      candidateAnchors: proposed.size,
      reviewChainNames: [...new Set(matching.map(c => c.name))].sort(),
      segments,
      status: 'review_required'
    });
  }
  return output;
}

function main(argv) {
  if (argv.length !== 3) {
    console.error('Usage: node tools/rnc-calibration-audit.js calibration.json national-review.json output.json');
    return 1;
  }
  const [calibrationPath, nationalPath, targetPath] = argv;
  const result = audit(readJson(calibrationPath), readJson(nationalPath));
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({
    corridors: result.length,
    corridorsWithSegments: result.filter(x => x.segments.length).length,
    segmentsForReview: result.reduce((sum, x) => sum + x.segments.length, 0)
  }));
  return 0;
}

module.exports = { key, audit };

if (require.main === module) process.exit(main(process.argv.slice(2)));