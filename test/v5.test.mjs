// Tests du lot 2 : choix par contexte (runes, bottes, familier, compétences), combats entre
// junglers et début de partie.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDdragon } from '../src/ddragon.mjs'
import { junglerDuels, laneOf, openingOf } from '../src/extract.mjs'
import { addRecord, buildChoices, buildJunglerStats, emptyState, openingStats } from '../src/aggregate.mjs'

const runesJson = [
  {
    id: 8000,
    key: 'Precision',
    name: 'Precision',
    slots: [
      { runes: [{ id: 8010, name: 'Conqueror' }, { id: 8008, name: 'Lethal Tempo' }] },
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
    3111: item("Mercury's Treads", 1250, { tags: ['Boots'], stats: {} }),
    1101: item('Scorchclaw Pup', 450, { tags: ['Jungle'], stats: {} }),
    1102: item('Gustwalker Hatchling', 450, { tags: ['Jungle'], stats: {} }),
    6692: item('Eclipse', 2900),
    3071: item('Black Cleaver', 3000),
    6333: item("Death's Dance", 3300)
  }
}
const championJson = { data: { LeeSin: { id: 'LeeSin', key: '64' } } }
const dd = buildDdragon('16.21.1', championJson, itemJson, runesJson)
const CONQ = '8000|8010,9111,9104,8014,8304,8347|8300|5005,5008,5001'
const TEMPO = '8000|8008,9111,9104,8014,8304,8347|8300|5005,5008,5001'

function rec(over) {
  return {
    champ: 'LeeSin',
    win: true,
    runeSig: CONQ,
    core: [6692, 3071, 6333],
    later: [],
    items: [6692, 3071, 6333],
    itemMin: [12, 18, 24],
    boots: 3047,
    pet: 1101,
    skills: 'Q>W>E',
    enemyJungler: 'Viego',
    allies: [],
    enemies: ['Garen'],
    foeTags: [],
    enemy: { minutes: 30, phys: 20000, magic: 60000, heal: 3000, tank: 100000, cc: 30 },
    bench: {},
    duels: [],
    opening: { side: null, first: null },
    ...over
  }
}

test('voies et combats entre junglers dans la chronologie', () => {
  assert.equal(laneOf({ x: 1500, y: 9000 }), 'top')
  assert.equal(laneOf({ x: 7400, y: 7300 }), 'mid')
  assert.equal(laneOf({ x: 13000, y: 4000 }), 'bot')
  assert.equal(laneOf({ x: 5000, y: 8000 }), 'jungle')
  const kill = (t, killerId, victimId, assist = [], position = { x: 1500, y: 9000 }) => ({
    type: 'CHAMPION_KILL', timestamp: t * 60000, killerId, victimId, assistingParticipantIds: assist, position
  })
  const timeline = {
    info: {
      frames: [
        { events: [] },
        { events: [] },
        { participantFrames: { 2: { position: { x: 4000, y: 9000 } } }, events: [kill(3.5, 3, 7, [2])] },
        { events: [kill(4, 7, 2), kill(9, 2, 7), kill(10, 4, 9, [2])] }
      ]
    }
  }
  assert.deepEqual(junglerDuels(timeline, 2, 7), [
    { min: 3.5, won: true },
    { min: 4, won: false },
    { min: 9, won: true }
  ])
  assert.deepEqual(openingOf(timeline, 2), { side: 'top', first: { min: 3.5, lane: 'top' } })
})

test('combats par période et début de partie agrégés', () => {
  const state = emptyState('16.21', 0)
  for (let i = 0; i < 40; i++) {
    addRecord(
      state,
      rec({
        duels: [
          { min: 3, won: i % 4 === 0 }, // tôt : 25 % gagnés
          { min: 20, won: i % 4 !== 0 } // tard : 75 %
        ],
        opening: { side: i % 5 < 3 ? 'top' : 'bot', first: { min: 3 + (i % 2), lane: i % 2 ? 'bot' : 'top' } }
      })
    )
  }
  const j = buildJunglerStats(state).LeeSin
  assert.deepEqual(j.duels.Viego, { early: [40, 0.25], late: [40, 0.75] })
  assert.ok(j.duels._all)
  assert.deepEqual(j.opening, { games: 40, top: 0.6, firstMinute: 3.5, firstLanes: { top: 0.5, bot: 0.5 } })
  assert.equal(openingStats({ g: 10, top: 5 }), null)
})

test('runes, bottes, familier et compétences par contexte', () => {
  const state = emptyState('16.21', 0)
  for (let i = 0; i < 200; i++) {
    const tempo = i % 2 === 0
    const merc = i % 3 === 0
    addRecord(
      state,
      rec({
        // Contre une équipe AP (toujours le cas ici), Tempo et Mercure gagnent plus.
        win: tempo ? i % 10 < 6 : i % 10 < 4,
        runeSig: tempo ? TEMPO : CONQ,
        boots: merc ? 3111 : 3047,
        pet: i % 4 === 0 ? 1102 : 1101,
        skills: i % 5 === 0 ? 'Q>E>W' : 'Q>W>E'
      })
    )
  }
  const choices = buildChoices(state.champs.LeeSin, dd)
  assert.equal(choices.runes.length, 2)
  const tempo = choices.runes.find((r) => r.runes.keystone === 'Lethal Tempo')
  assert.ok(tempo.contexts.ap[1] > 0.55, JSON.stringify(tempo.contexts))
  assert.deepEqual(choices.boots.map((b) => b.name).sort(), ["Mercury's Treads", 'Plated Steelcaps'])
  assert.ok(choices.pet.find((p) => p.name === 'Scorchclaw Pup').vs.Viego[0] >= 100)
  assert.equal(choices.skills.length, 2)
})
