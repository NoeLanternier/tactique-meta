// Client de l'API Riot avec respect strict des limites de la clé, comptées séparément par
// serveur. Au départ, celles d'une clé personnelle (20 requêtes/seconde, 100/2 minutes) ; dès la
// première réponse, celles qu'annonce Riot (en-têtes X-App-Rate-Limit et X-Method-Rate-Limit),
// par exemple bien plus hautes avec une clé de production.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export const PLATFORM_TO_REGION = {
  euw1: 'europe',
  eun1: 'europe',
  tr1: 'europe',
  ru: 'europe',
  me1: 'europe',
  kr: 'asia',
  jp1: 'asia',
  na1: 'americas',
  br1: 'americas',
  la1: 'americas',
  la2: 'americas',
  oc1: 'sea',
  sg2: 'sea',
  tw2: 'sea',
  vn2: 'sea'
}

export class FatalError extends Error {}
class DeadlineError extends Error {}

/** « 20:1,100:120 » → [[19, 1000], [98, 120000]] (petite marge sous la limite annoncée). */
export function parseRateLimit(header) {
  if (!header) return null
  const limits = header
    .split(',')
    .map((part) => part.split(':').map(Number))
    .filter(([max, sec]) => max > 0 && sec > 0)
    .map(([max, sec]) => [Math.max(1, Math.floor(max * 0.98) - (max < 50 ? 1 : 0)), sec * 1000])
  return limits.length ? limits : null
}

/** Type de clé d'après ses limites : une clé personnelle plafonne à 100 requêtes / 2 min. */
export function keyKind(limits) {
  const per10min = Math.min(...limits.map(([max, w]) => (max * 600000) / w))
  return per10min > 1000 ? 'production' : 'personnelle ou de développement'
}

/** Méthode de l'API (chemin sans les identifiants), pour ses limites propres. */
export function methodOf(path) {
  return path
    .split('?')[0]
    .replace(/\/[A-Z0-9]+_\d+/g, '/{match}')
    .replace(/\/[A-Za-z0-9_-]{30,}/g, '/{id}')
}

/** Fenêtres glissantes : on garde une petite marge sous les limites officielles. */
class Limiter {
  constructor(limits) {
    this.limits = limits
    this.stamps = []
    this.blockedUntil = 0
  }

  pause(ms) {
    this.blockedUntil = Math.max(this.blockedUntil, Date.now() + ms)
  }

  /** Attend un créneau libre ; abandonne si l'attente dépasse l'heure limite de la collecte. */
  async take(deadline = Infinity) {
    for (;;) {
      const now = Date.now()
      if (now < this.blockedUntil) {
        if (this.blockedUntil > deadline) throw new DeadlineError()
        await sleep(this.blockedUntil - now)
        continue
      }
      const longest = Math.max(...this.limits.map(([, w]) => w))
      this.stamps = this.stamps.filter((t) => now - t < longest)
      let wait = 0
      for (const [max, windowMs] of this.limits) {
        const inWindow = this.stamps.filter((t) => now - t < windowMs)
        if (inWindow.length >= max) wait = Math.max(wait, windowMs - (now - inWindow[0]) + 25)
      }
      if (wait === 0) {
        this.stamps.push(now)
        return
      }
      if (now + wait > deadline) throw new DeadlineError()
      await sleep(wait)
    }
  }
}

export class RiotClient {
  /**
   * @param {string} apiKey
   * @param {{ limits?: [number, number][], fetchImpl?: typeof fetch }} [options]
   */
  constructor(apiKey, options = {}) {
    if (!apiKey || !apiKey.startsWith('RGAPI-')) {
      throw new FatalError(
        'Clé API Riot absente ou mal formée. Elle doit commencer par "RGAPI-" (variable RIOT_API_KEY).'
      )
    }
    this.apiKey = apiKey
    this.limits = options.limits ?? [
      [19, 1000],
      [98, 120000]
    ]
    this.fetch = options.fetchImpl ?? ((...args) => fetch(...args))
    this.limiters = new Map()
    this.methodLimiters = new Map()
    /** Limites annoncées par Riot pour cette clé (null tant qu'aucune réponse). */
    this.appLimits = null
    this.stats = { requests: 0, errors: 0, rateLimited: 0 }
    /** Heure limite (ms) : au-delà, les requêtes en attente sont abandonnées. */
    this.deadline = Infinity
  }

  limiter(host) {
    if (!this.limiters.has(host)) this.limiters.set(host, new Limiter(this.limits))
    return this.limiters.get(host)
  }

  /** Applique les limites lues dans les en-têtes d'une réponse. */
  learnLimits(host, method, headers) {
    const app = parseRateLimit(headers.get('x-app-rate-limit'))
    if (app && JSON.stringify(app) !== JSON.stringify(this.appLimits)) {
      this.appLimits = app
      this.limits = app
      for (const l of this.limiters.values()) l.limits = app
    }
    const key = `${host} ${method}`
    const own = parseRateLimit(headers.get('x-method-rate-limit'))
    if (own && !this.methodLimiters.has(key)) this.methodLimiters.set(key, new Limiter(own))
  }

  /** GET sur https://{host}.api.riotgames.com{path}. Renvoie null si introuvable. */
  async get(host, path) {
    const method = methodOf(path)
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await this.limiter(host).take(this.deadline)
        await this.methodLimiters.get(`${host} ${method}`)?.take(this.deadline)
      } catch (e) {
        if (e instanceof DeadlineError) return null
        throw e
      }
      let res
      try {
        res = await this.fetch(`https://${host}.api.riotgames.com${path}`, {
          headers: { 'X-Riot-Token': this.apiKey }
        })
      } catch {
        await sleep(2000 * (attempt + 1))
        continue
      }
      this.stats.requests++
      if (res.headers?.get) this.learnLimits(host, method, res.headers)
      if (res.status === 200) return res.json()
      if (res.status === 404) return null
      if (res.status === 401 || res.status === 403) {
        throw new FatalError(
          `Clé API refusée par Riot (code ${res.status}) : elle est expirée, invalide ou n'a pas accès à cette API.`
        )
      }
      if (res.status === 429) {
        this.stats.rateLimited++
        const retryAfter = Number(res.headers.get('retry-after') ?? '5')
        const ms = (Number.isFinite(retryAfter) ? retryAfter : 5) * 1000
        // Limite de la méthode seule : les autres requêtes du serveur continuent.
        const methodLimiter = this.methodLimiters.get(`${host} ${method}`)
        if (res.headers.get('x-rate-limit-type') === 'method' && methodLimiter) methodLimiter.pause(ms)
        else this.limiter(host).pause(ms)
        continue
      }
      if (res.status >= 500) {
        await sleep(1500 * (attempt + 1))
        continue
      }
      this.stats.errors++
      return null
    }
    this.stats.errors++
    return null
  }
}
