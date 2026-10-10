'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const YAML = require('yaml');
const lockfile = require('proper-lockfile');

class WhoAmIError extends Error {}
class Conflict extends WhoAmIError {}
class PermissionDenied extends WhoAmIError {}
const DIMENSIONS = ['identity', 'experiences', 'values', 'goals', 'preferences', 'decisions', 'patterns', 'relationships', 'synthesis'];
const KINDS = ['fact', 'state', 'interpretation', 'pattern'];
const STATUSES = ['active', 'needs_review', 'disputed', 'superseded', 'retracted'];
const SENSITIVITY = ['ordinary', 'personal', 'sensitive'];
const RECALL_POLICIES = ['allowed', 'ask', 'never'];
const ACTIONS = ['persist', 'recall', 'send', 'summary', 'maintain'];
const RECIPIENT = 'codex-local';
const MAX_RECALL_BYTES = 64 * 1024;
const MAX_CONTEXT_BYTES = 8 * 1024;
const today = () => new Date().toISOString().slice(0, 10);
const copy = value => structuredClone(value);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const bytesize = value => Buffer.byteLength(value, 'utf8');
const without = (items, excluded) => items.filter(item => !excluded.includes(item));
const uuid = () => crypto.randomUUID();

function defaultMemoryPath({ home = os.homedir(), platform = process.platform, xdgDataHome = process.env.XDG_DATA_HOME, localAppData = process.env.LOCALAPPDATA } = {}) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'WhoAmI', 'personal-memory');
  if (platform === 'win32' || /mswin|mingw|cygwin/i.test(platform)) {
    const base = typeof localAppData === 'string' && (/^[A-Za-z]:[\\/]/.test(localAppData) || localAppData.startsWith('\\\\'))
      ? localAppData : path.join(home, 'AppData', 'Local');
    return path.join(base, 'WhoAmI', 'personal-memory');
  }
  return path.join(xdgDataHome?.startsWith('/') ? xdgDataHome : path.join(home, '.local', 'share'), 'whoami', 'personal-memory');
}

class Store {
  constructor(root = defaultMemoryPath()) { this.root = path.resolve(root); }

  init() {
    if (fs.existsSync(this.root) && fs.readdirSync(this.root).length) throw new Conflict('目录已有内容，不能初始化覆盖');
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    return this.withLock(true, () => {
      if (fs.existsSync(this.safePath('manifest.yaml'))) throw new Conflict('目录已初始化，不能覆盖');
      const policy = this.yamlDump({ grants: [] });
      this.writeAtomic('manifest.yaml', this.yamlDump({ schema_version: 1, model_id: uuid(), revision: 0, entries: {}, summary: null, policy_hash: sha(policy) }));
      this.writeAtomic('policy.yaml', policy);
      this.writeAtomic('.gitignore', '.transactions/\n.receipts/\n.lock\n.lockdir/\n');
      return this.statusUnlocked();
    });
  }

  status() { return this.withLock(false, () => { this.recoverLocked(); return this.statusUnlocked(); }); }
  statusUnlocked() {
    const m = this.manifest(); this.policy(m);
    return { memory_path: this.root, model_id: m.model_id, revision: m.revision, record_count: Object.keys(m.entries).length };
  }

  prepare(changes, selectedIds = null) {
    return this.withLock(false, () => {
      this.recoverLocked(); const m = this.manifest();
      const normalized = this.normalizeChanges(changes);
      const selected = selectedIds ?? normalized.map(c => c.change_id);
      if (!Array.isArray(selected) || without(selected, normalized.map(c => c.change_id)).length) throw new WhoAmIError('选择的变更 ID 无效');
      const sim = this.simulate(m, this.policy(m), normalized.filter(c => selected.includes(c.change_id)));
      const proposal = { model_id: m.model_id, base_revision: m.revision, manifest_hash: sha(this.readFile('manifest.yaml')),
        changes: normalized, selected_change_ids: selected, preview: sim.preview };
      proposal.patch_hash = sha(JSON.stringify(proposal));
      return proposal;
    });
  }

