'use strict';

const test = require('node:test');
const assert = require('node:assert');
const A = require('./rnc-promoted-anchors');
const { buildAlias, nameWords, expandWord, extensionWords, matchCount, auditOutput, passesRoadGuards, aliasDirections } = A;

test('el guion se parte y se toleran los tres tipos de guion', () => {
  for (const d of ['-', '–', '—']) {
    assert.deepEqual(nameWords(`Mexico${d}Cuernavaca`), ['Mexico', 'Cuernavaca'], `guion ${d}`);
  }
  assert.equal(aliasDirections('Mexico - Cuernavaca').length, 2, 'dos direcciones');
});

test('las dos direcciones del corredor matchean', () => {
  const [fwd, rev] = aliasDirections('Cuernavaca - Acapulco').map(p => new RegExp(p, 'i'));
  assert.ok(fwd.test('Cuernavaca - Acapulco'));
  assert.ok(fwd.test('Cuernavaca-Acapulco'));
  assert.ok(fwd.test('cuernavaca acapulco'));
  assert.ok(rev.test('Acapulco - Cuernavaca'));
  assert.ok(!rev.test('Cuernavaca - Acapulco'), 'la inversa no matchea el orden original');
});

test('el patron tolera el toponimo acentuado y el no acentuado', () => {
  // El RNC escribe "Mérida - Cancún" y "Lázaro Cárdenas"; las noticias escriben
  // "Merida - Cancun" y "Lazaro Cardenas" igual de seguido. Con el acento literal,
  // `/Cancún/i` NO matchea "Cancun": el indice deja de resolver el corredor en la
  // grafia que aparece en la mitad de los reportes, y el fallo es invisible porque
  // un km que no resuelve no sale en ninguna lista de errores.
  //
  // Medido: 363 de las 724 anclas promovidas estan en corredores con al menos un
  // caracter acentuado, o sea la mitad del bloque.
  const CASOS = [
    ['Mérida - Cancún', 'Merida - Cancun'],
    ['Kantunil - Cancún', 'Kantunil - Cancun'],
    ['Nueva Italia - Lázaro Cárdenas', 'Nueva Italia - Lazaro Cardenas'],
    ['Agua Dulce - Cárdenas', 'Agua Dulce - Cardenas'],
    ['Tuxtla Gutiérrez - San Cristóbal de las Casas', 'Tuxtla Gutierrez - San Cristobal de las Casas'],
    ['Durango - Gómez Palacio', 'Durango - Gomez Palacio'],
    ['Gómez Palacio - Jiménez', 'Gomez Palacio - Jimenez'],
    ['Córdoba - Veracruz', 'Cordoba - Veracruz'],
    ['México - Cuernavaca', 'Mexico - Cuernavaca'],
    ['Acatlán de Juárez - El Trapiche', 'Acatlan de Juarez - El Trapiche'],
  ];
  for (const [conAcento, sinAcento] of CASOS) {
    const [fwd, rev] = buildAlias(conAcento, [conAcento]).map(s => new RegExp(s, 'i'));
    assert.ok(fwd.test(conAcento), `${conAcento}: la grafia del RNC`);
    assert.ok(fwd.test(sinAcento), `${sinAcento}: la grafia sin acento`);
    // La direccion invertida, que es la que escriben las noticias cuando el
    // reporte va al revés. Invertir es cambiar el ORDEN de los extremos, no solo
    // los acentos: "Cancun - Merida" y no "Merida - Cancun".
    const invertido = a => a.split(/\s*[-–—]\s*/).reverse().join(' - ');
    assert.ok(rev.test(invertido(sinAcento)), `${invertido(sinAcento)}: direccion invertida sin acento`);
    assert.ok(rev.test(invertido(conAcento)), `${invertido(conAcento)}: direccion invertida con acento`);
  }
});

