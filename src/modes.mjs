// Modes de jeu collectés en plus des parties classées : ARAM, ARAM Mayhem, modes temporaires.
//
// Chaque mode a son état (state/modes/<mode>/<patch>.json) et sa méta (meta-<mode>.json), comme un
// poste de la Faille : builds, statistiques de sélection (alliés, adversaires, équilibre de
// l'équipe) et repères. Les files (queues) viennent des données du client (queues.json,
// CommunityDragon) ; la première de chaque liste est celle qu'on interroge. Les mêmes définitions
// existent dans l'app (src/shared/modes.ts).
//
// Modes privés : Riot ne publie pas leurs parties dans l'API (ARAM Mayhem et ses variantes, Mêlée :
// absentes des listes de parties, « 403 » à la lecture ; volontaire, pour qu'on ne calcule pas de
// taux de victoire sur ces modes). Ils ne sont pas collectés : l'app utilise pour eux la méta ARAM
// (même carte, mêmes objets) et ses propres parties. Le calcul des augments reste prêt
// (aggregate.mjs) si Riot ouvre un jour ces données.

export const MODES = {
  aram: { queues: [450], map: 12, label: 'ARAM', gameMode: 'ARAM', augments: false },
  mayhem: {
    queues: [2400],
    map: 12,
    label: 'ARAM Mayhem',
    gameMode: 'KIWI',
    augments: true,
    private: true
  },
  'mayhem-classic': {
    queues: [2450],
    map: 12,
    label: 'ARAM Mayhem Classic-ish',
    gameMode: 'KIWI_JADE',
    augments: true,
    temporary: true,
    private: true
  },
  arurf: { queues: [900], map: 11, label: 'ARURF', gameMode: 'ARURF', augments: false, temporary: true },
  urf: { queues: [1900], map: 11, label: 'URF', gameMode: 'URF', augments: false, temporary: true },
  ofa: { queues: [1020], map: 11, label: 'Un pour tous', gameMode: 'ONEFORALL', augments: false, temporary: true },
  brawl: {
    queues: [2300],
    map: 0,
    label: 'Brawl',
    gameMode: 'BRAWL',
    augments: false,
    temporary: true,
    private: true
  }
}

export const MODE_KEYS = Object.keys(MODES)
/** Modes collectés par défaut : ceux dont Riot publie les parties. */
export const COLLECTED_MODES = MODE_KEYS.filter((m) => !MODES[m].private)

/** Augments des modes (listes du jeu) : « KIWI » ARAM Mayhem, « KIWI_JADE » Mayhem Classic-ish. */
export const AUGMENT_LISTS = ['KIWI', 'KIWI_JADE']

/** Mode d'une file (null : pas un mode collecté). */
export function modeOfQueue(queueId) {
  for (const [key, m] of Object.entries(MODES)) if (m.queues.includes(queueId)) return key
  return null
}

/** Part des requêtes réservée aux modes (le reste pour le classé). Clé de production : davantage. */
export const MODE_SHARE = { personal: 0.25, production: 0.4 }

/**
 * Joueurs découverts dans les parties d'un mode (ils y jouent) : interrogés avant ceux du
 * classement, dans la limite de cette file par région.
 */
export const DISCOVERED_MAX = 20000

/**
 * Mode temporaire absent : après ce nombre de joueurs sans aucune partie de ce mode, on cesse de
 * l'interroger jusqu'à la prochaine collecte (une requête de moins par joueur).
 */
export const INACTIVE_AFTER = 25
