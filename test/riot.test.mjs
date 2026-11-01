import test from 'node:test'
import assert from 'node:assert/strict'
import { RiotClient, keyKind, methodOf, parseRateLimit } from '../src/riot.mjs'

test('limites lues dans les en-têtes de Riot', () => {
  assert.deepEqual(parseRateLimit('20:1,100:120'), [[18, 1000], [98, 120000]])
  assert.deepEqual(parseRateLimit('500:10,30000:600'), [[490, 10000], [29400, 600000]])
  assert.equal(keyKind(parseRateLimit('20:1,100:120')), 'personnelle ou de développement')
  assert.equal(keyKind(parseRateLimit('500:10,30000:600')), 'production')
  assert.equal(methodOf('/lol/match/v5/matches/EUW1_7212345678/timeline'), '/lol/match/v5/matches/{match}/timeline')
  assert.equal(
    methodOf('/lol/match/v5/matches/by-puuid/' + 'a'.repeat(78) + '/ids?queue=420'),
    '/lol/match/v5/matches/by-puuid/{id}/ids'
  )
})

test('le client adopte les limites annoncées', async () => {
  const headers = new Map([
    ['x-app-rate-limit', '500:10,30000:600'],
    ['x-method-rate-limit', '2000:10']
  ])
  const fetchImpl = async () => ({ status: 200, headers: { get: (k) => headers.get(k) ?? null }, json: async () => ({ ok: 1 }) })
  const riot = new RiotClient('RGAPI-test', { fetchImpl })
  assert.deepEqual(await riot.get('europe', '/lol/match/v5/matches/EUW1_1'), { ok: 1 })
  assert.deepEqual(riot.limiter('europe').limits, [[490, 10000], [29400, 600000]])
  assert.deepEqual(riot.limiter('asia').limits, [[490, 10000], [29400, 600000]])
  assert.ok(riot.methodLimiters.has('europe /lol/match/v5/matches/{match}'))
  // 150 requêtes rapides : impossible avec les limites d'une clé personnelle (98 / 2 min).
  const t = Date.now()
  for (let i = 0; i < 150; i++) await riot.get('europe', `/lol/match/v5/matches/EUW1_${i}`)
  assert.ok(Date.now() - t < 5000)
})
