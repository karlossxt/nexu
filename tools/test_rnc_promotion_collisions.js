'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { normalize } = require('./rnc-chain-invariant');
const { collisionKey, isSamePost, buildExclusions, validateExclusions } = require('./rnc-promotion-collisions');

// Los llamadores normalizan el nombre antes de indexarlo; los fixtures tambien,
// o el test compararia basura en vez de ejercitar el comportamiento real.
const chain = (code, name, posts) => ({ code, name, normalizedName: normalize(name), posts });
const manual = (code, name, km, sourcePostId) => ({ code, normalizedName: normalize(name), km, sourcePostId, lat: 1, lon: 2 });

test('collisionKey es univoco y no concatena ambigüamente', () => {
  // Si la clave fuera una concatenacion, '15'/'A B' y '15A'/'B' colisionarian.
  assert.notEqual(collisionKey('15', 'a b', 3), collisionKey('15a', 'b', 3));
  assert.equal(collisionKey('15', 'a b', 3), collisionKey('15', 'a b', 3));
  assert.equal(collisionKey('15', 'a b', 3), collisionKey('15', 'a b', '3'), 'el km numerico debe normalizarse');
});

test('el codigo solo no identifica un poste', () => {
  const a = { code: '15', normalizedName: 'atlacomulco zapotlanejo', km: 100 };
  const b = { code: '15', normalizedName: 'otro tramo', km: 100 };
  assert.ok(!isSamePost(a, b), 'el 15 cubre 39 secciones: el nombre es parte de la identidad');
  assert.ok(isSamePost(a, { ...a }));
});

test('una colision excluye el poste y conserva el resto', () => {
  const { exclusions, kept } = buildExclusions(
    [chain('150', 'Acatzingo - Ciudad Mendoza', [{ km: 197, id: 3976 }, { km: 198, id: 3977 }, { km: 199, id: 3978 }])],
    [manual('150', 'Acatzingo - Ciudad Mendoza', 197, 3976)]
  );
  assert.equal(exclusions.length, 1);
  assert.equal(exclusions[0].km, 197, 'solo el km en choque se excluye');
  assert.equal(exclusions[0].reason, 'duplicate_of_hand_reviewed_anchor');
  assert.deepEqual(kept.map(p => p.km), [198, 199], 'los postes libres siguen adelante');
});

test('sin colision, nada se excluye', () => {
  const { exclusions, kept } = buildExclusions(
    [chain('95', 'Cuernavaca - Acapulco', [{ km: 300, id: 1 }])],
    [manual('95', 'Cuernavaca - Acapulco', 247, 1237)]
  );
  assert.equal(exclusions.length, 0);
  assert.equal(kept.length, 1);
});

test('el nombre se compara normalizado, no literal', () => {
  // El archivo manual escribe "Nuevo Teapa – Cosoleacaque" con en dash y el
  // review trae el mismo tramo. Sin normalizar, la colision se pierde y el km 7
  // se promoveria dos veces.
  const { exclusions } = buildExclusions(
    [chain('180', 'Nuevo Teapa – Cosoleacaque', [{ km: 7, id: 6658 }])],
    [manual('180', 'Nuevo Teapa - Cosoleacaque', 7, 6658)]
  );
  assert.equal(exclusions.length, 1, 'el guion debe un dash no puede hacer perder la colision');
});

test('la exclusion exige que el ancla manual siga cubriendo ese km', () => {
  const { exclusions } = buildExclusions(
    [chain('150', 'A', [{ km: 197, id: 3976 }, { km: 198, id: 3977 }])],
    [manual('150', 'A', 197, 3976)]
  );
  const checked = validateExclusions(exclusions, [manual('150', 'A', 197, 3976)]);
  assert.equal(checked[0].coveredByManualAnchor, true);

  // Si el archivo manual pierde ese km, la exclusion queda huerfana y debe
  // notarse: es un hueco, no una exclusion legitima.
  const orphan = validateExclusions(exclusions, []);
  assert.equal(orphan[0].coveredByManualAnchor, false);
});

test('varias colisiones del mismo corredor se resuelven km por km', () => {
  const { exclusions, kept } = buildExclusions(
    [chain('95', 'Cuernavaca - Acapulco', [247, 248, 249, 250, 300].map(km => ({ km, id: 1000 + km })))],
    [247, 248, 249, 250].map(km => manual('95', 'Cuernavaca - Acapulco', km, 1000 + km))
  );
  assert.equal(exclusions.length, 4);
  assert.deepEqual(exclusions.map(e => e.km).sort((a, b) => a - b), [247, 248, 249, 250]);
  assert.deepEqual(kept.map(p => p.km), [300], 'km 300 no se toca por estar cerca de los excluidos');
});