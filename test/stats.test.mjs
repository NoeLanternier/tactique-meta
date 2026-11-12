// Lissage bayésien empirique : la force du lissage est mesurée sur les données.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { K_MAX, K_MIN, bestOption, momPrior, partitionCells, popularitySlope, posterior, rankOptions } from '../src/stats.mjs'
import { measurePriors, pooledItemLifts, stateOfLead, championItemLift } from '../src/priors.mjs'
import { addRecord, buildMeta, buildThreats, emptyState, situationalStats } from '../src/aggregate.mjs'
import { leadAt } from '../src/extract.mjs'

let seed = 7
const random = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296
  return seed / 4294967296
}
const gauss = () => Math.sqrt(-2 * Math.log(random() || 1e-9)) * Math.cos(2 * Math.PI * random())
const binom = (n, p) => {
  let w = 0
  for (let i = 0; i < n; i++) if (random() < p) w++
  return w
}

test('méthode des moments : retrouve la taille des vrais écarts', () => {
  // 600 options dont le vrai taux s'écarte de 50 % avec un écart-type de 2 points.
  const cells = []
  for (let i = 0; i < 600; i++) {
    const n = 100 + Math.floor(random() * 900)
    const p = 0.5 + 0.02 * gauss()
    cells.push([n, binom(n, p) / n - 0.5, 0.25 / n])
  }
  const { k, tau } = momPrior(cells)
  assert.ok(Math.abs(tau - 0.02) < 0.004, `tau ${tau}`)
  assert.ok(k > 400 && k < 1000, `k ${k}`) // 0,25 / 0,02² = 625
  // Aucun vrai écart : lissage maximal.
  const noise = []
  for (let i = 0; i < 600; i++) {
    const n = 100 + Math.floor(random() * 900)
    noise.push([n, binom(n, 0.5) / n - 0.5, 0.25 / n])
  }
  assert.ok(momPrior(noise).k > 5000, `k ${momPrior(noise).k}`)
  // Trop peu de cellules : valeur par défaut.
  assert.equal(momPrior(cells.slice(0, 5), { fallback: 1234 }).k, 1234)
  assert.ok(K_MIN < K_MAX)
})

test('meilleure option : la plus jouée, sauf avantage établi', () => {
  // 60 % sur 30 parties ne bat pas 51 % sur 3 000 parties (lissage 2 000).
  const map = { usual: [3000, 1530], lucky: [300, 165], rare: [30, 18] }
  assert.equal(bestOption(map, { k: 2000 }), 'usual')
  // 56 % sur 2 500 parties, si : l'avantage est établi.
  assert.equal(bestOption({ usual: [3000, 1530], strong: [2500, 1400] }, { k: 2000 }), 'strong')
  // Popularité : à écart égal, l'option la plus jouée passe devant.
  const ranked = rankOptions({ a: [4000, 2000], b: [500, 250] }, { k: 2000, slope: 0.003 })
  assert.equal(ranked[0].key, 'a')
  assert.ok(ranked[1].estimate < 0)
  // Aucune option assez jouée : la plus jouée.
  assert.equal(bestOption({ a: [3, 3], b: [4, 0] }, { minGames: 5 }), 'b')
  assert.equal(bestOption({}, {}), null)
  assert.ok(Math.abs(posterior(100, 0.1, 900) - 0.01) < 1e-12)
})

test('cellules d’options qui se partagent les mêmes parties, et pente de popularité', () => {
  const cells = partitionCells({ a: [800, 420], b: [200, 90], c: [10, 9] }, { minTotal: 100 })
  assert.equal(cells.length, 2) // c : trop peu jouée
  const [n, dev, v, share] = cells[0]
  assert.equal(n, 800)
  assert.ok(Math.abs(dev - (420 / 800 - 519 / 1010)) < 1e-12)
  assert.ok(v < 0.25 / 800) // corrigée : l'option fait partie de l'ensemble
  assert.ok(Math.abs(share - 800 / 1010) < 1e-12)
  // Options populaires meilleures de 0,3 point par doublement : pente retrouvée.
  const many = []
  for (let i = 0; i < 400; i++) {
    const share = 0.05 + random() * 0.6
    const n = Math.round(share * 4000)
    const p = 0.5 + 0.003 * Math.log2(share / 0.25)
    many.push([n, binom(n, p) / n - 0.5, 0.25 / n, share])
  }
  const slope = popularitySlope(many)
  assert.ok(slope > 0.0015 && slope <= 0.005, `slope ${slope}`)
})

