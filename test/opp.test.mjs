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
import { bootsTiming, extractProfiles, fedAt, foeTagsOf, foesAt } from '../src/extract.mjs'
import { itemTraits } from '../src/ddragon.mjs'
import { addProfiles, buildProfiles, laneContexts } from '../src/aggregate.mjs'
import { addNext, buildNext, fedContexts, pooledNext, purchaseContexts } from '../src/nextItems.mjs'
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

test('builds réels : objets critiques adverses et part magique habituelle des objets', () => {
  assert.ok(itemTraits('', { FlatCritChanceMod: 0.25, FlatPhysicalDamageMod: 40 }).includes('crit'))
  assert.ok(!itemTraits('', { FlatPhysicalDamageMod: 55 }).includes('crit'))
  const items = new Map([
    [10, { isLegendary: true, maps: new Set([11]), stats: { FlatCritChanceMod: 0.25, FlatPhysicalDamageMod: 40 }, traits: ['crit'] }],
    [11, { isLegendary: true, maps: new Set([11]), stats: { FlatPhysicalDamageMod: 55 }, traits: ['armorPen'] }],
    [12, { isLegendary: true, maps: new Set([11]), stats: { FlatMagicDamageMod: 90 }, traits: [] }]
  ])
  const dd2 = { items, champById: new Map([[21, 'MissFortune'], [22, 'Varus']]) }
  // Deux tireurs critiques : 3 objets critiques au moins → '#crit'.
  assert.ok(foeTagsOf([{ item0: 10, item1: 10 }, { item0: 10 }], dd2).includes('#crit'))
  assert.ok(!foeTagsOf([{ item0: 10, item1: 11 }], dd2).includes('#crit'))
  // Profils : part magique des objets (Miss Fortune létalité : 0 ; Varus AP : surtout magique).
  const match = (champ, its) => ({
    info: {
      gameDuration: 1800,
      participants: [{ championId: champ, ...Object.fromEntries(its.map((id, i) => [`item${i}`, id])) }]
    }
  })
  const state = emptyState('16.22', 0)
  for (let i = 0; i < 12; i++) {
    addProfiles(state, extractProfiles(match(21, [11, 11]), dd2))
    addProfiles(state, extractProfiles(match(22, [12, 12, 11]), dd2))
  }
  const profiles = buildProfiles(state, 10)
  assert.equal(profiles.MissFortune.itemAp, 0)
  assert.ok(profiles.Varus.itemAp > 0.6 && profiles.Varus.itemAp < 0.7, String(profiles.Varus.itemAp))
})

