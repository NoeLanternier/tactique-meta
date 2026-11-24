// Menace (adversaire très en avance, qui te tue) définie comme dans l'app, défense mesurée, preuve
// des choix de début de partie et du 2e objet (24 novembre 2026).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defenseOf, killerFocusAt } from '../src/extract.mjs'
import {
  addDefense,
  defenseSummary,
  emptyNextBacktest,
  foeApShare,
  nextBacktestSummary,
  threatContexts
} from '../src/nextItems.mjs'
import { choicesSummary, evaluateChoices, recommendedChoice } from '../src/backtest.mjs'
import { emptyState, seedFromPrevious } from '../src/aggregate.mjs'

test('qui te tue : comme l’app (auteur 1, assistance 0,5, moitié moins toutes les 10 minutes)', () => {
  const kill = (min, victimId, killerId, assists = []) => ({
    type: 'CHAMPION_KILL',
    timestamp: min * 60000,
    victimId,
    killerId,
    assistingParticipantIds: assists
  })
  const timeline = {
    info: {
      frames: [
        { events: [kill(4, 1, 7), kill(6, 2, 8)] },
        { events: [kill(9, 1, 7, [8]), kill(11, 1, 9)] }
      ]
    }
  }
  const later = { info: { frames: [...timeline.info.frames, { events: [kill(11.5, 1, 9)] }] } }
  const foes = new Set([6, 7, 8, 9, 10])
  // À 10 min : deux morts par 7 (une avec 8 en assistance) → 7 dépasse la moitié.
  assert.equal(killerFocusAt(timeline, 1, 10, foes), 7)
  // Une seule mort : il en faut l'équivalent de deux.
  assert.equal(killerFocusAt(timeline, 1, 5, foes), null)
  // À 12 min, une mort récente par 9 ne suffit pas (7 : 60 %) ; après deux, c'est 9 (58 %).
  assert.equal(killerFocusAt(timeline, 1, 12, foes), 7)
  assert.equal(killerFocusAt(later, 1, 12, foes), 9)
  // Un allié ou un monstre (0) ne compte pas.
  assert.equal(killerFocusAt(timeline, 1, 10, new Set([8, 9])), null)
  assert.equal(defenseOf({ stats: { FlatArmorMod: 40, FlatHPPoolMod: 300 } }), 'ah')
  assert.equal(defenseOf({ stats: { FlatSpellBlockMod: 40 } }), 'm')
  assert.equal(defenseOf({ stats: { FlatPhysicalDamageMod: 40 } }), '')
})

test('menace : même définition que l’app (objets 30 % au-dessus de la moyenne, 1 500 d’écart)', () => {
  const profiles = {
    Syndra: { g: 100, magic: 90, phys: 10, minutes: 30 },
    Zed: { g: 100, magic: 5, phys: 95, minutes: 30 },
    Ezreal: { g: 100, magic: 30, phys: 70, minutes: 30, itemN: 50, itemAp: 5 }
  }
  // [champion, or dépensé, valeur magique, valeur physique, critiques]
  const row = (champ, spent, ap = 0, ad = 0) => [champ, spent, ap, ad, 0]
  const calm = [row('Syndra', 5000), row('Zed', 5000), row('A', 4500), row('B', 4500), row('C', 4000)]
  const fedSyndra = [row('Syndra', 9000), row('Zed', 4000), row('A', 4500), row('B', 4500), row('C', 4000)]
  // Ezreal habituellement physique, mais tout en objets magiques à 8 000 : menace magique.
  const apEz = [row('Ezreal', 8000, 6000, 500), row('Zed', 4000), row('A', 4000), row('B', 4000), row('C', 3000)]
  const out = threatContexts(profiles, [calm, fedSyndra, apEz, fedSyndra], [null, null, null, 'Zed'])
  assert.deepEqual(out[0], [])
  assert.deepEqual(out[1], ['fedAp'])
  assert.deepEqual(out[2], ['fedAp'])
  // Syndra très en avance et Zed qui te tue : les deux menaces.
  assert.deepEqual(out[3].sort(), ['fedAd', 'fedAp'])
  assert.ok(foeApShare(profiles.Ezreal, 6000, 500) > 0.6)
  assert.equal(foeApShare(undefined, 0, 0), 0.5)
})

