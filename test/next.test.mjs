// Objet suivant (4e au 6e objet) : à avance égale, après les objets possédés, vérifié le lendemain.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addRecord, buildMeta, emptyState } from '../src/aggregate.mjs'
import { evaluateRecord } from '../src/backtest.mjs'
import {
  DEFAULT_MODEL,
  GAMMAS,
  buildNext,
  emptyNextBacktest,
  leadBucket,
  nextEstimate,
  nextModel,
  pooledNext,
  publishLead,
  rankNext
} from '../src/nextItems.mjs'
import { measurePriors } from '../src/priors.mjs'

/** Mesures publiées d'un champion (comme dans buildMeta). */
const nextOf = (state, champ = 'Ahri') =>
  buildNext(state.champs[champ], dd, measurePriors(state), pooledNext(state))
/** Méta minimale pour le backtest : build avec ses mesures, et courbe de victoire attendue. */
const metaOf = (state) => ({
  builds: [{ id: 'Ahri', core: ['A', 'B', 'C'], next: nextOf(state) }],
  lead: publishLead(state)
})

let seed = 11
const random = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296
  return seed / 4294967296
}

const SIG = '8000|8010,9111,9104,8014,8304,8347|8300|5005,5008,5001'
const rec = (champ, win, items, lead, extra = {}) => ({
  champ, win, runeSig: SIG, core: items.slice(0, 3), later: items.slice(3, 6), items,
  itemMin: items.map((_, k) => 10 + 6 * k),
  itemState: lead.map((x) => (x >= 0.05 ? 'a' : x <= -0.05 ? 'b' : 'e')),
  itemLead: lead,
  boots: 3047, pet: null, skills: 'Q>W>E', enemyJungler: 'Zed', allies: [], enemies: ['Garen'],
  foeTags: [], bench: {}, enemy: null, ...extra
})
const NAMES = { 1: 'A', 2: 'B', 3: 'C', 4: 'Luxury', 5: 'Safety', 6: 'Other', 7: 'Pen', 8: 'Shield', 9: 'Burst', 10: 'Guard' }
const dd = {
  patch: '16.22',
  items: new Map(Object.entries(NAMES).map(([id, name]) => [Number(id), { name, isLegendary: true, traits: [] }])),
  runes: new Map(),
  trees: new Map(),
  champById: new Map()
}
dd.items.set(3047, { name: 'Plated Steelcaps', isBoots: true, traits: [] })

test('tranches d’écart d’or', () => {
  assert.equal(leadBucket(-0.3), 0)
  assert.equal(leadBucket(0), 3)
  assert.equal(leadBucket(0.3), 6)
})

test('à avance égale : l’objet acheté en menant n’est pas « meilleur »', () => {
  const state = emptyState('16.22', 0)
  // « Luxury » s'achète surtout en menant (où tout le monde gagne), « Safety » surtout en retard.
  for (let i = 0; i < 9000; i++) {
    const lead = [0.2, 0, -0.2][i % 3]
    const p = lead > 0 ? 0.72 : lead < 0 ? 0.3 : 0.5
    const r = random()
    const fourth = lead > 0 ? (r < 0.7 ? 4 : 6) : lead < 0 ? (r < 0.7 ? 5 : 6) : r < 0.33 ? 4 : r < 0.66 ? 5 : 6
    addRecord(state, rec('Ahri', random() < p, [1, 2, 3, fourth], [0, 0, 0, lead]))
  }
  const meta = buildMeta(state, dd, null, {})
  const next = nextOf(state)
  // Taux brut : Luxury bien au-dessus, Safety bien en dessous. À avance égale : rien.
  const [g4, w4] = state.champs.Ahri.nx['*']['4']
  assert.ok(w4 / g4 > 0.6)
  assert.ok(Math.abs(next.base.Luxury[1]) < 0.015, `Luxury ${next.base.Luxury[1]}`)
  assert.ok(Math.abs(next.base.Safety[1]) < 0.015, `Safety ${next.base.Safety[1]}`)
  // Courbe publiée : victoire attendue selon l'avance au 4e objet.
  assert.ok(meta.lead.p[3][6] > 0.65 && meta.lead.p[3][0] < 0.35)
  assert.deepEqual(meta.nextModel, { ...DEFAULT_MODEL, decisions: 0 })
  assert.ok(meta.priors.nx0 > 0 && meta.priors.nxJ > 0 && meta.priors.nxC > 0)
})

