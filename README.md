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
   résistance, contrôles, soins, boucliers, objets critiques et de vitesse d'attaque, part magique
   habituelle de ses objets), et la performance des objets selon le contexte adverse (équipe très
   AP, très AD, beaucoup de soins, très résistante, beaucoup de contrôles). En partie, l'app compare
   les vrais objets de chaque adversaire à ce profil : un build inhabituel (Miss Fortune létalité,
   Varus AP) change l'analyse au fur et à mesure de ses achats.
6. Calcule le taux de victoire de chaque jungler, de chaque affrontement de junglers, avec chaque
   champion allié et contre chaque adversaire, selon la composition adverse (équipe très AP, très
   AD, soins, résistante, contrôles), et son taux de bannissement (conseils de pick et de ban dans
   l'app, qui ne tiennent compte que des champions déjà choisis pendant la draft). Pour les
   affrontements, alliés et adversaires, seul l'écart propre au champion compte (voir « Lissage
   mesuré »), et l'équilibre de l'équipe (dégâts, ligne de front) est mesuré à part.
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
   pénétration, armure, RM, vol de vie, critiques), en retirant l'effet que cet adversaire a sur tout le
   monde. Ces écarts sont publiés déjà lissés, et seulement s'ils dépassent 0,4 point. Publie
   aussi tous les champions vus dans l'équipe adverse, quel que soit leur poste (`threats` :
   parties, taux de victoire de leur équipe, taux de ban), pour les conseils de ban.
