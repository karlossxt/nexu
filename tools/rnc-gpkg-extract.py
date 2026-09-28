#!/usr/bin/env python3
"""Extract only the 54D/150D pilot region from the official RNC 2025 GeoPackage."""
import json, sqlite3, struct, sys
from pathlib import Path

if len(sys.argv) != 3:
    raise SystemExit('Usage: python3 tools/rnc-gpkg-extract.py rnc2025.gpkg output-directory')
source, target = sys.argv[1:]
out = Path(target)
out.mkdir(parents=True, exist_ok=True)
boxes = {'54D': (-104.6, 18.8, -102.5, 21.0), '150D': (-98.6, 18.1, -96.3, 19.5)}

def geometry(blob):
    if not blob or blob[:2] != b'GP':
        raise ValueError('Expected GeoPackage geometry')
    flags = blob[3]
    envelope_bytes = (0, 32, 48, 48, 64, 0, 0, 0)[(flags >> 1) & 7]
    pos = 8 + envelope_bytes
    endian = '<' if blob[pos] == 1 else '>'
    kind = struct.unpack_from(endian+'I', blob, pos+1)[0] % 1000
    pos += 5
    if kind == 1:
        return {'type':'Point', 'coordinates':list(struct.unpack_from(endian+'dd', blob, pos))}
    if kind != 2:
        raise ValueError(f'Unexpected geometry type: {kind}')
    size = struct.unpack_from(endian+'I', blob, pos)[0]
    pos += 4
    return {'type':'LineString','coordinates':[list(struct.unpack_from(endian+'dd',blob,pos+16*i)) for i in range(size)]}

def in_box(point, box):
    return box[0] <= point[0] <= box[2] and box[1] <= point[1] <= box[3]

conn = sqlite3.connect(f'file:{source}?mode=ro', uri=True)
roads = []
for geom, ident, code, name, toll in conn.execute("select geom,ID_RED,CODIGO,NOMBRE,PEAJE from red_vial where CODIGO in ('54','150') and PEAJE='Si'"):
    shape = geometry(geom)
    route = code+'D'
    if any(in_box(p, boxes[route]) for p in shape['coordinates']):
        roads.append({'type':'Feature','properties':{'Codigo':route,'Id_Red':ident,'Nombre':name},'geometry':shape})
posts = []
for geom, ident, km in conn.execute('select geom,ID_KM,KM from poste_de_referencia'):
    shape = geometry(geom)
    if any(in_box(shape['coordinates'],box) for box in boxes.values()):
        posts.append({'type':'Feature','properties':{'Id_Km':ident,'Km':km},'geometry':shape})
for name, features in [('roads',roads),('posts',posts)]:
    (out/(name+'.geojson')).write_text(json.dumps({'type':'FeatureCollection','features':features},ensure_ascii=False))
print(json.dumps({'roads':len(roads),'posts':len(posts)}))
