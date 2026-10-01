'use strict';

// Paso 2 de la promocion: escribe el indice de produccion.
//
// A diferencia del paso 1, ESTE script modifica el comportamiento del worker. Por
// eso la escritura esta condicionada a una auditoria que debe salir limpia: si
// falta un km o hay dos candidatas para el mismo, no se toca el indice.
//
// Que no se escriba nunca por un fallo silencioso es lo unico que hace aceptable
// continuar despues de esto. Todo lo demas (el invariante de cadena, el estado,
// las colisiones con las anclas manuales) ya quedo validado en pasos anteriores.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { evaluate, normalize } = require('./rnc-chain-invariant');
const { buildExclusions } = require('./rnc-promotion-collisions');
const { loadManualAnchors, stateFromLocalidad } = require('./rnc-promotion-collisions-run');
const { buildAlias, auditOutput } = require('./rnc-promoted-anchors');

// Confianza e incertidumbre IDENTICAS a las de las 37 anclas que la app ya acepta.
// Un poste RNC es un poste RNC, Promotion no lo hace mas fiable: si estos valores
// bajaran, las alertas promoverias menos informacion.
const CONFIDENCE = .78;
const UNCERTAINTY_M = 1500;

function run(gpkg, reviewFile, outFile, repo) {
  const review = JSON.parse(fs.readFileSync(reviewFile, 'utf8'));
  const db = new DatabaseSync(gpkg);

  const ids = new Set();
  for (const c of review.chains) for (const p of c.posts) ids.add(p.roadId);
  const want = new Set([...ids].map(Number));
  const roads = new Map();
  for (const r of db.prepare('select ID_RED,PEAJE,ADMINISTRA,NIVEL from red_vial').iterate()) {
    if (want.has(Number(r.ID_RED))) roads.set(Number(r.ID_RED), { toll: r.PEAJE === 'Si', admin: String(r.ADMINISTRA ?? '').trim(), nivel: r.NIVEL });
  }

  const result = evaluate(review, roads);
  const manual = loadManualAnchors(repo);

  // Escalon: cadenas sin ninguna marca. Las marcadas quedan fuera sin mirar por que:
  // algunas marcas son informativas y legitimas (estado de cuota, paso a desnivel) y
  // promoverlas exigiria decidir caso por caso.
  const clean = [];
  review.chains.forEach((c, i) => {
    if (result.chainReports[i].flags.length === 0) clean.push({ ...c, normalizedName: normalize(c.name) });
  });

  const { exclusions, kept } = buildExclusions(clean, manual);

  // El estado se resuelve por localidad, no se hereda del nombre del corredor: un
  // corredor largo lo atraviesa mas de un estado.
  const withState = kept.map(p => ({ ...p, ...stateFromLocalidad(db, p.lat, p.lon) }));
  const sinEstado = withState.filter(p => !p.state);

  // Un poste sin estado no puede defenderse contra un reporte con estado erroneo,
  // y resolveRncPost no podria filtrarlo. Se deja fuera.
  const conEstado = withState.filter(p => p.state);

  // Agrupar por corredor: el alias se deriva del nombre, y por eso todos los
  // corredores deben conocerse ANTES de derivar ninguno. Un alias escrito sin
  // conocer el resto puede capturar la cadena de otro, y eso no se ve hasta que se
  // instala en el indice.
  const corridors = new Map();
  for (const c of clean) {
    const k = `${c.code}|${c.normalizedName}`;
    if (!corridors.has(k)) corridors.set(k, { code: c.code, name: c.name, normalizedName: c.normalizedName, kms: [] });
  }
  const nombres = [...corridors.values()].map(c => c.name);

  // El alias vive UNA vez por corredor, no una vez por ancla. Repetirlo en las 724
  // entradas inflaba el archivo a 233 KB y hacia la revision manual inmanejable:
  // los 29 alias son lo unico que hay que leer para entender a quien cubre esto.
  //
  // El indice se asigna DESPUES de recolectar los km, no antes: un corredor puede
  // quedarse sin ningun poste promoted (si todos sus postes eran colisiones o no
  // tenian estado), y asignar indices antes de saber eso deja huecos en el archivo
  // de corredores, o peor, descarta anclas de un corredor que si los tiene.
  const anchors = [];
  for (const p of conEstado) {
    const c = corridors.get(`${p.code}|${normalize(p.name)}`);
    if (!c) continue;
    c.kms.push(p.km);
    anchors.push({
      corridor: c, // se resuelve a indice al final, cuando el orden ya es estable
      state: p.state,
      km: p.km,
      lat: p.lat,
      lon: p.lon,
      sourcePostId: p.id,
      sourceRoadId: p.roadId,
    });
  }
  db.close();

// Ahora que ya se sabe que corredores tienen km, el orden es estable y el indice
  // es contiguo: se asigna sobre los que quedan, no sobre los 29 nominales.
  const conKms = [...corridors.values()].filter(c => c.kms.length);
  conKms.sort((a, b) => a.code.localeCompare(b.code) || a.name.localeCompare(b.name));
  conKms.forEach((c, i) => { c.index = i; c.alias = buildAlias(c.name, nombres); });

  // Km repetidos dentro de un mismo corredor no pueden instalarse dos veces: el
  // indice exige unicidad por (cadena, km) y una fila repetida no aporta nada.
  const vistos = new Set();
  const duplicados = [];
  const unicos = [];
  for (const a of anchors) {
    const k = `${a.corridor.index}|${a.km}`;
    if (vistos.has(k)) { duplicados.push({ corridor: a.corridor.index, km: a.km, sourcePostId: a.sourcePostId }); continue; }
    vistos.add(k);
    unicos.push(a);
  }

  // A materializar para la auditoria: los alias como RegExp, igual que hace el worker.
  const paraAuditar = unicos.map(a => ({
    km: a.km,
    sourcePostId: a.sourcePostId,
    aliases: a.corridor.alias.map(src => new RegExp(src, 'i')),
  }));

  // La auditoria corre contra el indice PRODUCCION completo, no solo contra las
  // anclas nuevas. Un alias mal escrito no solo falla en su propio km: puede volver
  // ambiguo un km que hoy resuelve por una ancla revisada a mano, y ese km no esta
  // en la lista de promocion, asi que auditar solo las 724 no lo detectaria.
  const problemas = auditOutput(paraAuditar.concat(indiceExistente(repo)), conKms);

  const report = {
    step: '2_promocion',
    escribe_indice: problemas.length === 0,
    escalon: {
      chains: clean.length,
      corridors: corridors.size,
      postsBeforeExclusions: clean.reduce((s, c) => s + c.posts.length, 0),
      exclusions: exclusions.length,
      sinEstado: sinEstado.length,
      duplicados: duplicados.length,
      anchors: unicos.length,
    },
    problemas,
    corredores: conKms.map(c => ({
      index: c.index, code: c.code, name: c.name,
      km: c.kms.length, desde: Math.min(...c.kms), hasta: Math.max(...c.kms),
    })),
  };

  fs.writeFileSync(outFile, JSON.stringify(report, null, 1));

  // El archivo de produccion solo se escribe si la auditoria esta limpia.
  if (problemsClean(problemas)) {
    const dir = path.join(repo, 'worker');
    const corredorFile = path.join(dir, 'rnc-promoted-corridors.json');
    const anclaFile = path.join(dir, 'rnc-promoted.json');
    fs.writeFileSync(corredorFile, JSON.stringify(conKms.map(c => ({
      road: `${c.code} ${c.name}`,
      code: c.code,
      name: c.name,
      aliases: c.alias,
    })), null, 1) + '\n');
    fs.writeFileSync(anclaFile, JSON.stringify(unicos.map(a => ({
      corridor: a.corridor.index,
      state: a.state,
      km: a.km,
      lat: a.lat,
      lon: a.lon,
      sourcePostId: a.sourcePostId,
      sourceRoadId: a.sourceRoadId,
    })), null, 1) + '\n');
    report.escrito = [anclaFile, corredorFile];
  } else {
    report.escrito = null;
  }
  return report;
}

