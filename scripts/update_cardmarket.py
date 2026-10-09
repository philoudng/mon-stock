"""Récupère chaque jour les fichiers publics de Cardmarket (catalogue + price guide)
et produit data/cardmarket.json, utilisé par le scan du site :
  - "op" : pour chaque code One Piece (ex. OP05-119), la liste des produits Cardmarket
           [idProduct, version, tendance, tendance foil]
  - "pk" : pour chaque idProduct Pokémon présent dans data/pokemon.json, [tendance, tendance foil]
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
    for p in as_list(d, 'priceGuides', 'priceGuide'):
        pid = p.get('idProduct')
        if pid is None:
            continue
        out[int(pid)] = (num(p.get('trend')), num(p.get('trend-foil') or p.get('trendFoil')))
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
        sample = [x for x in plist if 'OP05-119' in ' '.join(str(v) for v in x.values())][:30]
        try:
            ns = as_list(get(f'{BASE}/productList/products_nonsingles_18.json'), 'products', 'product')
        except Exception as e:
            ns = [{'error': str(e)}]
        exp_ids = sorted({x.get('idExpansion') for x in sample})
        json.dump({'fields': sorted(plist[0].keys()) if plist else [], 'OP05-119': sample[:3],
                   'nonsingles_count': len(ns), 'nonsingles_for_exp': {str(e): [x.get('name') for x in ns if x.get('idExpansion') == e][:6] for e in exp_ids},
                   'nonsingles_first': ns[:5]},
                  open(os.path.join(ROOT, 'data', 'cardmarket-sample.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        for p in plist:
            text = ' '.join(str(v) for v in p.values() if isinstance(v, (str, int)))
            m = CODE.search(text)
            if not m:
                continue
            code = f'{m.group(1)}-{m.group(2)}'
            vm = VER.search(str(p.get('name', '')))
            pid = int(p['idProduct'])
            t, tf = pr.get(pid, (None, None))
            result['op'].setdefault(code, []).append([pid, int(vm.group(1)) if vm else 1, t, tf, str(p.get('name', '')), p.get('idExpansion')])
        for v in result['op'].values():
            v.sort(key=lambda x: (x[1], x[0]))
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
