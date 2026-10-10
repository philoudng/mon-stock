"""Récupère chaque jour les fichiers publics de Cardmarket (catalogue + price guide)
et produit data/cardmarket.json, utilisé par le scan du site :
  - "op" : pour chaque code One Piece (ex. OP05-119), la liste des produits Cardmarket
           [idProduct, version (V.n dans son extension), tendance, tendance foil, extension, hors anglais (0/1), prix le plus bas]
  - "pk" : pour chaque idProduct Pokémon présent dans data/pokemon.json, [tendance, tendance foil, prix le plus bas]
Jeux Cardmarket : 6 = Pokémon, 18 = One Piece.
"""
import json, os, re, sys, urllib.request, datetime

BASE = 'https://downloads.s3.cardmarket.com/productCatalog'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'cardmarket.json')

def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'mon-stock (usage personnel)'})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)

def as_list(d, *keys):
    if isinstance(d, list):
        return d
    for k in keys:
        v = d.get(k)
        if isinstance(v, list):
            return v
    for v in d.values():
        if isinstance(v, list) and v and isinstance(v[0], dict):
            return v
    return []

def num(x):
    try:
        return round(float(x), 2) if x is not None else None
    except (TypeError, ValueError):
        return None

def prices(game):
    d = get(f'{BASE}/priceGuide/price_guide_{game}.json')
    out = {}
    lst = as_list(d, 'priceGuides', 'priceGuide')
    for p in lst:
        pid = p.get('idProduct')
        if pid is None:
            continue
        out[int(pid)] = (num(p.get('trend')), num(p.get('trend-foil') or p.get('trendFoil')), num(p.get('low')))
    print(f'jeu {game} : {len(out)} prix', file=sys.stderr)
    return out

def products(game):
    d = get(f'{BASE}/productList/products_singles_{game}.json')
    lst = as_list(d, 'products', 'product')
    print(f'jeu {game} : {len(lst)} produits ; champs : {sorted(lst[0].keys()) if lst else []}', file=sys.stderr)
    return lst

CODE = re.compile(r'\b((?:OP|ST|EB|PRB)\d{2}|P)-(\d{3})\b')
VER = re.compile(r'\(\s*V\.?\s*(\d+)\s*\)', re.I)

def main():
    result = {'updated': datetime.date.today().isoformat(), 'op': {}, 'pk': {}}
    # One Piece
    try:
        pr = prices(18)
        plist = products(18)
        # Noms des extensions, déduits des produits scellés (boosters, displays…)
        exp_names, exp_foreign = {}, {}
        try:
            ns = as_list(get(f'{BASE}/productList/products_nonsingles_18.json'), 'products', 'product')
        except Exception as e:
            print('produits scellés indisponibles', e, file=sys.stderr); ns = []
        cands = {}
        for x in ns:
            e, n = x.get('idExpansion'), str(x.get('name', ''))
            if e is None or not n: continue
            if re.search(r'Non-English|Asia Region|Japanese|Chinese', n, re.I): exp_foreign[e] = 1
            base = re.sub(r'\s*\((?:Non-English|Asia Region Legal|Japanese|[^)]*Booster Box[^)]*)\)', '', n)
            base = re.sub(r'\s*(Booster Box Case.*|Booster Box|Sleeved Booster|Booster|Dash Pack|Premium Booster)$', '', base).strip(' -')
            if re.match(r'^(Common|Uncommon|Rare) Set - ', base): base = re.sub(r'^(Common|Uncommon|Rare) Set - ', '', base); base = re.sub(r'\s*\([A-Z]{2,3}\d{2}\)$', '', base)
            cands.setdefault(e, {}); cands[e][base] = cands[e].get(base, 0) + 1
        for e, c in cands.items():
            exp_names[e] = max(c.items(), key=lambda kv: (kv[1], -len(kv[0])))[0]
        groups = {}
        for p in plist:
            m = CODE.search(str(p.get('name', '')))
            if not m: continue
            code = f'{m.group(1)}-{m.group(2)}'
            groups.setdefault(code, {}).setdefault(p.get('idExpansion'), []).append(int(p['idProduct']))
        for code, exps in groups.items():
            rows = []
            for e, ids in exps.items():
                for v, pid in enumerate(sorted(ids), 1):
                    t, tf, low = pr.get(pid, (None, None, None))
                    rows.append([pid, v, t, tf, exp_names.get(e, ''), exp_foreign.get(e, 0), low])
            rows.sort(key=lambda r: (r[5], r[0]))
            result['op'][code] = rows
    except Exception as e:  # on garde le fichier précédent pour la partie qui échoue
        print('One Piece : échec', e, file=sys.stderr)
    # Pokémon : uniquement les produits présents dans notre liste
    try:
        wanted = set()
        with open(os.path.join(ROOT, 'data', 'pokemon.json'), encoding='utf-8') as f:
            for cards in json.load(f).values():
                for c in cards:
                    if 'm' in c:
                        wanted.add(int(c['m']))
        pr = prices(6)
        result['pk'] = {str(pid): list(v) for pid, v in pr.items() if pid in wanted and (v[0] or v[1])}
    except Exception as e:
        print('Pokémon : échec', e, file=sys.stderr)
    if not result['op'] and not result['pk']:
        print('Aucune donnée récupérée, fichier inchangé.', file=sys.stderr)
        sys.exit(1)
    if os.path.exists(OUT):  # ne pas écraser une partie qui a échoué
        old = json.load(open(OUT, encoding='utf-8'))
        if not result['op']: result['op'] = old.get('op', {})
        if not result['pk']: result['pk'] = old.get('pk', {})
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, separators=(',', ':'))
    print(f"OK : {len(result['op'])} codes One Piece, {len(result['pk'])} prix Pokémon", file=sys.stderr)

if __name__ == '__main__':
    main()