10. **Backtest** : chaque nouvelle partie est comparée à la méta précédente avant d'être ajoutée
    (famille recommandée suivie ou non ; chaque achat du 4e au 6e objet parmi les objets
    conseillés à ce moment, ou non, comparés au même rang ; et le conseil d'objet suivant, à or
    égal, voir « Objet suivant »). Le taux de victoire des groupes est publié dans `meta.json`
    (`backtest`) et dans le journal.
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
    (1 = poids actuel, borné entre 0 et 3, rapproché de 1 s'il est mal mesuré), publié dans
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
| Affrontement direct (voie), propre au champion | 1 à 2,7 points | 350 à 2 500 |
| Synergie avec un allié | non mesurable | maximum |
| Contre un adversaire hors voie, propre au champion | 0,6 à 0,8 point | 4 000 à 7 000 |
| Équilibre de l'équipe (magique / physique, ligne de front) | jusqu'à 2 points | mesuré à part |
| Champion selon la composition adverse | 0 à 2 points | 600 à maximum |
| Famille de build, clé de voûte | 0,4 à 1 point | 2 500 à 15 000 |
| Page de runes, bottes, compétences, départ | 0,5 à 1,8 point | 700 à 6 500 |
| Objet comparé aux autres au même rang | ≈ 1,6 point | ≈ 1 000 |
| Runes / bottes / objets selon la composition adverse | non mesurable à ce volume | maximum |
| Objet face à un champion adverse précis | non mesurable à ce volume | maximum |

« Non mesurable » ne veut pas dire que l'effet n'existe pas en jeu, mais qu'il est trop petit pour
être distingué du hasard avec ce nombre de parties : il ne pèse alors presque rien, et pèsera
davantage de lui-même quand il y aura plus de parties (clé de production).

**Écart propre au champion.** Un champion fort fait perdre tous ses adversaires : « 45 % contre
Fizz » ne dit rien d'un pick si tous les champions du poste font 45 % contre Fizz. Pour les
affrontements, les alliés et les adversaires, la collecte retire donc l'effet général de chaque
partenaire (sa moyenne sur tous les champions du poste) et ne mesure que ce qui reste ; l'app fait
de même. C'est le seul écart qui se retrouve sur les parties suivantes.

**Mesure regroupée.** Chaque force est mesurée sur chaque poste et niveau, puis rapprochée de la
même mesure faite sur les six métas ensemble (bien plus précise) selon son incertitude. Le hasard
est aussi corrigé pour les compteurs repris du patch précédent avec un poids réduit, plus précis
que leur nombre de parties ne le laisse croire (champ `noise` de `priors`).

**Équilibre de l'équipe** (`fit` dans `meta.json`) : régression des écarts propres aux paires
d'alliés sur le produit des profils (dégâts magiques × dégâts magiques, résistance × résistance).
Une équipe toute magique ou toute physique, ou une deuxième ligne de front, gagne moins ; l'app
en déduit l'effet de chaque pick selon les alliés déjà choisis, dès le premier.

Validation hors échantillon (parties du 9 au 12 novembre prédites avec les métas du 9, six métas) :
l'équilibre de l'équipe prédit les parties suivantes à 88 % de sa taille (z = 6,7) ; les
affrontements directs et les adversaires hors voie sont prédits eux aussi (z = 6,2 et 5,3), les
synergies avec un allié ne le sont pas (z = 0,7).

Validation hors échantillon (parties du 10 et 11 novembre prédites avec la méta du 9) : avec
l'ancien lissage fixe, l'effet prédit d'un affrontement direct était 4 à 20 fois trop fort, et la
prédiction était moins bonne que de ne rien prédire ; avec le lissage mesuré, elle est calibrée.

## Objet suivant (3e au 6e objet)

Chaque achat du 3e au 6e objet légendaire est mesuré **selon ce qui est déjà possédé et selon la
partie**, à **or égal** (`src/nextItems.mjs`, publié dans `builds[].next`). Le 3e objet complète le
cœur : l'app ne le remplace que si un autre gagne nettement plus après les deux premiers dans cette
partie (par exemple face à un adversaire très en avance).

- **À or égal.** Un objet acheté surtout en menant gagne souvent… parce qu'on menait. Chaque achat
  est donc comparé à la victoire attendue selon l'écart d'or de l'équipe à ce moment (courbe par
  rang et par tranche d'écart, publiée dans `lead`) : seules les victoires en plus comptent.
- **Après les objets possédés.** Pour chaque objet déjà acheté, l'écart d'un objet suivant par
  rapport à son écart habituel (interaction), pondéré par ce que cet objet distingue : un objet que
  presque tout le monde a déjà ne dit rien de plus. Un objet presque jamais pris après un objet
  possédé (moins de 5 achats sur au moins 300) est écarté.
- **Selon la partie.** Mêmes interactions avec la composition adverse (dégâts magiques ou
  physiques, soins, résistance, contrôles) et alliée (voir « Équipe alliée »), avec l'avance ou le
  retard au moment de l'achat, et avec un **adversaire très en avance** à ce moment (au moins 30 %
  d'or de plus que la moyenne de son équipe et 1 500 pièces d'or de plus), selon ses dégâts
  (`fedAp` : surtout magiques, `fedAd` : surtout physiques). L'app impose toujours un objet
  anti-soins face à une équipe qui soigne beaucoup, sauf si la mesure le contredit pour ce
  champion.
- **Lissage mesuré**, comme le reste (`priors.nx0`, `nxJ`, `nxC`) : l'écart propre est rapproché
  de l'écart moyen de l'objet sur tous les champions, les interactions sont rapprochées de 0.

L'app reprend la même estimation (`engine/nextItems.ts`, vérifiée par un test de parité) et choisit
les objets un par un : le suivant est celui qui gagne le plus après les objets déjà prévus,
corrigé par les besoins de la partie (règles, adversaires précis, tes parties).

**Preuve hors échantillon.** Chaque nuit, avant d'ajouter les nouvelles parties, chaque achat du
3e au 6e objet est comparé au conseil de la méta de la veille (`backtest.next` dans `meta.json`) :

