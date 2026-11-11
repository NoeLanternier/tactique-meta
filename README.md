# Tactique Meta

Calcule 4 fois par jour les meilleurs builds jungle (runes, cœur d'objets, bottes, familier, ordre des
compétences) à partir des parties classées **Master, Grandmaster et Challenger** du patch en cours,
grâce à l'API officielle de Riot. Le résultat, `meta.json`, est lu par l'Analyseur Tactique
(Réglages → Mise à jour de la méta).

Une seconde méta, `meta-gold.json`, est calculée de la même façon à partir des parties **Or,
Platine et Émeraude** (par défaut sur `euw1` et `na1`, variable `GOLD_REGIONS`, `none` pour la
désactiver). L'app la prend pour les joueurs de ces rangs et garde la méta Master+ pour les
champions qui n'y ont pas encore assez de parties. Les deux collectes tournent en même temps et se
partagent les limites de la clé : sur `euw1` et `na1`, chacune a environ la moitié des requêtes.

**Tous les postes.** Les mêmes parties servent aux cinq postes, sans requête de plus : chaque partie
contient les dix joueurs. La jungle garde `meta.json` (et `meta-gold.json`) ; les autres postes ont
leur fichier : `meta-top.json`, `meta-mid.json`, `meta-bot.json`, `meta-support.json` (et
`meta-gold-top.json`…). Pour chaque poste, « l'adversaire direct » (`vs`, combats par période) est
le joueur d'en face au même poste ; le familier et le début de partie ne concernent que la jungle.
Variable `ROLES` pour limiter les postes collectés (ex. `jungle,mid`). Les compteurs sont dans
`state/<poste>/` (`state/gold/<poste>/` pour Or à Émeraude), la jungle restant dans `state/`.

**Publication.** Les métas sont publiées à chaque exécution sur la branche `meta`, réécrite à chaque
fois (l'app lit `https://raw.githubusercontent.com/NoeLanternier/tactique-meta/meta/meta.json` et
ses voisins) : l'historique du dépôt ne grossit pas. Une copie est faite sur `main` une fois par
jour (exécution de 04h17 UTC), pour les anciennes versions de l'app et comme secours.

**Contexte adverse.** Les taux « face à une équipe AP, AD, qui soigne, résistante, à contrôles »
sont classés d'après la composition adverse attendue : profils moyens des cinq champions adverses
(comme l'app pendant la draft), et non ce qui s'est passé dans la partie. Une équipe qui gagne
soigne et encaisse davantage : les valeurs observées liaient le contexte à l'issue de la partie
(tous les champions avaient ~28 % « face aux soins »).

## Fonctionnement

1. Récupère les joueurs Master+ de chaque région (`euw1`, `kr`, `na1`, `sg2` par défaut : une
   région par grande zone, chacune a ses propres limites de requêtes).
2. Lit leurs parties classées solo du patch en cours (les remakes et parties < 15 min sont ignorés).
3. Pour chaque joueur (tous les postes) : page de runes complète, ordre réel d'achat (timeline), bottes, familier (jungle),
   ordre de montée des compétences, victoire ou défaite.
4. Choisit pour chaque champion les options au **meilleur taux de victoire estimé** parmi celles
   jouées dans au moins 8 à 15 % des parties. Le lissage est **mesuré sur les données** (voir
   « Lissage mesuré » plus bas) : une option peu jouée ne passe devant l'option habituelle que si
   son avantage est établi. Pour les runes, la clé de voûte est choisie d'abord (toutes ses pages
   réunies), puis la meilleure page de cette clé.
5. Mesure le vrai profil de chaque champion, tous postes confondus (part de dégâts magiques,
   résistance, contrôles, soins, boucliers), et la performance des objets selon le contexte adverse
   (équipe très AP, très AD, beaucoup de soins, très résistante, beaucoup de contrôles).
