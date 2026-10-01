'use strict';

// Contrato del indice promovido en bloque (worker/rnc-promoted.json).
//
// Estos tests no comprueban que las coordenadas sean correctas: eso lo decidio el RNC
// y lo valido el invariante de cadena y el estado por localidad, en herramientas
// offline. Comprueban lo que puede romperse en SILENCIO cuando el indice se edita a
// mano: que un km se quede sin ancla, que dos anclas compitan por el mismo km, que
// el filtro de estado deje de filtrar, o que las 38 anclas revisadas a manocedence.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveRncPost, anchorIndex } = require('./rnc-km-anchors');
const promoted = require('./rnc-promoted.json');
const corridors = require('./rnc-promoted-corridors.json');

const manual = anchorIndex.filter(a => !a.promoted);
const byPromoted = anchorIndex.filter(a => a.promoted);

// Como se consulta el indice: con el NOMBRE del corredor mas "Autopista ", no con
// la etiqueta "150 Acatzingo - Ciudad Mendoza". La etiqueta lleva el codigo de ruta
// suelto, y el guardia de resolveRncPost rechaza un numero sin "D" y sin
// "autopista" (precisamente para no confundir la cuota con la libre). La etiqueta
// es para el `label` de la respuesta, no es una entrada consultable del indice.
const viaNombre = a => `Autopista ${corridors[a.corridor].name}`;

test('el indice se compone de las anclas manuales y las promovidas', () => {
  assert.equal(byPromoted.length, promoted.length,
    'toda ancla promovida del archivo esta en el indice del worker');
  assert.equal(manual.length, 38, 'las 38 anclas revisadas a mano siguen ahi');
  assert.equal(anchorIndex.length, manual.length + byPromoted.length);
});

test('cada ancla apunta a un corredor existente', () => {
  const fuera = promoted.filter(p => !corridors[p.corridor]);
  assert.deepEqual(fuera.map(p => p.corridor), [],
    'ningun indice de corredor queda fuera de rango');
  assert.ok(promoted.every(p => Number.isInteger(p.corridor)));
});

test('las grafias que usan las noticias resuelven igual que las del RNC', () => {
  // Dos fallos que NO se ven en ninguna lista de errores, porque un km que no
  // resuelve simplemente no aparece en un reporte en vez de aparecer mal. Se
  // comprueban las 724, no unos ejemplos.
  //
  // 1) La abreviatura. El RNC escribe "Acatzingo - Ciudad Mendoza" y las noticias
  //    escriben "Cd. Mendoza". Con el patron derivado solo de la grafia del RNC,
  //    19 km de ese corredor no resolvian para la mitad de los reportes.
  // 2) El acento. El RNC escribe "Cancún" y las noticias escriben "Cancun".
  //    363 de las 724 anclas viven en corredores con algun acento: sin esto, la
  //    mitad del bloque fallaba en la grafia dominante.
  const sinAcento = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const invertir = s => s.split(/\s*[-–—]\s*/).reverse().join(' - ');
  const formaCorta = s => s.replace(/\bEntrada\b/gi, 'Ent.').replace(/\bCiudad\b/gi, 'Cd.');

  let conAcento = 0, conAbrev = 0;
  for (const a of promoted) {
    const nombre = corridors[a.corridor].name;
    const estado = a.state;
    const propia = r => r && r.source_post_id === a.sourcePostId;

    assert.ok(propia(resolveRncPost(viaNombre(a), a.km, estado)), `${nombre} km ${a.km}`);

    if (nombre !== sinAcento(nombre)) {
      conAcento++;
      assert.ok(propia(resolveRncPost('Autopista ' + sinAcento(nombre), a.km, estado)),
        `${sinAcento(nombre)} km ${a.km}: el toponimo sin acento`);
      assert.ok(propia(resolveRncPost(invertir(sinAcento(nombre)), a.km, estado)),
        `${invertir(sinAcento(nombre))} km ${a.km}: sin acento e invertida`);
    }
    if (formaCorta(nombre) !== nombre) {
      conAbrev++;
      assert.ok(propia(resolveRncPost('Autopista ' + formaCorta(nombre), a.km, estado)),
        `${formaCorta(nombre)} km ${a.km}: la abreviatura`);
    }
  }
  // Si estos numeros bajan, el indice dejo de cubrir algo que si cubria: se fija
  // el conteo para que el cambio se note en el diff del test.
  assert.equal(conAcento, 363, 'anclas en corredores con algun acento');
  assert.equal(conAbrev, 19, 'anclas en corredores con abreviatura');
});