// Las anclas que ya estan en produccion, leidas del modulo del worker con sus
// mismos RegExp. No se reconstruyen desde los JSON: los alias manuales viven en
// rnc-km-anchors.js, y una copia aparte se desincronizaria sin que nada lo note.
function indiceExistente(repo) {
  const { anchorIndex } = require(path.join(repo, 'worker', 'rnc-km-anchors.js'));
  return anchorIndex
    .filter(a => !a.promoted)
    .map(a => ({ km: a.km, sourcePostId: a.sourcePostId, aliases: a.aliases }));
}

function problemsClean(problemas) {
  return !problemas.some(p => p.kind === 'km_sin_ancla' || p.kind === 'km_ambiguo');
}

if (require.main === module) {
  const [gpkg, reviewFile, outFile, repo] = process.argv.slice(2);
  if (!gpkg || !reviewFile || !outFile || !repo) {
    console.error('uso: node tools/rnc-promoted-anchors-run.js <gpkg> <review.json> <out.json> <repo>');
    process.exit(1);
  }
  const r = run(gpkg, reviewFile, outFile, repo);
  console.log(JSON.stringify({ escalon: r.escalon, escribe_indice: r.escribe_indice, problemas: r.problemas.length, escrito: r.escrito }, null, 1));
  // Salida distinta de cero si la auditoria falla: el CI debe verlo.
  if (!r.escribe_indice) process.exit(2);
}

module.exports = { run, problemsClean, CONFIDENCE, UNCERTAINTY_M };