// Backtest : les nouvelles parties de chaque collecte sont comparées aux recommandations de la
// méta de la veille (avant d'être ajoutées aux statistiques, pour ne pas se juger soi-même).
//
// - Famille de build : le joueur a-t-il commencé par la famille que la méta recommandait pour
//   le contexte adverse de sa partie ? Taux de victoire de ceux qui l'ont fait vs les autres.
// - Objets situationnels : parmi ses 4e à 6e objets, combien font partie des 3 objets que la méta
//   recommandait pour ce contexte ? (≥ 2 : « suivi », 0 : « ignoré »).
//
// C'est une mesure indirecte (les joueurs qui suivent la méta ne sont pas forcément les mêmes que
// les autres), mais elle permet de vérifier jour après jour que les changements vont dans le bon
// sens : l'écart entre « suivi » et « ignoré » doit rester positif et grandir.

const bayes = (g, w, prior, k) => (w + k * prior) / (g + k)

/** Famille recommandée pour une partie : meilleur taux lissé dans les contextes de la partie. */
export function recommendedVariant(build, contexts) {
  const variants = build?.variants ?? []
  if (variants.length < 2) return null
  let best = null
  for (const v of variants) {
    const specific = contexts.filter((c) => c !== 'all' && v.contexts?.[c])
    const rates = specific.map((c) =>
      bayes(v.contexts[c][0], v.contexts[c][0] * v.contexts[c][1], v.winRate, 30)
    )
    const score = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : v.winRate
    if (!best || score > best.score) best = { key: v.key, score }
  }
  return best?.key ?? null
}

/** 3 objets situationnels recommandés pour les contextes d'une partie (hors cœur). */
export function recommendedItems(build, contexts) {
  const core = new Set(build?.core ?? [])
  const score = new Map()
  for (const ctx of contexts) {
    const weight = ctx === 'all' ? 0.6 : 1
    for (const e of build?.situational?.[ctx]?.items ?? []) {
      if (core.has(e.item) || e.share < 0.08) continue
      score.set(e.item, (score.get(e.item) ?? 0) + weight * (e.share * 0.9 + e.lift * 6))
    }
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([item]) => item)
}

function inc(cell, win) {
  cell[0] += 1
  if (win) cell[1] += 1
}

/** Compare une partie aux recommandations de `meta` et met à jour les compteurs `bt`. */
export function evaluateRecord(meta, contexts, rec, bt, dd) {
  const build = meta?.builds?.find((b) => b.id === rec.champ)
  if (!build) return
  const name = (id) => dd.items.get(Number(id))?.name
  let counted = false

  const variant = recommendedVariant(build, contexts)
  if (variant && rec.core.length >= 1) {
    inc(name(rec.core[0]) === variant ? bt.variant.followed : bt.variant.other, rec.win)
    counted = true
  }

  if ((rec.items ?? []).length >= 4) {
    const wanted = recommendedItems(build, contexts)
    if (wanted.length === 3) {
      const late = rec.items.slice(3).map(name)
      const matches = late.filter((n) => wanted.includes(n)).length
      if (matches >= 2) inc(bt.items.high, rec.win)
      else if (matches === 0) inc(bt.items.low, rec.win)
      counted = true
    }
  }
  if (counted) bt.games++
}
