// Real CLI -> HTTP -> scheduled analysis -> explicit approval regression.
// Requires a disposable loopback backend with DRIVEOS_AUTO_ANALYSIS=false.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ConvexHttpClient } from 'convex/browser';
import { anyApi } from 'convex/server';
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backendUrl = process.env.DRIVEOS_TEST_URL || 'http://127.0.0.1:3210';
const siteUrl = process.env.DRIVEOS_TEST_SITE_URL || 'http://127.0.0.1:3211';
for (const url of [backendUrl, siteUrl]) assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname), 'A disposable loopback backend is required.');
const fixture = fs.mkdtempSync(path.join(process.env.DRIVEOS_TEST_DIRECTORY || os.tmpdir(), 'driveos-scan-analysis-'));
const roots = [path.join(fixture, 'media-a'), path.join(fixture, 'media-b')];
const agentHome = path.join(fixture, 'agent-home'), quarantineRoot = path.join(fixture, 'quarantine');
const email = 'qa-scan-analysis-' + Date.now() + '@driveos.test', password = 'DriveOS-local-QA-2026!';
const client = new ConvexHttpClient(backendUrl, { logger: false });
const results = [], hashes = new Map();
let machine, browserFixtureOnly = false;
const record = name => { results.push({ name, status: 'passed' }); process.stdout.write('PASS ' + name + '\n'); };
const query = (module, name, args = {}) => client.query(anyApi[module][name], args);
const mutation = (module, name, args = {}) => client.mutation(anyApi[module][name], args);
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function write(root, relative, fill) {
  const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(1024 * 1024 + 17, fill));
  const stable = new Date(Date.now() - 120_000); fs.utimesSync(file, stable, stable);
  hashes.set(file, hash(file)); return file;
}
function assertUntouched() { for (const [file, expected] of hashes) assert.equal(hash(file), expected, 'Scan/analysis must preserve ' + file); }
function agent(args, label) {
  const result = spawnSync(process.execPath, [path.join(repository, 'apps/agent/dist/index.js'), ...args], {
    cwd: repository, encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, DRIVEOS_AGENT_HOME: agentHome, DRIVEOS_CONVEX_URL: siteUrl },
  });
  fs.writeFileSync(path.join(fixture, label + '.log'), (result.stdout || '') + '\n' + (result.stderr || ''));
  assert.equal(result.status, 0, label + ' exited ' + result.status + ': ' + (result.stderr || result.error || ''));
  return (result.stdout || '') + '\n' + (result.stderr || '');
}
async function api(operation, body, token = machine.token) {
  const response = await fetch(siteUrl + '/api/' + operation, { method: 'POST', headers: {
    'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}),
  }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  return { status: response.status, body: await response.json() };
}
async function analysisComplete() {
  const until = Date.now() + 30_000; let status;
  do {
    status = await query('scans', 'analysisStatus');
    if (status.status === 'completed' && status.catalogCurrent) return status;
    assert.notEqual(status.status, 'failed', status.error || 'Analysis failed'); await sleep(100);
  } while (Date.now() < until);
  throw new Error('Analysis did not complete: ' + JSON.stringify(status));
}
async function assertNoCleanup() {
  assert.ok((await query('cleanup', 'listJobs')).every(job => job.action === 'scan'), 'Scan/analysis must not create move/delete jobs.');
  assert.deepEqual(await query('cleanup', 'listQuarantine'), []); assertUntouched();
}
try {
  const auth = await client.action(anyApi.auth.signIn, { provider: 'password', params: {
    flow: 'signUp', email, password, name: 'One-click Scan QA', orgName: 'One-click Scan QA',
  } });
  assert.ok(auth.tokens?.token); client.setAuth(auth.tokens.token);
  fs.writeFileSync(path.join(fixture, 'browser-login.json'), JSON.stringify({ email, password, backendUrl, siteUrl }, null, 2));
  machine = await mutation('agentAuth', 'issueMachineToken', { machineName: 'OneClick-QA-' + Date.now() });
  const cacheA = write(roots[0], '06_RENDERS_CACHE/preview-a.dat', 65), cacheB = write(roots[1], '06_RENDERS_CACHE/preview-b.dat', 66);
  const musicA = write(roots[0], '04_ASSETS/MUSIC/song-a.wav', 77), musicB = write(roots[1], '04_ASSETS/MUSIC/song-b.wav', 77);
  const raw = write(roots[0], '02_RAW/A_CAM/take.mov', 71), final = write(roots[1], '08_DELIVERY/master.mov', 72);
  agent(['init', '--machine', machine.machineName, '--owner', email, '--convex', siteUrl, '--auth-token', machine.token,
    '--roots', roots.join(','), '--full-hash', '--central-quarantine', '--quarantine', quarantineRoot], 'init');
  const first = agent(['scan-now', '--full-hash'], 'one-click-multi-root');
  assert.equal((first.match(/\[Analysis Queued\]/g) || []).length, 1, 'One analysis request must follow the whole explicit cycle.');
  await analysisComplete();
  let files = await query('files', 'list', { limit: 100 }); assert.equal(files.length, 6);
  for (const [file, classification] of [[raw, 'RAW'], [final, 'EXPORT_FINAL'], [cacheA, 'CACHE']]) assert.equal(files.find(f => f.path === file).classification, classification);
  assert.ok((await query('duplicates', 'list')).some(cluster => cluster.type === 'exact' && cluster.fileCount === 2));
  assert.ok((await query('recommendations', 'list')).some(rec => rec.type === 'delete_cache' && rec.affectedFileIds.length === 2));
  record('one scan-now catalogs both roots, automatically tags files and publishes duplicate/cleanup analysis without a second click');
  await assertNoCleanup(); agent(['run-jobs'], 'unapproved-no-jobs'); await assertNoCleanup();
  record('analysis and subsequent agent polling never move/delete files before explicit approval');
  assert.equal((await api('requestScanAnalysis', {}, null)).status, 401);
  for (const body of [{}, { sessionId: 123 }]) assert.equal((await api('requestScanAnalysis', body)).status, 400);
  const session = (await query('scans', 'list')).find(scan => scan.status === 'completed');
  const other = await mutation('agentAuth', 'issueMachineToken', { machineName: 'Other-QA-' + Date.now() });
  assert.ok((await api('requestScanAnalysis', { sessionId: session._id }, other.token)).status >= 400);
  const foreignClient = new ConvexHttpClient(backendUrl, { logger: false });
  const foreignLogin = await foreignClient.action(anyApi.auth.signIn, { provider: 'password', params: { flow: 'signUp', email: 'other-' + email, password, name: 'Other workspace QA', orgName: 'Other workspace QA' } });
  foreignClient.setAuth(foreignLogin.tokens.token);
  const foreignMachine = await foreignClient.mutation(anyApi.agentAuth.issueMachineToken, { machineName: 'Foreign-workspace-QA' });
  assert.ok((await api('requestScanAnalysis', { sessionId: session._id }, foreignMachine.token)).status >= 400);
  const beforeReplay = await query('scans', 'analysisStatus');
  assert.equal((await api('requestScanAnalysis', { sessionId: session._id })).status, 200); await sleep(150);
  assert.equal((await query('scans', 'analysisStatus')).lastRunAt, beforeReplay.lastRunAt);
  record('HTTP analysis rejects missing auth, malformed requests and foreign-machine sessions; session replay is idempotent');
  for (const status of ['partial', 'failed']) {
    const start = await api('startScan', { machineId: machine.machineId, rootPath: roots[0], agentVersion: 'one-click-qa' }); assert.equal(start.status, 200);
    assert.equal((await api('completeScan', { sessionId: start.body.sessionId, status, errorsCount: 1 })).status, 200);
    assert.ok((await api('requestScanAnalysis', { sessionId: start.body.sessionId })).status >= 400);
  }
  assert.equal((await query('scans', 'analysisStatus')).lastRunAt, beforeReplay.lastRunAt);
  record('partial and failed sessions do not authorize analysis');
  const newCache = write(roots[0], '06_RENDERS_CACHE/new-dashboard.dat', 81);
  const drive = (await query('drives', 'list')).find(d => d.mountPath === roots[0]);
  const queued = await mutation('drives', 'requestScan', { driveId: drive._id }); assert.equal(queued.queued, 1); assertUntouched();
  agent(['run-jobs'], 'dashboard-scan-job'); await analysisComplete(); files = await query('files', 'list', { limit: 100 });
  assert.ok((await query('recommendations', 'list')).some(rec => rec.affectedFileIds.includes(files.find(f => f.path === newCache)._id)));
  assert.equal((await query('cleanup', 'listJobs')).find(job => job._id === queued.jobIds[0]).status, 'completed'); await assertNoCleanup();
  record('one dashboard scan request runs on its owning agent and automatically analyzes the newly cataloged file');
  const scheduledCache = write(roots[1], '06_RENDERS_CACHE/scheduled.dat', 82);
  assert.doesNotMatch(agent(['sync', '--once'], 'scheduled-scan-only'), /\[Analysis Queued\]/); await sleep(250);
  assert.equal((await query('scans', 'analysisStatus')).catalogCurrent, false); await assertNoCleanup();
  record('background sync remains scan-only with automatic analysis disabled');
  agent(['scan', '--path', roots[1], '--full-hash'], 'direct-scan-analysis'); await analysisComplete(); files = await query('files', 'list', { limit: 100 });
  assert.ok((await query('recommendations', 'list')).some(rec => rec.affectedFileIds.includes(files.find(f => f.path === scheduledCache)._id))); await assertNoCleanup();
  record('direct scan also publishes fresh analysis automatically');
  const beforePause = await query('scans', 'analysisStatus'); agent(['pause'], 'pause');
  assert.doesNotMatch(agent(['scan-now'], 'paused-scan-now'), /\[Analysis Queued\]/); agent(['resume'], 'resume');
  assert.equal((await query('scans', 'analysisStatus')).lastRunAt, beforePause.lastRunAt); record('pause prevents explicit scans and their analysis requests');
  if (process.env.DRIVEOS_TEST_PREPARE_BROWSER === '1') browserFixtureOnly = true;
  else {
    await assert.rejects(mutation('cleanup', 'queueQuarantine', { fileIds: [files.find(f => f.path === raw)._id] }));
    const approved = await mutation('cleanup', 'queueQuarantine', { fileIds: [files.find(f => f.path === cacheA)._id] }); assert.equal(approved.queued, 1); assertUntouched();
    agent(['run-jobs'], 'approved-quarantine');
    const item = (await query('cleanup', 'listQuarantine')).find(q => q.originalPath === cacheA); assert.ok(item); assert.equal(fs.existsSync(cacheA), false); assert.equal(hash(item.quarantinePath), hashes.get(cacheA));
    for (const file of [cacheB, musicA, musicB, raw, final]) assert.equal(hash(file), hashes.get(file));
    record('only explicit approval quarantines a selected file; protected media and duplicate copies remain intact');
    await mutation('cleanup', 'requestRestore', { quarantineId: item._id }); agent(['run-jobs'], 'approved-restore'); assertUntouched();
    await mutation('cleanup', 'queueQuarantine', { fileIds: [files.find(f => f.path === cacheB)._id], purgeAfter: true }); assertUntouched();
    agent(['run-jobs'], 'approved-permanent-delete-move'); agent(['run-jobs'], 'approved-permanent-delete-purge');
    assert.equal(fs.existsSync(cacheB), false); assert.ok(!(await query('cleanup', 'listQuarantine')).some(q => q.originalPath === cacheB)); hashes.delete(cacheB); assertUntouched();
    record('explicit restore and permanent-delete requests execute correctly; scanning never grants their approval');
  }
} catch (error) {
  process.exitCode = 1; results.push({ name: 'one-click end-to-end flow', status: 'failed', error: String(error?.stack || error) }); process.stderr.write('FAIL ' + (error?.stack || error) + '\n');
} finally {
  fs.writeFileSync(path.join(fixture, 'summary.json'), JSON.stringify({ fixture, email, results, browserFixtureOnly }, null, 2)); process.stdout.write('One-click scan/analysis evidence: ' + fixture + '\n');
}
