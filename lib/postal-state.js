'use strict';

// Códigos postales estatales que aparecen en las direcciones de los
// geocodificadores. Se leen solo de la parte de dirección, antes de " · ", para
// no confundir "sentido hacia CDMX" con el estado de la alerta.
const POSTAL_STATE_CODES = {
  AGS: 'Aguascalientes',
  BC: 'Baja California',
  BCS: 'Baja California Sur',
  CAMP: 'Campeche',
  CHIS: 'Chiapas',
  CHIH: 'Chihuahua',
  CHH: 'Chihuahua',
  CDMX: 'Ciudad de México',
  DF: 'Ciudad de México',
  COAH: 'Coahuila',
  COL: 'Colima',
  DGO: 'Durango',
  GTO: 'Guanajuato',
  GRO: 'Guerrero',
  HGO: 'Hidalgo',
  JAL: 'Jalisco',
  MEX: 'Estado de México',
  MICH: 'Michoacán',
  MOR: 'Morelos',
  NAY: 'Nayarit',
  NL: 'Nuevo León',
  OAX: 'Oaxaca',
  PUE: 'Puebla',
  QRO: 'Querétaro',
  QROO: 'Quintana Roo',
  SLP: 'San Luis Potosí',
  SIN: 'Sinaloa',
  SON: 'Sonora',
  TAB: 'Tabasco',
  TAMPS: 'Tamaulipas',
  TLAX: 'Tlaxcala',
  VER: 'Veracruz',
  YUC: 'Yucatán',
  ZAC: 'Zacatecas'
};

const CODES = Object.keys(POSTAL_STATE_CODES).sort((a, b) => b.length - a.length);
const CODE_PATTERN = new RegExp(`(?:^|[,\\s])(${CODES.join('|')})(?=\\s*(?:,|$))`, 'i');

function stateFromPostalLabel(label) {
  const address = String(label || '').split(/\s*·\s*/)[0].trim();
  if (!address) return '';
  const match = address.match(CODE_PATTERN);
  return match ? POSTAL_STATE_CODES[match[1].toUpperCase()] : '';
}

module.exports = { POSTAL_STATE_CODES, stateFromPostalLabel };
