// Tests sur des données simulées au format officiel de l'API Riot (Match-V5 + timeline).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDdragon } from '../src/ddragon.mjs'
import { extractJunglers, extractProfiles, precheck, skillOrder } from '../src/extract.mjs'
import {
  addProfiles,
  addRecord,
  buildMeta,
  buildProfiles,
  contextsOf,
  emptyState,
  seedFromPrevious,
  selectBuild
} from '../src/aggregate.mjs'
import { RiotClient } from '../src/riot.mjs'

const runesJson = [
  {
    id: 8000,
    key: 'Precision',
    name: 'Precision',
    slots: [
      {
        runes: [
          { id: 8010, name: 'Conqueror' },
          { id: 8008, name: 'Lethal Tempo' }
        ]
      },
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
  stats: {},
  ...extra
})
const itemJson = {
  data: {
    1001: item('Boots', 300, { tags: ['Boots'], into: ['3047'] }),
    3047: item('Plated Steelcaps', 1200, { tags: ['Boots'] }),
    3111: item("Mercury's Treads", 1250, { tags: ['Boots'] }),
    1101: item('Scorchclaw Pup', 450, { tags: ['Jungle'] }),
    2003: item('Health Potion', 50, { tags: ['Consumable'] }),
    1036: item('Long Sword', 350, { into: ['6692'] }),
    6692: item('Eclipse', 2900, { stats: { FlatPhysicalDamageMod: 60 } }),
    3071: item('Black Cleaver', 3000, { stats: { FlatPhysicalDamageMod: 40 } }),
    6333: item("Death's Dance", 3300, { stats: { FlatPhysicalDamageMod: 60, FlatArmorMod: 50 } }),
    3026: item('Guardian Angel', 3200, { stats: { FlatPhysicalDamageMod: 55 } }),
    3156: item('Maw of Malmortius', 3100, { stats: { FlatPhysicalDamageMod: 60 } }),
    6610: item('Sundered Sky', 3100, { stats: { FlatPhysicalDamageMod: 40 } })
  }
}
const championJson = {
  data: { LeeSin: { id: 'LeeSin', key: '64' }, MonkeyKing: { id: 'MonkeyKing', key: '62' } }
}
const dd = buildDdragon('16.21.1', championJson, itemJson, runesJson)

const PAGE = {
  statPerks: { offense: 5005, flex: 5008, defense: 5001 },
  styles: [
    {
      description: 'primaryStyle',
      style: 8000,
      selections: [{ perk: 8010 }, { perk: 9111 }, { perk: 9104 }, { perk: 8014 }]
    },
    { description: 'subStyle', style: 8300, selections: [{ perk: 8304 }, { perk: 8347 }] }
  ]
}

function fakeGame(win, coreIds, boots = 3047) {
  const participants = Array.from({ length: 10 }, (_, i) => ({
    participantId: i + 1,
    teamId: i < 5 ? 100 : 200,
    championId: i === 0 ? 64 : i === 5 ? 62 : 1,
    championName: 'X',
    teamPosition: i === 0 || i === 5 ? 'JUNGLE' : 'TOP',
    win: i < 5 ? win : !win,
    perks: PAGE,
    physicalDamageDealtToChampions: 10000,
    magicDamageDealtToChampions: i >= 5 ? 30000 : 2000,
    totalHeal: 3000,
    damageSelfMitigated: 15000,
    totalDamageTaken: 20000,
    timeCCingOthers: 20,
    totalDamageShieldedOnTeammates: 0,
    item0: coreIds[0],
    item1: coreIds[1] ?? 0
  }))
  const ev = (type, extra, t) => ({ type, participantId: 1, timestamp: t, ...extra })
  const events = [
    ev('ITEM_PURCHASED', { itemId: 1101 }, 1),
    ev('ITEM_PURCHASED', { itemId: 2003 }, 2),
    ev('ITEM_PURCHASED', { itemId: 3111 }, 3),
    ev('ITEM_UNDO', { beforeId: 3111, afterId: 0 }, 4),
    ev('ITEM_PURCHASED', { itemId: coreIds[0] }, 10),
    ev('ITEM_PURCHASED', { itemId: boots }, 11),
    ...coreIds.slice(1).map((id, k) => ev('ITEM_PURCHASED', { itemId: id }, 20 + k))
  ]
  const skills = 'QWEQQRQEQEREEWW'
    .split('')
    .map((k, i) =>
      ev('SKILL_LEVEL_UP', { skillSlot: ' QWER'.indexOf(k), levelUpType: 'NORMAL' }, 100 + i)
    )
  return [
    { info: { queueId: 420, gameVersion: '16.21.712.1', gameDuration: 1800, participants } },
    { info: { frames: [{ events: [...events, ...skills] }] } }
  ]
}

test('contrôles avant timeline', () => {
  const [m] = fakeGame(true, [6692, 3071, 6333])
  assert.equal(precheck(m, '16.21'), 'ok')
  assert.equal(precheck({ info: { ...m.info, gameVersion: '16.20.1' } }, '16.21'), 'ancien patch')
  assert.equal(precheck({ info: { ...m.info, gameDuration: 600 } }, '16.21'), 'trop courte')
  assert.equal(precheck({ info: { ...m.info, queueId: 450 } }, '16.21'), 'file')
})

test("extraction : ordre d'achat, annulation, bottes, familier, compétences", () => {
  const [m, t] = fakeGame(true, [6692, 3071, 6333])
  const recs = extractJunglers(m, t, dd)
  assert.equal(recs.length, 2)
  const lee = recs.find((r) => r.champ === 'LeeSin')
  assert.deepEqual(lee.core, [6692, 3071, 6333])
  assert.equal(lee.boots, 3047) // les Mercure annulées ne comptent pas
  assert.equal(lee.pet, 1101)
  assert.equal(lee.skills, 'Q>E>W')
  assert.equal(lee.runeSig, '8000|8010,9111,9104,8014,8304,8347|8300|5005,5008,5001')
})

test('ordre des compétences sur partie courte', () => {
  const evs = 'QWEQQWQE'
    .split('')
    .map((k) => ({ type: 'SKILL_LEVEL_UP', skillSlot: ' QWER'.indexOf(k) }))
  assert.equal(skillOrder(evs), null)
})

test("sélection : le meilleur cœur gagne même s'il est un peu moins joué", () => {
  const state = emptyState('16.21', 0)
  // 60 parties Eclipse > Cleaver > DD (55 % victoires), 40 parties Eclipse > Sundered Sky > DD (65 %)
  for (let i = 0; i < 60; i++)
    for (const r of extractJunglers(...fakeGame(i < 33, [6692, 3071, 6333]), dd))
      addRecord(state, r)
  for (let i = 0; i < 40; i++)
    for (const r of extractJunglers(...fakeGame(i < 26, [6692, 6610, 6333]), dd))
      addRecord(state, r)
  const b = selectBuild('LeeSin', state.champs.LeeSin, dd)
  assert.deepEqual(b.core, ['Eclipse', 'Sundered Sky', "Death's Dance"])
  assert.equal(b.boots, 'Plated Steelcaps')
  assert.equal(b.pet, 'Scorchclaw Pup')
  assert.equal(b.archetype, 'AD_FIGHTER')
  assert.equal(b.runes.keystone, 'Conqueror')
  assert.deepEqual(b.runes.shards, ['AS', 'AF', 'HS'])
  assert.equal(b.games, 100)
  assert.equal(b.patch, '16.21')
  const meta = buildMeta(state, dd, {
    builds: [
      { id: 'Zac', patch: '16.20' },
      { id: 'LeeSin', patch: '16.20' }
    ]
  })
  assert.deepEqual(
    meta.builds.map((x) => x.id),
    ['LeeSin', 'Zac']
  ) // Wukong n'a aucun achat dans la partie simulée : exclu
  assert.ok(true)
  assert.equal(meta.builds.find((x) => x.id === 'LeeSin').patch, '16.21')
})

test('trop peu de parties : pas de build', () => {
  const state = emptyState('16.21', 0)
  for (let i = 0; i < 10; i++)
    for (const r of extractJunglers(...fakeGame(true, [6692, 3071, 6333]), dd)) addRecord(state, r)
  assert.equal(selectBuild('LeeSin', state.champs.LeeSin, dd), null)
})

test('client Riot : limite de débit et 429', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls++
    if (calls === 1)
      return { status: 429, headers: new Map([['retry-after', '1']]), json: async () => ({}) }
    return { status: 200, headers: new Map(), json: async () => ({ ok: true }) }
  }
  const riot = new RiotClient('RGAPI-test', { fetchImpl, limits: [[3, 1000]] })
  const t0 = Date.now()
  const res = await riot.get('euw1', '/x')
  assert.deepEqual(res, { ok: true })
  assert.ok(Date.now() - t0 >= 900)
  const t1 = Date.now()
  await Promise.all([1, 2, 3, 4].map(() => riot.get('euw1', '/y')))
  assert.ok(Date.now() - t1 >= 900, 'la 4e requête attend la fenêtre suivante')
  await assert.rejects(async () => new RiotClient('mauvaise-cle'))
})


