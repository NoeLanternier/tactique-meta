# Tactique Meta

Calcule chaque jour les meilleurs builds jungle (runes, cœur d'objets, bottes, familier, ordre des
compétences) à partir des parties classées **Master, Grandmaster et Challenger** du patch en cours,
grâce à l'API officielle de Riot. Le résultat, `meta.json`, est lu par l'Analyseur Tactique
(Réglages → Mise à jour de la méta).

## Fonctionnement

1. Récupère les joueurs Master+ de chaque région (`euw1`, `kr`, `na1`, `sg2` par défaut : une
   région par grande zone, chacune a ses propres limites de requêtes).
2. Lit leurs parties classées solo du patch en cours (les remakes et parties < 15 min sont ignorés).
3. Pour chaque jungler : page de runes complète, ordre réel d'achat (timeline), bottes, familier,
   ordre de montée des compétences, victoire ou défaite.
4. Choisit pour chaque champion les options au **meilleur taux de victoire lissé** parmi celles
   jouées dans au moins 8 à 15 % des parties (une option rare ne peut pas gagner par chance).
5. Mesure le vrai profil de chaque champion, tous postes confondus (part de dégâts magiques,
   résistance, contrôles, soins, boucliers), et la performance des objets selon le contexte adverse
   (équipe très AP, très AD, beaucoup de soins, très résistante, beaucoup de contrôles).
6. Calcule le taux de victoire de chaque jungler, de chaque affrontement de junglers, avec chaque
   champion allié et contre chaque adversaire (conseils de pick et de ban dans l'app, qui ne
   tiennent compte que des champions déjà choisis pendant la draft).
7. Mesure l'effet de chaque objet **par rapport aux autres objets achetés au même rang** (4e, 5e…
   objet) et sa minute moyenne d'achat : sans cela, les objets tardifs paraîtraient « gagnants »
   simplement parce que seuls les joueurs en avance les terminent.
8. Repère les **familles de build** de chaque champion (même premier objet, au moins 12 % des
   parties) avec leur cœur, leurs runes et leur taux de victoire par contexte adverse : l'app
   choisit la famille adaptée à la partie, puis suit celle qui a été commencée.
9. Mesure, tous junglers confondus, chaque objet **face à chaque champion adverse et face aux
   objets adverses** (anti-soins, dégâts en % des PV, boucliers, stase / anti-sorts, pénétration,
   armure, RM, vol de vie), en retirant l'effet que cet adversaire a sur tout le monde.
10. **Backtest** : chaque nouvelle partie est comparée à la méta de la veille avant d'être ajoutée
    (famille recommandée suivie ou non, objets situationnels recommandés achetés ou non). Le taux
    de victoire des deux groupes est publié dans `meta.json` (`backtest`) et dans le journal.
11. Mesure par contexte adverse les **options courantes** de chaque champion (pages de runes, aussi
    par famille de build ; bottes ; familier, aussi selon le jungler adverse ; ordre des
    compétences) : l'app garde le choix du build sauf si une autre option gagne nettement plus.
12. Mesure les **combats entre les deux junglers** (éliminations où l'autre a participé) par
    période (avant 6 min, 6 à 14 min, après), et le **début de partie** de chaque jungler (côté de
    la carte à 2 minutes, minute et voie de sa première élimination). Affiché avant la partie.
13. Calcule les repères Master+ de chaque jungler (farm et or à 10/15 min, minute des deux
   premiers objets, participation, vision) utilisés par le bilan d'après-partie de l'app.
14. Écrit `meta.json`. Les champions qui n'ont pas encore assez de parties sur le nouveau patch
   gardent leur build du patch précédent (l'app prend alors les runes recommandées par Riot).

Les compteurs du patch sont conservés dans `state/`, sur la branche `data` du dépôt (réécrite à chaque exécution pour ne pas alourdir l'historique de `main`) : chaque exécution ajoute de nouvelles parties,
les données s'affinent donc de jour en jour jusqu'au patch suivant. Au changement de patch, les
données du patch précédent sont reprises avec un poids de 25 % pour des builds stables dès le
premier jour.

## Commandes

```powershell
$env:RIOT_API_KEY = "RGAPI-..."   # votre clé
npm run test-rapide               # 3 minutes sur EUW, résultat dans test-local/
npm start                         # collecte complète (90 min par défaut, 180 sur GitHub)
npm test                          # tests sur données simulées
```

Options : `--minutes 90`, `--regions euw1,kr,na1`, `--min-games 40`, `--out dossier`.

## Limites

- Les limites de requêtes sont lues dans les réponses de Riot et le journal indique le type de clé
  (« Limites de la clé … → clé production »). Clé personnelle : 100 requêtes / 2 minutes par région,
  soit environ 1 500 parties par heure et par région. Clé de production : en général 500 requêtes /
  10 secondes, la collecte va alors bien plus vite.
- GitHub peut désactiver une tâche planifiée d'un dépôt public après 60 jours sans activité. Si vous
  recevez l'e-mail d'avertissement, ouvrez l'onglet Actions et cliquez sur « Enable workflow ».
