// Modes (ARAM, ARAM Mayhem…) : extraction des parties, augments, part des requêtes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAugments, buildDdragon, legendaryOn } from '../src/ddragon.mjs'
import { augmentsOf, extractModePlayers, precheckMode } from '../src/extract.mjs'
import { addRecord, augmentStats, buildMeta, emptyState, expectedEnemy } from '../src/aggregate.mjs'
import { MODES, modeOfQueue } from '../src/modes.mjs'
import { RiotClient } from '../src/riot.mjs'

const item = (name, total, maps, extra = {}) => ({ name, gold: { total }, maps, tags: [], stats: {}, description: '', ...extra })
const dd = buildDdragon(
  '16.22.1',
  { data: { Ahri: { id: 'Ahri', key: '103' }, Lux: { id: 'Lux', key: '99' }, Garen: { id: 'Garen', key: '86' } } },
  {
    data: {
      // Objet de l'Abîme seulement, objet de la Faille seulement, objet des deux.
      9001: item('Abyss Only', 3000, { 11: false, 12: true }),
      9002: item('Rift Only', 3000, { 11: true, 12: false }),
      6655: item("Luden's Companion", 2900, { 11: true, 12: true }, { stats: { FlatMagicDamageMod: 95 } }),
      3089: item("Rabadon's Deathcap", 3600, { 11: true, 12: true }, { stats: { FlatMagicDamageMod: 130 } }),
      3157: item("Zhonya's Hourglass", 3250, { 11: true, 12: true }, { stats: { FlatMagicDamageMod: 105 } }),
      3020: item("Sorcerer's Shoes", 1100, { 11: true, 12: true }, { tags: ['Boots'] })
    }
  },
  [{ id: 8100, name: 'Domination', slots: [{ runes: [{ id: 8112, name: 'Electrocute' }] }] }]
)

test('files des modes et objets finaux selon la carte', () => {
  assert.equal(modeOfQueue(450), 'aram')
  assert.equal(modeOfQueue(2400), 'mayhem')
  assert.equal(modeOfQueue(420), null)
  assert.equal(legendaryOn(dd.items.get(9001), 12), true)
  assert.equal(legendaryOn(dd.items.get(9001), 11), false)
  assert.equal(legendaryOn(dd.items.get(9002), 12), false)
  assert.equal(legendaryOn(dd.items.get(9002), 11), true)
  assert.equal(legendaryOn(dd.items.get(3020), 12), false) // bottes
})

test('augments du jeu : noms, rareté, listes par mode', () => {
  const { augments, augmentModes } = buildAugments(
    [
      { id: 1205, augmentNameId: 'ARAM_ADAPt', nameTRA: 'ADAPt', augmentSmallIconPath: '/x.png', rarity: 'kSilver' },
      { id: 7, augmentNameId: 'Bad', nameTRA: 'Bad', rarity: 'kBronze' }
    ],
    [{ id: 1205, nameTRA: 'ADAPtation' }],
    [{ modeName: 'KIWI', augmentList: ['Maps/ModeSpecificData/Augments/ARAM_ADAPt', 'Maps/X/Unknown'] }]
  )
  assert.deepEqual(augments.get(1205), { id: 1205, nameId: 'ARAM_ADAPt', name: 'ADAPt', nameFr: 'ADAPtation', rarity: 'silver', icon: '/x.png' })
  assert.equal(augments.has(7), false)
  assert.deepEqual([...augmentModes.KIWI], [1205])
  // Données absentes : rien, sans erreur.
  assert.equal(buildAugments(null, null, null).augments.size, 0)
})