6. Calcule le taux de victoire de chaque jungler, de chaque affrontement de junglers, avec chaque
   champion allié et contre chaque adversaire, selon la composition adverse (équipe très AP, très
   AD, soins, résistante, contrôles), et son taux de bannissement (conseils de pick et de ban dans
   l'app, qui ne tiennent compte que des champions déjà choisis pendant la draft).
7. Mesure l'effet de chaque objet **par rapport aux autres objets achetés au même rang** (4e, 5e…
   objet) **et dans le même état de la partie** (équipe en avance, à égalité ou en retard d'au
   moins 5 % d'or au moment de l'achat), et sa minute moyenne d'achat. Sans cela, les objets
   tardifs ou « de luxe » paraîtraient gagnants simplement parce qu'on les achète quand on gagne
   déjà, et les objets défensifs ou anti-soins perdants parce qu'on les achète quand ça va mal.
   La **part** de chaque objet face à chaque type d'équipe, et quand on est en avance ou en
   retard, est publiée aussi : c'est le signal le plus fiable de ce que les joueurs adaptent.
8. Repère les **familles de build** de chaque champion (même premier objet, au moins 12 % des
   parties) avec leur cœur, leurs runes et leur taux de victoire par contexte adverse : l'app
   choisit la famille adaptée à la partie, puis suit celle qui a été commencée.
9. Mesure, tous champions du poste confondus, chaque objet **face à chaque champion adverse et
   face aux objets adverses** (anti-soins, dégâts en % des PV, boucliers, stase / anti-sorts,
   pénétration, armure, RM, vol de vie), en retirant l'effet que cet adversaire a sur tout le
   monde. Ces écarts sont publiés déjà lissés, et seulement s'ils dépassent 0,4 point. Publie
   aussi tous les champions vus dans l'équipe adverse, quel que soit leur poste (`threats` :
   parties, taux de victoire de leur équipe, taux de ban), pour les conseils de ban.
10. **Backtest** : chaque nouvelle partie est comparée à la méta précédente avant d'être ajoutée
    (famille recommandée suivie ou non ; chaque achat du 4e au 6e objet parmi les objets
    conseillés à ce moment, ou non, comparés au même rang). Le taux de victoire des deux groupes
    est publié dans `meta.json` (`backtest`) et dans le journal.
11. Mesure par contexte adverse les **options courantes** de chaque champion (pages de runes, aussi
    par famille de build ; bottes ; familier, aussi selon le jungler adverse ; ordre des
    compétences) : l'app garde le choix du build sauf si une autre option gagne nettement plus.
