// Tests des statistiques v4 : rang des objets, familles de build, objets face aux adversaires,
// caractéristiques des objets adverses et backtest.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDdragon, itemTraits } from '../src/ddragon.mjs'
import { foeTagsOf } from '../src/extract.mjs'
import {
  addRecord,
  buildItemCounters,
  buildMeta,
  emptyState,
  seedFromPrevious,
  situationalStats
} from '../src/aggregate.mjs'
import { evaluateRecord, recommendedItems, recommendedVariant } from '../src/backtest.mjs'

const runesJson = [
  {
    id: 8000,
    key: 'Precision',
    name: 'Precision',
    slots: [
      { runes: [{ id: 8010, name: 'Conqueror' }] },
      { runes: [{ id: 9111, name: 'Triumph' }] },
      { runes: [{ id: 9104, name: 'Legend: Alacrity' }] },
      { runes: [{ id: 8014, name: 'Coup de Grace' }] }
    ]
  },
  {
    id: 8300,
    key: 'Inspiration',
    name: 'Inspiration',
    slots: [
      { runes: [{ id: 8369, name: 'First Strike' }] },
      { runes: [{ id: 8304, name: 'Magical Footwear' }] },
      { runes: [{ id: 8345, name: 'Biscuit Delivery' }] },
      { runes: [{ id: 8347, name: 'Cosmic Insight' }] }
    ]
  }
]
const item = (name, total, extra = {}) => ({
  name,
  gold: { total },
  maps: { 11: true },
  tags: [],
  stats: { FlatPhysicalDamageMod: 40 },
  description: '',
  ...extra
})
const itemJson = {
  data: {
    3047: item('Plated Steelcaps', 1200, { tags: ['Boots'], stats: {} }),
    1101: item('Scorchclaw Pup', 450, { tags: ['Jungle'], stats: {} }),
    6692: item('Eclipse', 2900),
    6610: item('Sundered Sky', 3100),
    3071: item('Black Cleaver', 3000),
    6333: item("Death's Dance", 3300),
    3026: item('Guardian Angel', 3200),
    3156: item('Maw of Malmortius', 3100, {
      description: '<passive>Lifeline</passive> grants a <shield>magic damage Shield</shield>'
    }),
    3153: item('Blade of the Ruined King', 3200, {
      description: 'Attacks deal <physicalDamage>8% current Health</physicalDamage> physical damage'
    }),
    3033: item('Mortal Reminder', 3000, {
      description: '<stats>35% Armor Penetration</stats> applies <status>Grievous Wounds</status>'
    }),
    3157: item("Zhonya's Hourglass", 3250, {
      stats: { FlatMagicDamageMod: 105, FlatArmorMod: 50 },
      description: '<active>Stasis</active> become invulnerable'
    })
  }
}
const championJson = {
  data: {
    LeeSin: { id: 'LeeSin', key: '64' },
    MonkeyKing: { id: 'MonkeyKing', key: '62' },
    Zed: { id: 'Zed', key: '238' },
    Garen: { id: 'Garen', key: '86' }
  }
}
const dd = buildDdragon('16.21.1', championJson, itemJson, runesJson)
const SIG = '8000|8010,9111,9104,8014,8304,8347|8300|5005,5008,5001'

/** Enregistrement de jungler simulé (format de extractJunglers). */
function rec({ win, items, foes = ['Garen'], foeTags = [], champ = 'LeeSin' }) {
  return {
    champ,
    win,
    runeSig: SIG,
    core: items.slice(0, 3),
    later: items.slice(3, 6),
    items,
    itemMin: items.map((_, k) => 12 + k * 6),
    boots: 3047,
    pet: 1101,
    skills: 'Q>W>E',
    enemyJungler: 'MonkeyKing',
    allies: [],
    enemies: foes,
    foeTags,
    enemy: { minutes: 30, phys: 60000, magic: 20000, heal: 3000, tank: 100000, cc: 30 },
    bench: {}
  }
}

test('traits des objets adverses tirés de la description', () => {
  assert.deepEqual(dd.items.get(3153).traits, ['pctHp'])
  assert.deepEqual(dd.items.get(3033).traits.sort(), ['antiheal', 'armorPen'])
  assert.ok(dd.items.get(3157).traits.includes('antiCc'))
  assert.ok(dd.items.get(3157).traits.includes('armor'))
  assert.ok(dd.items.get(3156).traits.includes('shield'))
  assert.deepEqual(itemTraits('spell shield blocks the next ability', {}), ['antiCc'])
  const foes = [{ item0: 3153 }, { item0: 3153, item1: 3033 }, { item0: 3071 }]
  assert.deepEqual(foeTagsOf(foes, dd), ['#antiheal', '#pctHp'])
})

