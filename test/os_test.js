'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const YAML = require('../skill/node_modules/yaml');
const { Store, WhoAmIError, Conflict, PermissionDenied, defaultMemoryPath } = require('../skill/scripts/whoami_os');

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'whoami-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const memory = path.join(temp, 'personal-memory');
  const store = new Store(memory); store.init();
  return { temp, memory, store };
}
const grant = actions => ({ actions, purpose: 'personal-context', recipient: 'codex-local', task_id: '*', until_revoked: true, confirmation_id: 'fictional-user-confirmation' });
const event = (id = 'evt-work-001', policy = 'allowed') => ({ change_id: 'chg-event', op: 'add_event', record: {
  id, statement: '正在考虑职业方向', recorded_at: '2026-10-08', occurred_at: '2026-10-08', domains: ['career'],
  recall_policy: policy, sensitivity: 'personal' }, grants: [grant(['persist', 'recall', 'send'])] });
const record = (id = 'rec-work-001', evidence = 'evt-work-001') => ({ change_id: 'chg-record', op: 'add_record', record: {
  id, kind: 'state', dimension: 'goals', statement: '正在评估换工作，尚未决定', domains: ['career'], evidence_ids: [evidence],
  recall_policy: 'allowed', sensitivity: 'personal', role: 'hard_constraint', recorded_at: '2026-10-08', include_in_summary: false },
  grants: [grant(['persist', 'recall', 'send'])] });