12. Mesure les **combats entre les deux junglers** (éliminations où l'autre a participé) par
    période (avant 6 min, 6 à 14 min, après), et le **début de partie** de chaque jungler (côté de
    la carte à 2 minutes, minute et voie de sa première élimination). Affiché avant la partie.
13. Calcule les repères Master+ de chaque jungler (farm et or à 10/15 min, minute des deux
   premiers objets, participation, vision) utilisés par le bilan d'après-partie de l'app.
14. **Réglage automatique du moteur** : sur les mêmes nouvelles parties (évaluées avec la méta de
    la veille), mesure combien chaque critère du moteur de l'app prédit réellement la victoire
    (force du champion, jungler adverse, alliés et adversaires, famille de build, runes / bottes /
    familier / compétences, objets face aux adversaires). Chaque critère reçoit un coefficient
    (1 = poids actuel, borné entre 0 et 2, rapproché de 1 s'il est mal mesuré), publié dans
    `meta.json` (`tuning`) dès 2 000 parties : l'app multiplie chaque critère par son coefficient.
15. **Contrôle des données** : si les runes, les objets, les compétences ou les positions ne sont
    plus trouvés pour la plupart des junglers (format des réponses de Riot changé), la collecte
    échoue sans rien publier. GitHub envoie alors un e-mail d'échec du workflow.
16. Écrit `meta.json` (et `meta-gold.json`). Les champions qui n'ont pas encore assez de parties sur le nouveau patch
   gardent leur build du patch précédent (l'app prend alors les runes recommandées par Riot).

Les compteurs du patch sont conservés dans `state/` (`state/gold/` pour la méta Or à Émeraude), sur la branche `data` du dépôt (réécrite à chaque exécution pour ne pas alourdir l'historique de `main`) : chaque exécution ajoute de nouvelles parties,
les données s'affinent donc de jour en jour jusqu'au patch suivant. Au changement de patch, les
données du patch précédent sont reprises avec un poids de 25 % pour des builds stables dès le
premier jour.

## Lissage mesuré

Un taux de victoire observé sur n parties s'écarte du vrai taux d'environ 50 / √n points : ±5
points sur 100 parties. Or les vrais écarts entre deux options (pages de runes, objets,
affrontements…) sont de l'ordre de **1 point**. Choisir « le meilleur taux observé » revient donc
souvent à choisir l'option la plus chanceuse.

Pour chaque famille de statistiques, la collecte mesure donc sur ses propres données la taille des
vrais écarts (variance observée − variance due au hasard), ce qui donne un nombre de parties
« a priori » k. Un écart observé sur n parties est ensuite retenu pour n / (n + k) de sa valeur.
Ces forces sont publiées dans `meta.json` (`priors`) et l'app applique le même calcul
(`src/stats.mjs`, `src/priors.mjs`). Mesures de novembre 2026 (patch 16.22) :

| Statistique | Vrai écart (écart-type) | k |
| --- | --- | --- |
| Force d'un champion à son poste | ≈ 1,5 point | ≈ 1 000 |
| Affrontement direct (voie) | 1,3 à 2,3 points (0 en jungle) | 500 à 1 500 |
| Synergie avec un allié / contre un adversaire hors voie | non mesurable | maximum |
| Champion selon la composition adverse | 0 à 2 points | 600 à maximum |
| Famille de build, clé de voûte | 0,4 à 1 point | 2 500 à 15 000 |
| Page de runes, bottes, compétences, départ | 0,5 à 1,8 point | 700 à 6 500 |
| Objet comparé aux autres au même rang | ≈ 1,6 point | ≈ 1 000 |
| Runes / bottes / objets selon la composition adverse | non mesurable à ce volume | maximum |
| Objet face à un champion adverse précis | non mesurable à ce volume | maximum |

« Non mesurable » ne veut pas dire que l'effet n'existe pas en jeu, mais qu'il est trop petit pour
être distingué du hasard avec ce nombre de parties : il ne pèse alors presque rien, et pèsera
davantage de lui-même quand il y aura plus de parties (clé de production).

Validation hors échantillon (parties du 10 et 11 novembre prédites avec la méta du 9) : avec
l'ancien lissage fixe, l'effet prédit d'un affrontement direct était 4 à 20 fois trop fort, et la
prédiction était moins bonne que de ne rien prédire ; avec le lissage mesuré, elle est calibrée.

## Commandes

```powershell
$env:RIOT_API_KEY = "RGAPI-..."   # votre clé
npm run test-rapide               # 3 minutes sur EUW, résultat dans test-local/
npm start                         # collecte complète (90 min par défaut ; sur GitHub, 300 min toutes les 6 heures)
npm test                          # tests sur données simulées
```

Options : `--minutes 90`, `--roles jungle,mid`, `--regions euw1,kr,na1`, `--gold-regions euw1` (vide : pas de méta Or), `--min-games 40`, `--out dossier`.

## Limites

- Les limites de requêtes sont lues dans les réponses de Riot et le journal indique le type de clé
  (« Limites de la clé … → clé production »). Clé personnelle : 100 requêtes / 2 minutes par région,
  soit environ 1 500 parties par heure et par région. Sur GitHub, 4 collectes de 5 heures par jour
  (toutes les 6 heures) utilisent la clé environ 20 heures sur 24. Clé de production : en général 500 requêtes /
  10 secondes, la collecte va alors bien plus vite.
- GitHub peut désactiver une tâche planifiée d'un dépôt public après 60 jours sans activité. Si vous
  recevez l'e-mail d'avertissement, ouvrez l'onglet Actions et cliquez sur « Enable workflow ».
