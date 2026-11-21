/**
 * Isolated integration: the Chore Scout jobs runtime against REAL BOB (CS-3979,
 * CS-3992; review 40503/40505 "isolated integration").
 *
 * Runs inside the harness container of docker-compose.yml, on an internal-only
 * network: mongo (single-node replica set), bob (BOB built from its repo at a
 * named SHA, SERVICE_MODE=bob, every outside service unset or unreachable) and
 * this harness. Nothing here can reach AWS, Odyssey, Resend or the internet.
 *
 * Real clock only, on both sides. Nothing is faked or accelerated: history is
 * SEEDED instead (an allowance authority that started 2026-11-02, so on today's
 * real clock its 2026-11-02 week was missed and is caught up late). BOB's own
 * 7.5 checks (INVALID_CYCLE, no future cycle) run on BOB's real clock too.
 *
 * What it proves (each is an assertion; any failure exits 1):
 *   I1 one payment per cycle: real jobs-main pays each ended cycle once, with
 *      key cs:<cycleKey>:allowance; later ticks send nothing; BOB refuses a new
 *      key for a paid cycle (CYCLE_ALREADY_PAID); BOB holds one execution row
 *      per (child, cycle) and one funding leg per execution.
 *   I2 missed-run reconciliation: the missed 2026-11-02 week is paid once, at
 *      its own amount, as its own payment, with an ALLOWANCE_MISSED_RUN alert.
 *   I3 original-key retry: BOB commits but the answer is lost (proxy drops it);
 *      the job retries with the original key after RETRY_AFTER_MS; BOB replays
 *      (x-idempotency-replay); one execution; cycle EXECUTED.
 *   I4 revocation: an authority revoked under the Guardian's session gives
 *      FAILED AUTHORITY_REVOKED, no money, no retry.
 *   I5 exact amount (SD-7): a rule that disagrees with BOB's authority gives
 *      FAILED AMOUNT_NOT_AUTHORISED, no money, plus an UNEXPECTED_FAILED alert.
 *   I6 two banks: a Manly runner pays the Manly child with the Manly credential;
 *      each bank has its own lease; a Bilgola credential on a Manly authority
 *      gets 404 NOT_FOUND.
 *   I7 failover: the Bilgola leader is killed without releasing; the other
 *      Bilgola runner takes over after the lease TTL and finishes the retries.
 *   I8 hold and recovery: BOB's answer is altered by the proxy three times ->
 *      operator hold + ALLOWANCE_OPERATOR_HOLD; with the proxy restored, the
 *      real jobs-recover CLI rechecks with the original key -> RESOLVED_EXECUTED
 *      via BOB's replay; still one execution.
 *   I9 single initiator: every allowance money movement in BOB has a matching
 *      7.5 execution (no legacy family scheduler moved money).
 *   I10 7.5 refuses a person session (403) and a future cycle (INVALID_CYCLE).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { MongoClient, type Db } from 'mongodb'

const MONGO = process.env.MONGO_URL ?? 'mongodb://mongo:27017/?replicaSet=rs0'
const BOB = process.env.BOB_URL ?? 'http://bob:3000'
const BOB_DB = 'odyssey_rehearsal'
const CS_DB = 'chorescout_it'
const PROXY_PORT = 4001
const GIT_SHA = process.env.GIT_SHA ?? 'it-local'
const RETRY_AFTER_MS = 60_000

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const b64 = (n: number) => randomBytes(n).toString('base64url')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const now = () => new Date()
const log = (...a: unknown[]) => console.log(`[harness ${now().toISOString()}]`, ...a)

// ---------- results ----------
const results: { id: string; ok: boolean; detail: string }[] = []
function check(id: string, ok: boolean, detail: string) {
  results.push({ id, ok, detail })
  log(`${ok ? 'PASS' : 'FAIL'} ${id}: ${detail}`)
}

// ---------- fault-injecting proxy between jobs-main and BOB ----------
type Mode = 'pass' | 'drop-once' | 'mutate'
const proxyMode = new Map<string, Mode>() // by authority id
const proxyLog: { at: string; method: string; path: string; key: string | null; status: number; replay: boolean; mode: Mode; dropped: boolean }[] = []
function startProxy() {
  const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const m = /\/service\/standing-authorities\/([^/]+)\/executions$/.exec(req.url ?? '')
      const auth = m ? decodeURIComponent(m[1]!) : ''
      const mode: Mode = (auth && proxyMode.get(auth)) || 'pass'
      const up = httpRequest(`${BOB}${req.url}`, { method: req.method, headers: { ...req.headers, host: 'bob:3000' } }, (ur) => {
        const out: Buffer[] = []
        ur.on('data', (c) => out.push(c))
        ur.on('end', () => {
          let payload = Buffer.concat(out)
          const replay = ur.headers['x-idempotency-replay'] === 'true'
          const entry = { at: now().toISOString(), method: req.method ?? '', path: req.url ?? '', key: (req.headers['idempotency-key'] as string) ?? null, status: ur.statusCode ?? 0, replay, mode, dropped: false }
          if (mode === 'drop-once') {
            proxyMode.set(auth, 'pass')
            entry.dropped = true
            proxyLog.push(entry)
            req.socket.destroy() // BOB committed; the caller never hears back
            return
          }
          if (mode === 'mutate' && ur.statusCode === 201) {
            const j = JSON.parse(payload.toString('utf8'))
            j.data.amount_cents += 100 // disagrees with what was asked
            payload = Buffer.from(JSON.stringify(j))
          }
          proxyLog.push(entry)
          const headers = { ...ur.headers, 'content-length': String(payload.length) }
          res.writeHead(ur.statusCode ?? 502, headers)
          res.end(payload)
        })
      })
      up.on('error', () => {
        res.writeHead(502)
        res.end()
      })
      up.end(body)
    })
  })
  return new Promise<void>((r) => srv.listen(PROXY_PORT, '127.0.0.1', () => r()))
}

// ---------- BOB HTTP helpers ----------
async function bob(method: string, path: string, bearer: string, body?: unknown, key?: string) {
  const res = await fetch(`${BOB}${path}`, {
    method,
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, replay: res.headers.get('x-idempotency-replay') === 'true', json: text ? JSON.parse(text) : null }
}
async function waitForBob() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${BOB}/api/v1/auth/session`)
      if (r.status > 0) return
    } catch {
      /* not up yet */
    }
    await sleep(1000)
  }
  throw new Error('BOB did not come up')
}

