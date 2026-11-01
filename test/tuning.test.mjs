// Tests du lot 3 : réglage automatique des poids du moteur.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addTuning, emptyTuning, solveTuning, tuningFeatures, TUNING_KEYS } from '../src/tuning.mjs'

// Générateur pseudo-aléatoire reproductible.
let seed = 12345
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296)

test('la régression retrouve les vrais poids des critères', () => {
  const truth = { pick: 0.6, vs: 1, pairs: 1.5, famBase: 1, famCtx: 0.3, choiceBase: 1, choiceCtx: 1, counter: 0 }
  const t = emptyTuning()
  for (let i = 0; i < 200000; i++) {
    const f = {
      pick: (rand() - 0.5) * 0.08,
      vs: (rand() - 0.5) * 0.1,
      pairs: (rand() - 0.5) * 0.08,
      famBase: (rand() - 0.5) * 0.04,
      famCtx: (rand() - 0.5) * 0.06,
      choiceBase: 0, // jamais mesuré : garde 1
      choiceCtx: (rand() - 0.5) * 0.06,
      counter: (rand() - 0.5) * 0.1
    }
    const p = 0.5 + TUNING_KEYS.reduce((s, k) => s + truth[k] * f[k], 0)
    addTuning(t, f, rand() < p)
  }
  const r = solveTuning(t)
  console.log(r)
  assert.equal(r.games, 200000)
  assert.equal(r.weights.choiceBase, 1)
  assert.equal(r.se.choiceBase, null)
  for (const k of ['pick', 'vs', 'pairs', 'famCtx', 'counter'])
    assert.ok(Math.abs(r.weights[k] - truth[k]) < 3 * r.se[k] + 0.05, `${k} : ${r.weights[k]} (vrai ${truth[k]})`)
  assert.ok(r.weights.counter < 0.4 && r.weights.pairs > 1.2)
})

test('trop peu de parties : pas de réglage', () => {
  const t = emptyTuning()
  addTuning(t, { pick: 0.01 }, true)
  assert.equal(solveTuning(t), null)
})

test('critères calculés comme dans l’app', () => {
  const dd = {
    items: new Map([
      [1, { name: 'Eclipse' }],
      [2, { name: 'Sundered Sky' }],
      [3, { name: 'Guardian Angel' }],
      [10, { name: 'Plated Steelcaps' }],
      [11, { name: "Mercury's Treads" }]
    ])
  }
  const meta = {
    builds: [
      {
        id: 'LeeSin',
        winRate: 0.5,
        variants: [
          { key: 'Eclipse', games: 600, winRate: 0.48, contexts: { ap: [200, 0.44] } },
          { key: 'Sundered Sky', games: 600, winRate: 0.52, contexts: { ap: [200, 0.58] } }
        ],
        choices: {
          boots: [
            { name: 'Plated Steelcaps', games: 700, winRate: 0.5, contexts: {} },
            { name: "Mercury's Treads", games: 400, winRate: 0.5, contexts: { ap: [300, 0.56] } }
          ]
        }
      }
    ],
    junglers: {
      LeeSin: { games: 2000, winRate: 0.51, vs: { Viego: [100, 0.6] }, with: {}, against: {} },
      Viego: { games: 2000, winRate: 0.5, vs: {}, with: {}, against: {} }
    },
    itemCounters: { 'Guardian Angel': { Zed: [500, 0.04], '#pctHp': [300, -0.02] } }
  }
  const rec = {
    champ: 'LeeSin',
    win: true,
    core: [2],
    items: [2, 3],
    boots: 11,
    pet: null,
    runeSig: null,
    skills: null,
    enemyJungler: 'Viego',
    allies: [],
    enemies: ['Zed', 'Lux'],
    foeTags: ['#pctHp']
  }
  const f = tuningFeatures(meta, rec, ['all', 'ap'], dd)
  console.log(f)
  assert.ok(Math.abs(f.pick - ((0.51 * 2000 + 30) / 2060 - 0.5)) < 1e-9)
  assert.ok(f.vs > 0.03)
  assert.ok(f.famBase > 0.01 && f.famCtx > 0.03) // Sundered Sky, meilleure vs AP
  assert.ok(f.choiceCtx > 0.03) // Mercure vs AP
  assert.ok(Math.abs(f.counter - 0.02) < 1e-9) // GA : +0,04 vs Zed, −0,02 vs %PV
  assert.equal(f.pairs, 0)
  // Famille non mesurée (premier objet hors familles) : aucun écart de famille.
  const g = tuningFeatures(meta, { ...rec, core: [3] }, ['all', 'ap'], dd)
  assert.equal(g.famBase, 0)
  assert.equal(g.famCtx, 0)
})
