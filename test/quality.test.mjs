import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emptyQuality, qualityIssues, recordQuality } from '../src/quality.mjs'

const good = { runeSig: 'x', items: [1], skills: 'Q>W>E', opening: { side: 'top' } }

test('données normales : rien à signaler', () => {
  const q = emptyQuality()
  for (let i = 0; i < 300; i++) recordQuality(q, i % 10 === 0 ? { ...good, skills: null } : good)
  assert.deepEqual(qualityIssues(q), [])
})

test('format changé : la collecte est bloquée', () => {
  const q = emptyQuality()
  for (let i = 0; i < 300; i++) recordQuality(q, { ...good, runeSig: null, items: [] })
  const issues = qualityIssues(q)
  assert.equal(issues.length, 2)
  assert.match(issues[0], /pages de runes trouvé\(e\)s pour 0 %/)
})

test('trop peu de parties pour conclure', () => {
  const q = emptyQuality()
  for (let i = 0; i < 50; i++) recordQuality(q, { runeSig: null })
  assert.deepEqual(qualityIssues(q), [])
})
