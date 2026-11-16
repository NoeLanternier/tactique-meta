// Adversaire direct, équipe alliée, adversaire très en avance et moment des bottes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addRecord,
  allyContexts,
  buildChoices,
  buildVariants,
  classifyContexts,
  emptyState,
  oppEffects
} from '../src/aggregate.mjs'
import { recommendedVariant } from '../src/backtest.mjs'
import { bootsTiming, fedAt } from '../src/extract.mjs'
import { addNext, buildNext, fedContexts, pooledNext } from '../src/nextItems.mjs'
import { measurePriors, oppRows } from '../src/priors.mjs'
import { tuningFeatures } from '../src/tuning.mjs'

let seed = 7
const random = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296
  return seed / 4294967296
}

const NAMES = { 1: 'A', 2: 'B', 3: 'C', 4: 'X', 5: 'Shield', 6: 'Other', 7: 'Pen' }
const dd = {
  patch: '16.22',
  items: new Map(Object.entries(NAMES).map(([id, name]) => [Number(id), { name, isLegendary: true, traits: [] }])),
  runes: new Map(),
  trees: new Map(),
  champById: new Map()
}
dd.items.set(1055, { name: "Doran's Blade", traits: [] })
dd.items.set(1054, { name: "Doran's Shield", traits: [] })
dd.items.set(2003, { name: 'Health Potion', traits: [] })
dd.items.set(3047, { name: 'Plated Steelcaps', isBoots: true, traits: [] })
dd.items.set(3111, { name: "Mercury's Treads", isBoots: true, traits: [] })

const SIG = '8000|8010,9111,9104,8014,8304,8347|8300|5005,5008,5001'
const rec = (over) => ({
  champ: 'Garen',
  win: false,
  runeSig: SIG,
  core: [1, 2, 3],
  later: [],
  items: [1, 2, 3],
  itemMin: [10, 16, 22],
  itemState: ['e', 'e', 'e'],
  itemLead: [0, 0, 0],
  boots: 3047,
  pet: null,
  start: '1055,2003',
  skills: 'Q>E>W',
  enemyJungler: 'Darius',
  allies: [],
  enemies: [],
  foeTags: [],
  bench: {},
  enemy: null,
  ...over
})

test('moment des bottes et adversaire très en avance', () => {
  assert.equal(bootsTiming(8, [10, 16]), 'early')
  assert.equal(bootsTiming(12, [10, 16]), 'first')
  assert.equal(bootsTiming(20, [10, 16]), 'later')
  assert.equal(bootsTiming(undefined, [10, 16]), 'later')
  assert.equal(bootsTiming(12, [10]), null)
  assert.equal(bootsTiming(undefined, [10]), null)
  const frame = (golds) => ({
    participantFrames: Object.fromEntries(golds.map((g, i) => [String(i + 1), { totalGold: g }]))
  })
  const teamOf = new Map(Array.from({ length: 10 }, (_, i) => [i + 1, i < 5 ? 100 : 200]))
  const tl = (golds) => ({ info: { frames: [frame(golds)] } })
  // Adversaires 6 à 10 : le 7 a 9 000 or contre 5 000 en moyenne pour les autres.
  assert.equal(fedAt(tl([5000, 5000, 5000, 5000, 5000, 5000, 9000, 5000, 4500, 4000]), teamOf, 100, 0), 7)
  assert.equal(fedAt(tl([5000, 5000, 5000, 5000, 5000, 5000, 5600, 5000, 4500, 4000]), teamOf, 100, 0), null)
  const profiles = { Syndra: { g: 50, phys: 10, magic: 90 }, Zed: { g: 50, phys: 90, magic: 10 }, Sett: { g: 50, phys: 50, magic: 50 } }
  assert.deepEqual(fedContexts(profiles, [null, 'Syndra', 'Zed', 'Sett', 'Inconnu']), [null, 'fedAp', 'fedAd', null, null])
})

test('équipe alliée : alliés surtout magiques ou physiques', () => {
  assert.deepEqual(allyContexts({ minutes: 1, phys: 30, magic: 70 }), ['allyAp'])
  assert.deepEqual(allyContexts({ minutes: 1, phys: 70, magic: 30 }), ['allyAd'])
  assert.deepEqual(allyContexts({ minutes: 1, phys: 55, magic: 45 }), [])
  assert.deepEqual(allyContexts(null), [])
  const state = emptyState('16.22', 0)
  assert.deepEqual(classifyContexts(state, null, { minutes: 1, phys: 30, magic: 70 }), ['all', 'allyAp'])
  // Famille AP et famille AD : la famille AD gagne avec des alliés AP, la famille AP avec des alliés AD.
  for (let i = 0; i < 6000; i++) {
    const apAllies = random() < 0.5
    const apFamily = random() < 0.5
    const good = apAllies !== apFamily
    addRecord(
      state,
      rec({
        champ: 'Kaisa',
        core: apFamily ? [4, 2, 3] : [1, 2, 3],
        items: apFamily ? [4, 2, 3] : [1, 2, 3],
        win: random() < (good ? 0.56 : 0.46),
        ally: apAllies ? { minutes: 1, phys: 30, magic: 70 } : { minutes: 1, phys: 70, magic: 30 }
      })
    )
  }
  const c = state.champs.Kaisa
  assert.ok(c.ctxBase.allyAp[0] > 2500 && c.ctxBase.allyAd[0] > 2500)
  const variants = buildVariants('Kaisa', c, dd, { minGames: 40, priors: measurePriors(state), allowNoRunes: true })
  const ap = variants.find((v) => v.key === 'X')
  const ad = variants.find((v) => v.key === 'A')
  assert.ok(ap.contexts.allyAd[1] > ap.contexts.allyAp[1] + 0.05)
  assert.ok(ad.contexts.allyAp[1] > ad.contexts.allyAd[1] + 0.05)
  // Le backtest choisit la famille selon les alliés.
  const build = { winRate: 0.51, variants }
  assert.equal(recommendedVariant(build, ['all', 'allyAp']), 'A')
  assert.equal(recommendedVariant(build, ['all', 'allyAd']), 'X')
})