test('défense face à une menace : achats défensifs adaptés comparés aux autres, à avance égale', () => {
  const state = emptyState('16.23', 0)
  for (let i = 0; i < 400; i++) {
    const armor = i % 2 === 0
    addDefense(
      state,
      {
        win: armor ? i % 4 === 0 || i % 8 === 2 : i % 4 === 1,
        items: [1, 2, 3],
        itemDef: ['', armor ? 'a' : 'h', ''],
        itemState: ['e', 'e', 'b'],
        itemFedCtx: [[], ['fedAd'], []]
      },
      [0.5, 0.5, 0.5]
    )
  }
  const sum = defenseSummary(state)
  // Armure face à un adversaire physique très en avance : 75 % de victoires contre 50 %.
  assert.equal(sum.fedAd.followed, 200)
  assert.equal(sum.fedAd.gain, 0.25)
  // En retard (3e achat, rien de défensif) : tout est dans « autres », pas de mesure publiée.
  assert.equal(sum.behind, undefined)
  // Reprise au patch suivant à 25 %.
  const seeded = seedFromPrevious(emptyState('16.24', 0), state, 0.25)
  assert.equal(seeded.defense.fedAd.d[0], 50)
})

test('2e objet : preuve par rang dans le résumé du backtest', () => {
  const bt = emptyNextBacktest()
  bt.n = 6000
  bt.g[0] = { f: [3000, 90], o: [3000, 0] }
  bt.rk = {
    1: [{ f: [1000, 50], o: [1000, 0] }, { f: [0, 0], o: [0, 0] }],
    3: [{ f: [2000, 40], o: [2000, 0] }, { f: [0, 0], o: [0, 0] }]
  }
  const sum = nextBacktestSummary(bt)
  assert.equal(sum.ranks['1'].gain, 0.05)
  assert.equal(sum.ranks['3'].gain, 0.02)
})

test('runes, bottes, départ… : option que l’app aurait conseillée, suivie ou non', () => {
  const opt = (extra) => ({ games: 600, winRate: 0.5, share: 0.5, contexts: {}, ...extra })
  const build = {
    id: 'Garen',
    winRate: 0.5,
    runes: { keystone: 'Conqueror', primary: ['Triumph', 'Legend: Alacrity', 'Last Stand'], secondaryTree: 'Resolve' },
    boots: 'Plated Steelcaps',
    start: ["Doran's Blade", 'Health Potion'],
    skills: 'Q>E>W',
    choices: {
      boots: [opt({ name: 'Plated Steelcaps' }), opt({ name: "Mercury's Treads", contexts: { ap: [500, 0.6] } })],
      start: [opt({ items: ["Doran's Blade", 'Health Potion'] }), opt({ items: ["Doran's Shield", 'Health Potion'] })]
    }
  }
  const meta = { builds: [build], priors: { boots: 300, start: 300, choiceCtx: 150 }, tuning: null }
  // Contexte AP : Sandales (60 % face à l'AP sur 500 parties) passent devant.
  const picked = recommendedChoice(
    build.choices.boots,
    (o) => o.name === build.boots,
    ['ap'],
    0.5,
    300,
    150,
    null,
    null
  )
  assert.equal(picked.name, "Mercury's Treads")
  assert.equal(recommendedChoice(build.choices.boots, (o) => o.name === build.boots, ['ad'], 0.5, 300, 150), null)
  const dd = {
    items: new Map([
      [3047, { name: 'Plated Steelcaps' }],
      [3111, { name: "Mercury's Treads" }],
      [1055, { name: "Doran's Blade" }],
      [1054, { name: "Doran's Shield" }],
      [2003, { name: 'Health Potion' }]
    ])
  }
  const bt = {}
  const g = (win, boots, start, contexts, skills = 'Q>E>W') =>
    evaluateChoices(meta, contexts, { champ: 'Garen', win, boots, start, skills }, bt, dd)
  for (let i = 0; i < 100; i++) {
    g(true, 3111, '1055,2003', ['ap']) // conseil (Sandales face à l'AP) suivi, gagne
    g(false, 3047, '2003,1054', ['ap']) // conseil ignoré, perd
    g(i % 2 === 0, 3047, '1055,2003', ['ad'], 'W>Q>E') // option du build suivie (sauf compétences)
  }
  const sum = choicesSummary(bt)
  assert.equal(sum.boots.followed, 200)
  assert.equal(sum.boots.other, 100)
  assert.ok(sum.boots.gain > 0.5)
  // Changement d'option conseillé par le contexte : suivi 100 fois, gagnant à chaque fois.
  assert.equal(sum.boots.switched.followed, 100)
  assert.equal(sum.boots.switched.gain, 1)
  // Départ : ordre des objets sans importance ; compétences comptées aussi.
  assert.equal(sum.start.followed, 200)
  assert.equal(sum.skills.followed, 200)
  assert.equal(sum.skills.switched, undefined)
})