test('composition adverse au moment de chaque achat, d’après les vrais objets', () => {
  const items = new Map([
    [10, { stats: { FlatCritChanceMod: 0.25, FlatPhysicalDamageMod: 40 } }],
    [11, { stats: { FlatPhysicalDamageMod: 55 } }],
    [12, { stats: { FlatMagicDamageMod: 90 } }]
  ])
  const timeline = {
    info: {
      frames: Array.from({ length: 30 }, (_, m) => ({
        participantFrames: { 6: { totalGold: 500 + m * 400, currentGold: 300 }, 7: { totalGold: 500 + m * 380, currentGold: 200 } }
      }))
    }
  }
  const foes = [{ participantId: 6 }, { participantId: 7 }]
  const bought = new Map([
    [6, [{ id: 11, min: 9 }, { id: 11, min: 15 }]],
    [7, [{ id: 12, min: 10 }, { id: 12, min: 20 }]]
  ])
  const champ = (f) => (f.participantId === 6 ? 'MissFortune' : 'Varus')
  const at14 = foesAt(timeline, foes, bought, 14, { items }, champ)
  // Miss Fortune à 14 min : un objet AD (le second est acheté à 15 min), or dépensé d'après la chronologie.
  assert.deepEqual(at14[0], ['MissFortune', 500 + 14 * 400 - 300, 0, 55 * 35, 0])
  assert.equal(at14[1][2], 1800) // un objet AP à 14 min
  // Profils : Miss Fortune critique et physique d'habitude ; Varus physique d'habitude.
  const p = (phys, magic, crit, itemAp) => ({ g: 100, minutes: 3000, phys, magic, crit, itemAp: itemAp * 50, itemN: 50 })
  const profiles = {
    MissFortune: p(90000, 5000, 200, 0),
    Varus: p(80000, 20000, 60, 0.1),
    Garen: p(70000, 5000, 0, 0),
    Leona: p(20000, 30000, 0, 0.5),
    Lux: p(5000, 90000, 0, 1)
  }
  // Varus AP (deux objets AP) + Miss Fortune létalité (aucun critique) : équipe AP, pas critique.
  const late = [['MissFortune', 9000, 0, 3850, 0], ['Varus', 8000, 3600, 0, 0], ['Garen', 6000, 0, 1000, 0], ['Leona', 5000, 0, 0, 0], ['Lux', 7000, 3600, 0, 0]]
  // Au début (aucun objet) : profils habituels, Miss Fortune et Varus physiques → équipe AD, critique.
  const early = late.map(([c]) => [c, 500, 0, 0, 0])
  const [now, before] = purchaseContexts(profiles, [late, early])
  assert.ok(!now.includes('crit'), JSON.stringify(now))
  assert.ok(now.includes('ap') || !now.includes('ad'), JSON.stringify(now))
  assert.ok(!before.includes('ap'), JSON.stringify(before))
  // Miss Fortune et un second tireur critiques : 'crit'.
  const crits = [['MissFortune', 9000, 0, 5000, 0.75], ['Varus', 9000, 0, 5000, 0.5], ['Garen', 6000, 0, 1000, 0], ['Leona', 5000, 0, 0, 0], ['Lux', 7000, 3600, 0, 0]]
  assert.ok(purchaseContexts(profiles, [crits])[0].includes('crit'))
  // Moins de 3 adversaires connus : rien.
  assert.equal(purchaseContexts({}, [late])[0], null)
})

test('adversaire de voie par type (distance, dégâts) et sorts d’invocateur', () => {
  const dd3 = { ...dd, champRange: new Map([['Teemo', 500], ['Darius', 175]]) }
  const profiles = { Teemo: { g: 50, phys: 20, magic: 80 }, Darius: { g: 50, phys: 90, magic: 10 } }
  assert.deepEqual(laneContexts(profiles, dd3, 'Teemo'), ['vsRanged', 'vsAp'])
  assert.deepEqual(laneContexts(profiles, dd3, 'Darius'), ['vsMelee', 'vsAd'])
  assert.deepEqual(laneContexts(profiles, dd3, null), [])
  // Garen : Fantôme + Saut éclair gagne contre les adversaires de mêlée, Embrasement à distance.
  const state = emptyState('16.22', 0)
  for (let i = 0; i < 6000; i++) {
    const ranged = random() < 0.5
    const ghost = random() < 0.5
    const good = ranged ? !ghost : ghost
    addRecord(state, rec({ win: random() < (good ? 0.56 : 0.46), spells: ghost ? '4,6' : '4,14', lane: ranged ? ['vsRanged'] : ['vsMelee'] }))
  }
  const choices = buildChoices(state.champs.Garen, dd, measurePriors(state))
  const ghost = choices.spells.find((o) => o.ids.join() === '4,6')
  const ignite = choices.spells.find((o) => o.ids.join() === '4,14')
  assert.ok(ghost.contexts.vsMelee[1] > ghost.contexts.vsRanged[1] + 0.05)
  assert.ok(ignite.contexts.vsRanged[1] > ignite.contexts.vsMelee[1] + 0.05)
  // Le type d'adversaire ne fausse pas les objets par contexte (composition seulement).
  assert.equal(state.champs.Garen.ctxItems.vsMelee, undefined)
})