- victoires en plus des achats conformes au conseil moins celles des autres achats (`gain`, avec
  son erreur type `se`), pour plusieurs poids de la popularité (`gamma` : part des joueurs qui
  prennent l'objet après les mêmes objets, de 0 à 1) ;
- calibration : victoires en plus observées par point d'écart prévu (1 : prévisions exactes) ;
- l'ancien conseil (objets les plus construits selon le contexte), jugé de la même façon sur les
  achats du 4e au 6e objet (`old`).

Dès 1 000 achats vérifiés, `nextModel` publie le poids de popularité qui a le mieux réussi et la
pente de calibration (rapprochée de 1 selon son incertitude, bornée entre 0 et 2) : l'app multiplie
les écarts par cette pente. Si les écarts ne se vérifient pas le lendemain (pente proche de 0), les
règles reprennent la main et l'app n'affiche plus d'explication tirée de ces mesures. Le résultat
est affiché dans l'app (Réglages, « Qualité du moteur », et Bilan, « L'app t'aide-t-elle ? »).

Mesure sur les vraies parties avant ce modèle (backtest publié par les six métas) : acheter un
des trois objets les plus construits selon le contexte ne gagnait pas plus que les autres achats
(de −0,5 à +0,8 point selon la méta), d'où ce modèle.

## Adversaire direct, équipe alliée et moment des bottes

**Adversaire direct** (le jungler adverse pour un jungler, le joueur d'en face sinon). Le départ,
les bottes, la clé de voûte, la famille de build (1er objet), le moment des bottes et le familier
sont mesurés face à chaque adversaire (`opp` dans `builds[].choices` et `builds[].variants`) :
écart du taux de victoire de l'option face à lui, une fois retirés le taux habituel de l'option et
l'effet de cet adversaire sur le champion (un adversaire fort fait perdre toutes les options : cela
n'en distingue aucune). Écarts lissés avec la force mesurée (`priors.choiceVs`), publiés à partir
de 0,3 point. Le backtest de la famille et le réglage du moteur en tiennent compte.

**Équipe alliée.** Deux contextes de plus, tirés de la composition attendue des quatre alliés :
`allyAp` (alliés surtout magiques, au moins 55 % de dégâts magiques) et `allyAd` (surtout physiques,
35 % au plus). Ils comptent partout comme la composition adverse : familles de build (un champion
qui joue AP ou AD, comme Kai'Sa ou Varus), runes et autres choix, objets, objet suivant. L'app
n'utilise plus sa règle manuelle des dégâts qui manquent à l'équipe dès que la méta mesure ces
contextes.

**Moment des bottes** (`builds[].choices.bootsT`) : avant le 1er objet légendaire (`early`), entre le
1er et le 2e (`first`) ou après (`later`), selon la composition et l'adversaire direct. L'app place
les bottes au moment le plus courant pour le champion, sauf si un autre gagne nettement plus.

Ces mesures demandent beaucoup de parties par adversaire : avec peu de données, l'écart lissé est
proche de zéro et l'app garde le choix habituel. La clé de production multipliera les données.

## Modes : ARAM, modes temporaires (et ARAM Mayhem)

En plus du classé, la collecte lit les parties de plusieurs modes, chacun avec sa méta
(`meta-aram.json`, `meta-arurf.json`, `meta-urf.json`, `meta-ofa.json`) et son état
(`state/modes/<mode>/`) :

| Mode | File interrogée | Carte | Particularités |
| --- | --- | --- | --- |
| ARAM | 450 | Abîme hurlant | champions au hasard, banc et relances |
| ARURF, URF, Un pour tous | 900, 1900, 1020 | Faille | temporaires |
| ARAM Mayhem, Mayhem Classic-ish, Mêlée | 2400, 2450, 2300 | — | **privés : pas collectés** |

- **Modes privés** : Riot ne publie pas les parties d'ARAM Mayhem (et de ses variantes, ni de la
  Mêlée) dans son API. Elles n'apparaissent pas dans les listes de parties d'un joueur, et les
  lire renvoie « accès refusé ». C'est volontaire : Riot ne veut pas de taux de victoire calculés
  sur ces modes ([developer-relations #1109](https://github.com/RiotGames/developer-relations/issues/1109),
  [#1204](https://github.com/RiotGames/developer-relations/issues/1204)). Ils ne sont donc jamais
  interrogés. L'app utilise pour ARAM Mayhem la méta ARAM (même carte, mêmes objets, sans les
  runes) et classe les augments d'après ce qu'ils renforcent (voir `meta-augments.json`). Le
  calcul des statistiques d'augments (`augmentInfo`, `augmentItems`, `augmentPairs` dans
  aggregate.mjs, testé) reste prêt si Riot ouvre un jour ces données.
- **Joueurs** : d'abord ceux trouvés dans les parties du mode déjà lues (ils y jouent, donc
  presque chaque requête rapporte des parties), puis ceux du classement Or à Émeraude des régions
  de la méta Or (`MODE_REGIONS` pour en choisir d'autres). Tous rangs confondus : les modes n'ont
  qu'un niveau de données. (Avant : uniquement les joueurs classés, qui jouent peu en ARAM :
  environ 35 requêtes par partie ARAM trouvée ; maintenant environ 2.)
- **Budget** : la clé est partagée avec le classé. Tant que le classé collecte, les modes ne
  prennent pas plus de **25 %** des requêtes de chaque serveur (40 % avec une clé de production) ;
  quand le classé a fini, ils prennent tout le reste. Les modes actifs avancent chacun leur tour.
- **Modes temporaires** : si aucun des 25 premiers joueurs n'a de partie récente dans ce mode, il
  n'est plus interrogé jusqu'à la collecte suivante ; sa méta et son état précédents sont gardés.
- **Par partie**, les dix joueurs comptent (pas de poste) : builds, départs, bottes, compétences,
  alliés et adversaires (pas d'adversaire direct), équilibre de l'équipe, objets selon l'état de
  la partie, avec les objets finaux de la carte du mode. Repères propres aux modes : or et
  dégâts aux champions par minute, morts par 10 minutes, part des dégâts de l'équipe.
- **Runes et augments** : la méta indique ce qui est réellement utilisé dans les parties
  (`features`).

### meta-augments.json : les augments (données du jeu)

Les augments d'ARAM Mayhem et de Mayhem Classic-ish (listes `KIWI` et `KIWI_JADE` du jeu), sans
aucune statistique de parties : nom anglais et français, rareté, icône, description (anglais et,
quand CommunityDragon répond, français), objet amélioré (« Upgrade Infinity Edge »), objets
finaux cités (quêtes « Possède … ») et ce que l'augment renforce (`tags` : puissance, dégâts
d'attaque, attaques, vitesse d'attaque, critiques, effets à l'impact, compétences, accélération,
ultime, résistances, soins, boucliers, alliés, vol de vie, mana, vitesse, contrôles, or, sorts
d'invocateur). Les descriptions viennent des chaînes du jeu (`lol.stringtable.json`, ≈ 30 Mo
par langue) : le fichier n'est recalculé qu'au changement de patch, quand un augment apparaît,
ou si le français manquait la fois précédente.

## Commandes

```powershell
$env:RIOT_API_KEY = "RGAPI-..."   # votre clé
npm run test-rapide               # 3 minutes sur EUW, résultat dans test-local/
npm start                         # collecte complète (90 min par défaut ; sur GitHub, 300 min toutes les 6 heures)
npm test                          # tests sur données simulées
```

Options : `--minutes 90`, `--roles jungle,mid`, `--regions euw1,kr,na1`, `--gold-regions euw1` (vide : pas de méta Or), `--modes aram,urf` (vide : aucun mode ; les modes privés sont ignorés), `--mode-regions euw1`, `--min-games 40`, `--out dossier`.

## Limites

- Les limites de requêtes sont lues dans les réponses de Riot et le journal indique le type de clé
  (« Limites de la clé … → clé production »). Clé personnelle : 100 requêtes / 2 minutes par région,
  soit environ 1 500 parties par heure et par région. Sur GitHub, 4 collectes de 5 heures par jour
  (toutes les 6 heures) utilisent la clé environ 20 heures sur 24. Clé de production : en général 500 requêtes /
  10 secondes, la collecte va alors bien plus vite.
- GitHub peut désactiver une tâche planifiée d'un dépôt public après 60 jours sans activité. Si vous
  recevez l'e-mail d'avertissement, ouvrez l'onglet Actions et cliquez sur « Enable workflow ».