  apply(proposal, approvalHash, faultAfter = null) {
    return this.withLock(false, () => {
      this.recoverLocked();
      if (approvalHash !== proposal.patch_hash) throw new PermissionDenied('必须确认当前预览摘要后才能保存');
      const receiptPath = `.receipts/${proposal.patch_hash}.json`;
      if (fs.existsSync(this.safePath(receiptPath))) return JSON.parse(this.readFile(receiptPath));
      const m = this.manifest();
      if (proposal.model_id !== m.model_id || proposal.base_revision !== m.revision) throw new Conflict('模型或修订号已变化，请重新预览');
      if (proposal.manifest_hash !== sha(this.readFile('manifest.yaml'))) throw new Conflict('源文件已变化，请重新预览');
      for (const entry of Object.values(m.entries)) if (!this.entryFresh(entry)) throw new Conflict(`记录文件已变化：${entry.id}`);
      const { patch_hash, ...check } = proposal;
      if (sha(JSON.stringify(check)) !== patch_hash) throw new WhoAmIError('预览摘要不匹配');
      const selected = proposal.selected_change_ids;
      const normalized = this.normalizeChanges(proposal.changes, false);
      if (!Array.isArray(selected) || !selected.length) throw new WhoAmIError('未选择任何变更');
      if (new Set(selected).size !== selected.length || without(selected, normalized.map(c => c.change_id)).length) throw new WhoAmIError('变更 ID 无效或重复');
      const sim = this.simulate(m, this.policy(m), normalized.filter(c => selected.includes(c.change_id)));
      if (JSON.stringify(sim.preview) !== JSON.stringify(proposal.preview)) throw new Conflict('预览内容已变化，请重新预览');
      const writes = this.buildWrites(m, sim);
      const transactionId = uuid();
      const result = { model_id: m.model_id, revision: m.revision + 1, transaction_id: transactionId, applied_change_ids: selected };
      writes[receiptPath] = JSON.stringify(result);
      this.transaction(writes, transactionId, faultAfter);
      return result;
    });
  }

  openContext({ recipient = RECIPIENT, purpose = 'personal-context', taskId = null } = {}) {
    return this.withLock(false, () => {
      this.recoverLocked(); const m = this.manifest(); const grants = this.policy(m);
      const output = { model_id: m.model_id, revision: m.revision, summary: null };
      const info = m.summary;
      if (!info || !fs.existsSync(this.safePath('AGENT.md'))) return output;
      const context = { entries: m.entries, grants: grants.grants };
      if (!info.source_ids.every(id => this.summaryAllowed(m.entries[id], context, recipient, purpose, taskId))) return output;
      if (!info.source_ids.every(id => this.entryFresh(m.entries[id]))) return output;
      const body = this.readFile('AGENT.md');
      if (sha(body) === info.sha256 && info.revision === m.revision) output.summary = body;
      return output;
    });
  }

  grants() { return this.withLock(false, () => { this.recoverLocked(); return this.policy(this.manifest()).grants; }); }