test('rang des objets : un objet tardif n’est plus « gagnant » juste parce qu’il est tardif', () => {
  const state = emptyState('16.21', 0)
  // Plus le joueur a d'objets, plus il gagne (avance d'or). Maw n'est jamais acheté que 5e,
  // et gagne autant que Sundered Sky au même rang.
  for (let i = 0; i < 400; i++) {
    const n = 3 + (i % 3) // 3, 4 ou 5 objets
    const fifth = i % 2 === 0 ? 3156 : 6610
    const items = [6692, 3071, 6333, 3026, fifth].slice(0, n)
    const win = n === 5 ? i % 10 < 8 : n === 4 ? i % 10 < 5 : i % 10 < 2
    addRecord(state, rec({ win, items }))
  }
  const sit = situationalStats(state.champs.LeeSin, dd)
  const maw = sit.all.items.find((x) => x.item === 'Maw of Malmortius')
  assert.ok(Math.abs(maw.lift) < 0.03, `lift ${maw.lift}`)
  assert.equal(maw.minute, 36)
  // L'ancienne mesure (avec / sans) aurait donné un gros écart positif.
  const c = state.champs.LeeSin
  const [g, w] = c.ctxItems.all['3156']
  const [G, W] = c.ctxBase.all
  assert.ok(w / g - (W - w) / (G - g) > 0.2)
})

test('familles de build : deux premiers objets distincts', () => {
  const state = emptyState('16.21', 0)
  for (let i = 0; i < 200; i++) {
    const first = i % 3 === 0 ? 6610 : 6692
    addRecord(state, rec({ win: i % 2 === 0, items: [first, 3071, 6333, 3026] }))
  }
  const meta = buildMeta(state, dd, null, { minGames: 40 })
  const lee = meta.builds.find((b) => b.id === 'LeeSin')
  assert.equal(lee.variants.length, 2)
  assert.deepEqual(
    lee.variants.map((v) => v.key),
    ['Eclipse', 'Sundered Sky']
  )
  assert.ok(lee.variants[1].share > 0.3 && lee.variants[1].share < 0.36)
  assert.deepEqual(lee.variants[1].core, ['Sundered Sky', 'Black Cleaver', "Death's Dance"])
  assert.ok(lee.variants[0].contexts.all[0] > 100)
})

test('objets face aux adversaires et aux objets adverses', () => {
  const state = emptyState('16.21', 0)
  let seed = 42
  const random = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296
    return seed / 4294967296
  }
  for (let i = 0; i < 20000; i++) {
    const zed = i % 2 === 0
    const ga = i % 4 < 2 ? 3026 : 3156 // GA dans la moitié des parties, avec ou sans Zed
    const pct = i % 3 === 0
    // Zed fait perdre tout le monde un peu ; GA gagne beaucoup plus que Maw face à Zed ;
    // Maw perd face aux dégâts en % PV.
    let p = 0.5 - (zed ? 0.05 : 0)
    if (zed && ga === 3026) p += 0.1
    if (zed && ga === 3156) p -= 0.05
    if (pct && ga === 3156) p -= 0.1
    const win = random() < p
    addRecord(
      state,
      rec({
        win,
        items: [6692, 3071, 6333, ga],
        foes: zed ? ['Zed'] : ['Garen'],
        foeTags: pct ? ['#pctHp'] : []
      })
    )
  }
  const counters = buildItemCounters(state, dd, { minItemGames: 100, minPairGames: 40 })
  assert.ok(counters['Guardian Angel'].Zed[1] > 0.02, JSON.stringify(counters['Guardian Angel']))
  assert.ok(
    counters['Maw of Malmortius']['#pctHp'][1] < -0.02,
    JSON.stringify(counters['Maw of Malmortius'])
  )
  // Reprise au patch suivant : compteurs réduits, rapports conservés.
  const seeded = seedFromPrevious(emptyState('16.22', 0), state, 0.25)
  assert.equal(seeded.itemAll['3026'][0], state.itemAll['3026'][0] * 0.25)
  assert.equal(seeded.champs.LeeSin.fam['6692'].g, state.champs.LeeSin.fam['6692'].g * 0.25)
})

test('backtest : famille et objets recommandés', () => {
  const build = {
    id: 'LeeSin',
    core: ['Eclipse', 'Black Cleaver', "Death's Dance"],
    winRate: 0.5,
    variants: [
      { key: 'Eclipse', winRate: 0.5, contexts: { ap: [200, 0.45] } },
      { key: 'Sundered Sky', winRate: 0.5, contexts: { ap: [200, 0.56] } }
    ],
    situational: {
      all: {
        games: 500,
        items: [
          { item: 'Guardian Angel', share: 0.3, lift: 0.01 },
          { item: 'Maw of Malmortius', share: 0.25, lift: 0.0 },
          { item: 'Blade of the Ruined King', share: 0.2, lift: 0.0 },
          { item: 'Mortal Reminder', share: 0.1, lift: -0.02 }
        ]
      }
    }
  }
  assert.equal(recommendedVariant(build, ['all', 'ap']), 'Sundered Sky')
  assert.equal(recommendedVariant(build, ['all']), 'Eclipse')
  assert.deepEqual(recommendedItems(build, ['all']), [
    'Guardian Angel',
    'Maw of Malmortius',
    'Blade of the Ruined King'
  ])
  const bt = emptyState('16.21', 0).backtest
  const meta = { builds: [build] }
  evaluateRecord(
    meta,
    ['all', 'ap'],
    rec({ win: true, items: [6610, 3071, 6333, 3026, 3156] }),
    bt,
    dd
  )
  evaluateRecord(
    meta,
    ['all', 'ap'],
    rec({ win: false, items: [6692, 3071, 6333, 3033, 3157] }),
    bt,
    dd
  )
  assert.deepEqual(bt.variant, { followed: [1, 1], other: [1, 0] })
  assert.deepEqual(bt.items, { high: [1, 1], low: [1, 0] })
  assert.equal(bt.games, 2)
})
