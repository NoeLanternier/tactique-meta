// Faux serveurs Data Dragon et API Riot pour le test de bout en bout (chargé avec node --import).
// MOCK_BROKEN=1 : réponses sans runes ni objets (format changé).
const broken = process.env.MOCK_BROKEN === '1'
// MOCK_DAY : change les identifiants des parties (nouvelles parties « le lendemain »).
const day = process.env.MOCK_DAY ?? '1'
let seed = 7
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)

const item = (name, total, extra = {}) => ({ name, gold: { total }, maps: { 11: true, 12: true }, tags: [], stats: {}, description: '', ...extra })
// Augments (données du jeu, CommunityDragon) : deux augments d'ARAM Mayhem.
const cdragon = {
  '/latest/plugins/rcp-be-lol-game-data/global/default/v1/cherry-augments.json': [
    { id: 1205, augmentNameId: 'ARAM_ADAPt', nameTRA: 'ADAPt', augmentSmallIconPath: '/lol-game-data/assets/ASSETS/UX/Cherry/Augments/Icons/ADAPt_small.png', rarity: 'kSilver' },
    { id: 206, augmentNameId: 'escAPADe', nameTRA: 'escAPADe', augmentSmallIconPath: '', rarity: 'kPrismatic' }
  ],
  '/latest/plugins/rcp-be-lol-game-data/global/fr_fr/v1/cherry-augments.json': [
    { id: 1205, nameTRA: 'ADAPtation', rarity: 'kSilver' }
  ],
  '/latest/plugins/rcp-be-lol-game-data/global/default/v1/augment-lists.json': [
    { modeName: 'KIWI', augmentList: ['Maps/ModeSpecificData/Augments/ARAM_ADAPt', 'Maps/ModeSpecificData/Augments/escAPADe'] }
  ],
  // Chaînes du jeu (descriptions des augments).
  '/latest/game/en_us/data/menu/en_us/lol.stringtable.json': {
    entries: {
      kiwi_aram_adapt_name: 'ADAPt',
      cherry_adapt_summary: 'Convert <scaleAD>Bonus Attack Damage</scaleAD> to <scaleAP>Ability Power</scaleAP>. Gain <scaleAP>@APAmp*100@% Ability Power</scaleAP>.'
    }
  },
  '/latest/game/fr_fr/data/menu/fr_fr/lol.stringtable.json': {
    entries: {
      cherry_adapt_summary: 'Convertit les <scaleAD>dégâts d’attaque bonus</scaleAD> en <scaleAP>puissance</scaleAP>.'
    }
  }
}
const ddragon = {
  '/api/versions.json': ['16.21.1'],
  '/cdn/16.21.1/data/en_US/champion.json': {
    data: { LeeSin: { id: 'LeeSin', key: '64' }, Viego: { id: 'Viego', key: '234' }, Ahri: { id: 'Ahri', key: '103' } }
  },
  '/cdn/16.21.1/data/en_US/item.json': {
    data: {
      3047: item('Plated Steelcaps', 1200, { tags: ['Boots'] }),
      3111: item("Mercury's Treads", 1250, { tags: ['Boots'] }),
      1101: item('Scorchclaw Pup', 450, { tags: ['Jungle'] }),
      6692: item('Eclipse', 2900, { stats: { FlatPhysicalDamageMod: 60 } }),
      3071: item('Black Cleaver', 3000, { stats: { FlatPhysicalDamageMod: 40 } }),
      6333: item("Death's Dance", 3300, { stats: { FlatPhysicalDamageMod: 60, FlatArmorMod: 50 } }),
      6610: item('Sundered Sky', 3100, { stats: { FlatPhysicalDamageMod: 40 } })
    }
  },
  '/cdn/16.21.1/data/en_US/runesReforged.json': [
    {
      id: 8000, key: 'Precision', name: 'Precision',
      slots: [
        { runes: [{ id: 8010, name: 'Conqueror' }, { id: 8008, name: 'Lethal Tempo' }] },
        { runes: [{ id: 9111, name: 'Triumph' }] },
        { runes: [{ id: 9104, name: 'Legend: Alacrity' }] },
        { runes: [{ id: 8014, name: 'Coup de Grace' }] }
      ]
    },
    {
      id: 8300, key: 'Inspiration', name: 'Inspiration',
      slots: [
        { runes: [{ id: 8369, name: 'First Strike' }] },
        { runes: [{ id: 8304, name: 'Magical Footwear' }] },
        { runes: [{ id: 8345, name: 'Biscuit Delivery' }] },
        { runes: [{ id: 8347, name: 'Cosmic Insight' }] }
      ]
    }
  ]
}