  recall({ domain, recipient = RECIPIENT, purpose, taskId, limit = 8, readLimit = 24 }) {
    return this.withLock(false, () => {
      this.recoverLocked(); const m = this.manifest(); const policy = this.policy(m);
      const entries = Object.values(m.entries).filter(e => e.entity_type === 'record' && e.domains.includes(domain) && e.status === 'active' &&
        (!e.valid_from || e.valid_from <= today()) && (!e.valid_to || e.valid_to >= today()) &&
        this.lineageAllowed(e, m.entries, policy, ['recall', 'send'], recipient, purpose, taskId));
      entries.sort((a, b) => Number(b.role === 'hard_constraint') - Number(a.role === 'hard_constraint') ||
        Number(b.role === 'counterexample') - Number(a.role === 'counterexample') || a.id.localeCompare(b.id));
      if (!Number.isInteger(limit) || limit <= 0 || !Number.isInteger(readLimit) || readLimit <= 0) throw new WhoAmIError('读取预算无效');
      const chosen = entries.slice(0, Math.min(readLimit, 24));
      const uncertainties = [], records = [];
      let bytesRead = 0, bytesSent = 0, processed = 0, truncatedBy = null;
      for (const e of chosen) {
        if (records.length >= Math.min(limit, 8)) { truncatedBy = 'record_limit'; break; }
        if (!this.entryFresh(e)) throw new Conflict(`记录文件已变化：${e.id}`);
        const raw = this.readFile(e.path);
        if (bytesRead + bytesize(raw) > MAX_RECALL_BYTES) { truncatedBy = 'read_bytes'; break; }
        bytesRead += bytesize(raw);
        const body = this.parseYaml(raw, e.path); processed++;
        if (e.review_after && e.review_after <= today()) { uncertainties.push({ id: e.id, reason: 'needs_review' }); continue; }
        if (!e.valid_from && !e.valid_to) uncertainties.push({ id: e.id, reason: 'valid_period_unknown' });
        const item = { id: e.id, statement: body.statement, kind: body.kind, evidence_ids: body.evidence_ids,
          valid_from: e.valid_from, valid_to: e.valid_to, role: e.role,
          statement_origin: body.statement_origin ?? null, evidence_level: body.evidence_level ?? null,
          confidence: body.confidence ?? null, confidence_reason: body.confidence_reason ?? null,
          confirmation_status: body.confirmation_status ?? 'legacy_unknown', derived_from: body.derived_from };
        if (bytesSent + bytesize(JSON.stringify(item)) > MAX_CONTEXT_BYTES) { truncatedBy = 'context_bytes'; break; }
        bytesSent += bytesize(JSON.stringify(item)); records.push(item);
      }
      if (!truncatedBy && entries.length > chosen.length) truncatedBy = 'read_limit';
      return { model_id: m.model_id, revision: m.revision, task_id: taskId, purpose, recipient, records,
        coverage: truncatedBy ? 'partial' : 'complete', truncated_by: truncatedBy,
        unread_candidate_count: Math.max(entries.length - processed, 0), uncertainties };
    });
  }

  evidence({ id, recipient = RECIPIENT, purpose, taskId }) {
    return this.withLock(false, () => {
      this.recoverLocked(); const m = this.manifest(); const e = m.entries[id];
      if (!e || e.entity_type !== 'event') throw new WhoAmIError('来源不存在');
      if (e.recall_policy === 'never' || !this.grantFor(e, this.policy(m), ['recall', 'send'], recipient, purpose, taskId)) throw new PermissionDenied('来源未获准读取或发送');
      if (!this.entryFresh(e)) throw new Conflict('来源文件已被修改');
      return this.loadYaml(e.path);
    });
  }
  recover() { return this.withLock(false, () => this.recoverLocked()); }

