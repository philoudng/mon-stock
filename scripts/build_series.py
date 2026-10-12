"""Construit data/series.json : noms des séries à partir des listes de cartes du site.
pk : abréviation Pokémon (MEW, PAL…) -> nom de l'extension en français
op : code One Piece (OP13, ST21, EB02, PRB01…) -> nom de l'extension
"""
import json, re, collections, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
pk = json.loads((root / 'data/pokemon.json').read_text(encoding='utf-8'))
op = json.loads((root / 'data/onepiece.json').read_text(encoding='utf-8'))

ab = collections.defaultdict(collections.Counter)
for lst in pk.values():
    for c in lst:
        if c.get('a') and c.get('s'):
            ab[c['a']][c['s']] += 1
pk_names = {a: cs.most_common(1)[0][0] for a, cs in ab.items()}

# Chemin des illustrations TCGdex par extension (+ numéros complétés par des zéros ou non)
paths = collections.defaultdict(collections.Counter)
padded = collections.defaultdict(lambda: [0, 0])
for key, lst in pk.items():
    num = key.split('/')[0]
    for c in lst:
        m = re.match(r'https://assets\.tcgdex\.net/fr/(.+)/([^/]+)/low\.webp$', c.get('i', ''))
        if not (m and c.get('a')):
            continue
        paths[c['a']][m.group(1)] += 1
        loc = m.group(2)
        if loc.isdigit() and num.isdigit() and len(num) < 3:
            padded[c['a']][0 if loc == num else 1] += 1
pk_img = {}
for a, cs in paths.items():
    z = padded[a]
    pk_img[a] = cs.most_common(1)[0][0] + (':3' if z[1] > z[0] else ':0')

def clean(name, code):
    n = re.sub(r'^\s*(?:OP|ST|EB|PRB)-?\d{2}(?:-(?:OP|ST|EB|PRB)\d{2})?\s*', '', name, flags=re.I).strip(' -–')
    n = n.strip('-').strip()
    return ' '.join(w[:1].upper() + w[1:].lower() for w in n.split()) if n.isupper() else n

sets = collections.defaultdict(collections.Counter)
for code, c in op.items():
    prefix = code.split('-')[0]
    for v in c['v']:
        sets[prefix][v['s']] += 1
op_names = {}
for prefix, cs in sets.items():
    m = re.match(r'([A-Z]+)(\d{2})$', prefix)
    want = f'{m.group(1)}-{m.group(2)}' if m else prefix
    own = [(n, k) for n, k in cs.items() if n.upper().startswith(want)]
    best = max(own, key=lambda x: x[1])[0] if own else cs.most_common(1)[0][0]
    op_names[prefix] = 'Promos' if prefix == 'P' else clean(best, prefix)

out = {'pk': dict(sorted(pk_names.items())), 'op': dict(sorted(op_names.items())), 'pkImg': dict(sorted(pk_img.items()))}
(root / 'data/series.json').write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
print(len(out['pk']), 'séries Pokémon ·', len(out['op']), 'séries One Piece')
