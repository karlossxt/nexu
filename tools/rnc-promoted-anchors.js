'use strict';

// Paso 2 de la promocion: de cadenas de postes RNC a anclas de produccion.
//
// Aqui no se decide NINGUNA coordenada. Cada punto de la salida es un poste que
// el RNC ya localizo y que los pasos anteriores ya declararon promovible. Lo que
// este modulo hace es traducirlos al formato que resolveRncPost() consume, y
// sobre todo garantizar que ese formato no se rompa a si mismo.
//
// El riesgo real no es la coordenada, es la AMBIGUEDAD. resolveRncPost exige
// match UNICO: si dos anclas matchean el mismo (carretera, km) devuelve null. Una
// ancla nueva mal escrita no anade cobertura, DESTRUYE la que ya habia, en
// silencio. Por eso los alias se derivan con reglas que se pueden auditar y el
// solapamiento se mide antes de escribir el archivo.

// Un guion puede llegar como - (ASCII), – (en dash) o — (em dash). Los tres
// aparecen en datos reales, y el normalizador los convierte todos a texto plano.
const DASHES = '[-–—]?';
// Abreviaturas de toponimos, en AMBAS direcciones.
//
// El RNC no es consistente: escribe "Ent. Tulancingo" pero "Acatzingo - Ciudad
// Mendoza". Las noticias hacen lo contrario, y escriben "Cd. Mendoza" todo el tiempo.
// Si el patron solo acepta la forma que el RNC uso, el indice deja de resolver el
// corredor justo en la grafia dominante de los reportes, y el fallo es invisible:
// el km no aparece en ninguna lista de errores, simplemente nunca resuelve.
//
// Por eso la tabla declara las dos formas y `wordPattern` acepta las dos, sin
// importar cual de las dos escribió el RNC. El canonical es solo para COMPARAR
// nombres entre si, no para construir el patron.
const WORD_ABBREVIATIONS = [
  { re: /^(?:ent\.?|entrada)$/i, short: 'Ent\\.?', long: 'Entrada', canonical: 'entrada' },
  { re: /^(?:cd\.?|ciudad)$/i, short: 'Cd\\.?', long: 'Ciudad', canonical: 'ciudad' },
];
// Palabras que el clasificador antepone y que no cambian el corredor.
const ROAD_PREFIX = /^(?:autopista|carretera|carretero)\s+(?:federal\s+|federale\s+|estatal\s+|estatale\s+)?/i;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Los toponimos del RNC van acentuados ("Cancún", "Lázaro Cárdenas") y las noticias
// no siempre ("Cancun", "Lazaro Cardenas"). La diferencia no es decorativa: con el
// acento, `/Cancún/i` NO matchea "Cancun", y el indice deja de resolver el corredor
// en la grafia que aparece en la mitad de los reportes.
//
// Medido: 363 de las 724 anclas promovidas estan en corredores con al menos un
// caracter acentuado, o sea la mitad del bloque. Por eso cada vocal acentuada se
// convierte en una clase de caracteres que acepta las dos formas, en vez de
// normalizar el nombre: normalizar solo arreglaria una de las dos direcciones.
//
// La tolerancia es en UN sentido, y a proposito: el RNC nombra los topimos con
// acento (64 de sus 127 cadenas lo traen) y lo que falla es que la noticia lo
// PIERDA. Al reves no hay evidencia --ningun corredor del RNC esta escrito sin
// acento donde el topimo real lo lleva-- y hacerlo bidireccional convertiria cada
// vocal de los 29 alias en una clase, dejando un archivo que nadie puede revisar a
// ojo. Si algun dia aparece ese caso, la medicion que lo delata es esta misma.
const ACCENTED = { 'á': 'a', 'é': 'e', 'í': 'i', 'ó': 'o', 'ú': 'u', 'ñ': 'n' };

// Escapa para regex y ademas vuelve tolerante a la falta de acento. Se aplica a
// cualquier palabra del nombre, no solo a las que se sabe acentuadas: un toponimo
// puede traer un caracter que no esta en la tabla y ese caso se comporta como
// antes, sin romper.
function accentTolerantEscape(s) {
  let out = '';
  for (const ch of s) {
    const lower = ch.toLowerCase();
    const plain = ACCENTED[lower];
    if (plain === undefined) { out += escapeRe(ch); continue; }
    const upper = ch === lower ? ch : ch.toUpperCase();
    out += `[${plain}${lower}${upper}]`;
  }
  return out;
}