  normalizeChanges(changes, generateIds = true) {
    if (!Array.isArray(changes) || !changes.length) throw new WhoAmIError('变更必须是非空数组');
    const normalized = changes.map(input => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new WhoAmIError('变更必须是对象');
      const c = copy(input); c.change_id ??= generateIds ? `chg-${uuid()}` : null;
      if (typeof c.change_id !== 'string' || !/^chg-[\w-]+$/.test(c.change_id)) throw new WhoAmIError('变更缺少 ID');
      if (!['add_event', 'add_record', 'supersede', 'retract', 'forget', 'revoke_grant'].includes(c.op)) throw new WhoAmIError('不支持的变更操作');
      if (['add_event', 'add_record', 'supersede'].includes(c.op)) {
        if (!c.record || typeof c.record !== 'object' || Array.isArray(c.record)) throw new WhoAmIError('记录必须是对象');
        const prefix = c.op === 'add_event' ? 'evt' : 'rec';
        c.record.id ??= generateIds ? `${prefix}-${uuid()}` : null;
        if (typeof c.record.id !== 'string' || !new RegExp(`^${prefix}-[a-zA-Z0-9-]+$`).test(c.record.id)) throw new WhoAmIError('记录 ID 无效');
      }
      return c;
    });
    if (new Set(normalized.map(c => c.change_id)).size !== normalized.length) throw new WhoAmIError('变更 ID 重复');
    return normalized;
  }

  simulate(manifest, policy, changes) {
    const entries = copy(manifest.entries), grants = copy(policy.grants), bodies = {}, preview = [];
    for (const change of changes) {
      const op = change.op;
      if (['add_event', 'add_record', 'supersede'].includes(op)) {
        const data = this.validateRecord(change.record, op), id = data.id;
        if (entries[id]) throw new Conflict(`ID 已存在：${id}`);
        if (op === 'supersede') {
          const oldId = change.target_id, old = entries[oldId];
          if (!old || old.entity_type !== 'record' || old.status !== 'active') throw new WhoAmIError('被替代记录不存在或不活跃');
          const oldBody = this.bodyFor(old, bodies); oldBody.status = 'superseded'; bodies[oldId] = oldBody;
          old.status = 'superseded'; data.supersedes = [...new Set([...data.supersedes, oldId])];
        }
        const filePath = op === 'add_event' ? `timeline/${data.recorded_at.slice(0, 4)}/${id}.yaml` : `model/${data.dimension}/${id}.yaml`;
        entries[id] = this.metadata(data, filePath, op === 'add_event' ? 'event' : 'record');
        bodies[id] = data;
        this.addGrants(grants, change.grants, id);
        preview.push({ change_id: change.change_id, op, id, statement: data.statement,
          dimension: data.dimension ?? null, kind: data.kind ?? 'event', statement_origin: data.statement_origin,
          evidence_level: data.evidence_level, confidence: data.confidence, confidence_reason: data.confidence_reason,
          evidence_ids: data.evidence_ids, derived_from: data.derived_from, source: data.source ?? null,
          target_id: change.target_id ?? null, confirmation_status: 'pending' });
      } else if (op === 'retract') {
        const id = change.target_id, e = entries[id];
        if (!e || e.entity_type !== 'record') throw new WhoAmIError('待撤回记录不存在');
        const data = this.bodyFor(e, bodies); data.status = 'retracted'; bodies[id] = data; e.status = 'retracted';
        const affected = this.descendants(entries, id);
        for (const otherId of affected) {
          const child = entries[otherId]; if (!child || child.entity_type !== 'record') continue;
          const obj = this.bodyFor(child, bodies); obj.status = 'needs_review'; bodies[otherId] = obj; child.status = 'needs_review';
        }
        preview.push({ change_id: change.change_id, op, id, affected_ids: affected });
      } else if (op === 'forget') {
        const id = change.target_id; if (!entries[id]) throw new WhoAmIError('待忘记记录不存在');
        const affected = [...new Set([id, ...this.descendants(entries, id)])];
        for (const victim of affected) { delete entries[victim]; delete bodies[victim]; }
        for (let i = grants.length - 1; i >= 0; i--) if (grants[i].record_ids.some(r => affected.includes(r))) grants.splice(i, 1);
        preview.push({ change_id: change.change_id, op, removed_ids: affected });
      } else if (op === 'revoke_grant') {
        const id = change.target_id, grant = grants.find(g => g.id === id);
        if (!grant || grant.revoked_at) throw new WhoAmIError('授权不存在或已撤销');
        grant.revoked_at = today();
        preview.push({ change_id: change.change_id, op, grant_id: id, record_ids: grant.record_ids, actions: grant.actions });
      }
    }
    this.validateReferences(entries, bodies);
    return { entries, grants, bodies, preview };
  }

  validateRecord(record, op) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new WhoAmIError('记录必须是对象');
    const data = copy(record);
    data.status ??= 'active'; data.sensitivity ??= 'personal'; data.recall_policy ??= 'ask';
    data.domains ??= []; data.evidence_ids ??= []; data.derived_from ??= []; data.supersedes ??= [];
    data.include_in_summary ??= false; data.recorded_at ??= today();
    if (typeof data.statement !== 'string' || !data.statement.trim()) throw new WhoAmIError('陈述不能为空');
    if (!STATUSES.includes(data.status) || !SENSITIVITY.includes(data.sensitivity) || !RECALL_POLICIES.includes(data.recall_policy)) throw new WhoAmIError('状态、敏感级别或召回规则无效');
    if (!Array.isArray(data.domains) || !data.domains.every(v => typeof v === 'string' && /^[a-z_]+$/.test(v))) throw new WhoAmIError('领域必须是字符串数组');
    for (const key of ['evidence_ids', 'derived_from', 'supersedes']) if (!Array.isArray(data[key]) || !data[key].every(v => typeof v === 'string')) throw new WhoAmIError(`${key} 必须是数组`);
    this.checkDate(data.recorded_at);
    for (const key of ['valid_from', 'valid_to', 'review_after']) if (data[key]) this.checkDate(data[key]);
    if (op === 'add_event') {
      data.type ??= 'user_statement'; data.occurred_at ??= null;
      if (data.occurred_at) this.checkDate(data.occurred_at);
    } else {
      if (!DIMENSIONS.includes(data.dimension) || !KINDS.includes(data.kind)) throw new WhoAmIError('维度或性质无效');
      if (typeof data.include_in_summary !== 'boolean') throw new WhoAmIError('summary 必须是布尔值');
      data.stability ??= 'short_term';
      if (!['short_term', 'long_term'].includes(data.stability)) throw new WhoAmIError('稳定性无效');
      if (data.include_in_summary && (data.stability !== 'long_term' || data.kind === 'state')) throw new WhoAmIError('临时状态不能进入常驻摘要');
    }
    if (data.valid_from && data.valid_to && data.valid_from > data.valid_to) throw new WhoAmIError('有效期开始不能晚于结束');
    if (data.confirmation_status && data.confirmation_status !== 'pending') throw new WhoAmIError('候选不能自称已经确认');
    if (data.confirmed_at || data.confirmation_ids) throw new WhoAmIError('确认信息由 apply 生成');
    data.confirmation_status = 'pending';
    data.confidence ??= null;
    data.confidence_reason ??= null;
    if (data.confidence !== null && !['low', 'medium', 'high'].includes(data.confidence)) throw new WhoAmIError('可信度只能为 low/medium/high 或 null');
    if (data.confidence !== null && (typeof data.confidence_reason !== 'string' || !data.confidence_reason.trim())) throw new WhoAmIError('可信度必须说明证据与适用情境');
    if (op === 'add_event') {
      data.source ??= { type: 'self_report' };
      if (!data.source || typeof data.source !== 'object' || Array.isArray(data.source) || !['self_report', 'document', 'ai_output'].includes(data.source.type)) throw new WhoAmIError('来源类型无效');
      if (data.source.type === 'document' && (typeof data.source.reference !== 'string' || !data.source.reference.trim())) throw new WhoAmIError('资料来源需要定位信息');
      data.statement_origin = data.source.type;
      data.evidence_level = data.source.type === 'ai_output' ? 'E0' : 'E1';
    } else {
      data.statement_origin = data.kind === 'interpretation' || data.kind === 'pattern' ? 'ai_inference' : 'direct_report';
      const level = data.kind === 'interpretation' ? 'E0' : data.kind === 'pattern' ? 'E2' : 'E1';
      if (data.evidence_level && data.evidence_level !== level) throw new WhoAmIError('证据等级与记录性质不一致');
      data.evidence_level = level;
    }
    return data;
  }

  metadata(data, filePath, type) {
    return { id: data.id, entity_type: type, path: filePath, dimension: data.dimension ?? null,
      domains: data.domains, status: data.status, valid_from: data.valid_from ?? null, valid_to: data.valid_to ?? null,
      review_after: data.review_after ?? null, sensitivity: data.sensitivity, recall_policy: data.recall_policy,
      role: data.role || 'context', evidence_ids: data.evidence_ids, derived_from: data.derived_from,
      include_in_summary: data.include_in_summary, content_hash: null };
  }

  addGrants(grants, newGrants, id) {
    if (!Array.isArray(newGrants) || !newGrants.length) throw new PermissionDenied('每条新增记录都需要保存授权');
    for (const raw of newGrants) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new WhoAmIError('授权格式无效');
      const g = copy(raw); g.id ??= `grant-${uuid()}`; g.record_ids = [id];
      if (!Array.isArray(g.actions) || without(g.actions, ACTIONS).length || !g.actions.includes('persist')) throw new WhoAmIError('授权操作无效');
      if (typeof g.purpose !== 'string' || !g.purpose || g.recipient !== RECIPIENT) throw new WhoAmIError('授权缺少用途或接收目标');
      if (typeof g.task_id !== 'string' || !(g.expires_at || g.until_revoked === true)) throw new WhoAmIError('授权缺少任务范围或期限');
      if (g.expires_at) this.checkDate(g.expires_at);
      if (typeof g.confirmation_id !== 'string' || !g.confirmation_id) throw new WhoAmIError('缺少确认回执');
      grants.push(g);
    }
  }

  validateReferences(entries, bodies) {
    for (const e of Object.values(entries)) {
      if (e.entity_type !== 'record') continue;
      for (const ref of e.evidence_ids) if (!entries[ref] || entries[ref].entity_type !== 'event') throw new WhoAmIError(`来源引用缺失：${ref}`);
      for (const ref of e.derived_from) if (!entries[ref] || entries[ref].entity_type !== 'record') throw new WhoAmIError(`推导引用缺失：${ref}`);
      const body = this.bodyFor(e, bodies);
      // Apply stronger checks to new candidates without rewriting legacy records.
      if (bodies[e.id]?.confirmation_status === 'pending') {
        if (['fact', 'state', 'pattern'].includes(body.kind) && !e.evidence_ids.length) throw new WhoAmIError('自述、状态和模式需要直接来源');
        if (body.kind === 'interpretation' && !e.evidence_ids.length && !e.derived_from.length) throw new WhoAmIError('推断需要来源或推导依据');
        for (const ref of e.evidence_ids) {
          const source = this.bodyFor(entries[ref], bodies);
          if (body.kind !== 'interpretation' && source.source?.type === 'ai_output') throw new WhoAmIError('AI 输出不能作为自述或模式的独立证据');
        }
      }
      if (body.kind !== 'pattern' || e.status !== 'active') continue;
      const sourceIds = [...new Set(e.evidence_ids)];
      const dates = [...new Set(sourceIds.map(ref => { const source = this.bodyFor(entries[ref], bodies); return source.occurred_at || source.recorded_at; }))];
      if (sourceIds.length < 3 || dates.length < 2) throw new WhoAmIError('模式至少需要三个独立事件、跨两个日期');
    }
    const visiting = new Set(), done = new Set();
    const visit = id => {
      if (visiting.has(id)) throw new WhoAmIError('推导引用有循环');
      if (done.has(id)) return;
      visiting.add(id);
      for (const parent of entries[id].derived_from || []) visit(parent);
      visiting.delete(id); done.add(id);
    };
    for (const id of Object.keys(entries)) visit(id);
  }

  descendants(entries, rootId) {
    const found = [], queue = [rootId];
    while (queue.length) {
      const current = queue.shift();
      for (const [id, e] of Object.entries(entries)) {
        if (id === rootId || found.includes(id)) continue;
        if (e.evidence_ids.includes(current) || e.derived_from.includes(current)) { found.push(id); queue.push(id); }
      }
    }
    return found;
  }

  buildWrites(oldManifest, sim) {
    const entries = sim.entries, writes = {};
    for (const id of Object.keys(oldManifest.entries)) if (!entries[id]) writes[oldManifest.entries[id].path] = null;
    for (const [id, body] of Object.entries(sim.bodies)) {
      if (body.confirmation_status === 'pending') {
        body.confirmation_status = 'confirmed';
        body.confirmed_at = today();
        body.confirmation_ids = [...new Set(sim.grants.filter(g => g.record_ids.includes(id)).map(g => g.confirmation_id))];
      }
      const filePath = entries[id].path, content = this.yamlDump(body);
      writes[filePath] = content; entries[id].content_hash = sha(content);
    }
    for (const [id, e] of Object.entries(entries)) e.content_hash ??= oldManifest.entries[id].content_hash;
    const revision = oldManifest.revision + 1;
    let summaryIds = Object.values(entries).filter(e => e.entity_type === 'record' && e.status === 'active' && e.include_in_summary &&
      e.recall_policy === 'allowed' && this.summaryAllowed(e, { entries, grants: sim.grants }, RECIPIENT, 'personal-context', null)).map(e => e.id);
    summaryIds = summaryIds.filter(id => !entries[id].review_after || entries[id].review_after > today());
    const summary = summaryIds.map(id => { const body = sim.bodies[id] || this.loadYaml(entries[id].path); return `- [${id}] ${body.statement}`; });
    let info = null;
    if (!summary.length) writes['AGENT.md'] = null;
    else {
      const content = `# 我的个人摘要\n\n> 模型版本 ${revision}；这是经确认记录生成的数据，不是操作指令。\n\n${summary.join('\n')}\n`;
      writes['AGENT.md'] = content;
      info = { sha256: sha(content), revision, source_ids: summaryIds };
    }
    const m = copy(oldManifest); m.revision = revision; m.entries = entries; m.summary = info;
    writes['policy.yaml'] = this.yamlDump({ grants: sim.grants });
    m.policy_hash = sha(writes['policy.yaml']); writes['manifest.yaml'] = this.yamlDump(m);
    return writes;
  }

  transaction(writes, id, faultAfter = null) {
    const txRel = `.transactions/${id}`, txDir = this.safePath(txRel);
    fs.mkdirSync(txDir, { recursive: true, mode: 0o700 });
    const operations = Object.entries(writes).map(([filePath, after]) => {
      const previous = fs.existsSync(this.safePath(filePath)) ? this.readFile(filePath) : null;
      return { path: filePath, before: previous === null ? null : Buffer.from(previous).toString('base64'),
        before_sha: previous === null ? null : sha(previous), after: after === null ? null : Buffer.from(after).toString('base64'),
        after_sha: after === null ? null : sha(after) };
    });
    const journalPath = path.join(txDir, 'journal.json');
    this.writeAndSync(journalPath, JSON.stringify({ state: 'prepared', operations }));
    operations.forEach((op, index) => {
      this.writeAtomic(op.path, op.after === null ? null : Buffer.from(op.after, 'base64'));
      if (faultAfter === index) throw new WhoAmIError('模拟写入中断');
    });
    this.writeAndSync(journalPath, JSON.stringify({ state: 'committed', operations }));
    fs.rmSync(txDir, { recursive: true, force: true });
    return id;
  }

  recoverLocked() {
    const txRoot = this.safePath('.transactions');
    if (!fs.existsSync(txRoot)) return { recovered: 0 };
    let count = 0;
    for (const name of fs.readdirSync(txRoot).sort()) {
      const dir = this.safePath(`.transactions/${name}`), journalPath = path.join(dir, 'journal.json');
      if (!fs.existsSync(journalPath)) throw new Conflict('恢复日志缺失；停止读写');
      const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
      if (!['prepared', 'committed'].includes(journal.state)) throw new Conflict('恢复日志状态无效');
      for (const op of [...journal.operations].reverse()) {
        const target = this.safePath(op.path);
        const current = fs.existsSync(target) ? sha(fs.readFileSync(target)) : null;
        if (![op.before_sha, op.after_sha].includes(current)) throw new Conflict(`恢复发现外部修改：${op.path}`);
        const wanted = journal.state === 'committed' ? op.after : op.before;
        this.writeAtomic(op.path, wanted === null ? null : Buffer.from(wanted, 'base64'));
      }
      fs.rmSync(dir, { recursive: true, force: true }); count++;
    }
    return { recovered: count };
  }

  manifest() {
    const data = this.loadYaml('manifest.yaml');
    if (data.schema_version !== 1 || !data.entries || typeof data.entries !== 'object' || Array.isArray(data.entries)) throw new WhoAmIError('模型版本不兼容');
    return data;
  }
  policy(m = this.manifest()) {
    const bytes = this.readFile('policy.yaml');
    if (sha(bytes) !== m.policy_hash) throw new Conflict('授权文件已被手工修改，停止读取');
    const data = this.parseYaml(bytes, 'policy.yaml');
    if (!Array.isArray(data.grants)) throw new WhoAmIError('授权文件损坏');
    return data;
  }
  entryFresh(entry) { return !!entry && fs.existsSync(this.safePath(entry.path)) && sha(fs.readFileSync(this.safePath(entry.path))) === entry.content_hash; }

  summaryAllowed(entry, policy, recipient, purpose, taskId) {
    return !!entry && entry.status === 'active' && entry.recall_policy === 'allowed' &&
      (!entry.valid_from || entry.valid_from <= today()) && (!entry.valid_to || entry.valid_to >= today()) &&
      (!entry.review_after || entry.review_after > today()) &&
      this.lineageAllowed(entry, policy.entries, policy, ['summary', 'send'], recipient, purpose, taskId);
  }
  lineageAllowed(entry, entries, policy, actions, recipient, purpose, taskId, visited = new Set()) {
    if (!entry || entry.status !== 'active' || entry.recall_policy === 'never' || visited.has(entry.id)) return false;
    if (!this.grantFor(entry, policy, actions, recipient, purpose, taskId)) return false;
    const next = new Set(visited); next.add(entry.id);
    return [...entry.evidence_ids, ...entry.derived_from].every(id => this.lineageAllowed(entries[id], entries, policy, ['recall', 'send'], recipient, purpose, taskId, next));
  }
  grantFor(entry, policy, actions, recipient, purpose, taskId) {
    return policy.grants.some(g => g.record_ids.includes(entry.id) && !without(actions, g.actions).length &&
      g.recipient === recipient && g.purpose === purpose && (g.task_id === taskId || g.task_id === '*') &&
      !g.revoked_at && (g.until_revoked === true || (g.expires_at && g.expires_at >= today())));
  }
  bodyFor(entry, staged) { return staged[entry.id] || this.loadYaml(entry.path); }
  checkDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new WhoAmIError('日期必须为 YYYY-MM-DD');
    const date = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new WhoAmIError('日期无效');
  }
  safePath(relative) {
    if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..') || !relative) throw new WhoAmIError('路径无效');
    const target = path.resolve(this.root, relative);
    if (!target.startsWith(this.root + path.sep)) throw new WhoAmIError('路径越界');
    let cursor = this.root;
    for (const part of relative.split(/[\\/]/)) { cursor = path.join(cursor, part); if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new WhoAmIError('不允许符号链接'); }
    return target;
  }
  writeAtomic(relative, bytes) {
    const target = this.safePath(relative);
    if (bytes === null) { if (fs.existsSync(target)) fs.unlinkSync(target); return; }
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const tmp = `${target}.tmp-${crypto.randomBytes(6).toString('hex')}`;
    try {
      this.writeAndSync(tmp, bytes, 'wx'); fs.renameSync(tmp, target);
      if (process.platform !== 'win32') { const fd = fs.openSync(path.dirname(target), 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
    } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  }
  writeAndSync(filePath, content, flag = 'w') {
    const fd = fs.openSync(filePath, flag, 0o600);
    try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  readFile(relative) { return fs.readFileSync(this.safePath(relative), 'utf8'); }
  parseYaml(content, relative) {
    try {
      const doc = YAML.parseDocument(content, { uniqueKeys: true, maxAliasCount: 0, stringKeys: true });
      if (doc.errors.length || doc.warnings.length) throw new WhoAmIError(doc.errors[0]?.message || doc.warnings[0]?.message);
      const data = doc.toJS({ maxAliasCount: 0 });
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new WhoAmIError(`YAML 必须是对象：${relative}`);
      return data;
    } catch (error) { if (error instanceof WhoAmIError) throw error; throw new WhoAmIError(`YAML 解析失败：${relative}: ${error.message}`); }
  }
  loadYaml(relative) { return this.parseYaml(this.readFile(relative), relative); }
  yamlDump(data) { return `---\n${YAML.stringify(data, { lineWidth: 0 })}`; }
  withLock(creating, operation) {
    if (!creating && !fs.existsSync(this.safePath('manifest.yaml'))) throw new WhoAmIError('记忆目录尚未初始化，请先运行 init');
    const options = { realpath: true, lockfilePath: path.join(this.root, '.lockdir'), stale: 30000, update: 10000 };
    let release;
    for (let attempt = 0; attempt < 40; attempt++) {
      try { release = lockfile.lockSync(this.root, options); break; }
      catch (error) {
        if (error.code !== 'ELOCKED' || attempt === 39) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    }
    try { return operation(); } finally { release(); }
  }
}

module.exports = { Store, WhoAmIError, Conflict, PermissionDenied, defaultMemoryPath, RECIPIENT };