function match(id) {
  // Parties des modes : file indiquée dans l'identifiant (voir la liste des parties plus bas).
  const queue = Number(/_Q(\d+)_/.exec(id)?.[1] ?? 420)
  const aram = queue !== 420
  const win = rand() < 0.5
  const core = rand() < 0.5 ? [6692, 3071, 6333] : [6610, 3071, 6333]
  const keystone = rand() < 0.6 ? 8010 : 8008
  const page = {
    statPerks: { offense: 5005, flex: 5008, defense: 5001 },
    styles: [
      { description: 'primaryStyle', style: 8000, selections: [{ perk: keystone }, { perk: 9111 }, { perk: 9104 }, { perk: 8014 }] },
      { description: 'subStyle', style: 8300, selections: [{ perk: 8304 }, { perk: 8347 }] }
    ]
  }
  const champs = [64, 103, 103, 103, 103, 234, 103, 103, 103, 103]
  // Joueurs : ceux des modes forment un petit groupe (on les retrouve de partie en partie).
  const h = [...id].reduce((t, c) => t + c.charCodeAt(0), 0)
  const puuids = champs.map((_, i) => (aram ? `fan${(h + i * 7) % 30}` : `r${i}`))
  const participants = champs.map((championId, i) => ({
    participantId: i + 1,
    puuid: puuids[i],
    teamId: i < 5 ? 100 : 200,
    championId,
    championName: 'X',
    teamPosition: aram ? '' : ['JUNGLE', 'TOP', 'MIDDLE', 'BOTTOM', 'UTILITY'][i % 5],
    win: i < 5 ? win : !win,
    // ARAM Mayhem : pas de runes, des augments.
    perks: broken || queue === 2400 ? {} : page,
    ...(queue === 2400 ? { playerAugment1: rand() < 0.5 ? 1205 : 206, playerAugment2: 0 } : {}),
    goldEarned: 12000, deaths: 6,
    physicalDamageDealtToChampions: 10000 + rand() * 20000,
    magicDamageDealtToChampions: 5000 + rand() * 20000,
    totalHeal: 3000, damageSelfMitigated: 15000, totalDamageTaken: 20000, timeCCingOthers: 20,
    totalDamageShieldedOnTeammates: 0, kills: 4, assists: 6, visionScore: 30, visionWardsBoughtInGame: 4,
    item0: core[0], item1: core[1], item2: core[2]
  }))
  const buys = (pid) => broken ? [] : [
    { type: 'ITEM_PURCHASED', participantId: pid, itemId: 1101, timestamp: 1000 },
    { type: 'ITEM_PURCHASED', participantId: pid, itemId: core[0], timestamp: 600000 },
    { type: 'ITEM_PURCHASED', participantId: pid, itemId: rand() < 0.5 ? 3047 : 3111, timestamp: 700000 },
    { type: 'ITEM_PURCHASED', participantId: pid, itemId: core[1], timestamp: 900000 },
    { type: 'ITEM_PURCHASED', participantId: pid, itemId: core[2], timestamp: 1200000 }
  ]
  const skills = (pid) => 'QWEQQRQEQEREEWW'.split('').map((k, i) => ({
    type: 'SKILL_LEVEL_UP', participantId: pid, skillSlot: ' QWER'.indexOf(k), levelUpType: 'NORMAL', timestamp: 60000 * (i + 1)
  }))
  const frames = Array.from({ length: 31 }, (_, m) => ({
    timestamp: m * 60000,
    events: m === 0 ? Array.from({ length: 10 }, (_, k) => [...buys(k + 1), ...skills(k + 1)]).flat() : m === 4
      ? [{ type: 'CHAMPION_KILL', killerId: 1, victimId: 6, assistingParticipantIds: [], timestamp: 240000, position: { x: 7000, y: 7400 } }]
      : [],
    participantFrames: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [String(i + 1), {
      position: { x: 3000 + rand() * 9000, y: 3000 + rand() * 9000 },
      minionsKilled: 4 * m, jungleMinionsKilled: 4 * m, totalGold: 400 * m, level: Math.min(18, m)
    }]))
  }))
  return [
    { metadata: { matchId: id, participants: puuids }, info: { queueId: queue, mapId: aram ? 12 : 11, gameVersion: '16.21.712.1', gameDuration: aram ? 1100 : 1800, participants, teams: [{ teamId: 100, bans: [{ championId: 234, pickTurn: 1 }] }, { teamId: 200, bans: [{ championId: -1, pickTurn: 6 }] }] } },
    { info: { frames } }
  ]
}

const games = new Map()
const json = (body) => ({
  ok: true,
  status: 200,
  headers: { get: (k) => ({ 'x-app-rate-limit': '100000:1' })[k.toLowerCase()] ?? null },
  json: async () => body
})
const notFound = { ok: false, status: 404, headers: { get: () => null }, json: async () => null }

globalThis.fetch = async (input) => {
  const url = new URL(String(input))
  if (url.host === 'ddragon.leagueoflegends.com') return ddragon[url.pathname] ? json(ddragon[url.pathname]) : notFound
  if (url.host === 'raw.communitydragon.org') return cdragon[url.pathname] ? json(cdragon[url.pathname]) : notFound
  const p = url.pathname
  let m
  if ((m = p.match(/\/lol\/league\/v4\/(\w+)leagues\/by-queue/)))
    return json({ entries: Array.from({ length: 10 }, (_, i) => ({ puuid: `${m[1]}-${i}` })) })
  if ((m = p.match(/\/lol\/league\/v4\/entries\/RANKED_SOLO_5x5\/(\w+)\/(\w+)/)))
    return json(m[1] === 'GOLD' && m[2] === 'I' ? Array.from({ length: 10 }, (_, i) => ({ puuid: `gold-${i}` })) : [])
  if ((m = p.match(/\/by-puuid\/([^/]+)\/ids/))) {
    const queue = Number(url.searchParams.get('queue') ?? 420)
    // Modes temporaires : absents en ce moment (aucune partie).
    if (![420, 450, 2400].includes(queue)) return json([])
    const tag = queue === 420 ? '' : `Q${queue}_`
    const n = queue === 420 ? 20 : 10
    return json(Array.from({ length: n }, (_, k) => `EUW1_${tag}${day}${m[1].replace(/\W/g, '')}${k}`))
  }
  if ((m = p.match(/\/lol\/match\/v5\/matches\/([^/]+)(\/timeline)?$/))) {
    if (!games.has(m[1])) games.set(m[1], match(m[1]))
    return json(games.get(m[1])[m[2] ? 1 : 0])
  }
  return notFound
}