// ---------- seed ----------
interface Person { id: string; bank: string; token?: string }
interface Kid extends Person { name: string; start: string; ruleCents: number; authorityCents: number; mode: Mode; authorityId?: string; revoke?: boolean }

async function seedPerson(bdb: Db, p: Person, kind: 'adult' | 'child') {
  const at = now()
  const base = { _id: p.id, customer_id: p.id, bank_id: p.bank, email: `${p.id}@it.invalid`, display_name: p.id, onboarded_at: at }
  if (kind === 'adult') await bdb.collection('customers').insertOne({ ...base, hidden: false } as never)
  else await bdb.collection('customers').insertOne({ ...base, customer_kind: 'child', customer_type: 'consumer', first_name: p.id, date_of_birth: '2015-03-01', auth_status: 'active', hidden: true, jars: { spend: `${p.id}_spend`, save: `${p.id}_save`, give: `${p.id}_give` } } as never)
}
async function seedAccount(bdb: Db, id: string, owner: string, bank: string, jar: string | null, balance: number) {
  await bdb.collection('accounts').insertOne({
    _id: id, account_id: id, player_id: owner, bank_id: bank, account_type: jar && jar !== 'spend' ? 'savings' : 'current',
    product_type: jar && jar !== 'spend' ? 'junior_savings' : 'everyday_transaction', ...(jar ? { jar } : {}), balance_semantics: 'asset',
    starting_balance: balance, balance, currency: 'AUD', opened_at_sim_day: 0, opened_at_calendar: '2026-11-01', origin: jar ? 'guardian_created' : 'seed',
  } as never)
}
async function seedSession(bdb: Db, p: Person) {
  const token = `bobat_${b64(32)}`
  const far = new Date(Date.now() + 3 * 3_600_000)
  await bdb.collection('auth_sessions').insertOne({
    _id: `ses_it_${p.id}`, customer_id: p.id, bank_id: p.bank, issued_at: now(), last_used_at: now(), idle_expires_at: far, access_hash: sha256(token), access_expires_at: far,
    prev_access_hash: null, prev_access_expires_at: null, refresh_hash: sha256(`bobrt_${b64(32)}`), revoked_at: null, revoke_reason: null, purge_at: new Date(far.getTime() + 86_400_000),
  } as never)
  p.token = token
}
async function issueCredential(bdb: Db, bank: string) {
  const raw = `bobsvc_${b64(32)}`
  await bdb.collection('service_credentials').insertOne({ _id: `svc_it_${bank}`, bank_id: bank, purpose: 'allowance', hash: sha256(raw), status: 'active', created_at: now(), retired_at: null } as never)
  return raw
}