/** Parties où le meilleur 5e objet dépend du 4e : Pen après Luxury, Shield après Safety. */
function synergyGames(state, n, { day = 1, bt = null, meta = null } = {}) {
  for (let i = 0; i < n; i++) {
    const fourth = random() < 0.5 ? 4 : 5
    // (« Other » : un troisième choix neutre, comme dans les vraies parties.)
    const r5 = random()
    const fifth = r5 < 0.45 ? 7 : r5 < 0.9 ? 8 : 6
    const good = (fourth === 4 && fifth === 7) || (fourth === 5 && fifth === 8)
    const lead = (random() - 0.5) * 0.2
    const r = rec('Ahri', random() < (good ? 0.6 : 0.46) + lead, [1, 2, 3, fourth, fifth], [0, 0, 0, lead, lead])
    if (bt && meta) evaluateRecord(meta, ['all'], r, bt, dd)
    addRecord(state, r)
  }
  return day
}

test('après les objets possédés : le meilleur suivant dépend de ce qu’on a', () => {
  const state = emptyState('16.22', 0)
  synergyGames(state, 8000)
  const next = nextOf(state)
  assert.ok(next.after.Luxury.i.Pen[1] > 0.01, JSON.stringify(next.after.Luxury.i))
  assert.ok(next.after.Safety.i.Shield[1] > 0.01)
  const best = (owned) => rankNext(next, owned, [], { gamma: 0, slope: 1 })[0].item
  assert.equal(best(['A', 'B', 'C', 'Luxury']), 'Pen')
  assert.equal(best(['A', 'B', 'C', 'Safety']), 'Shield')
  // Possédé : jamais proposé.
  assert.ok(!rankNext(next, ['A', 'B', 'C', 'Luxury', 'Pen'], []).some((x) => x.item === 'Pen'))
  // Part des joueurs qui le prennent après ces objets.
  assert.ok(Math.abs(nextEstimate(next, 'Pen', ['Luxury']).share - 0.45) < 0.05)
})

test('objet presque jamais pris avec un autre : écarté', () => {
  const next = {
    base: { X: [500, 0.01, 0.3], Y: [500, 0, 0.3], Z: [500, 0, 0.3] },
    after: { J: { t: 400, i: { Y: [200, 0, 0.5], Z: [200, 0, 0.5] } } },
    ctx: { ap: { X: [100, -0.02] } }
  }
  assert.equal(nextEstimate(next, 'X', ['J']).excluded, true)
  assert.equal(nextEstimate(next, 'X', []).excluded, false)
  // Contexte : interaction pondérée par la force du contexte.
  assert.ok(Math.abs(nextEstimate(next, 'X', [], [['ap', 0.5]]).lift - 0) < 1e-9)
  assert.ok(Math.abs(nextEstimate(next, 'X', [], [['ap', 1]]).lift + 0.01) < 1e-9)
  assert.equal(nextEstimate(next, 'Inconnu', []), null)
})

test('backtest : les conseils de la veille sont jugés sur les parties du lendemain', () => {
  const state = emptyState('16.22', 0)
  synergyGames(state, 8000)
  const meta = metaOf(state)
  const bt = { games: 0, variant: { followed: [0, 0], other: [0, 0] }, items: { high: [0, 0], low: [0, 0] }, next: emptyNextBacktest() }
  // Lendemain : les mêmes règles du jeu.
  synergyGames(emptyState('16.22', 0), 6000, { bt, meta })
  assert.ok(bt.next.n > 3000)
  // Sans popularité (γ = 0) : suivre le conseil gagne nettement plus, à avance égale.
  const followed = bt.next.g[0].f
  const other = bt.next.g[0].o
  const gain = followed[1] / followed[0] - other[1] / other[0]
  assert.ok(gain > 0.05, `gain ${gain}`)
  const model = nextModel(bt.next)
  assert.equal(model.measured, true)
  assert.ok(GAMMAS.includes(model.gamma))
  // Les écarts prévus sont bien calibrés (pente proche de 1, rapprochée de 1 par son incertitude).
  assert.ok(model.slope > 0.6 && model.slope <= 2, `slope ${model.slope}`)
  // Résumé publié dans la méta suivante, avec le modèle mesuré.
  state.backtest = bt
  const published = buildMeta(state, dd, null, {})
  assert.equal(published.nextModel.measured, true)
  const summary = published.backtest.next
  assert.equal(summary.decisions, bt.next.n)
  assert.ok(summary.gammas[0].gain > 0.05)
  assert.ok(summary.calibration.slope > 0.5)
})