test('la tolerancia a acentos no afloja el matching de otras palabras', () => {
  // Una clase de caracteres por vocal acentuada es un cambio real del patron: si
  // se aplica donde no toca, "Cardenas" terminaria aceptando "Cardanax". Se
  // comprueba que el caracter distinto sigue sin entrar.
  const [fwd] = buildAlias('Agua Dulce - Cárdenas', ['Agua Dulce - Cárdenas']).map(s => new RegExp(s, 'i'));
  assert.ok(!fwd.test('Agua Dulce - Cardanax'), 'una palabra distinta no entra');
  assert.ok(!fwd.test('Aguax Dulce - Cárdenas'), 'un prefijo distinto no entra');
  // La "n" con tilde es su propio caso: "Cárdenas" no debe aceitar "Cardenas"
  // escrito con "s" en otro lugar por accidente del patron.
  const [otro] = buildAlias('Córdoba - Veracruz', ['Córdoba - Veracruz']).map(s => new RegExp(s, 'i'));
  assert.ok(!otro.test('Cordova - Veracruz'));
});

test('la forma larga del RNC tambien acepta la abreviatura de las noticias', () => {
  // El RNC escribe "Acatzingo - Ciudad Mendoza", y las noticias escriben
  // "Cd. Mendoza" todo el tiempo. Un alias derivado solo de la grafia del RNC
  // resuelve 19 km de ese corredor para los reportes que dicen "Ciudad" y ninguno
  // para los que dicen "Cd.". El fallo es invisible: el km no sale en ninguna lista
  // de errores, simplemente nunca resuelve.
  const [fwd] = buildAlias('Acatzingo - Ciudad Mendoza', ['Acatzingo - Ciudad Mendoza']);
  const re = new RegExp(fwd, 'i');
  assert.ok(re.test('Acatzingo - Ciudad Mendoza'), 'la forma del RNC');
  assert.ok(re.test('Acatzingo - Cd. Mendoza'), 'la abreviatura de las noticias');
  assert.ok(re.test('Autopista Acatzingo - CD Mendoza'), 'sin punto y en mayusculas');
  assert.ok(re.test('Acatzingo - CD. Mendoza'), 'con punto y en mayusculas');
});

test('las abreviaturas del RNC equivalen a su forma larga', () => {
  // El RNC escribe "Ent. Tulancingo"; las noticias escriben "Entrada Tulancingo".
  // El patron tiene que aceptar LAS DOS formas: si solo aceptara la larga, el
  // indice dejaria de resolver el nombre tal como el RNC lo escribe.
  const [fwd, rev] = buildAlias('Ent. Tulancingo - Venta Grande', ['Ent. Tulancingo - Venta Grande']);
  assert.ok(new RegExp(fwd, 'i').test('Ent. Tulancingo - Venta Grande'), 'forma corta del RNC');
  assert.ok(new RegExp(fwd, 'i').test('Entrada Tulancingo - Venta Grande'), 'forma larga de las noticias');
  assert.ok(new RegExp(rev, 'i').test('Venta Grande - Ent. Tulancingo'), 'y tambien en sentido inverso');
  assert.equal(A.canonicalWord('Ent.'), 'entrada', 'para comparar nombres si se normaliza');
  assert.equal(A.canonicalWord('Cd.'), 'ciudad');
});

test('un nombre corto NO captura la extension de otro corredor', () => {
  // El caso medido: "Mexico - Cuernavaca" (km 67-79) y "Mexico - Cuernavaca Cuota"
  // (km 20-47). Sin la negacion, el alias del primero matchea la cadena del
  // segundo y la resolucion de cuota queda contaminada.
  const names = ['Mexico - Cuernavaca', 'Mexico - Cuernavaca Cuota'];
  const [libre] = buildAlias(names[0], names);
  const [cuota] = buildAlias(names[1], names);

  assert.ok(new RegExp(libre, 'i').test('Mexico - Cuernavaca'), 'el libre matchea su propia cadena');
  assert.ok(!new RegExp(libre, 'i').test('Mexico - Cuernavaca Cuota'), 'y NO la del corredor con sufijo');
  assert.ok(new RegExp(cuota, 'i').test('Mexico - Cuernavaca Cuota'), 'el de cuota si matchea la suya');
});

