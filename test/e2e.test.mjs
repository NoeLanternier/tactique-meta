// Test de bout en bout : la collecte complète (deux niveaux de jeu) sur de faux serveurs Riot.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = mkdtempSync(join(tmpdir(), 'tactique-e2e-'))
const run = (env = {}) =>
  spawnSync(
    process.execPath,
    ['--import', './test/e2e/mock-fetch.mjs', 'src/run.mjs', '--minutes', '1', '--regions', 'euw1', '--gold-regions', 'euw1', '--min-games', '5', '--out', out],
    { encoding: 'utf-8', env: { ...process.env, RIOT_API_KEY: 'RGAPI-test', ...env }, timeout: 120000 }
  )

test('collecte complète : Master+ et Or à Émeraude, puis réglage le lendemain', () => {
  const first = run()
  assert.equal(first.status, 0, first.stdout + first.stderr)
  assert.match(first.stdout, /clé production/) // limites lues dans les en-têtes du faux serveur
  const master = JSON.parse(readFileSync(join(out, 'meta.json'), 'utf-8'))
  const gold = JSON.parse(readFileSync(join(out, 'meta-gold.json'), 'utf-8'))
  assert.equal(master.bracket, 'master')
  assert.equal(gold.bracket, 'gold')
  assert.ok(master.builds.some((b) => b.id === 'LeeSin'))
  // Départs courants avec leur part (ici tous les joueurs commencent par le familier).
  const lee = master.builds.find((b) => b.id === 'LeeSin')
  assert.deepEqual(lee.startOptions[0].items, ['Scorchclaw Pup'])
  assert.equal(lee.startOptions[0].share, 1)
  assert.ok(gold.sampleGames > 0)
  // Taux de victoire selon la composition adverse, et taux de bannissement.
  assert.equal(master.junglers.Viego.banRate, 1)
  assert.equal(master.junglers.LeeSin.banRate, 0)
  assert.ok(existsSync(join(out, 'state', '16.21.json')))
  assert.ok(existsSync(join(out, 'state', 'gold', '16.21.json')))
  // Une méta par poste, pour chaque niveau (la jungle garde meta.json).
  for (const role of ['top', 'mid', 'bot', 'support']) {
    const m = JSON.parse(readFileSync(join(out, `meta-${role}.json`), 'utf-8'))
    assert.equal(m.role, role)
    assert.ok(m.builds.length > 0 && m.builds.every((b) => b.pet === null))
    assert.ok(Object.keys(m.profiles).length > 0) // profils repris de la jungle
    assert.ok(existsSync(join(out, `meta-gold-${role}.json`)))
    assert.ok(existsSync(join(out, 'state', role, '16.21.json')))
  }
  assert.equal(master.role, 'jungle')

  // Modes : une méta par mode, tous rangs confondus, sans poste ni familier.
  const aram = JSON.parse(readFileSync(join(out, 'meta-aram.json'), 'utf-8'))
  assert.equal(aram.mode, 'aram')
  assert.equal(aram.role, 'aram')
  assert.equal(aram.bracket, 'all')
  assert.ok(aram.builds.length > 0 && aram.builds.every((b) => b.pet === null))
  assert.deepEqual(aram.features, { runes: true, augments: false })
  // Repères propres aux modes (dégâts et or par minute, morts, part des dégâts).
  assert.ok(aram.benchmarks._all.dmgPerMin > 0 && aram.benchmarks._all.deathsPer10 > 0)
  // Alliés et adversaires : les dix joueurs, pas d'adversaire direct.
  assert.deepEqual(aram.junglers.LeeSin.vs, {})
  assert.ok(Object.keys(aram.junglers.LeeSin.against).length > 0)
  assert.ok(existsSync(join(out, 'state', 'modes', 'aram', '16.21.json')))
  // ARAM Mayhem : pas de runes, des augments (noms anglais et français, rareté).
  const mayhem = JSON.parse(readFileSync(join(out, 'meta-mayhem.json'), 'utf-8'))
  assert.deepEqual(mayhem.features, { runes: false, augments: true })
  assert.equal(mayhem.augmentInfo['1205'].nameFr, 'ADAPtation')
  assert.equal(mayhem.augmentInfo['206'].rarity, 'prismatic')
  assert.ok(mayhem.augmentInfo['1205'].games > 0)
  assert.ok(mayhem.builds.some((b) => b.augments?.length))
  // Modes temporaires absents : rien d'écrit, signalé dans le journal.
  assert.ok(!existsSync(join(out, 'meta-urf.json')))
  assert.match(first.stdout, /\[URF\] terminé : 0 nouvelles parties/)
  assert.match(first.stdout, /modes \d+\)/)

  // Le lendemain (mêmes parties déjà vues) : la méta de la veille sert au backtest et au réglage.
  const second = run({ MOCK_DAY: '2' })
  assert.equal(second.status, 0, second.stdout + second.stderr)
  assert.match(second.stdout, /\[Master\+\] réglage du moteur : 1200 parties/)
  assert.match(second.stdout, /\[Master\+ · top\] réglage du moteur : 1200 parties/)
  assert.match(second.stdout, /\[Or à Émeraude\] réglage du moteur : 400 parties/)
  assert.match(second.stdout, /\[Master\+\] backtest/)
  // Les parties déjà vues ne sont pas recomptées.
  const third = run({ MOCK_DAY: '2' })
  assert.match(third.stdout, /\[Master\+\] terminé : 0 nouvelles parties/)
})

test('format des réponses changé : rien n’est publié', () => {
  const before = readFileSync(join(out, 'meta.json'), 'utf-8')
  const broken = run({ MOCK_BROKEN: '1', MOCK_DAY: '3' })
  assert.equal(broken.status, 1)
  assert.match(broken.stderr, /Données Riot inattendues/)
  assert.equal(readFileSync(join(out, 'meta.json'), 'utf-8'), before)
  rmSync(out, { recursive: true, force: true })
})