function stablePreference() {
  const source = event('evt-preference-001'); source.change_id = 'chg-preference-source'; source.record.statement = '希望回答先给结论';
  const item = { change_id: 'chg-preference', op: 'add_record', record: { id: 'rec-preference-001', kind: 'fact', dimension: 'preferences',
    statement: '回答时先给结论', domains: ['career'], evidence_ids: ['evt-preference-001'], recall_policy: 'allowed',
    stability: 'long_term', include_in_summary: true, recorded_at: '2026-10-08' }, grants: [grant(['persist', 'recall', 'send', 'summary'])] };
  return [source, item];
}
const commit = (store, changes) => { const p = store.prepare(changes); return store.apply(p, p.patch_hash); };
const load = file => YAML.parse(fs.readFileSync(file, 'utf8'));
const recall = store => store.recall({ domain: 'career', purpose: 'personal-context', taskId: 'advice' });
const evidence = (store, id) => store.evidence({ id, purpose: 'personal-context', taskId: 'advice' });

 test('cold start persists YAML and new session recalls with source', t => {
  const { memory, store } = fixture(t); commit(store, [event(), record(), ...stablePreference()]);
  const reopened = new Store(memory); assert.equal(reopened.status().record_count, 4);
  assert.match(reopened.openContext().summary, /回答时先给结论/);
  const context = recall(reopened); assert.equal(context.coverage, 'complete');
  assert.deepEqual(context.records.map(r => r.id), ['rec-work-001', 'rec-preference-001']);
  assert.deepEqual(context.records[0].evidence_ids, ['evt-work-001']);
  assert.equal(evidence(reopened, 'evt-work-001').statement, '正在考虑职业方向');
  assert.match(fs.readFileSync(path.join(memory, 'model/goals/rec-work-001.yaml'), 'utf8'), /^---/);
});
 test('partial confirmation excludes unselected change', t => {
  const { store } = fixture(t); const p = store.prepare([event(), record()], ['chg-event']); store.apply(p, p.patch_hash);
  assert.equal(store.status().record_count, 1); assert.equal(store.openContext().summary, null);
});
 test('partial confirmation cannot leave dangling source', t => {
  const { store } = fixture(t); assert.throws(() => store.prepare([event(), record()], ['chg-record']), WhoAmIError);
});
 test('changed preview and unapproved apply rejected', t => {
  const { store } = fixture(t); const p = store.prepare([event()]);
  assert.throws(() => store.apply(p, 'other'), PermissionDenied);
  p.changes[0].record.statement = '偷偷改变的内容';
  assert.throws(() => store.apply(p, p.patch_hash), WhoAmIError); assert.equal(store.status().record_count, 0);
});
 test('retry approved proposal is idempotent', t => {
  const { store } = fixture(t); const p = store.prepare([event()]);
  assert.deepEqual(store.apply(p, p.patch_hash), store.apply(p, p.patch_hash)); assert.equal(store.status().revision, 1);
});
 test('superseding state preserves history and changes recall', t => {
  const { memory, store } = fixture(t); commit(store, [event(), record()]);
  const change = record('rec-work-002'); change.change_id = 'chg-new-state'; change.op = 'supersede'; change.target_id = 'rec-work-001'; change.record.statement = '决定先留在现有工作';
  commit(store, [change]); assert.deepEqual(recall(store).records.map(r => r.id), ['rec-work-002']);
  assert.equal(load(path.join(memory, 'model/goals/rec-work-001.yaml')).status, 'superseded');
  assert.deepEqual(load(path.join(memory, 'model/goals/rec-work-002.yaml')).supersedes, ['rec-work-001']);
});
 test('never policy blocks content recall even with grant', t => {
  const { store } = fixture(t); commit(store, [event('evt-work-001', 'never'), record()]);
  assert.throws(() => evidence(store, 'evt-work-001'), PermissionDenied); assert.deepEqual(recall(store).records, []);
});
 test('pattern needs three independent events on two dates', t => {
  const { store } = fixture(t); const sources = ['001','002','003'].map(suffix => {
    const source = event(`evt-pattern-${suffix}`); source.change_id = `chg-source-${suffix}`; source.record.occurred_at = suffix === '003' ? '2026-10-09' : '2026-10-08'; return source;
  });
  const pattern = { change_id: 'chg-pattern', op: 'add_record', record: { id: 'rec-pattern-001', kind: 'pattern', dimension: 'patterns',
    statement: '倾向先检查约束', domains: ['career'], evidence_ids: sources.map(s => s.record.id) }, grants: [grant(['persist', 'recall', 'send'])] };
  assert.throws(() => store.prepare([sources[0], pattern]), WhoAmIError);
  assert.equal(commit(store, [...sources, pattern]).revision, 1); assert.equal(store.status().record_count, 4);
});
 test('retract marks dependents for review and removes summary', t => {
  const { memory, store } = fixture(t); const derived = { change_id: 'chg-derived', op: 'add_record', record: {
    id: 'rec-interpretation-001', kind: 'interpretation', dimension: 'synthesis', statement: '正在权衡稳定与成长',
    domains: ['career'], derived_from: ['rec-work-001'], recall_policy: 'allowed', recorded_at: '2026-10-08' },
    grants: [grant(['persist','recall','send'])] };
  commit(store, [event(), record(), derived]); commit(store, [{ change_id: 'chg-retract', op: 'retract', target_id: 'rec-work-001' }]);
  assert.equal(store.openContext().summary, null); assert.deepEqual(recall(store).records, []);
  assert.equal(load(path.join(memory, 'model/synthesis/rec-interpretation-001.yaml')).status, 'needs_review');
});
 test('forget source removes dependents and summary', t => {
  const { memory, store } = fixture(t); commit(store, [event(), record()]); commit(store, [{ change_id: 'chg-forget', op: 'forget', target_id: 'evt-work-001' }]);
  assert.equal(store.status().record_count, 0); assert.equal(store.openContext().summary, null);
  assert.equal(fs.existsSync(path.join(memory, 'timeline/2026/evt-work-001.yaml')), false);
  assert.equal(fs.existsSync(path.join(memory, 'model/goals/rec-work-001.yaml')), false);
});
 test('interrupted multi-file commit recovers old state', t => {
  const { memory, store } = fixture(t); const p = store.prepare([event(), record()]);
  assert.throws(() => store.apply(p, p.patch_hash, 0), WhoAmIError);
  const reopened = new Store(memory); assert.equal(reopened.status().revision, 0); assert.equal(reopened.status().record_count, 0);
  assert.deepEqual(fs.readdirSync(path.join(memory, '.transactions')), []);
});
 test('manual edit blocks update and stale summary', t => {
  const { memory, store } = fixture(t); commit(store, stablePreference());
  fs.appendFileSync(path.join(memory, 'model/preferences/rec-preference-001.yaml'), '# changed by editor\n');
  assert.equal(store.openContext().summary, null);
  const p = store.prepare([{ change_id: 'chg-retract', op: 'retract', target_id: 'rec-preference-001' }]);
  assert.throws(() => store.apply(p, p.patch_hash), Conflict);
});
 test('manual policy expansion cannot authorize reading', t => {
  const { memory, store } = fixture(t); commit(store, [event(), record()]); fs.appendFileSync(path.join(memory, 'policy.yaml'), '# unauthorized edit\n');
  assert.throws(() => recall(store), Conflict); assert.throws(() => store.openContext(), Conflict);
});
 test('retracting stable record invalidates summary', t => {
  const { store } = fixture(t); commit(store, stablePreference()); assert.match(store.openContext().summary, /回答时先给结论/);
  commit(store, [{ change_id: 'chg-retract-pref', op: 'retract', target_id: 'rec-preference-001' }]); assert.equal(store.openContext().summary, null);
});
 test('task scope and expired grant block recall', t => {
  const { store } = fixture(t); const limited = record(); limited.grants = [{ actions: ['persist','recall','send'], purpose: 'personal-context',
    recipient: 'codex-local', task_id: 'approved-task', expires_at: '2999-01-01', confirmation_id: 'fictional-confirmation' }];
  commit(store, [event(), limited]);
  assert.deepEqual(store.recall({ domain: 'career', purpose: 'personal-context', taskId: 'other-task' }).records, []);
  assert.equal(store.recall({ domain: 'career', purpose: 'personal-context', taskId: 'approved-task' }).records.length, 1);
});
 test('record budget reports partial coverage', t => {
  const { store } = fixture(t); const changes = [event()];
  for (let i = 0; i < 10; i++) { const item = record(`rec-budget-${i}`); item.change_id = `chg-budget-${i}`; changes.push(item); }
  commit(store, changes); const context = recall(store);
  assert.equal(context.coverage, 'partial'); assert.equal(context.truncated_by, 'record_limit');
  assert.equal(context.records.length, 8); assert.equal(context.unread_candidate_count, 2);
});
 test('revoke grant removes summary without deleting record', t => {
  const { store } = fixture(t); commit(store, stablePreference()); assert.match(store.openContext().summary, /回答时先给结论/);
  const grantId = store.grants().find(g => g.record_ids.includes('rec-preference-001')).id;
  commit(store, [{ change_id: 'chg-revoke', op: 'revoke_grant', target_id: grantId }]);
  assert.equal(store.openContext().summary, null); assert.equal(recall(store).records.some(r => r.id === 'rec-preference-001'), false);
  assert.equal(store.status().record_count, 2);
});
 test('default location remains outside repo and requires init', t => {
  const { temp } = fixture(t); const env = { ...process.env, HOME: temp };
  const command = path.join(__dirname, '../skill/scripts/whoami.js');
  const expected = defaultMemoryPath({ home: temp });
  let output = spawnSync(process.execPath, [command, 'location'], { env, encoding: 'utf8' });
  assert.equal(output.status, 0, output.stderr); assert.equal(JSON.parse(output.stdout).memory_path, expected);
  output = spawnSync(process.execPath, [command, 'status'], { env, encoding: 'utf8' });
  assert.notEqual(output.status, 0); assert.equal(fs.existsSync(expected), false);
  output = spawnSync(process.execPath, [command, 'init'], { env, encoding: 'utf8' });
  assert.equal(output.status, 0, output.stderr); assert.equal(JSON.parse(output.stdout).memory_path, expected);
  assert.equal(fs.existsSync(path.join(expected, 'manifest.yaml')), true);
});
 test('explicit memory path overrides default', t => {
  const { temp } = fixture(t); const env = { ...process.env, HOME: temp }, command = path.join(__dirname, '../skill/scripts/whoami.js');
  const chosen = path.join(temp, 'other-personal-memory');
  const output = spawnSync(process.execPath, [command, 'init', '--memory', chosen], { env, encoding: 'utf8' });
  assert.equal(output.status, 0, output.stderr); assert.equal(JSON.parse(output.stdout).memory_path, chosen);
  assert.equal(fs.existsSync(defaultMemoryPath({ home: temp })), false);
});
 test('default path follows local platform convention', t => {
  const { temp } = fixture(t);
  assert.equal(defaultMemoryPath({ home: temp, platform: 'darwin' }), path.join(temp, 'Library', 'Application Support', 'WhoAmI', 'personal-memory'));
  assert.equal(defaultMemoryPath({ home: temp, platform: 'linux', xdgDataHome: path.join(temp, 'data') }), path.join(temp, 'data', 'whoami', 'personal-memory'));
  assert.equal(defaultMemoryPath({ home: 'C:/Users/A Name', platform: 'win32', localAppData: 'C:\\Users\\A Name\\AppData\\Local' }).replace(/\\/g, '/'), 'C:/Users/A Name/AppData/Local/WhoAmI/personal-memory');
});
 test('Windows branch retains process recovery', t => {
  const { store } = fixture(t); commit(store, [event(), record()]); assert.equal(store.status().record_count, 2);
});
 test('skill folder runs after being copied alone', t => {
  const { temp } = fixture(t); const installed = path.join(temp, 'installed', 'who-am-i'); fs.mkdirSync(installed, { recursive: true });
  fs.cpSync(path.join(__dirname, '../skill'), installed, { recursive: true, filter: source => !source.endsWith('node_modules') });
  fs.cpSync(path.join(__dirname, '../skill/node_modules'), path.join(installed, 'node_modules'), { recursive: true });
  const command = path.join(installed, 'scripts', 'whoami.js'), env = { ...process.env, HOME: path.join(temp, 'new-home') };
  const run = (operation, input, ...args) => spawnSync(process.execPath, [command, operation, ...args], { env, input: input === undefined ? undefined : JSON.stringify(input), encoding: 'utf8' });
  let output = run('location'); assert.equal(output.status, 0, output.stderr); const memory = JSON.parse(output.stdout).memory_path;
  assert.equal(fs.existsSync(memory), false);
  output = run('init'); assert.equal(output.status, 0, output.stderr); assert.equal(JSON.parse(output.stdout).memory_path, memory);
  output = run('status'); assert.equal(output.status, 0, output.stderr); assert.equal(JSON.parse(output.stdout).record_count, 0);
  output = run('prepare', { changes: [event()] }); assert.equal(output.status, 0, output.stderr); const proposal = JSON.parse(output.stdout);
  output = run('apply', proposal, '--approval-hash', proposal.patch_hash); assert.equal(output.status, 0, output.stderr);
  output = run('status'); assert.equal(output.status, 0, output.stderr); assert.equal(JSON.parse(output.stdout).record_count, 1);
});

