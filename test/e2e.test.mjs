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
  assert.ok(gold.sampleGames > 0)
  assert.ok(existsSync(join(out, 'state', '16.21.json')))
  assert.ok(existsSync(join(out, 'state', 'gold', '16.21.json')))

  // Le lendemain (mêmes parties déjà vues) : la méta de la veille sert au backtest et au réglage.
  const second = run({ MOCK_DAY: '2' })
  assert.equal(second.status, 0, second.stdout + second.stderr)
  assert.match(second.stdout, /\[Master\+\] réglage du moteur : 1200 parties/)
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
