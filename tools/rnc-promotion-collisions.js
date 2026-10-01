'use strict';

// Paso 1 de la promocion: las colisiones entre anclas revisadas a mano y postes
// RNC que el invariante de cadena consideraria promovibles.
//
// El problema que resuelve: resolveRncPost exige match UNICO y devuelve null si
// hay dos. Si un km aparece en el indice promoting y tambien en un archivo
// revisado a mano, una alerta que hoy resuelve pasaria a no resolver. Eso es una
// REGRESION silenciosa, no cobertura extra.
//
// Medido: las 10 colisiones coinciden a 0.0 m y comparten el mismo ID_KM. Las
// anclas manuales se derivaron de esos mismos postes, asi que no hay decision de
// coordenada que tomar: gana el ancla manual y el poste RNC se excluye por
// (corredor, km), nunca por rango, para que un km futuro no se cuele por descuido.

const { normalize } = require('./rnc-chain-invariant');

// Estructura de salida: una lista de claves (code, nombre normalizado, km) a
// excluir, con el ID del ancla manual que manda y el del poste RNC descartado.
function collisionKey(code, normalizedName, km) {
  return JSON.stringify([String(code), String(normalizedName), Number(km)]);
}

// Un corredor y un km identifican un poste. El codigo solo no alcanza: el 15
// cubre 39 secciones declaradas.
function isSamePost(a, b) {
  return Number(a.code) === Number(b.code) && String(a.normalizedName) === String(b.normalizedName) && Number(a.km) === Number(b.km);
}

function buildExclusions(promotedChains, manualAnchors) {
  // Indice manual por corredor: las anclas de formato {km,...} (sin nombre) se
  // agrupan por la familia a la que el llamador las asigna.
  const manualByCorridor = new Map();
  for (const m of manualAnchors) {
    const k = collisionKey(m.code, m.normalizedName, m.km);
    if (!manualByCorridor.has(k)) manualByCorridor.set(k, []);
    manualByCorridor.get(k).push(m);
  }

  const exclusions = [];
  const kept = [];
  for (const chain of promotedChains) {
    for (const post of chain.posts) {
      const k = collisionKey(chain.code, chain.normalizedName, post.km);
      const clash = manualByCorridor.get(k);
      if (clash && clash.length) {
        exclusions.push({
          code: String(chain.code),
          name: chain.name,
          // La clave normalizada viaja con la exclusion: sin ella el chequeo de
          // cobertura tendria que re-derivarla del nombre con otra regla, y dos
          // reglas de normalizacion divergen justo donde nadie mira.
          normalizedName: chain.normalizedName,
          km: post.km,
          rncPostId: post.id,
          manualPostId: clash[0].sourcePostId ?? clash[0].id ?? null,
          reason: 'duplicate_of_hand_reviewed_anchor',
        });
      } else {
        kept.push(post);
      }
    }
  }
  return { exclusions, kept };
}

// Una exclusion solo vale si el ancla manual que manda realmente cubre ese km.
// Si se rompe un archivo revisado a mano, la exclusion pasa a promotion y el
// invariante lo ve como colision, en vez de dejar un hueco silencioso.
function validateExclusions(exclusions, manualAnchors) {
  const covered = new Set(manualAnchors.map(m => collisionKey(m.code, m.normalizedName, m.km)));
  return exclusions.map(e => {
    const name = e.normalizedName ?? normalize(e.name);
    return { ...e, normalizedName: name, coveredByManualAnchor: covered.has(collisionKey(e.code, name, e.km)) };
  });
}

module.exports = { collisionKey, isSamePost, buildExclusions, validateExclusions };