function aramMatch(queue = 450, win = true, augment = 1205) {
  const champs = [103, 99, 86, 103, 99, 86, 103, 99, 86, 103]
  const participants = champs.map((championId, i) => ({
    participantId: i + 1,
    teamId: i < 5 ? 100 : 200,
    championId,
    teamPosition: '',
    win: i < 5 ? win : !win,
    perks: {},
    goldEarned: 12000,
    kills: 5,
    deaths: 6,
    assists: 10,
    physicalDamageDealtToChampions: 5000,
    magicDamageDealtToChampions: i === 0 ? 40000 : 20000,
    // Les deux équipes prennent des augments différents (sinon l'effet s'annule).
    playerAugment1: queue === 2400 ? (i < 5 ? augment : augment === 1205 ? 77 : 1205) : 0,
    playerAugment2: queue === 2400 ? 206 : 0
  }))
  const events = [
    { type: 'ITEM_PURCHASED', participantId: 1, itemId: 9001, timestamp: 300000 },
    { type: 'ITEM_PURCHASED', participantId: 1, itemId: 9002, timestamp: 400000 },
    { type: 'ITEM_PURCHASED', participantId: 1, itemId: 6655, timestamp: 500000 },
    { type: 'ITEM_PURCHASED', participantId: 1, itemId: 3020, timestamp: 550000 },
    { type: 'ITEM_PURCHASED', participantId: 1, itemId: 3089, timestamp: 700000 }
  ]
  return [
    { info: { queueId: queue, mapId: 12, gameVersion: '16.22.1.1', gameDuration: 1080, participants } },
    {
      info: {
        frames: Array.from({ length: 17 }, (_, m) => ({
          timestamp: m * 60000,
          events: m === 0 ? events : [],
          participantFrames: Object.fromEntries(
            Array.from({ length: 10 }, (_, k) => [String(k + 1), { minionsKilled: 3 * m, totalGold: 600 * m, level: Math.min(18, m + 3) }])
          )
        }))
      }
    }
  ]
}

test('partie ARAM : dix joueurs, sans poste ni adversaire direct, objets de l’Abîme', () => {
  const [match, timeline] = aramMatch()
  assert.equal(precheckMode(match, '16.22', 'aram'), 'ok')
  assert.equal(precheckMode(match, '16.22', 'mayhem'), 'file')
  assert.equal(precheckMode({ info: { ...match.info, gameDuration: 300 } }, '16.22', 'aram'), 'trop courte')
  const recs = extractModePlayers(match, timeline, dd, 'aram')
  assert.equal(recs.length, 10)
  const me = recs[0]
  assert.equal(me.role, 'aram')
  assert.equal(me.mode, 'aram')
  assert.equal(me.enemyJungler, null)
  assert.equal(me.allies.length, 4)
  assert.equal(me.enemies.length, 5)
  assert.equal(me.pet, null)
  // Objet de l'Abîme compté, objet de la Faille seule ignoré.
  assert.deepEqual(me.core, [9001, 6655, 3089])
  assert.equal(me.runeSig, null)
  assert.ok(me.bench.dmgPerMin > 0 && me.bench.goldPerMin > 0 && me.bench.deathsPer10 > 0)
  assert.ok(me.bench.dmgShare > 0.2)
  assert.deepEqual(augmentsOf({ playerAugment1: 3, playerAugment2: 0, playerAugment3: 5 }), [3, 5])
})