// ---------- jobs processes (the real entry points, real clock) ----------
const procs = new Map<string, { p: ChildProcess; lines: string[] }>()
function startJobs(name: string, bank: string, credential: string) {
  const env = {
    PATH: process.env.PATH ?? '', NODE_ENV: 'development', LOG_LEVEL: 'info', GIT_SHA, MONGODB_URI: MONGO, MONGODB_DB: CS_DB,
    BOB_API_URL: `http://127.0.0.1:${PROXY_PORT}`, ALLOWANCE_TENANT_ID: bank, BOB_ALLOWANCE_CREDENTIAL: credential, JOB_LEASE_TTL_MS: '10000', JOB_TICK_INTERVAL_MS: '2000',
  }
  // One process (node --import tsx), so the lease holder's pid is the process we can kill.
  const p = spawn('node', ['--import', 'tsx', 'src/jobs-main.ts'], { env, cwd: '/app' })
  const lines: string[] = []
  const take = (d: Buffer) => d.toString('utf8').split('\n').filter(Boolean).forEach((l) => lines.push(l))
  p.stdout.on('data', take)
  p.stderr.on('data', take)
  procs.set(name, { p, lines })
  return p
}
const jsonLines = (name: string) => (procs.get(name)?.lines ?? []).flatMap((l) => { try { return [JSON.parse(l) as Record<string, unknown>] } catch { return [] } })
const allJson = (): Record<string, unknown>[] => [...procs.keys()].flatMap((n) => jsonLines(n).map((j) => ({ ...j, proc: n })))
async function stopAll(signal: NodeJS.Signals = 'SIGTERM') {
  for (const { p } of procs.values()) if (p.exitCode === null) p.kill(signal)
  await sleep(3000)
}
async function runRecover(bank: string, credential: string, args: string[]) {
  const env = { PATH: process.env.PATH ?? '', NODE_ENV: 'development', LOG_LEVEL: 'info', GIT_SHA, MONGODB_URI: MONGO, MONGODB_DB: CS_DB, BOB_API_URL: `http://127.0.0.1:${PROXY_PORT}`, ALLOWANCE_TENANT_ID: bank, BOB_ALLOWANCE_CREDENTIAL: credential }
  return new Promise<{ code: number | null; out: string }>((r) => {
    const p = spawn('node', ['--import', 'tsx', 'src/jobs-recover-main.ts', ...args], { env, cwd: '/app' })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (out += d))
    p.on('close', (code) => r({ code, out }))
  })
}

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs: number, everyMs = 1000): Promise<T | null> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v as T
    await sleep(everyMs)
  }
  log(`timed out waiting for: ${what}`)
  return null
}

