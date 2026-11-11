// Backtest : les nouvelles parties de chaque collecte sont comparées aux recommandations de la
// méta précédente (avant d'être ajoutées aux statistiques, pour ne pas se juger soi-même).
//
// - Famille de build : le joueur a-t-il commencé par la famille que la méta recommandait pour
//   le contexte adverse de sa partie ? Taux de victoire de ceux qui l'ont fait vs les autres.
// - Objets après le cœur : chaque achat du 4e au 6e objet est-il l'un des 3 objets que la méta
//   recommandait à ce moment (contexte adverse, avance ou retard, objets déjà achetés) ? Les achats
//   « suivis » et les autres sont comparés au même rang : comparer des parties entières
//   avantagerait ceux qui ont peu d'objets (les parties gagnées vite), ce qui faussait l'ancienne
//   mesure.
//
// C'est une mesure indirecte (les joueurs qui suivent la méta ne sont pas forcément les mêmes que
// les autres), mais elle permet de vérifier collecte après collecte que les changements vont dans
// le bon sens : l'écart entre « suivi » et « autre » doit rester positif.

import { DEFAULT_PRIORS } from './priors.mjs'
import { posterior } from './stats.mjs'

/** Famille recommandée pour une partie : meilleur taux estimé dans les contextes de la partie. */
export function recommendedVariant(build, contexts, priors = DEFAULT_PRIORS) {
  const variants = build?.variants ?? []
  if (variants.length < 2) return null
  const prior = build.winRate ?? 0.5
  const kFam = priors?.fam ?? DEFAULT_PRIORS.fam
  const kCtx = priors?.famCtx ?? DEFAULT_PRIORS.famCtx
  let best = null
  for (const v of variants) {
    const base = prior + posterior(v.games ?? 0, v.winRate - prior, kFam)
    const specific = contexts.filter((c) => c !== 'all' && v.contexts?.[c])
    const shifts = specific.map((c) => posterior(v.contexts[c][0], v.contexts[c][1] - base, kCtx))
    const score = base + (shifts.length ? shifts.reduce((a, b) => a + b, 0) / shifts.length : 0)
    if (!best || score > best.score) best = { key: v.key, score }
  }
  return best?.key ?? null
}

/** 3 objets recommandés après le cœur pour les contextes d'une partie, hors objets déjà achetés. */
export function recommendedItems(build, contexts, exclude = []) {
  const skip = new Set([...(build?.core ?? []), ...exclude])
  const score = new Map()
  for (const ctx of contexts) {
    const weight = ctx === 'all' ? 0.6 : 1
    for (const e of build?.situational?.[ctx]?.items ?? []) {
      if (skip.has(e.item) || e.share < 0.05) continue
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

const STATE_CONTEXT = { a: 'ahead', b: 'behind' }

/** Compare une partie aux recommandations de `meta` et met à jour les compteurs `bt`. */
export function evaluateRecord(meta, contexts, rec, bt, dd) {
  const build = meta?.builds?.find((b) => b.id === rec.champ)
  if (!build) return
  const name = (id) => dd.items.get(Number(id))?.name
  let counted = false

  const variant = recommendedVariant(build, contexts, meta.priors)
  if (variant && rec.core.length >= 1) {
    inc(name(rec.core[0]) === variant ? bt.variant.followed : bt.variant.other, rec.win)
    counted = true
  }

  const items = (rec.items ?? []).map(name)
  for (let k = 3; k < items.length; k++) {
    const state = STATE_CONTEXT[rec.itemState?.[k]]
    const wanted = recommendedItems(
      build,
      state ? [...contexts, state] : contexts,
      items.slice(0, k)
    )
    if (wanted.length < 3) continue
    inc(wanted.includes(items[k]) ? bt.items.high : bt.items.low, rec.win)
    counted = true
  }
  if (counted) bt.games++
}