test('ARAM Mayhem : augments par champion, lissés vers l’effet de l’augment', () => {
  const state = emptyState('16.22', 0)
  let seed = 3
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
  for (let i = 0; i < 600; i++) {
    // L'augment 1205 gagne plus souvent que 77.
    const aug = rand() < 0.5 ? 1205 : 77
    const win = rand() < (aug === 1205 ? 0.6 : 0.45)
    const [match, timeline] = aramMatch(2400, win, aug)
    for (const rec of extractModePlayers(match, timeline, dd, 'mayhem')) {
      rec.enemy = expectedEnemy({}, rec.enemies)
      addRecord(state, rec)
    }
  }
  const aug = augmentStats(state)
  assert.ok(aug.pooled['1205'].lift > aug.pooled['77'].lift)
  assert.ok(aug.perChamp.Ahri.length > 0)
  // Méta du mode : augments publiés (seulement ceux connus du jeu), sans runes.
  Object.assign(dd, buildAugments(
    [{ id: 1205, augmentNameId: 'A', nameTRA: 'ADAPt', rarity: 'kSilver' }, { id: 206, augmentNameId: 'B', nameTRA: 'escAPADe', rarity: 'kGold' }],
    null,
    [{ modeName: 'KIWI', augmentList: ['X/A', 'X/B'] }]
  ))
  const meta = buildMeta(state, dd, null, { minGames: 20, role: 'mayhem', mode: 'mayhem' })
  assert.equal(meta.mode, 'mayhem')
  assert.deepEqual(meta.features, { runes: false, augments: true })
  assert.deepEqual(Object.keys(meta.augmentInfo).sort(), ['1205', '206'])
  const ahri = meta.builds.find((b) => b.id === 'Ahri')
  assert.equal(ahri.runes, null) // pas de runes en Mayhem
  assert.equal(ahri.pet, null)
  assert.ok(ahri.augments.every((a) => meta.augmentInfo[a.id]))
  assert.ok(meta.benchmarks._all.dmgPerMin > 0)
  assert.equal(MODES.mayhem.gameMode, 'KIWI')
})

test('part des requêtes des modes limitée tant que le classé collecte', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) })
  const riot = new RiotClient('RGAPI-x', { fetchImpl, limits: [[100000, 1000]], modeShare: 0.25 })
  const order = []
  const loop = async (lane, n) => {
    for (let i = 0; i < n; i++) {
      await riot.get('europe', '/x', lane)
      order.push(lane)
      await new Promise((r) => setTimeout(r, 40))
    }
  }
  await Promise.all([loop('main', 60), loop('mode', 60)])
  // Pendant que le classé tourne, les modes restent autour de 25 % des requêtes.
  const firstHalf = order.slice(0, 60)
  const share = firstHalf.filter((x) => x === 'mode').length / firstHalf.length
  assert.ok(share > 0.15 && share < 0.35, `part ${share}`)
  // Classé terminé : les modes passent sans attendre.
  assert.equal(riot.stats.lanes.mode, 60)
})

test('ARAM Mayhem : objets qui vont avec un augment, augments qui vont ensemble', async () => {
  const { augmentItemStats, augmentPairStats } = await import('../src/aggregate.mjs')
  // 20 champions : Rabadon acheté par 20 % des joueurs, mais par 60 % de ceux qui prennent 1205.
  const champs = {}
  for (let i = 0; i < 20; i++)
    champs[`C${i}`] = {
      g: 1000, w: 500,
      aug: { 1205: [200, 100], 77: [200, 100] },
      ctxItems: { all: { 3089: [200, 100], 3157: [300, 150] } }
    }
  const state = {
    champs,
    itemAll: { 3089: [4000, 2000], 3157: [6000, 3000] },
    // Avec 1205 : Rabadon 2 400 fois sur 4 000 et gagne 58 % ; Zhonya comme d'habitude.
    augItem: { 1205: { 3089: [2400, 1392], 3157: [1200, 600] }, 77: { 3089: [800, 400] } },
    augPair: { '1205|77': [800, 520], '1205|99': [800, 400] }
  }
  const items = augmentItemStats(state, dd)
  assert.equal(items['1205'][0].id, 3089)
  assert.ok(Math.abs(items['1205'][0].uplift - 0.4) < 1e-9)
  assert.ok(items['1205'][0].lift > 0.02)
  // Zhonya : pas plus acheté avec 1205 que d'habitude, donc absent ; 77 : rien de particulier.
  assert.ok(!items['1205'].some((x) => x.id === 3157))
  assert.equal(items['77'], undefined)
  const pairs = augmentPairStats(state, { 1205: { lift: 0 }, 77: { lift: 0 }, 99: { lift: 0 } })
  assert.ok(pairs['1205|77'][1] > 0.01) // +15 points observés, lissés (peu de paires mesurées)
  assert.equal(pairs['1205|99'], undefined)
})