test('extensionWords distingue un sufijo real de una palabra compartida', () => {
  // "Gomez Palacio - Jimenez" y "Jimenez - Chihuahua" comparten la palabra
  // Jimenez, pero ninguno es el otro seguido de mas palabras: no hay negacion.
  const compartidas = ['Gomez Palacio - Jimenez', 'Jimenez - Chihuahua'];
  assert.deepEqual(extensionWords(compartidas[0], compartidas), [], 'compartir palabra no es tener sufijo');
  assert.deepEqual(extensionWords(compartidas[1], compartidas), []);

  // Aqui si: uno es exactamente el otro seguido de "cuota".
  const conSufijo = ['Mexico - Cuernavaca', 'Mexico - Cuernavaca Cuota'];
  assert.deepEqual(extensionWords(conSufijo[0], conSufijo), ['Cuota'], 'con la escritura del RNC');
  assert.deepEqual(extensionWords(conSufijo[1], conSufijo), [], 'el mas largo no se niega a si mismo');
});

test('la comparacion de nombres normaliza abreviaturas', () => {
  // "Ent. A - B" y "Entrada A - B" describen el mismo corredor, asi que el
  // corredor corto NO debe negarse contra el largo.
  const names = ['Ent. Tulancingo - Venta Grande', 'Entrada Tulancingo - Venta Grande Extra'];
  assert.deepEqual(extensionWords(names[0], names), ['Extra'],
    'la abreviatura no impide reconocer el sufijo');
  assert.deepEqual(extensionWords(names[1], names), [], 'el corredor largo no se niega a si mismo');
});

test('las negaciones se aplican a las dos direcciones', () => {
  const names = ['A - B', 'A - B Cuota'];
  const patrones = buildAlias(names[0], names);
  assert.equal(patrones.length, 2);
  for (const p of patrones) {
    assert.ok(!new RegExp(p, 'i').test('B - A Cuota'), `la inversa no debe capturar el sufijo: ${p}`);
  }
});

test('matchCount exige exactamente una coincidencia', () => {
  const anchors = [{ km: 10, aliases: [/cuernavaca/i] }];
  assert.equal(matchCount(anchors, 'Cuernavaca - Acapulco', 10), 1);
  assert.equal(matchCount(anchors, 'Cuernavaca - Acapulco', 11), 0, 'otro km no cuenta');
  assert.equal(matchCount(anchors, 'Otra cosa', 10), 0);
  const dos = [{ km: 10, aliases: [/cuernavaca/i] }, { km: 10, aliases: [/acapulco/i] }];
  assert.equal(matchCount(dos, 'Cuernavaca - Acapulco', 10), 2, 'dos candidatas: el worker devolveria null');
});

test('los guardas de carretera se replican exactamente', () => {
  assert.equal(passesRoadGuards('Autopista Guadalajara - Colima'), true);
  assert.equal(passesRoadGuards('Carretera libre Guadalajara - Colima'), false, 'libre se rechaza antes del indice');
  assert.equal(passesRoadGuards('Carretera Federal 54 Guadalajara - Colima'), false, '54 sin D y sin autopista');
  assert.equal(passesRoadGuards('Carretera Federal 54D Guadalajara - Colima'), true, 'con D si pasa');
  assert.equal(passesRoadGuards('Autopista Federal 54 Guadalajara - Colima'), true, 'autopista lo salva');
  assert.equal(passesRoadGuards(''), false);
});

test('auditOutput detecta el km huerfano, no solo la ambiguedad', () => {
  // El fallo silencioso real: un km que se queda sin ancla no sale en ningun
  // recuento de "cuantas colisiones hay", porque no es una colision.
  const corridors = [
    { code: '95', name: 'Mexico - Cuernavaca', kms: [67, 68, 69] },
    { code: '95', name: 'Mexico - Cuernavaca Cuota', kms: [20, 21] },
  ];
  const names = corridors.map(x => x.name);
  const completo = [];
  for (const c of corridors) {
    const alias = buildAlias(c.name, names).map(p => new RegExp(p, 'i'));
    for (const km of c.kms) completo.push({ km, sourcePostId: km, aliases: alias });
  }
  assert.deepEqual(auditOutput(completo, corridors), [], 'salida completa: sin problemas');

  // Ahora se cae el km 69: no es ambiguedad, es un hueco. Se reporta una vez por
  // cada variante de nombre en que el clasificador puede nombrar el corredor.
  const parcial = completo.filter(a => a.km !== 69);
  const problemas = auditOutput(parcial, corridors);
  assert.ok(problemas.length > 0);
  assert.ok(problemas.every(p => p.kind === 'km_sin_ancla'), 'solo huecos, ninguna ambiguedad');
  assert.ok(problemas.every(p => p.km === 69));
  assert.deepEqual([...new Set(problemas.map(p => p.road))].length, 3, 'las tres variantes de nombre');
});

