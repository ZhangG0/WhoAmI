# frozen_string_literal: true

require 'yaml'
require 'json'
require 'digest'
require 'securerandom'
require 'fileutils'
require 'date'
require 'base64'

module WhoAmIOS
  class Error < StandardError; end
  class Conflict < Error; end
  class PermissionDenied < Error; end

  DIMENSIONS = %w[identity experiences values goals preferences decisions patterns relationships synthesis].freeze
  KINDS = %w[fact state interpretation pattern].freeze
  STATUSES = %w[active needs_review disputed superseded retracted].freeze
  SENSITIVITY = %w[ordinary personal sensitive].freeze
  RECALL_POLICIES = %w[allowed ask never].freeze
  ACTIONS = %w[persist recall send summary maintain].freeze
  RECIPIENT = 'codex-local'
  MAX_RECALL_BYTES = 64 * 1024
  MAX_CONTEXT_BYTES = 8 * 1024

  class Store
    attr_reader :root

    def initialize(root)
      @root = File.expand_path(root)
    end

    def init!
      raise Conflict, '目录已有内容，不能初始化覆盖' if File.exist?(@root) && !Dir.empty?(@root)
      FileUtils.mkdir_p(@root, mode: 0o700)
      lock do
        policy_bytes = yaml_dump({ 'grants' => [] })
        write_atomic('manifest.yaml', yaml_dump({ 'schema_version' => 1, 'model_id' => SecureRandom.uuid,
                                                    'revision' => 0, 'entries' => {}, 'summary' => nil,
                                                    'policy_hash' => sha(policy_bytes) }))
        write_atomic('policy.yaml', policy_bytes)
        write_atomic('.gitignore', ".transactions/\n.receipts/\n.lock\n")
      end
      status
    end

    def status
      lock do
        recover_locked!
        m = manifest
        policy
        { 'model_id' => m.fetch('model_id'), 'revision' => m.fetch('revision'),
          'record_count' => m.fetch('entries').size }
      end
    end

    def prepare(changes, selected_ids: nil)
      lock do
        recover_locked!
        m = manifest
        normalized = normalize_changes(changes)
        selected = selected_ids || normalized.map { |c| c.fetch('change_id') }
        raise Error, '选择的变更 ID 无效' unless (selected - normalized.map { |c| c['change_id'] }).empty?
        simulation = simulate(m, policy, normalized.select { |c| selected.include?(c['change_id']) })
        proposal = { 'model_id' => m.fetch('model_id'), 'base_revision' => m.fetch('revision'),
                     'manifest_hash' => sha(read_file('manifest.yaml')),
                     'changes' => normalized, 'selected_change_ids' => selected,
                     'preview' => simulation.fetch(:preview) }
        proposal['patch_hash'] = sha(JSON.generate(proposal))
        proposal
      end
    end

    def apply!(proposal, approval_hash:, fault_after: nil)
      lock do
        recover_locked!
        raise PermissionDenied, '必须确认当前预览摘要后才能保存' unless approval_hash == proposal['patch_hash']
        receipt_path = ".receipts/#{proposal['patch_hash']}.json"
        return JSON.parse(read_file(receipt_path)) if File.file?(safe_path(receipt_path))
        m = manifest
        raise Conflict, '模型或修订号已变化，请重新预览' unless proposal['model_id'] == m['model_id'] && proposal['base_revision'] == m['revision']
        raise Conflict, '源文件已变化，请重新预览' unless proposal['manifest_hash'] == sha(read_file('manifest.yaml'))
        m.fetch('entries').each_value do |entry|
          raise Conflict, "记录文件已变化：#{entry['id']}" unless entry_fresh?(entry)
        end
        check = proposal.reject { |k, _| k == 'patch_hash' }
        raise Error, '预览摘要不匹配' unless sha(JSON.generate(check)) == proposal['patch_hash']
        selected = proposal.fetch('selected_change_ids')
        normalized = normalize_changes(proposal.fetch('changes'), generate_ids: false)
        raise Error, '未选择任何变更' if selected.empty?
        raise Error, '变更 ID 无效或重复' unless selected.uniq == selected && (selected - normalized.map { |c| c['change_id'] }).empty?
        simulation = simulate(m, policy, normalized.select { |c| selected.include?(c['change_id']) })
        raise Conflict, '预览内容已变化，请重新预览' unless simulation.fetch(:preview) == proposal['preview']
        writes = build_writes(m, simulation)
        id = SecureRandom.uuid
        result = { 'model_id' => m['model_id'], 'revision' => m['revision'] + 1,
                   'transaction_id' => id, 'applied_change_ids' => selected }
        writes[receipt_path] = JSON.generate(result)
        transaction!(writes, transaction_id: id, fault_after: fault_after)
        result
      end
    end

    def open_context(recipient: RECIPIENT, purpose: 'personal-context', task_id: nil)
      lock do
        recover_locked!
        m = manifest
        grants = policy
        output = { 'model_id' => m['model_id'], 'revision' => m['revision'], 'summary' => nil }
        info = m['summary']
        return output unless info && File.file?(safe_path('AGENT.md'))
        return output unless info.fetch('source_ids').all? { |id| summary_allowed?(m['entries'][id], grants.merge('entries' => m['entries']), recipient, purpose, task_id) }
        return output unless info.fetch('source_ids').all? { |id| entry_fresh?(m['entries'][id]) }
        body = read_file('AGENT.md')
        output['summary'] = body.force_encoding(Encoding::UTF_8) if sha(body) == info['sha256'] && info['revision'] == m['revision']
        output
      end
    end

    def grants
      lock do
        recover_locked!
        policy.fetch('grants')
      end
    end

    def recall(domain:, recipient: RECIPIENT, purpose:, task_id:, limit: 8, read_limit: 24)
      lock do
        recover_locked!
        m = manifest
        grants = policy
        entries = m.fetch('entries').values.select do |e|
          e['entity_type'] == 'record' && e['domains'].include?(domain) && e['status'] == 'active' &&
            (!e['valid_from'] || Date.parse(e['valid_from']) <= Date.today) &&
            (!e['valid_to'] || Date.parse(e['valid_to']) >= Date.today) &&
            lineage_allowed?(e, m['entries'], grants, %w[recall send], recipient, purpose, task_id)
        end
        entries.sort_by! { |e| [e['role'] == 'hard_constraint' ? 0 : 1, e['role'] == 'counterexample' ? 0 : 1, e['id']] }
        raise Error, '读取预算无效' unless limit.is_a?(Integer) && limit.positive? && read_limit.is_a?(Integer) && read_limit.positive?
        chosen = entries.first([read_limit, 24].min)
        uncertainties = []
        records = []
        bytes_read = 0
        bytes_sent = 0
        processed = 0
        truncated_by = nil
        chosen.each do |e|
          if records.size >= [limit, 8].min
            truncated_by = 'record_limit'
            break
          end
          raise Conflict, "记录文件已变化：#{e['id']}" unless entry_fresh?(e)
          raw = read_file(e['path'])
          if bytes_read + raw.bytesize > MAX_RECALL_BYTES
            truncated_by = 'read_bytes'
            break
          end
          bytes_read += raw.bytesize
          body = YAML.safe_load(raw, permitted_classes: [], permitted_symbols: [], aliases: false)
          raise Error, '记录正文格式无效' unless body.is_a?(Hash)
          processed += 1
          if e['review_after'] && Date.parse(e['review_after']) <= Date.today
            uncertainties << { 'id' => e['id'], 'reason' => 'needs_review' }
            next
          end
          uncertainties << { 'id' => e['id'], 'reason' => 'valid_period_unknown' } unless e['valid_from'] || e['valid_to']
          item = { 'id' => e['id'], 'statement' => body['statement'], 'kind' => body['kind'],
                   'evidence_ids' => body['evidence_ids'], 'valid_from' => e['valid_from'],
                   'valid_to' => e['valid_to'], 'role' => e['role'] }
          if bytes_sent + JSON.generate(item).bytesize > MAX_CONTEXT_BYTES
            truncated_by = 'context_bytes'
            break
          end
          bytes_sent += JSON.generate(item).bytesize
          records << item
        end
        truncated_by ||= 'read_limit' if entries.size > chosen.size
        { 'model_id' => m['model_id'], 'revision' => m['revision'], 'task_id' => task_id,
          'purpose' => purpose, 'recipient' => recipient, 'records' => records,
          'coverage' => truncated_by ? 'partial' : 'complete', 'truncated_by' => truncated_by,
          'unread_candidate_count' => [entries.size - processed, 0].max,
          'uncertainties' => uncertainties }
      end
    end

    def evidence(id:, recipient: RECIPIENT, purpose:, task_id:)
      lock do
        recover_locked!
        m = manifest
        e = m['entries'][id]
        raise Error, '来源不存在' unless e && e['entity_type'] == 'event'
        raise PermissionDenied, '来源未获准读取或发送' unless e['recall_policy'] != 'never' && grant_for?(e, policy, %w[recall send], recipient, purpose, task_id)
        raise Conflict, '来源文件已被修改' unless entry_fresh?(e)
        load_yaml(e['path'])
      end
    end

    def recover!
      lock { recover_locked! }
    end

    private

    def normalize_changes(changes, generate_ids: true)
      raise Error, '变更必须是非空数组' unless changes.is_a?(Array) && !changes.empty?
      normalized = changes.map do |input|
        raise Error, '变更必须是对象' unless input.is_a?(Hash)
        change = input.dup
        change['change_id'] ||= (generate_ids ? "chg-#{SecureRandom.uuid}" : nil)
        raise Error, '变更缺少 ID' unless change['change_id'].is_a?(String) && change['change_id'].match?(/\Achg-[\w-]+\z/)
        raise Error, '不支持的变更操作' unless %w[add_event add_record supersede retract forget revoke_grant].include?(change['op'])
        if %w[add_event add_record supersede].include?(change['op'])
          record = change.fetch('record').dup
          prefix = change['op'] == 'add_event' ? 'evt' : 'rec'
          record['id'] ||= (generate_ids ? "#{prefix}-#{SecureRandom.uuid}" : nil)
          raise Error, '记录 ID 无效' unless record['id'].is_a?(String) && record['id'].match?(/\A#{prefix}-[a-zA-Z0-9-]+\z/)
          change['record'] = record
        end
        change
      end
      raise Error, '变更 ID 重复' unless normalized.map { |c| c['change_id'] }.uniq.size == normalized.size
      normalized
    end

    def simulate(manifest_data, policy_data, changes)
      entries = deep_copy(manifest_data.fetch('entries'))
      grants = deep_copy(policy_data.fetch('grants'))
      bodies = {}
      preview = []
      changes.each do |change|
        op = change.fetch('op')
        case op
        when 'add_event', 'add_record', 'supersede'
          data = validate_record(change.fetch('record'), op)
          id = data.fetch('id')
          raise Conflict, "ID 已存在：#{id}" if entries.key?(id)
          if op == 'supersede'
            old_id = change.fetch('target_id')
            old = entries[old_id]
            raise Error, '被替代记录不存在或不活跃' unless old && old['entity_type'] == 'record' && old['status'] == 'active'
            old_body = body_for(old, bodies)
            old_body['status'] = 'superseded'
            bodies[old_id] = old_body
            old['status'] = 'superseded'
            data['supersedes'] = (data['supersedes'] + [old_id]).uniq
          end
          path = op == 'add_event' ? "timeline/#{Date.parse(data['recorded_at']).year}/#{id}.yaml" : "model/#{data['dimension']}/#{id}.yaml"
          entries[id] = metadata(data, path, op == 'add_event' ? 'event' : 'record')
          bodies[id] = data
          add_grants!(grants, change.fetch('grants'), id)
          preview << { 'change_id' => change['change_id'], 'op' => op, 'id' => id, 'statement' => data['statement'] }
        when 'retract'
          id = change.fetch('target_id')
          e = entries[id]
          raise Error, '待撤回记录不存在' unless e && e['entity_type'] == 'record'
          data = body_for(e, bodies); data['status'] = 'retracted'; bodies[id] = data; e['status'] = 'retracted'
          affected = descendants(entries, id)
          affected.each do |other_id|
            child = entries[other_id]
            next unless child && child['entity_type'] == 'record'
            obj = body_for(child, bodies); obj['status'] = 'needs_review'; bodies[other_id] = obj; child['status'] = 'needs_review'
          end
          preview << { 'change_id' => change['change_id'], 'op' => op, 'id' => id, 'affected_ids' => affected }
        when 'forget'
          id = change.fetch('target_id')
          raise Error, '待忘记记录不存在' unless entries.key?(id)
          affected = ([id] + descendants(entries, id)).uniq
          affected.each { |victim| entries.delete(victim); bodies.delete(victim) }
          grants.reject! { |g| (g['record_ids'] & affected).any? }
          preview << { 'change_id' => change['change_id'], 'op' => op, 'removed_ids' => affected }
        when 'revoke_grant'
          id = change.fetch('target_id')
          grant = grants.find { |g| g['id'] == id }
          raise Error, '授权不存在或已撤销' unless grant && !grant['revoked_at']
          grant['revoked_at'] = Date.today.iso8601
          preview << { 'change_id' => change['change_id'], 'op' => op, 'grant_id' => id,
                       'record_ids' => grant['record_ids'], 'actions' => grant['actions'] }
        end
      end
      validate_references!(entries, bodies)
      { entries: entries, grants: grants, bodies: bodies, preview: preview }
    end

    def validate_record(record, op)
      raise Error, '记录必须是对象' unless record.is_a?(Hash)
      data = deep_copy(record)
      data['status'] ||= 'active';data['sensitivity'] ||= 'personal';data['recall_policy'] ||= 'ask'
      data['domains'] ||= [];data['evidence_ids'] ||= [];data['derived_from'] ||= [];data['supersedes'] ||= []
      data['include_in_summary'] = false unless data.key?('include_in_summary')
      data['recorded_at'] ||= Date.today.iso8601
      raise Error, '陈述不能为空' unless data['statement'].is_a?(String) && !data['statement'].strip.empty?
      raise Error, '状态、敏感级别或召回规则无效' unless STATUSES.include?(data['status']) && SENSITIVITY.include?(data['sensitivity']) && RECALL_POLICIES.include?(data['recall_policy'])
      raise Error, '领域必须是字符串数组' unless data['domains'].is_a?(Array) && data['domains'].all? { |v| v.is_a?(String) && v.match?(/\A[a-z_]+\z/) }
      %w[evidence_ids derived_from supersedes].each { |k| raise Error, "#{k} 必须是数组" unless data[k].is_a?(Array) && data[k].all? { |v| v.is_a?(String) } }
      date!(data['recorded_at']);%w[valid_from valid_to review_after].each { |k| date!(data[k]) if data[k] }
      if op == 'add_event'
        data['type'] ||= 'user_statement'
        data['occurred_at'] ||= nil
        date!(data['occurred_at']) if data['occurred_at']
      else
        raise Error, '维度或性质无效' unless DIMENSIONS.include?(data['dimension']) && KINDS.include?(data['kind'])
        raise Error, 'summary 必须是布尔值' unless [true, false].include?(data['include_in_summary'])
        data['stability'] ||= 'short_term'
        raise Error, '稳定性无效' unless %w[short_term long_term].include?(data['stability'])
        if data['include_in_summary'] && (data['stability'] != 'long_term' || data['kind'] == 'state')
          raise Error, '临时状态不能进入常驻摘要'
        end
      end
      data
    end

    def metadata(data, path, type)
      { 'id' => data['id'], 'entity_type' => type, 'path' => path,
        'dimension' => data['dimension'], 'domains' => data['domains'], 'status' => data['status'],
        'valid_from' => data['valid_from'], 'valid_to' => data['valid_to'],
        'review_after' => data['review_after'], 'sensitivity' => data['sensitivity'],
        'recall_policy' => data['recall_policy'], 'role' => data['role'] || 'context',
        'evidence_ids' => data['evidence_ids'], 'derived_from' => data['derived_from'],
        'include_in_summary' => data['include_in_summary'], 'content_hash' => nil }
    end

    def add_grants!(grants, new_grants, id)
      raise PermissionDenied, '每条新增记录都需要保存授权' unless new_grants.is_a?(Array) && !new_grants.empty?
      new_grants.each do |raw|
        raise Error, '授权格式无效' unless raw.is_a?(Hash)
        g = deep_copy(raw)
        g['id'] ||= "grant-#{SecureRandom.uuid}"
        g['record_ids'] = [id]
        raise Error, '授权操作无效' unless g['actions'].is_a?(Array) && (g['actions'] - ACTIONS).empty? && g['actions'].include?('persist')
        raise Error, '授权缺少用途或接收目标' unless g['purpose'].is_a?(String) && !g['purpose'].empty? && g['recipient'] == RECIPIENT
        raise Error, '授权缺少任务范围或期限' unless g['task_id'].is_a?(String) && (g['expires_at'] || g['until_revoked'] == true)
        date!(g['expires_at']) if g['expires_at']
        raise Error, '缺少确认回执' unless g['confirmation_id'].is_a?(String) && !g['confirmation_id'].empty?
        grants << g
      end
    end

    def validate_references!(entries, bodies)
      entries.each do |id, e|
        next unless e['entity_type'] == 'record'
        e['evidence_ids'].each { |ref| raise Error, "来源引用缺失：#{ref}" unless entries[ref] && entries[ref]['entity_type'] == 'event' }
        e['derived_from'].each { |ref| raise Error, "推导引用缺失：#{ref}" unless entries[ref] && entries[ref]['entity_type'] == 'record' }
        body = body_for(e, bodies)
        next unless body['kind'] == 'pattern' && e['status'] == 'active'
        source_ids = e['evidence_ids'].uniq
        dates = source_ids.map do |ref|
          source = body_for(entries.fetch(ref), bodies)
          source['occurred_at'] || source['recorded_at']
        end.uniq
        raise Error, '模式至少需要三个独立事件、跨两个日期' unless source_ids.size >= 3 && dates.size >= 2
      end
      visiting = {};done = {}
      visit = lambda do |id|
        raise Error, '推导引用有循环' if visiting[id]
        return if done[id]
        visiting[id] = true
        (entries[id]['derived_from'] || []).each { |parent| visit.call(parent) }
        visiting.delete(id);done[id] = true
      end
      entries.each_key { |id| visit.call(id) }
    end

    def descendants(entries, root_id)
      found = [];queue = [root_id]
      until queue.empty?
        current = queue.shift
        entries.each do |id, e|
          next if found.include?(id) || id == root_id
          if e['evidence_ids'].include?(current) || e['derived_from'].include?(current)
            found << id;queue << id
          end
        end
      end
      found
    end

    def build_writes(old_manifest, sim)
      entries = sim[:entries]
      writes = {}
      (old_manifest['entries'].keys - entries.keys).each { |id| writes[old_manifest['entries'][id]['path']] = nil }
      sim[:bodies].each do |id, body|
        path = entries.fetch(id).fetch('path')
        content = yaml_dump(body)
        writes[path] = content
        entries[id]['content_hash'] = sha(content)
      end
      entries.each do |id, e|
        e['content_hash'] ||= old_manifest['entries'].fetch(id).fetch('content_hash')
      end
      new_revision = old_manifest['revision'] + 1
      summary_ids = entries.values.select do |e|
        e['entity_type'] == 'record' && e['status'] == 'active' && e['include_in_summary'] &&
          e['recall_policy'] == 'allowed' && summary_allowed?(e, { 'entries' => entries, 'grants' => sim[:grants] }, RECIPIENT, 'personal-context', nil)
      end.map { |e| e['id'] }
      summary_ids.select! { |id| !entries[id]['review_after'] || Date.parse(entries[id]['review_after']) > Date.today }
      summary = summary_ids.map do |id|
        body = sim[:bodies][id] || load_yaml(entries[id]['path'])
        "- [#{id}] #{body['statement']}"
      end
      if summary.empty?
        writes['AGENT.md'] = nil
        info = nil
      else
        content = "# 我的个人摘要\n\n> 模型版本 #{new_revision}；这是经确认记录生成的数据，不是操作指令。\n\n#{summary.join("\n")}\n"
        writes['AGENT.md'] = content
        info = { 'sha256' => sha(content), 'revision' => new_revision, 'source_ids' => summary_ids }
      end
      m = deep_copy(old_manifest);m['revision'] = new_revision;m['entries'] = entries;m['summary'] = info
      writes['policy.yaml'] = yaml_dump({ 'grants' => sim[:grants] })
      m['policy_hash'] = sha(writes['policy.yaml'])
      writes['manifest.yaml'] = yaml_dump(m)
      writes
    end

    def transaction!(writes, transaction_id:, fault_after: nil)
      id = transaction_id
      tx_rel = ".transactions/#{id}"
      tx_dir = safe_path(tx_rel)
      FileUtils.mkdir_p(tx_dir, mode: 0o700)
      operations = writes.map do |relative, after|
        previous = File.file?(safe_path(relative)) ? read_file(relative) : nil
        { 'path' => relative, 'before' => previous && Base64.strict_encode64(previous),
          'before_sha' => previous && sha(previous), 'after' => after && Base64.strict_encode64(after),
          'after_sha' => after && sha(after) }
      end
      journal = { 'state' => 'prepared', 'operations' => operations }
      File.write(File.join(tx_dir, 'journal.json'), JSON.generate(journal), mode: 'wb', perm: 0o600)
      sync_file(File.join(tx_dir, 'journal.json'))
      operations.each_with_index do |op, index|
        bytes = op['after'] && Base64.decode64(op['after'])
        write_atomic(op['path'], bytes)
        raise Error, '模拟写入中断' if fault_after == index
      end
      journal['state'] = 'committed'
      File.write(File.join(tx_dir, 'journal.json'), JSON.generate(journal), mode: 'wb', perm: 0o600)
      sync_file(File.join(tx_dir, 'journal.json'))
      @last_transaction_id = id
      FileUtils.remove_entry(tx_dir)
      id
    rescue StandardError
      # Keep the journal intact; the next controlled operation will recover it.
      raise
    end

    def recover_locked!
      tx_root = safe_path('.transactions')
      return { 'recovered' => 0 } unless Dir.exist?(tx_root)
      count = 0
      Dir.children(tx_root).sort.each do |name|
        dir = safe_path(".transactions/#{name}")
        journal_path = File.join(dir, 'journal.json')
        raise Conflict, '恢复日志缺失；停止读写' unless File.file?(journal_path)
        journal = JSON.parse(File.read(journal_path))
        raise Conflict, '恢复日志状态无效' unless %w[prepared committed].include?(journal['state'])
        journal.fetch('operations').reverse_each do |op|
          target = safe_path(op.fetch('path'))
          current = File.file?(target) ? sha(File.binread(target)) : nil
          expected = [op['before_sha'], op['after_sha']]
          raise Conflict, "恢复发现外部修改：#{op['path']}" unless expected.include?(current)
          wanted = journal['state'] == 'committed' ? op['after'] : op['before']
          write_atomic(op['path'], wanted && Base64.decode64(wanted))
        end
        FileUtils.remove_entry(dir)
        count += 1
      end
      { 'recovered' => count }
    end

    def manifest
      data = load_yaml('manifest.yaml')
      raise Error, '模型版本不兼容' unless data['schema_version'] == 1 && data['entries'].is_a?(Hash)
      data
    end

    def policy
      bytes = read_file('policy.yaml')
      raise Conflict, '授权文件已被手工修改，停止读取' unless sha(bytes) == manifest['policy_hash']
      data = YAML.safe_load(bytes, permitted_classes: [], permitted_symbols: [], aliases: false)
      raise Error, '授权文件损坏' unless data['grants'].is_a?(Array)
      data
    rescue Psych::Exception => e
      raise Error, "授权文件解析失败：#{e.message}"
    end

    def entry_fresh?(entry)
      path = safe_path(entry['path'])
      File.file?(path) && sha(File.binread(path)) == entry['content_hash']
    end

    def summary_allowed?(entry, policy_data, recipient, purpose, task_id)
      entry && entry['status'] == 'active' && entry['recall_policy'] == 'allowed' &&
        (!entry['valid_from'] || Date.parse(entry['valid_from']) <= Date.today) &&
        (!entry['valid_to'] || Date.parse(entry['valid_to']) >= Date.today) &&
        (!entry['review_after'] || Date.parse(entry['review_after']) > Date.today) &&
        lineage_allowed?(entry, policy_data['entries'], policy_data, %w[summary send], recipient, purpose, task_id)
    end

    def lineage_allowed?(entry, entries, policy_data, actions, recipient, purpose, task_id, visited = {})
      return false unless entry && entry['status'] == 'active' && entry['recall_policy'] != 'never'
      return false if visited[entry['id']]
      return false unless grant_for?(entry, policy_data, actions, recipient, purpose, task_id)
      visited = visited.merge(entry['id'] => true)
      (entry['evidence_ids'] + entry['derived_from']).all? do |id|
        lineage_allowed?(entries[id], entries, policy_data, %w[recall send], recipient, purpose, task_id, visited)
      end
    end

    def grant_for?(entry, policy_data, actions, recipient, purpose, task_id)
      policy_data['grants'].any? do |g|
        g['record_ids'].include?(entry['id']) && (actions - g['actions']).empty? &&
          g['recipient'] == recipient && g['purpose'] == purpose &&
          (g['task_id'] == task_id || g['task_id'] == '*') &&
          !g['revoked_at'] && (g['until_revoked'] == true || (g['expires_at'] && Date.parse(g['expires_at']) >= Date.today))
      end
    end

    def body_for(entry, staged)
      staged[entry['id']] || load_yaml(entry['path'])
    end

    def date!(value)
      raise Error, '日期必须为 YYYY-MM-DD' unless value.is_a?(String) && value.match?(/\A\d{4}-\d{2}-\d{2}\z/) && Date.iso8601(value)
    rescue Date::Error
      raise Error, '日期无效'
    end

    def safe_path(relative)
      raise Error, '路径无效' unless relative.is_a?(String) && !relative.start_with?('/') && !relative.split('/').include?('..')
      path = File.expand_path(relative, @root)
      raise Error, '路径越界' unless path.start_with?(@root + '/')
      cursor = @root
      relative.split('/').each do |part|
        cursor = File.join(cursor, part)
        raise Error, '不允许符号链接' if File.symlink?(cursor)
      end
      path
    end

    def write_atomic(relative, bytes)
      path = safe_path(relative)
      if bytes.nil?
        File.delete(path) if File.exist?(path)
        return
      end
      FileUtils.mkdir_p(File.dirname(path), mode: 0o700)
      tmp = "#{path}.tmp-#{SecureRandom.hex(6)}"
      File.open(tmp, File::WRONLY | File::CREAT | File::EXCL, 0o600) { |f| f.write(bytes); f.flush; f.fsync }
      File.rename(tmp, path)
      File.open(File.dirname(path), 'r') { |dir| dir.fsync }
    ensure
      File.delete(tmp) if tmp && File.exist?(tmp)
    end

    def sync_file(path)
      File.open(path, 'r') { |f| f.fsync }
    end

    def read_file(relative)
      File.binread(safe_path(relative))
    end

    def load_yaml(relative)
      data = YAML.safe_load(read_file(relative), permitted_classes: [], permitted_symbols: [], aliases: false)
      raise Error, "YAML 必须是对象：#{relative}" unless data.is_a?(Hash)
      data
    rescue Psych::Exception => e
      raise Error, "YAML 解析失败：#{relative}: #{e.message}"
    end

    def yaml_dump(data)
      YAML.dump(data)
    end

    def lock
      FileUtils.mkdir_p(@root, mode: 0o700)
      File.open(safe_path('.lock'), File::RDWR | File::CREAT, 0o600) do |f|
        f.flock(File::LOCK_EX)
        yield
      ensure
        f.flock(File::LOCK_UN)
      end
    end

    def sha(bytes)
      Digest::SHA256.hexdigest(bytes)
    end

    def deep_copy(value)
      Marshal.load(Marshal.dump(value))
    end
  end
end