test('nickname alone can start a profile with optional dimensions empty', t => {
  const { store, memory } = fixture(t);
  const source = event(); source.record.statement = '请叫我小林'; source.record.domains = ['identity'];
  const name = record(); Object.assign(name.record, { kind: 'fact', dimension: 'identity', statement: '称呼是小林', domains: ['identity'] });
  const proposal = store.prepare([source, name]);
  assert.equal(proposal.preview[1].confirmation_status, 'pending');
  assert.equal(store.status().record_count, 0);
  store.apply(proposal, proposal.patch_hash);
  const saved = load(path.join(memory, 'model/identity/rec-work-001.yaml'));
  assert.equal(saved.confirmation_status, 'confirmed');
  assert.deepEqual(saved.confirmation_ids, ['fictional-user-confirmation']);
  assert.equal(saved.confidence, null);
  assert.deepEqual(fs.readdirSync(path.join(memory, 'model')), ['identity']);
});
test('AI interpretation stays an interpretation after confirmation and recall', t => {
  const { store } = fixture(t); const inference = record(); inference.record.kind = 'interpretation';
  commit(store, [event(), inference]); const item = recall(store).records[0];
  assert.equal(item.kind, 'interpretation'); assert.equal(item.evidence_level, 'E0');
  assert.equal(item.statement_origin, 'ai_inference'); assert.equal(item.confirmation_status, 'confirmed');
});
test('new statements require evidence and AI output cannot support direct claims', t => {
  const { store } = fixture(t); const unsupported = record(); unsupported.record.evidence_ids = [];
  assert.throws(() => store.prepare([unsupported]), /需要直接来源/);
  unsupported.record.kind = 'interpretation';
  assert.throws(() => store.prepare([unsupported]), /推断需要/);
  const ai = event(); ai.record.source = { type: 'ai_output' };
  assert.throws(() => store.prepare([ai, record()]), /AI 输出不能/);
});
test('confidence needs rationale and cannot upgrade an interpretation', t => {
  const { store } = fixture(t); const item = record(); item.record.confidence = 'high';
  assert.throws(() => store.prepare([event(), item]), /必须说明/);
  item.record.confidence_reason = '用户明确表达当前意向，仅对表达本身有把握';
  assert.equal(store.prepare([event(), item]).preview[1].confidence, 'high');
  item.record.kind = 'interpretation'; item.record.evidence_level = 'E1';
  assert.throws(() => store.prepare([event(), item]), /证据等级/);
});
test('candidate cannot forge saved confirmation and invalid time intervals rejected', t => {
  const { store } = fixture(t); const item = record(); item.record.confirmation_status = 'confirmed';
  assert.throws(() => store.prepare([event(), item]), /候选不能/);
  delete item.record.confirmation_status; item.record.confirmed_at = '2026-10-09';
  assert.throws(() => store.prepare([event(), item]), /apply 生成/);
  delete item.record.confirmed_at; item.record.valid_from = '2026-10-10'; item.record.valid_to = '2026-10-01';
  assert.throws(() => store.prepare([event(), item]), /有效期/);
});
test('temporary state cannot become permanent summary and history remains inspectable', t => {
  const { store, memory } = fixture(t); const mood = record(); mood.record.include_in_summary = true; mood.record.stability = 'long_term';
  assert.throws(() => store.prepare([event(), mood]), /临时状态/);
  commit(store, [event(), record()]); const next = record('rec-next'); next.op = 'supersede'; next.target_id = 'rec-work-001';
  commit(store, [next]); const old = load(path.join(memory, 'model/goals/rec-work-001.yaml'));
  assert.equal(old.status, 'superseded'); assert.equal(old.statement, '正在评估换工作，尚未决定');
});