// De "Ent. Tulancingo - Venta Grande" a una lista de palabras, sin el guion.
// El guion se acepta SIN espacios alrededor porque "Cuernavaca-Acapulco" es la
// forma mas comun en las noticias, y el RNC lo escribe con espacios. Un guion
// pegado a una palabra tambien puede ser parte de un topónimo ("Mérida-Cancún"
// lo es, pero "Guadalajara-Colima" tambien), asi que la regla es simple y
// explicita: cualquier guion, con o sin espacios, separa extremos del corredor.
function splitCorridor(name) {
  return String(name)
    .split(/\s*[-–—]\s*/)
    .map(w => w.trim())
    .filter(Boolean);
}

function nameWords(name) {
  return splitCorridor(name).flatMap(part => part.split(/\s+/).filter(Boolean));
}

// Una palabra abreviada genera SIEMPRE las dos formas, sin importar cual escribio
// el RNC. El punto final de la forma corta se marca opcional antes de escapar:
// escapar despues convertiria el "." en "\." y un reemplazo posterior lo duplicaria
// en "\\.?", que en regex es una barra literal seguida de cualquier cosa.
function wordPattern(word) {
  const abbr = WORD_ABBREVIATIONS.find(a => a.re.test(word));
  if (!abbr) return accentTolerantEscape(word).replace(/\s+/g, '\\s+');
  return `(?:${abbr.short}|${accentTolerantEscape(abbr.long)})`;
}

function wordsToPattern(words) {
  return words.map(wordPattern).join(`\\s*${DASHES}\\s*`);
}

// Version de comparacion, sin regex: sirve para decidir si dos nombres describen el
// mismo corredor. Minuscula siempre, porque comparar "Ent." con "Entrada" debe dar
// IGUALES y la capitalizacion del RNC no debe crear dos claves para un corredor.
function canonicalWord(word) {
  const abbr = WORD_ABBREVIATIONS.find(a => a.re.test(word));
  return (abbr ? abbr.canonical : word).toLowerCase();
}

// Un corredor son dos extremos. Se generan las dos direcciones porque las
// noticias nombran el corredor en cualquiera de los dos sentidos.
function aliasDirections(originalName) {
  const parts = splitCorridor(originalName);
  if (parts.length < 2) {
    const words = nameWords(originalName);
    return words.length ? [wordsToPattern(words)] : [];
  }
  // Cada extremo aporta varias palabras: "Ent. Tulancingo" son dos, no una. Se
  //acharcan por palabra, no por parte del corredor.
  if (parts.length !== 2) return [wordsToPattern(nameWords(originalName))];
  return [wordsToPattern([...nameWords(parts[0]), ...nameWords(parts[1])]),
          wordsToPattern([...nameWords(parts[1]), ...nameWords(parts[0])])];
}

// Palabras que otro corredor anade al final de este nombre. Sirven para negar la
// forma corta: sin esto, el alias de "Mexico - Cuernavaca" matchearia la cadena
// "Mexico - Cuernavaca Cuota" y la ancla de cuota nunca resolveria, porque el
// indice devolveria dos candidatas... o Peor, resolveria el tramo equivocado.
function extensionWords(originalName, allNames) {
  const mine = nameWords(originalName);
  const mineKey = mine.map(canonicalWord).join(' ');
  const out = new Set();
  for (const other of allNames) {
    if (other === originalName) continue;
    const ow = nameWords(other).map(canonicalWord);
    if (ow.length <= mine.length) continue;
    // Solo si es ESTE nombre seguido de mas palabras, no si comparte prefijo por casualidad.
    if (ow.slice(0, mine.length).join(' ') !== mineKey) continue;
    // La palabra se devuelve con su ESCRITURA ORIGINAL, no la canonica: la
    // negacion acaba en un patron de indice de produccion y ahi se lee mejor el
    // nombre tal como lo escribio el RNC.
    const extrasOriginales = nameWords(other);
    for (let i = mine.length; i < ow.length; i++) {
      const original = extrasOriginales[i];
      if (!mine.map(canonicalWord).includes(ow[i])) out.add(original);
    }
  }
  return [...out];
}