test('état de la partie à l’achat : avance, égalité, retard', () => {
  assert.equal(stateOfLead(0.08), 'a')
  assert.equal(stateOfLead(-0.08), 'b')
  assert.equal(stateOfLead(0.01), 'e')
  assert.equal(stateOfLead(null), null)
  const teamOf = new Map([[1, 100], [2, 200]])
  const timeline = { info: { frames: [0, 1, 2].map((m) => ({ participantFrames: { 1: { totalGold: 1000 + m * 600 }, 2: { totalGold: 1000 + m * 400 } } })) } }
  assert.equal(leadAt(timeline, teamOf, 100, 0.5), 0)
  assert.ok(Math.abs(leadAt(timeline, teamOf, 100, 2.4) - 400 / 1800) < 1e-12)
  assert.ok(leadAt(timeline, teamOf, 200, 2.4) < 0)
  assert.equal(leadAt(null, teamOf, 100, 3), null)
})

const SIG = '8000|8010,9111,9104,8014,8304,8347|8300|5005,5008,5001'
const rec = (champ, win, items, itemState, extra = {}) => ({
  champ, win, runeSig: SIG, core: items.slice(0, 3), later: items.slice(3, 6), items,
  itemMin: items.map((_, k) => 10 + 6 * k), itemState, boots: 3047, pet: null, skills: 'Q>W>E',
  enemyJungler: 'Zed', allies: [], enemies: ['Garen'], foeTags: [], bench: {}, enemy: null, ...extra
})
const dd = {
  patch: '16.22',
  items: new Map([[1, 'A'], [2, 'B'], [3, 'C'], [4, 'Luxury'], [5, 'Safety'], [6, 'Other'], [3047, 'Plated Steelcaps']].map(([id, name]) => [id, { name, isLegendary: id < 100, traits: [] }])),
  runes: new Map(), trees: new Map(), champById: new Map()
}

test('objets comparés au même rang et dans le même état de la partie', () => {
  const state = emptyState('16.22', 0)
  // « Luxury » s'achète surtout en avance (où tout le monde gagne), « Safety » surtout en retard.
  // À état égal, les deux gagnent autant que l'autre choix « Other ».
  for (let i = 0; i < 6000; i++) {
    const st = ['a', 'e', 'b'][i % 3]
    const p = st === 'a' ? 0.68 : st === 'b' ? 0.32 : 0.5
    const r = random()
    const fourth = st === 'a' ? (r < 0.6 ? 4 : r < 0.7 ? 5 : 6) : st === 'b' ? (r < 0.1 ? 4 : r < 0.7 ? 5 : 6) : r < 0.3 ? 4 : r < 0.6 ? 5 : 6
    addRecord(state, rec('Ahri', random() < p, [1, 2, 3, fourth], ['e', 'e', st, st]))
  }
  const c = state.champs.Ahri
  assert.ok(c.sl.a[3]['4'][0] > 1000)
  // Sans tenir compte de l'état, Luxury aurait un gros écart positif et Safety un gros écart négatif.
  const naive = (id) => { const [g, w] = c.ctxItems.all[id]; return w / g - c.w / c.g }
  assert.ok(naive('4') > 0.06 && naive('5') < -0.06)
  const [n, lift] = championItemLift(c, '4', {}, 1000)
  assert.ok(n > 1500 && Math.abs(lift) < 0.02, `lift ${lift}`)
  assert.ok(Math.abs(championItemLift(c, '5', {}, 1000)[1]) < 0.02)
  const sit = situationalStats(c, dd, { priors: { slot: 1000 } })
  const share = (ctx, name) => sit[ctx].items.find((x) => x.item === name).share
  // Part des achats selon l'état : Luxury davantage en avance, Safety davantage en retard.
  assert.ok(share('ahead', 'Luxury') > share('all', 'Luxury') * 1.4)
  assert.ok(share('behind', 'Safety') > share('all', 'Safety') * 1.4)
  assert.ok(share('behind', 'Luxury') < share('all', 'Luxury') * 0.6)
  assert.ok(sit.all.items.every((x) => Math.abs(x.lift) < 0.02))
  // Effets regroupés : rien de mesurable ici non plus.
  const pooled = pooledItemLifts(state)
  assert.ok(Math.abs(pooled['4'].lift) < 0.02 && pooled['4'].games > 1500)
})

