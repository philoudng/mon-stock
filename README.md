# Mon Stock

Site personnel de suivi : trésorerie (comptes et espèces), abonnements, achats / ventes / cartes obtenues par jeu (Pokémon, One Piece, Lorcana, Riftbound, Babaticket, Divers), cotes Cardmarket, objectifs financiers, bilan mensuel et annuel.

- Adresse : https://stock.philoudng.fr
- Les données sont enregistrées **dans le navigateur de l'appareil** (aucune donnée dans ce dépôt). Copie en ligne facultative avec un compte Supabase (voir plus bas), et « Sauvegarder mes données » en bas de page pour un fichier de sauvegarde.
- Fichiers : `index.html` (tout le site), `sw.js` (hors connexion), `manifest.webmanifest` + `icons/` (installation sur l'écran d'accueil), `CNAME` (domaine).

## Listes de cartes (`data/`)

Fichiers générés pour le scan, sans aucune donnée personnelle :
- `data/pokemon.json` — cartes Pokémon (noms français) tirées de [TCGdex](https://github.com/tcgdex/cards-database) (MIT), reliées à [pokemon-tcg-data](https://github.com/PokemonTCG/pokemon-tcg-data) (MIT) pour les liens de prix. Images : TCGdex / pokemontcg.io.
- `data/onepiece.json` — cartes One Piece tirées de [Punk Records](https://github.com/buhbbl/punk-records), elles-mêmes issues du site officiel. Images : onepiece-cardgame.com.

Les cartes et illustrations restent la propriété de leurs ayants droit (The Pokémon Company / Nintendo / Creatures / GAME FREAK ; Eiichiro Oda / Shueisha, Toei Animation, Bandai).

## Compte en ligne (Supabase, facultatif)

- `supabase/schema.sql` : table `stock_entries` (une ligne par mouvement) et règles de sécurité : chaque compte ne lit et ne modifie que ses propres lignes. À coller une fois dans Supabase → SQL Editor → Run.
- Le site garde tout dans l'appareil (fonctionne hors connexion) et synchronise : envoi des lignes modifiées, puis récupération de ce qui a changé ailleurs (heure du serveur). Une suppression est envoyée comme une ligne « supprimée ».
- Seules l'adresse du projet et la clé **publique** (publishable / anon) vont dans le site. La clé secrète (service_role / sb_secret) ne doit jamais y être.

## Bot Discord (facultatif)

- `supabase/functions/discord/index.ts` : Edge Function Supabase qui reçoit les commandes Discord (`/tresorerie`, `/mois`, `/carte`, `/objectifs`, `/reglage`), vérifie la signature Ed25519 de Discord et calcule les chiffres comme le site à partir de `stock_entries`.
- Réglages dans la table `bot_config` (lue seulement côté serveur) ; jeton du bot dans le secret `DISCORD_BOT_TOKEN`. Un seul serveur autorisé (celui du premier `/reglage`), bot privé.