async function main() {
  log(`harness at ${GIT_SHA}; BOB ${BOB}; real clock ${now().toISOString()}`)
  await waitForBob()
  const client = await MongoClient.connect(MONGO)
  const bdb = client.db(BOB_DB)
  const sdb = client.db(CS_DB)
  await sdb.dropDatabase()
  // BOB needs its clock document for transfers (bob mode never creates it).
  await bdb.collection('simulator_state').updateOne({ _id: 'singleton' as never }, { $setOnInsert: { sim_day: 0, sim_hour: 0, sim_start_date: '2026-01-01', speed_multiplier: 1, running: false, last_tick_at: null, simulator_seed: 'it', version: '0' } }, { upsert: true })

  const run = b64(4).replace(/[^A-Za-z0-9]/g, 'x')
  const G1: Person = { id: `cust_it_${run}_sarah`, bank: 'bank_bilgola' }
  const G2: Person = { id: `cust_it_${run}_manlyg`, bank: 'bank_manly' }
  const kid = (name: string, bank: string, start: string, o: Partial<Kid> = {}): Kid => ({ id: `cust_it_${run}_${name}`, name, bank, start, ruleCents: 1000, authorityCents: 1000, mode: 'pass', ...o })
  const kids: Kid[] = [
    kid('ava', 'bank_bilgola', '2026-11-02'), // I1, I2: missed week + current week
    kid('ben', 'bank_bilgola', '2026-11-09', { revoke: true }), // I4
    kid('cal', 'bank_bilgola', '2026-11-09', { ruleCents: 1200 }), // I5
    kid('dee', 'bank_bilgola', '2026-11-09', { mode: 'drop-once' }), // I3
    kid('eli', 'bank_bilgola', '2026-11-09', { mode: 'mutate' }), // I8
    kid('max', 'bank_manly', '2026-11-09'), // I6
  ]
  const guardianOf = (k: Kid) => (k.bank === 'bank_bilgola' ? G1 : G2)
  for (const g of [G1, G2]) {
    await seedPerson(bdb, g, 'adult')
    await seedAccount(bdb, `${g.id}_funding_acct`, g.id, g.bank, null, 500)
    await seedSession(bdb, g)
  }
  for (const k of kids) {
    await seedPerson(bdb, k, 'child')
    for (const jar of ['spend', 'save', 'give']) await seedAccount(bdb, `${k.id}_${jar}`, k.id, k.bank, jar, 0)
    const g = guardianOf(k)
    await bdb.collection('guardian_links').insertOne({ _id: `lnk_it_${k.id}`, bank_id: k.bank, guardian_customer_id: g.id, child_customer_id: k.id, status: 'active', action: 'create_linked_child', guardian_confirmed: true, created_at: now(), recorded_against_session_id: `ses_it_${g.id}`, setup_ref: `it-${k.id}`, request_hash: 'it', welcome_email: 'deferred', revoked_at: null, revoked_by_session_id: null, revoke_key: null } as never)
  }
  const cred = { bank_bilgola: await issueCredential(bdb, 'bank_bilgola'), bank_manly: await issueCredential(bdb, 'bank_manly') }

  // 7.1: each authority created through BOB's real route, under the Guardian's own session.
  for (const k of kids) {
    const g = guardianOf(k)
    const split = { spend: k.authorityCents / 2, save: (k.authorityCents * 3) / 10, give: k.authorityCents / 5 }
    const r = await bob('POST', `/api/v1/children/${k.id}/standing-authorities`, g.token!, { from_account_id: `${g.id}_funding_acct`, amount_cents: k.authorityCents, currency: 'AUD', split_cents: split, cycle: { period: 'weekly', start_date: k.start, timezone: 'Australia/Sydney' } }, `cs:${k.id}:authority:create`)
    if (r.status !== 201) throw new Error(`7.1 for ${k.name}: ${r.status} ${JSON.stringify(r.json)}`)
    k.authorityId = r.json.data.authority_id
    proxyMode.set(k.authorityId!, k.mode)
    // The server's rule, as setAllowance would have stored it (seeded: the harness has no API session check here).
    const ruleSplit = { spend: k.ruleCents / 2, save: (k.ruleCents * 3) / 10, give: k.ruleCents / 5 }
    await sdb.collection('allowance_rules').insertOne({ childCustomerId: k.id, tenantId: k.bank, guardianCustomerId: g.id, mode: 'FREE', amountCents: k.ruleCents, cadence: 'WEEKLY', startDate: k.start, timezone: 'Australia/Sydney', split: { spendPercent: 50, savePercent: 30, givePercent: 20 }, splitCents: ruleSplit, linkedCondition: null, fromAccountId: `${g.id}_funding_acct`, authorityId: k.authorityId, authorityVersion: 1, effectiveFrom: k.start, version: 1, applied: [], createdAt: now(), updatedAt: now() } as never)
  }
  const ben = kids.find((k) => k.name === 'ben')!
  const rv = await bob('POST', `/api/v1/standing-authorities/${ben.authorityId}/revoke`, G1.token!, {}, `it-revoke-${ben.id}`)
  check('I4-setup', rv.status === 200, `ben's authority revoked under Sarah's session: ${rv.status}`)
  // Server indexes (migrations) as the API deploy would have run them.
  const { runMigrations } = await import('../../src/migrations/index.js')
  await runMigrations(sdb, { holder: 'it' })
  await startProxy()

  // ---------- phase 1: start the real jobs processes ----------
  startJobs('bilgola-1', 'bank_bilgola', cred.bank_bilgola)
  startJobs('bilgola-2', 'bank_bilgola', cred.bank_bilgola)
  startJobs('manly-1', 'bank_manly', cred.bank_manly)
  const cycles = () => sdb.collection('allowance_cycles').find({}, { projection: { _id: 0, cycleKey: 1, childCustomerId: 1, periodStart: 1, status: 1, decision: 1, bobReason: 1, amountCents: 1, mismatches: 1, operatorHold: 1, bobOperationRef: 1, attempts: 1 } }).toArray()
  const cyc = async (k: Kid, p: string) => (await cycles()).find((c) => c.cycleKey === `${k.id}:${p}`)
  const byName = (n: string) => kids.find((k) => k.name === n)!
  await waitFor('first decisions', async () => (await cycles()).length >= 7, 60_000)
  await sleep(8000)

  const leases = await sdb.collection<{ _id: string; holder: string }>('leases').find({ _id: { $regex: '^scheduler:allowance:' } as never }).toArray()
  check('I6-leases', leases.length === 2 && leases.some((l) => l._id === 'scheduler:allowance:bank_bilgola') && leases.some((l) => l._id === 'scheduler:allowance:bank_manly'), `leases: ${leases.map((l) => `${l._id}=${l.holder}`).join(', ')}`)
  const bilgolaLeader = String(leases.find((l) => l._id === 'scheduler:allowance:bank_bilgola')?.holder ?? '')

  const ava = byName('ava'), cal = byName('cal'), dee = byName('dee'), eli = byName('eli'), max = byName('max')
  const a1 = await cyc(ava, '2026-11-02'), a2 = await cyc(ava, '2026-11-09')
  check('I1-pay', a1?.status === 'EXECUTED' && a2?.status === 'EXECUTED' && a1.amountCents === 1000 && a2.amountCents === 1000, `ava 11-02 ${a1?.status}, 11-09 ${a2?.status}`)
  const lateAlerts = allJson().filter((j) => j.alert === 'ALLOWANCE_MISSED_RUN' && j.cycleKey === `${ava.id}:2026-11-02`)
  check('I2-missed-run', lateAlerts.length === 1 && a1?.status === 'EXECUTED', `ava's missed 2026-11-02 week caught up once at its own amount; MISSED_RUN alerts: ${lateAlerts.length}`)
  const b1 = await cyc(ben, '2026-11-09')
  check('I4-revoked', b1?.status === 'FAILED' && b1.bobReason === 'AUTHORITY_REVOKED', `ben ${b1?.status} ${b1?.bobReason}`)
  const c1 = await cyc(cal, '2026-11-09')
  const calAlert = allJson().some((j) => j.alert === 'ALLOWANCE_UNEXPECTED_FAILED' && j.cycleKey === `${cal.id}:2026-11-09`)
  check('I5-exact-amount', c1?.status === 'FAILED' && c1.bobReason === 'AMOUNT_NOT_AUTHORISED' && calAlert, `cal ${c1?.status} ${c1?.bobReason}; unexpected-FAILED alert ${calAlert}`)
  const d1 = await cyc(dee, '2026-11-09')
  check('I3-lost-answer', d1?.status === 'DECIDED' && d1.bobReason === 'UPSTREAM_UNAVAILABLE' && proxyLog.some((e) => e.dropped && e.path.includes(dee.authorityId!)), `dee ${d1?.status} ${d1?.bobReason} after BOB committed and the answer was dropped`)
  const m1 = await cyc(max, '2026-11-09')
  const maxCalls = proxyLog.filter((e) => e.path.includes(max.authorityId!))
  check('I6-manly', m1?.status === 'EXECUTED', `max (Bank of Manly) ${m1?.status} via the Manly runner`)

  // ---------- phase 2: kill the Bilgola leader without releasing; the other takes over ----------
  const leaderPid = Number(bilgolaLeader.split(':').at(-1))
  const leaderName = [...procs.keys()].find((n) => n.startsWith('bilgola') && procs.get(n)!.p.pid === leaderPid)
  check('I7-leader-known', leaderName !== undefined, `Bilgola leader ${bilgolaLeader} is process ${leaderName}`)
  procs.get(leaderName ?? 'bilgola-1')!.p.kill('SIGKILL')
  log(`killed the Bilgola leader (${bilgolaLeader}) with SIGKILL; waiting for the retries (RETRY_AFTER_MS ${RETRY_AFTER_MS} ms)`)
  const deeDone = await waitFor('dee retried with its original key', async () => (await cyc(dee, '2026-11-09'))?.status === 'EXECUTED', 3 * RETRY_AFTER_MS)
  const deeCalls = proxyLog.filter((e) => e.path.includes(dee.authorityId!))
  check('I3-original-key', Boolean(deeDone) && deeCalls.length === 2 && new Set(deeCalls.map((e) => e.key)).size === 1 && deeCalls[0]!.key === `cs:${dee.id}:2026-11-09:allowance` && deeCalls[1]!.replay, `dee calls ${deeCalls.map((e) => `${e.status}${e.replay ? ' replay' : ''}${e.dropped ? ' dropped' : ''}`).join(', ')} with key ${deeCalls[0]?.key}`)
  const newLeader = String((await sdb.collection<{ _id: string; holder: string }>('leases').findOne({ _id: 'scheduler:allowance:bank_bilgola' as never }))?.holder ?? '')
  check('I7-failover', newLeader !== '' && newLeader !== bilgolaLeader, `Bilgola lease ${bilgolaLeader} -> ${newLeader} after the leader was killed`)
  const held = await waitFor('eli held after 3 mismatches', async () => (await cyc(eli, '2026-11-09'))?.operatorHold === 'UPSTREAM_MISMATCH', 4 * RETRY_AFTER_MS)
  const holdAlerts = allJson().filter((j) => j.alert === 'ALLOWANCE_OPERATOR_HOLD' && j.cycleKey === `${eli.id}:2026-11-09`)
  check('I8-hold', Boolean(held) && holdAlerts.length === 1, `eli held after ${(await cyc(eli, '2026-11-09'))?.mismatches} mismatches; OPERATOR_HOLD alerts ${holdAlerts.length}`)
  const sentBefore = proxyLog.length
  await sleep(10_000)
  check('I1-no-resend', proxyLog.filter((e) => e.path.includes('/executions')).length === proxyLog.slice(0, sentBefore).filter((e) => e.path.includes('/executions')).length, 'no further 7.5 calls on later ticks once every cycle is final or held')
  await stopAll()

  // ---------- phase 3: operator recovery with the real CLI ----------
  proxyMode.set(eli.authorityId!, 'pass')
  const diag = await runRecover('bank_bilgola', cred.bank_bilgola, ['--cycle', `${eli.id}:2026-11-09`, '--operator', 'it-operator', '--reason', 'isolated integration: diagnose first'])
  check('I8-diagnose', diag.code === 0 && diag.out.includes('"kind":"DIAGNOSED"'), `jobs-recover diagnose exit ${diag.code}`)
  const rec = await runRecover('bank_bilgola', cred.bank_bilgola, ['--cycle', `${eli.id}:2026-11-09`, '--operator', 'it-operator', '--reason', 'isolated integration: BOB answer restored', '--recheck'])
  const eliCalls = proxyLog.filter((e) => e.path.includes(eli.authorityId!))
  const e1 = await cyc(eli, '2026-11-09')
  check('I8-recover', rec.code === 0 && rec.out.includes('"outcome":"RESOLVED_EXECUTED"') && e1?.status === 'EXECUTED' && e1.operatorHold === null && eliCalls.at(-1)!.replay && new Set(eliCalls.map((e) => e.key)).size === 1, `jobs-recover --recheck exit ${rec.code}; eli ${e1?.status}; ${eliCalls.length} calls, one key, last a replay`)
  const otherBank = await runRecover('bank_manly', cred.bank_manly, ['--cycle', `${eli.id}:2026-11-09`, '--operator', 'it-operator', '--reason', 'isolated integration: wrong bank refused', '--recheck'])
  check('I8-other-bank', otherBank.code === 3, `jobs-recover with the Manly task definition on a Bilgola cycle: exit ${otherBank.code}`)

  // ---------- phase 4: BOB-side invariants and direct 7.5 refusals ----------
  const exes = await bdb.collection('allowance_executions').find({}, { projection: { _id: 1, child_customer_id: 1, cycle_ref: 1, amount_cents: 1, bank_id: 1 } }).toArray()
  const perCycle = new Map<string, number>()
  for (const e of exes) perCycle.set(`${e.child_customer_id}:${e.cycle_ref}`, (perCycle.get(`${e.child_customer_id}:${e.cycle_ref}`) ?? 0) + 1)
  const want = [`${ava.id}:2026-11-02`, `${ava.id}:2026-11-09`, `${dee.id}:2026-11-09`, `${eli.id}:2026-11-09`, `${max.id}:2026-11-09`].sort()
  check('I1-once-per-cycle', [...perCycle.values()].every((n) => n === 1) && JSON.stringify([...perCycle.keys()].sort()) === JSON.stringify(want), `BOB executions: ${[...perCycle.entries()].map(([k, n]) => `${k.replace(`cust_it_${run}_`, '')}=${n}`).join(', ')}`)
  const serverExecuted = (await cycles()).filter((c) => c.status === 'EXECUTED').map((c) => c.bobOperationRef).sort()
  check('I1-records-agree', JSON.stringify(serverExecuted) === JSON.stringify(exes.map((e) => e._id).sort()), `server EXECUTED cycles carry exactly BOB's execution ids (${serverExecuted.length})`)
  const fundingEvents = await bdb.collection('simulator_events').countDocuments({ purpose: 'allowance_funding' } as never)
  check('I9-single-initiator', fundingEvents === exes.length, `allowance_funding events in BOB ${fundingEvents} = 7.5 executions ${exes.length}: nothing else moved allowance money`)
  const again = await bob('POST', `/api/v1/service/standing-authorities/${ava.authorityId}/executions`, cred.bank_bilgola, { child_customer_id: ava.id, cycle_ref: '2026-11-09', amount_cents: 1000, instruction_ref: `cyc_${ava.id}:2026-11-09` }, `it-new-key-${b64(4)}`)
  check('I1-new-key-refused', again.status === 409 && again.json?.errors?.[0]?.code === 'CYCLE_ALREADY_PAID', `a new key for ava's paid 11-09: ${again.status} ${again.json?.errors?.[0]?.code}`)
  const cross = await bob('POST', `/api/v1/service/standing-authorities/${max.authorityId}/executions`, cred.bank_bilgola, { child_customer_id: max.id, cycle_ref: '2026-11-09', amount_cents: 1000, instruction_ref: `cyc_${max.id}:2026-11-09` }, `it-cross-${b64(4)}`)
  check('I6-cross-bank', cross.status === 404 && cross.json?.errors?.[0]?.code === 'NOT_FOUND', `Bilgola credential on a Manly authority: ${cross.status} ${cross.json?.errors?.[0]?.code}`)
  const person = await bob('POST', `/api/v1/service/standing-authorities/${ava.authorityId}/executions`, G1.token!, { child_customer_id: ava.id, cycle_ref: '2026-11-09', amount_cents: 1000, instruction_ref: 'x' }, `it-person-${b64(4)}`)
  check('I10-person-refused', person.status === 403, `Sarah's own session on 7.5: ${person.status}`)
  const future = await bob('POST', `/api/v1/service/standing-authorities/${max.authorityId}/executions`, cred.bank_manly, { child_customer_id: max.id, cycle_ref: '2026-11-30', amount_cents: 1000, instruction_ref: `cyc_${max.id}:2026-11-30` }, `it-future-${b64(4)}`)
  check('I10-future-refused', future.status === 422 && future.json?.errors?.[0]?.code === 'INVALID_CYCLE', `a future cycle: ${future.status} ${future.json?.errors?.[0]?.code}`)
  check('I6-manly-credential', maxCalls.length >= 1, `max was paid through ${maxCalls.length} 7.5 call(s) from the Manly runner`)

  await client.close()
  const failed = results.filter((r) => !r.ok)
  console.log('\n== isolated integration summary ==')
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id.padEnd(22)} ${r.detail}`)
  console.log(`${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch(async (err) => {
  console.error('harness error', err)
  await stopAll('SIGKILL').catch(() => undefined)
  process.exit(2)
})