test('lissages mesurés publiés dans la méta, et adversaires de tous postes', () => {
  const state = emptyState('16.22', 0)
  for (let i = 0; i < 900; i++)
    addRecord(state, rec(i % 2 ? 'Ahri' : 'Lux', random() < 0.5, [1, 2, 3], ['e', 'e', 'e'], { enemies: [i % 3 ? 'Garen' : 'Darius'] }))
  const priors = measurePriors(state)
  for (const key of ['vs', 'pair', 'comp', 'fam', 'famCtx', 'runes', 'boots', 'skills', 'start', 'c1', 'c2', 'c3', 'slot', 'choiceCtx'])
    assert.ok(priors[key] >= K_MIN && priors[key] <= K_MAX, `${key} ${priors[key]}`)
  assert.ok(priors.slope.item >= 0 && priors.slope.item <= 0.005)
  const threats = buildThreats(state)
  assert.equal(threats.Zed[0], 900) // adversaire direct compris
  assert.equal(threats.Garen[0], 600)
  assert.ok(threats.Garen[1] > 0.4 && threats.Garen[1] < 0.6)
  const meta = buildMeta(state, { ...dd, version: '16.22.1' }, null, { minGames: 40 })
  assert.equal(meta.priors.vs, priors.vs)
  assert.ok(meta.threats.Darius)
})

// Poste simulé : champions × partenaires, avec un effet général de chaque partenaire (le même pour
// tous les champions), des interactions vraies d'écart-type `tau`, et l'équilibre magique / physique.
function simulatedRole({ tau = 0, fitAp = 0, games = 120, champs = 40, partners = 60 } = {}) {
  const profiles = {}
  const state = { champs: {} }
  const general = Array.from({ length: partners }, () => 0.03 * gauss())
  for (let p = 0; p < partners; p++) profiles[`P${p}`] = { ap: random(), tank: random() }
  for (let c = 0; c < champs; c++) {
    const id = `C${c}`
    profiles[id] = { ap: random(), tank: random() }
    const base = 0.5 + 0.015 * gauss()
    const row = { g: 0, w: 0, vs: {}, with: {}, against: {} }
    for (let p = 0; p < partners; p++) {
      const pid = `P${p}`
      const n = Math.round(games * (0.5 + random()))
      const fit = fitAp * (profiles[id].ap - 0.5) * (profiles[pid].ap - 0.5)
      const rate = base + general[p] + tau * gauss() + fit
      row.with[pid] = [n, binom(n, rate)]
      row.against[pid] = [n, binom(n, base - general[p])]
      row.g += n
      row.w += row.with[pid][1]
    }
    state.champs[id] = row
  }
  return { state, profiles }
}

test('alliés et adversaires : seul l’écart propre au champion compte, mesuré sur tous les postes', async () => {
  const { interactionCells, measurePriors, poolEvidence, priorEvidence } = await import('../src/priors.mjs')
  // L'effet général des partenaires (±3 points) est retiré : il ne passe pas pour une interaction.
  const flat = simulatedRole({ tau: 0 })
  // (côté alliés : le taux du champion vient des mêmes parties, comme dans les vraies données.)
  const cells = interactionCells(Object.entries(flat.state.champs), 'with')
  assert.ok(cells.length > 2000)
  assert.ok(momPrior(cells).k >= 5000, `k ${momPrior(cells).k}`)
  // Interactions réelles de 2 points avec les alliés : retrouvées (k ≈ 0,25 / 0,02² = 625).
  const real = simulatedRole({ tau: 0.02 })
  const p = measurePriors(real.state)
  assert.ok(p.with > 300 && p.with < 1500, `with ${p.with}`)
  assert.equal(p.pair, Math.max(p.with, p.against))
  // Mesure regroupée : un petit poste imprécis est rapproché de la mesure de tous les postes.
  const small = simulatedRole({ tau: 0, games: 15, champs: 12, partners: 30 })
  const pooled = poolEvidence([real.state, simulatedRole({ tau: 0.02 }).state, small.state])
  const alone = measurePriors(small.state).with
  const joined = measurePriors(small.state, pooled).with
  assert.ok(joined < alone, `${joined} < ${alone}`)
  assert.ok(priorEvidence(real.state).with.cells > 2000)
})

test('équilibre de l’équipe : une équipe toute magique ou toute physique gagne moins', async () => {
  const { measureFit, FIT_PRIOR } = await import('../src/priors.mjs')
  // Vrai effet : −8 points × (écart de profil du champion) × (écart de profil de l'allié).
  const { state, profiles } = simulatedRole({ fitAp: -0.08, games: 400, champs: 60, partners: 80 })
  const fit = measureFit(state, profiles)
  assert.ok(fit.ap < -0.04 * 0.9 || fit.ap === -0.04, `ap ${fit.ap}`) // borné à −0,04
  assert.ok(Math.abs(fit.center.ap[0] - 0.5) < 0.15)
  // Aucun effet : la mesure ramène vers 0, loin de la valeur a priori.
  const none = measureFit(simulatedRole({ games: 400, champs: 60, partners: 80 }).state, profiles)
  assert.ok(none.ap > FIT_PRIOR.ap[0] / 2, `ap ${none.ap}`)
  assert.ok(none.ap <= 0)
  // Sans profils : rien.
  assert.equal(measureFit(state, null), null)
})
