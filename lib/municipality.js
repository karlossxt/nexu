'use strict';

// Extrae el municipio/alcaldía de las respuestas de los geocodificadores.
// En México, Google suele traerlo en administrative_area_level_2; Nominatim en
// municipality/county; Geoapify en municipality/city/county. Si el proveedor
// solo devuelve una localidad, se usa como referencia municipal y se conserva
// el nombre tal cual para no inventar una equivalencia.

function clean(value) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function addressMunicipality(address = {}) {
  // En CDMX, Nominatim devuelve la alcaldía en `borough` y la ciudad en
  // `city` ("Ciudad de México"). Por eso `borough` va antes que `city`.
  for (const key of ['municipality', 'county', 'borough', 'city', 'town', 'village', 'district']) {
    const value = clean(address[key]);
    if (value) return value;
  }
  return '';
}

function googleMunicipality(result = {}) {
  for (const type of ['administrative_area_level_2', 'locality', 'administrative_area_level_3']) {
    const value = clean(result.address_components?.find(item => item.types?.includes(type))?.long_name);
    if (value) return value;
  }
  return '';
}

function geoapifyMunicipality(result = {}) {
  // En CDMX Geoapify puede devolver city="Ciudad de México" y la alcaldía en
  // district/borough. Evitamos guardar la entidad como si fuera municipio.
  const cityKey = clean(result.city).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (cityKey === 'ciudad de mexico' || cityKey === 'cdmx') {
    const district = clean(result.district || result.borough);
    if (district) return district;
  }
  for (const key of ['municipality', 'city', 'county', 'district', 'borough']) {
    const value = clean(result[key]);
    if (value) return value;
  }
  return '';
}

module.exports = { addressMunicipality, googleMunicipality, geoapifyMunicipality };