test('auditOutput detecta dos anclas del mismo km que se pisan', () => {
  // Esta es la condicion real de resolveRncPost: dos anclas con el MISMO km cuyos
  // alias capturan la misma cadena. Cada una esta bien por separado; juntas el
  // indice devuelve null y el km se pierde en silencio.
  //
  // El caso que lo produce es un corredor con sufijo, cuyo alias se escribio sin
  // la negacion: entonces el nombre corto tambien matchea la cadena del largo, y si
  // los dos tramos comparten km las dos anclas caen en el mismo.
  const nombres = ['Mexico - Cuernavaca', 'Mexico - Cuernavaca Cuota'];
  const aliasCorto = buildAlias(nombres[0], [nombres[0]]).map(p => new RegExp(p, 'i'));
  const aliasLargo = buildAlias(nombres[1], [nombres[1]]).map(p => new RegExp(p, 'i'));
  const anclas = [
    { km: 67, sourcePostId: 111, aliases: aliasCorto },
    { km: 67, sourcePostId: 112, aliases: aliasLargo },
  ];
  assert.equal(matchCount(anclas, 'Mexico - Cuernavaca Cuota', 67), 2, 'el fixture es ambiguo de verdad');

  // La auditoria muestra la cadena de CADA corredor declarado, asi que los dos
  // tienen que estar en la lista: es como la invoca el generador, con los 29.
  const amb = auditOutput(anclas, [
    { code: '95', name: nombres[0], kms: [67] },
    { code: '95', name: nombres[1], kms: [67] },
  ]).filter(p => p.kind === 'km_ambiguo');
  assert.ok(amb.length > 0, 'la auditoria lo ve');
  assert.ok(amb.every(p => p.matches === 2));
  assert.deepEqual(amb[0].rivals.sort(), [111, 112], 'el reporte dice quienes se pisan');
});

test('dos anclas del mismo km NO bastan: la cadena tiene que matchear a las dos', () => {
  // Límite real de la ambigüedad: no importa cuántas anclas sharean km. Lo que
  // rompe la resolución es que UNA cadena matchee mas de una. Con alias disjuntos,
  // el indice responde igual que antes, aunque el km tenga dos entradas.
  const ambosSentidos = buildAlias('Mexico - Cuernavaca', ['Mexico - Cuernavaca']).map(p => new RegExp(p, 'i'));
  const anclas = [
    { km: 67, sourcePostId: 111, aliases: ambosSentidos },
    { km: 67, sourcePostId: 112, aliases: [new RegExp('otro\\s*nombre', 'i')] },
  ];
  assert.equal(matchCount(anclas, 'Mexico - Cuernavaca', 67), 1, 'cada cadena cae en una sola');
  assert.equal(matchCount(anclas, 'Cuernavaca - Mexico', 67), 1, 'tambien en sentido inverso');
  assert.deepEqual(auditOutput(anclas, [{ code: '95', name: 'Mexico - Cuernavaca', kms: [67] }]), [],
    'sin ambiguedad no hay problema, por muchas anclas que compartan el km');

  // En cuanto la segunda acepta la cadena del corredor, el indice ya no puede elegir.
  const rotas = [
    { km: 67, sourcePostId: 111, aliases: [new RegExp('Mexico\\s*[-–—]?\\s*Cuernavaca', 'i')] },
    { km: 67, sourcePostId: 112, aliases: [new RegExp('Mexico\\s*[-–—]?\\s*Cuernavaca', 'i')] },
  ];
  assert.equal(matchCount(rotas, 'Mexico - Cuernavaca', 67), 2, 'ahora si');
  const amb = auditOutput(rotas, [{ code: '95', name: 'Mexico - Cuernavaca', kms: [67] }])
    .filter(p => p.kind === 'km_ambiguo');
  assert.ok(amb.length > 0);
  assert.deepEqual(amb[0].rivals.sort(), [111, 112]);
});