/** Garen : face à Darius, la lame de Doran gagne bien plus que le bouclier ; face aux autres, pareil. */
function laneState() {
  const state = emptyState('16.22', 0)
  for (let i = 0; i < 12000; i++) {
    const opp = ['Darius', 'Teemo', 'Fiora', 'Shen'][i % 4]
    const blade = random() < 0.5
    // Darius gagne contre Garen en général (effet de l'adversaire, commun aux deux départs).
    let p = opp === 'Darius' ? 0.42 : 0.52
    if (opp === 'Darius') p += blade ? 0.06 : -0.06
    addRecord(
      state,
      rec({
        win: random() < p,
        enemyJungler: opp,
        start: blade ? '1055,2003' : '1054,2003',
        boots: random() < 0.5 ? 3047 : 3111,
        bootsT: random() < 0.6 ? 'first' : 'early'
      })
    )
  }
  return state
}

test('adversaire direct : départ mesuré face à lui, son effet général retiré', () => {
  const state = laneState()
  const c = state.champs.Garen
  const rows = oppRows(c).filter((r) => r.kind === 'start' && r.opp === 'Darius')
  assert.equal(rows.length, 2)
  const blade = rows.find((r) => r.value === '1055,2003')
  // Effet propre : +6 points environ face à Darius (et non −2 : son effet général est retiré).
  assert.ok(blade.d > 0.03, `blade ${blade.d}`)
  const priors = measurePriors(state)
  assert.ok(priors.choiceVs > 0)
  const choices = buildChoices(c, dd, priors)
  assert.equal(choices.start.length, 2)
  const b = choices.start.find((o) => o.items[0] === "Doran's Blade")
  const s = choices.start.find((o) => o.items[0] === "Doran's Shield")
  assert.ok(b.opp.Darius[1] > 0.005, JSON.stringify(b.opp))
  assert.ok(s.opp.Darius[1] < -0.005)
  // Face aux autres adversaires : au plus un petit écart dû au hasard.
  for (const o of ['Teemo', 'Fiora', 'Shen']) assert.ok(!b.opp[o] || Math.abs(b.opp[o][1]) < b.opp.Darius[1] / 2)
  // Moment des bottes publié comme un choix.
  assert.deepEqual(choices.bootsT.map((o) => o.value).sort(), ['early', 'first'])
  // Lecture directe.
  const get = oppEffects(c, priors.choiceVs)
  assert.equal(get('start', '1055,2003').Darius[1], b.opp.Darius[1])
  // Réglage du moteur : l'effet face à l'adversaire compte dans les choix.
  const meta = { builds: [{ id: 'Garen', winRate: 0.5, choices }], priors }
  const vsDarius = tuningFeatures(meta, rec({ start: '1055,2003', enemyJungler: 'Darius' }), ['all'], dd)
  const vsTeemo = tuningFeatures(meta, rec({ start: '1055,2003', enemyJungler: 'Teemo' }), ['all'], dd)
  assert.ok(vsDarius.choiceCtx - vsTeemo.choiceCtx > 0.005)
})

test('objet suivant : 3e objet et adversaire très en avance', () => {
  const state = emptyState('16.22', 0)
  const c = { nx: { '*': {}, a: {}, x: {} } }
  // 3e objet : « Shield » gagne face à un adversaire AP très en avance, « Pen » sinon.
  for (let i = 0; i < 8000; i++) {
    const fed = random() < 0.5
    const third = random() < 0.5 ? 5 : 7
    const good = fed ? third === 5 : third === 7
    addNext(
      state,
      c,
      {
        win: random() < (good ? 0.58 : 0.44),
        items: [1, 2, third],
        itemLead: [0, 0, 0],
        itemState: ['e', 'e', 'e'],
        itemFedCtx: [null, null, fed ? 'fedAp' : null]
      },
      ['all']
    )
  }
  assert.ok(c.nx['*']['5'][0] > 3000)
  const next = buildNext({ ...c, g: 8000 }, dd, measurePriors(state), pooledNext(state))
  assert.ok(next.ctx.fedAp.Shield[1] > 0.01, JSON.stringify(next.ctx.fedAp))
})