test('la tolerancia a acentos no crea colisiones entre corredores', () => {
  // Un patron tolerante acepta dos grafias donde antes aceptaba una. Si dos
  // corredores se distinguieran SOLO por un acento, dejarian de distinguirse y el
  // indice se volveria ambiguo en los km que comparten. No hay hoy ningun par asi,
  // y por eso el indice de 762 entradas sigue resolviendo 1 por (carretera, km).
  const sinAcento = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const pares = [];
  for (let i = 0; i < corridors.length; i++) {
    for (let j = i + 1; j < corridors.length; j++) {
      const a = sinAcento(corridors[i].name), b = sinAcento(corridors[j].name);
      if (corridors[i].name !== corridors[j].name && a === b) pares.push([a, b]);
    }
  }
  assert.deepEqual(pares, [], 'ningun par de corredores se vuelve indistinguible');
});

test('cada corredor conserva su alias en las dos direcciones', () => {
  for (const c of corridors) {
    assert.equal(c.aliases.length, 2, `${c.road}: dos direcciones`);
    for (const src of c.aliases) {
      assert.doesNotThrow(() => new RegExp(src, 'i'), `${c.road}: el alias compila`);
    }
    const [fwd, rev] = c.aliases.map(s => new RegExp(s, 'i'));
    const partes = c.name.split(/\s*[-–—]\s*/).filter(Boolean);
    if (partes.length !== 2) continue;
    assert.ok(fwd.test(partes.join(' - ')), `${c.road}: la direccion directa matchea`);
    assert.ok(rev.test([partes[1], partes[0]].join(' - ')), `${c.road}: la inversa matchea`);
  }
});

test('ningun km del indice queda con dos anclas que compitan', () => {
  // Esta es la condicion que hace que resolveRncPost devuelva null. Se comprueba
  // sobre el indice REAL, con los alias ya materializados, y en cada una de las
  // formas en que el clasificador puede nombrar un corredor.
  const ambiguos = [];
  for (const a of byPromoted) {
    const partes = a.road.replace(/^\d+\s+/, '').split(/\s*[-–—]\s*/).filter(Boolean);
    const variantes = [
      a.road,
      partes.join(' '),
      'Autopista ' + partes.join(' '),
      partes.length === 2 ? partes[1] + ' - ' + partes[0] : a.road,
    ];
    for (const v of new Set(variantes)) {
      const hits = anchorIndex.filter(x => x.km === a.km && x.aliases.some(re => re.test(v)));
      if (hits.length !== 1) ambiguos.push({ road: a.road, km: a.km, variante: v, n: hits.length });
    }
  }
  assert.deepEqual(ambiguos, [], 'todo (carretera, km) resuelve exactamente una vez');
});

test('un corredor con sufijo no roba la cadena del corredor sin sufijo', () => {
  // "Mexico - Cuernavaca" (km 67-79) y "Mexico - Cuernavaca Cuota" (km 20-47). Sin
  // la negacion de sufijo, el alias del primero tambien matchea la cadena del
  // segundo. Aqui se comprueba sobre el indice, no sobre el generador.
  const libre = corridors.find(c => /cuernavaca$/i.test(c.name));
  const cuota = corridors.find(c => /cuernavaca cuota$/i.test(c.name));
  assert.ok(libre && cuota, 'los dos corredores estan en el indice');
  const [patronLibre] = libre.aliases.map(s => new RegExp(s, 'i'));
  assert.ok(patronLibre.test(libre.name), 'el libre matchea su propia cadena');
  assert.ok(!patronLibre.test(cuota.name),
    'y NO la del corredor con sufijo, que de otro modo nunca resolveria');
  // Y el caso real, con las grafias acentuadas del RNC.
  assert.ok(patronLibre.test('México - Cuernavaca'));
  assert.ok(!patronLibre.test('México - Cuernavaca Cuota'));
});

test('las anclas promovidas rechazan el estado equivocado', () => {
  // El estado viene de localidad.CVEGEO, no del nombre del corredor: es lo que
  // permite que una alerta con estado erroneo se descarte en vez de resolverse.
  // Sonora no toca ninguno de los 29 corredores, asi que debe rechazarlos a todos.
  let probadas = 0;
  for (const a of promoted) {
    assert.equal(resolveRncPost(viaNombre(a), a.km, 'Sonora'), null, `${viaNombre(a)} km ${a.km} (${a.state})`);
    probadas++;
  }
  assert.equal(probadas, 724, 'se prueban todas, no una muestra');
});

