import json, struct, sys
p = sys.argv[1]
with open(p, 'rb') as f:
    n = struct.unpack('<Q', f.read(8))[0]
    hdr = json.loads(f.read(n))
keys = [k for k in hdr.keys() if k != '__metadata__']
print('total keys:', len(keys))
print('__metadata__:', json.dumps(hdr.get('__metadata__', {}), ensure_ascii=False)[:300])
for k in keys[:6]:
    print(k, hdr[k]['shape'], hdr[k]['dtype'])
# find conv_in-ish keys
for k in keys:
    if 'conv_in' in k:
        print('CONV_IN:', k, hdr[k]['shape'])