function buildAlias(originalName, allNames) {
  const extras = extensionWords(originalName, allNames);
  // La negacion va al final del patron: "mexico cuernavaca" seguido de "cuota" no
  // es este corredor. Se aplica a las dos direcciones por igual.
  // El sufijo se escapa literal, no tolerante a acentos: "Cuota" no lleva acento y
// negarlo en su forma exacta es lo que evita que el nombre corto capture al largo.
// El .map lleva flecha explicita porque escapeRe recibe un solo argumento y map le
// pasa tambien el indice: si manana admite un segundo parametro, esto se rompe.
  const guard = extras.length ? `(?![\\s${DASHES}]*(?:${extras.map(w => escapeRe(w)).join('|')})\\b)` : '';
  return aliasDirections(originalName).map(p => p + guard);
}

// Todo lo que resolveRncPost filtra ANTES de mirar el indice. Se replica aqui para
// que el generador pueda afirmar, sobre su propia salida, lo mismo que afirmara
// el worker. Si estas reglas cambian, este modulo queda obsoleto a proposito: es
// la unica copia que puede desincronizarse sin que nada lo note.
function passesRoadGuards(road) {
  const value = String(road || '').trim();
  if (!value) return false;
  if (/\blibre\b/i.test(value)) return false;
  if (/\b(?:54|150)\b/i.test(value) && !/\b(?:54D|150D)\b/i.test(value) && !/autopista/i.test(value)) return false;
  return true;
}

// Cuantas anclas matchearia un (carretera, km) concreto. resolveRncPost exige
// exactamente una; este es el numero que decide si la salida es utilizable.
function matchCount(anchors, road, km) {
  if (!passesRoadGuards(road)) return 0;
  let n = 0;
  for (const a of anchors) {
    if (a.km !== km) continue;
    if (a.aliases.some(re => re.test(road))) n++;
  }
  return n;
}

// Una salida es sana si, para cada (corredor, km) que se QUIERE promover, la
// cadena de carretera del corredor matchea exactamente una ancla: la suya.
//
// Se auditan las anclas REALES, no las que este modulo reconstruiria a partir del
// nombre. Si se reconstruyeran, la auditoria solo podria confirmar que el
// generador es coherente consigo mismo, y no detectaria el fallo que de verdad
// importa: dos anclas escritas a mano que se pisan entre si. Por eso recibe
// `anchors` con sus alias ya materializados.
//
// Tampoco basta con exigir "no hay dos": el fallo silencioso real es un km que se
// queda SIN ancla, y ese no aparece en ningun recuento de colisiones.
function auditOutput(anchors, corridors) {
  const problems = [];
  const samplesFor = c => [...new Set([
    c.name,
    c.name.replace(/\s*[-–—]\s*/g, ' '),
    c.name.split(/\s*[-–—]\s*/).reverse().join(' - '),
  ])];

  // Dos auditorias distintas, porque los dos fallos son distintos y uno de ellos
  // solo puede darse sobre el indice completo.
  //
  // 1) HUECO: un (corredor, km) que se quiere promover no tiene ancla. Se revisa
  //    cada corredor contra sus propios km.
  for (const c of corridors) {
    for (const km of c.kms) {
      for (const road of samplesFor(c)) {
        const n = matchCount(anchors, road, km);
        if (n === 0) problems.push({ kind: 'km_sin_ancla', corridor: `${c.code}|${c.name}`, km, road, matches: 0, rivals: [] });
      }
    }
  }

  // 2) AMBIGUEDAD: una cadena captura mas de una ancla. Se prueba cada cadena de
  //    cualquier corredor contra TODOS los km del indice, no solo los suyos: un
  //    alias nuevo puede volver ambiguo un km que ya resolvia y que no pertenece
  //    a la lista de promocion. Sin este barrido, contaminar "Mexico - Cuernavaca
  //    Cuota" con el alias de "Mexico - Cuernavaca" pasaria desapercibido.
  const roads = [...new Set(corridors.flatMap(samplesFor))];
  const allKms = [...new Set(anchors.map(a => a.km))];
  for (const road of roads) {
    for (const km of allKms) {
      const n = matchCount(anchors, road, km);
      if (n <= 1) continue;
      problems.push({
        kind: 'km_ambiguo', km, road, matches: n,
        rivals: anchors.filter(a => a.km === km && a.aliases.some(re => re.test(road)))
          .map(a => a.roadId ?? a.sourcePostId ?? null),
      });
    }
  }
  return problems;
}

module.exports = {
  DASHES, ROAD_PREFIX, WORD_ABBREVIATIONS,
  escapeRe, accentTolerantEscape, splitCorridor, nameWords, canonicalWord, wordPattern, wordsToPattern,
  aliasDirections, extensionWords, buildAlias,
  passesRoadGuards, matchCount, auditOutput,
};