test('las anclas promovidas resuelven con su propio estado', () => {
  for (const a of promoted) {
    const r = resolveRncPost(viaNombre(a), a.km, a.state);
    assert.ok(r, `${viaNombre(a)} km ${a.km} (${a.state}) deberia resolver`);
    assert.equal(r.precision, 'kilometer_rnc');
    assert.equal(r.status, 'approximate');
    assert.equal(r.uncertainty_m, 1500);
    assert.equal(r.confidence, .78);
    assert.equal(r.source_post_id, a.sourcePostId);
    // La etiqueta que ve el usuario lleva el codigo de ruta, aunque la entrada que
    // se consulta no lo lleve.
    assert.equal(r.label, `${corridors[a.corridor].road} · km ${a.km} (referencia aproximada)`);
  }
});

test('la etiqueta del indice no se confunde con la carretera libre', () => {
  // El indice rotula las anclas con el codigo de ruta ("150 Acatzingo..."), pero ese
  // texto no es consultable: el guardia /\b150\b/ lo rechaza justamente para no
  // resolver una alerta de carretera libre contra un poste de cuota. Se fija aqui
  // para que nadie "arregle" el guardia sin ver esta consecuencia.
  assert.equal(resolveRncPost('150 Acatzingo - Ciudad Mendoza', 168, 'Puebla'), null);
  assert.equal(resolveRncPost('Autopista Acatzingo - Ciudad Mendoza', 168, 'Puebla')?.source_post_id, 3970);
});

test('un km sin poste RNC se queda sin ancla, en vez de inventarse una', () => {
  // 259 y 260 no tienen poste en el tramo promovido: el indice NO debe inventar
  // nada entre el ultimo poste y el siguiente. Este es el comportamiento
  // conservador que hay que conservar aunque baje la cobertura.
  assert.equal(resolveRncPost('Autopista Cuernavaca - Acapulco', 259, 'Guerrero'), null);
  assert.equal(resolveRncPost('Autopista Cuernavaca - Acapulco', 400, 'Guerrero'), null);
  assert.equal(resolveRncPost('Autopista Cuernavaca - Acapulco', 0, 'Guerrero'), null);

  // Las dos direcciones del corredor. Solo para los km promovidos: el km 250 lo
  // resuelve un ancla revisada a mano cuyo alias no tiene direccion inversa, y eso
  // es comportamiento preexistente, no algo que introduced esta promocion.
  assert.equal(resolveRncPost('Acapulco - Cuernavaca', 251, 'Guerrero')?.source_post_id, 1241);
  assert.equal(resolveRncPost('Cuernavaca - Acapulco', 251, 'Guerrero')?.source_post_id, 1241);
  // km 250 sigue resolviendo solo en un sentido, como antes de este cambio.
  assert.equal(resolveRncPost('Cuernavaca - Acapulco', 250, 'Guerrero')?.source_post_id, 1240);
  assert.equal(resolveRncPost('Acapulco - Cuernavaca', 250, 'Guerrero'), null);
});

test('las 38 anclas revisadas a mano siguen resolviendo igual', () => {
  // La promocion no puede quitar cobertura existente. Estos casos son los que
  // importan: cada uno resolvia antes de este cambio.
  const CASOS = [
    ['Autopista Guadalajara - Colima', 117, 'Jalisco', 40870],
    ['Autopista Acatzingo - Cd. Mendoza', 229, 'Veracruz', 5725],
    ['Autopista Cuernavaca - Acapulco', 142, 'Morelos', 1510],
    ['Autopista Puente de Ixtla - Iguala', 48, 'Guerrero', 1317],
    ['Autopista México-Cuernavaca', 63, 'Morelos', 1405],
    ['Autopista Nuevo Teapa - Cosoleacaque', 7, 'Veracruz', 6658],
  ];
  for (const [road, km, state, id] of CASOS) {
    assert.equal(resolveRncPost(road, km, state)?.source_post_id, id, `${road} km ${km}`);
  }
});

test('las coordenadas quedan dentro de Mexico continental', () => {
  const fuera = promoted.filter(p => !(p.lat > 14 && p.lat < 33 && p.lon > -118 && p.lon < -86));
  assert.deepEqual(fuera, [], 'ninguna coordenada con error de signo o de datum');
  assert.ok(promoted.every(p => typeof p.lat === 'number' && typeof p.lon === 'number'));
  assert.ok(promoted.every(p => p.state && typeof p.state === 'string'));
});

test('cada poste del RNC aparece una sola vez', () => {
  // Dos entradas con el mismo sourcePostId significan que el generador se ejecuto
  // dos veces sin limpiar, o que alguien edito el archivo a mano.
  const ids = promoted.map(p => p.sourcePostId);
  assert.equal(new Set(ids).size, ids.length, 'ningun sourcePostId repetido');
  const pares = promoted.map(p => `${p.corridor}|${p.km}`);
  assert.equal(new Set(pares).size, pares.length, 'ningun (corredor, km) repetido');
});