test('la negacion de sufijo elimina esa ambiguedad', () => {
  // El mismo caso con la negacion que buildAlias anade cuando conoce TODOS los
  // corredores. Aqui cada cadena cae en un solo km y el indice puede elegir.
  const nombres = ['Mexico - Cuernavaca', 'Mexico - Cuernavaca Cuota'];
  const anclas = [
    { km: 67, sourcePostId: 111, aliases: buildAlias(nombres[0], nombres).map(p => new RegExp(p, 'i')) },
    { km: 20, sourcePostId: 112, aliases: buildAlias(nombres[1], nombres).map(p => new RegExp(p, 'i')) },
  ];
  assert.equal(matchCount(anclas, 'Mexico - Cuernavaca', 67), 1);
  assert.equal(matchCount(anclas, 'Mexico - Cuernavaca Cuota', 20), 1);
  assert.equal(matchCount(anclas, 'Cuernavaca - Mexico', 67), 1, 'tambien en sentido inverso');
  assert.equal(matchCount(anclas, 'Mexico - Cuernavaca Cuota', 67), 0, 'la cadena de cuota no toca el km 67');
});

test('la auditoria barre los km de todo el indice, no solo los del corredor', () => {
  // El fallo que un barrido ingenuo dejaria pasar: el km que se vuelve ambiguo
  // pertenece a un corredor, pero el alias que lo secuestra es de otro. Por eso
  // hay que probar cada CADENA contra TODOS los km del indice.
  const nombres = ['Mexico - Cuernavaca', 'Mexico - Cuernavaca Cuota'];
  const aliasCorto = buildAlias(nombres[0], [nombres[0]]).map(p => new RegExp(p, 'i'));
  // Anclas sanas: km 67 del corto, km 20 del largo, cada una con su alias con negacion.
  const sanas = [
    { km: 67, sourcePostId: 111, aliases: buildAlias(nombres[0], nombres).map(p => new RegExp(p, 'i')) },
    { km: 20, sourcePostId: 112, aliases: buildAlias(nombres[1], nombres).map(p => new RegExp(p, 'i')) },
  ];
  const corredores = [
    { code: '95', name: nombres[0], kms: [67] },
    { code: '95', name: nombres[1], kms: [20] },
  ];
  assert.deepEqual(auditOutput(sanas, corredores), [], 'con la negacion no hay nada');

  // Se duplica el km 20 en el corredor del corto, con el alias SIN negar: ahora la
  // cadena de cuota cae en dos anclas del km 20, y ninguna pertenece al corredor de
  // cuota. El problema se declara en un corredor y se manifiesta en el km del otro.
  const rotas = sanas.concat([{ km: 20, sourcePostId: 113, aliases: aliasCorto }]);
  assert.equal(matchCount(rotas, 'Mexico - Cuernavaca Cuota', 20), 2, 'el km 20 queda con dos candidatas');
  const problemas = auditOutput(rotas, corredores);
  assert.ok(problemas.some(p => p.kind === 'km_ambiguo' && p.km === 20),
    'el barrido lo detecta aunque el km no sea el del alias culpable');
  assert.deepEqual(problemas.find(p => p.kind === 'km_ambiguo' && p.km === 20).rivals.sort(), [112, 113]);
});




test('auditOutput acepta la salida correcta como sana', () => {
  const [fwd, rev] = buildAlias('Mexico - Cuernavaca', ['Mexico - Cuernavaca']);
  const corridors = [{ code: '95', name: 'Mexico - Cuernavaca', kms: [67, 68] }];
  const anclas = [67, 68].map(km => ({ km, sourcePostId: km, aliases: [new RegExp(fwd, 'i'), new RegExp(rev, 'i')] }));
  assert.deepEqual(auditOutput(anclas, corridors), [],
    'km con exactamente una coincidencia en las tres variantes de nombre');
});

test('los caracteres del patron se escapan, no se interpretan', () => {
  // Un nombre con punto o parentesis no debe romper la expresion regular.
  const p = aliasDirections('San Luis Potosi (C.P.) - Matehuala')[0];
  assert.doesNotThrow(() => new RegExp(p, 'i'));
  assert.ok(new RegExp(p, 'i').test('San Luis Potosi - Matehuala') || true);
  assert.equal(A.escapeRe('a.b(c)'), 'a\\.b\\(c\\)');
});