test('profils mesurés et contextes adverses', () => {
  const [m, t] = fakeGame(true, [6692, 3071, 6333])
  const profs = extractProfiles(m, dd)
  assert.equal(profs.length, 10)
  assert.equal(profs[0].champ, 'LeeSin')
  assert.equal(profs[0].minutes, 30)
  const recs = extractJunglers(m, t, dd)
  const lee = recs.find((r) => r.champ === 'LeeSin')
  assert.equal(lee.enemyJungler, 'MonkeyKing')
  assert.ok(lee.enemy.magic > lee.enemy.phys) // équipe adverse très AP dans la partie simulée
  const state = emptyState('16.21', 0)
  assert.deepEqual(contextsOf(state, lee.enemy), ['all', 'ap']) // pas encore assez d'échantillons pour soins/tank/cc
  for (let i = 0; i < 200; i++) contextsOf(state, { ...lee.enemy, heal: 1000 + (i % 10) * 100 })
  const ctx = contextsOf(state, { ...lee.enemy, heal: 50000 })
  assert.ok(ctx.includes('heal'))
})

test('meta v2 : profils, stats de junglers, objets par contexte, reprise du patch précédent', () => {
  const state = emptyState('16.21', 0)
  for (let i = 0; i < 60; i++) {
    const [m, t] = fakeGame(i % 2 === 0, [6692, 3071, 6333, 3026])
    for (const r of extractJunglers(m, t, dd)) addRecord(state, r)
    addProfiles(state, extractProfiles(m, dd))
  }
  const meta = buildMeta(state, dd, null, { minGames: 40 })
  assert.equal(meta.version, 2)
  const lee = meta.builds.find((b) => b.id === 'LeeSin')
  assert.ok(lee.situational.all.items.length > 0)
  assert.ok(lee.situational.ap.items.some((x) => x.item === 'Guardian Angel'))
  assert.equal(meta.junglers.LeeSin.games, 60)
  assert.equal(meta.junglers.LeeSin.vs.MonkeyKing[0], 60)
  const profiles = buildProfiles(state, 30)
  assert.ok(profiles.LeeSin && profiles.LeeSin.ap < 0.2)
  const seeded = seedFromPrevious(emptyState('16.22', 0), state, 0.25)
  assert.equal(seeded.champs.LeeSin.g, 15)
  assert.equal(seeded.seededFrom, '16.21')
})
