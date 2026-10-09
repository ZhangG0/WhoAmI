# frozen_string_literal: true

require 'minitest/autorun'
require 'tmpdir'
require 'open3'
require 'rbconfig'
require_relative '../lib/whoami_os'

class WhoAmIOSTest < Minitest::Test
  def setup
    @temp = Dir.mktmpdir('whoami-test-')
    @path = File.join(@temp, 'personal-memory')
    @os = WhoAmIOS::Store.new(@path)
    @os.init!
  end

  def teardown
    FileUtils.remove_entry(@temp)
  end

  def grant(actions)
    { 'actions' => actions, 'purpose' => 'personal-context', 'recipient' => 'codex-local',
      'task_id' => '*', 'until_revoked' => true, 'confirmation_id' => 'fictional-user-confirmation' }
  end

  def event(id = 'evt-work-001', policy = 'allowed')
    { 'change_id' => 'chg-event', 'op' => 'add_event',
      'record' => { 'id' => id, 'statement' => '正在考虑职业方向', 'recorded_at' => '2026-10-08',
                    'occurred_at' => '2026-10-08', 'domains' => ['career'],
                    'recall_policy' => policy, 'sensitivity' => 'personal' },
      'grants' => [grant(%w[persist recall send])] }
  end

  def record(id = 'rec-work-001', evidence = 'evt-work-001')
    { 'change_id' => 'chg-record', 'op' => 'add_record',
      'record' => { 'id' => id, 'kind' => 'state', 'dimension' => 'goals',
                    'statement' => '正在评估换工作，尚未决定', 'domains' => ['career'],
                    'evidence_ids' => [evidence], 'recall_policy' => 'allowed',
                    'sensitivity' => 'personal', 'role' => 'hard_constraint',
                    'recorded_at' => '2026-10-08', 'include_in_summary' => false },
      'grants' => [grant(%w[persist recall send])] }
  end

  def stable_preference
    source = event('evt-preference-001')
    source['change_id'] = 'chg-preference-source'
    source['record']['statement'] = '希望回答先给结论'
    item = { 'change_id' => 'chg-preference', 'op' => 'add_record',
             'record' => { 'id' => 'rec-preference-001', 'kind' => 'fact', 'dimension' => 'preferences',
                           'statement' => '回答时先给结论', 'domains' => ['career'],
                           'evidence_ids' => ['evt-preference-001'], 'recall_policy' => 'allowed',
                           'stability' => 'long_term', 'include_in_summary' => true,
                           'recorded_at' => '2026-10-08' },
             'grants' => [grant(%w[persist recall send summary])] }
    [source, item]
  end

  def commit(changes)
    proposal = @os.prepare(changes)
    @os.apply!(proposal, approval_hash: proposal.fetch('patch_hash'))
  end

  def test_cold_start_persists_yaml_and_new_session_recalls_with_source
    commit([event, record, *stable_preference])
    reopened = WhoAmIOS::Store.new(@path)
    assert_equal 4, reopened.status['record_count']
    assert_includes reopened.open_context['summary'], '回答时先给结论'
    context = reopened.recall(domain: 'career', purpose: 'personal-context', task_id: 'career-advice')
    assert_equal 'complete', context['coverage']
    assert_equal ['rec-work-001', 'rec-preference-001'], context['records'].map { |r| r['id'] }
    assert_equal ['evt-work-001'], context['records'][0]['evidence_ids']
    assert_equal '正在考虑职业方向', reopened.evidence(id: 'evt-work-001', purpose: 'personal-context', task_id: 'career-advice')['statement']
    assert File.read(File.join(@path, 'model/goals/rec-work-001.yaml')).start_with?('---')
  end

  def test_partial_confirmation_does_not_save_unselected_record
    proposal = @os.prepare([event, record], selected_ids: ['chg-event'])
    @os.apply!(proposal, approval_hash: proposal['patch_hash'])
    assert_equal 1, @os.status['record_count']
    assert_nil @os.open_context['summary']
  end

  def test_partial_confirmation_cannot_leave_dangling_source
    assert_raises(WhoAmIOS::Error) do
      @os.prepare([event, record], selected_ids: ['chg-record'])
    end
  end

  def test_changed_preview_and_unapproved_apply_are_rejected
    proposal = @os.prepare([event])
    assert_raises(WhoAmIOS::PermissionDenied) { @os.apply!(proposal, approval_hash: 'other') }
    proposal['changes'][0]['record']['statement'] = '偷偷改变的内容'
    assert_raises(WhoAmIOS::Error) { @os.apply!(proposal, approval_hash: proposal['patch_hash']) }
    assert_equal 0, @os.status['record_count']
  end

  def test_retry_same_approved_proposal_is_idempotent
    proposal = @os.prepare([event])
    first = @os.apply!(proposal, approval_hash: proposal['patch_hash'])
    second = @os.apply!(proposal, approval_hash: proposal['patch_hash'])
    assert_equal first, second
    assert_equal 1, @os.status['revision']
  end

  def test_superseding_a_state_preserves_history_and_changes_recall
    commit([event, record])
    change = record('rec-work-002')
    change['change_id'] = 'chg-new-state'
    change['op'] = 'supersede'
    change['target_id'] = 'rec-work-001'
    change['record']['statement'] = '决定先留在现有工作'
    commit([change])
    current = @os.recall(domain: 'career', purpose: 'personal-context', task_id: 'advice')['records']
    assert_equal ['rec-work-002'], current.map { |r| r['id'] }
    assert_equal 'superseded', YAML.safe_load(File.read(File.join(@path, 'model/goals/rec-work-001.yaml')))['status']
    assert_equal ['rec-work-001'], YAML.safe_load(File.read(File.join(@path, 'model/goals/rec-work-002.yaml')))['supersedes']
  end

  def test_never_policy_blocks_content_recall_even_with_grant
    commit([event('evt-work-001', 'never'), record])
    assert_raises(WhoAmIOS::PermissionDenied) { @os.evidence(id: 'evt-work-001', purpose: 'personal-context', task_id: 'advice') }
    assert_empty @os.recall(domain: 'career', purpose: 'personal-context', task_id: 'advice')['records']
  end

  def test_pattern_requires_three_events_on_two_dates
    sources = %w[001 002 003].map do |suffix|
      source = event("evt-pattern-#{suffix}")
      source['change_id'] = "chg-source-#{suffix}"
      source['record']['occurred_at'] = suffix == '003' ? '2026-10-09' : '2026-10-08'
      source
    end
    pattern = { 'change_id' => 'chg-pattern', 'op' => 'add_record',
                'record' => { 'id' => 'rec-pattern-001', 'kind' => 'pattern', 'dimension' => 'patterns',
                              'statement' => '倾向先检查约束', 'domains' => ['career'],
                              'evidence_ids' => sources.map { |s| s['record']['id'] } },
                'grants' => [grant(%w[persist recall send])] }
    assert_raises(WhoAmIOS::Error) { @os.prepare([sources.first, pattern]) }
    assert_equal 1, commit([*sources, pattern])['revision']
    assert_equal 4, @os.status['record_count']
  end

  def test_retract_marks_dependents_for_review_and_removes_summary
    derived = { 'change_id' => 'chg-derived', 'op' => 'add_record',
                'record' => { 'id' => 'rec-interpretation-001', 'kind' => 'interpretation',
                              'dimension' => 'synthesis', 'statement' => '正在权衡稳定与成长',
                              'domains' => ['career'], 'derived_from' => ['rec-work-001'],
                              'recall_policy' => 'allowed', 'recorded_at' => '2026-10-08' },
                'grants' => [grant(%w[persist recall send])] }
    commit([event, record, derived])
    commit([{ 'change_id' => 'chg-retract', 'op' => 'retract', 'target_id' => 'rec-work-001' }])
    assert_nil @os.open_context['summary']
    assert_empty @os.recall(domain: 'career', purpose: 'personal-context', task_id: 'advice')['records']
    assert_equal 'needs_review', YAML.safe_load(File.read(File.join(@path, 'model/synthesis/rec-interpretation-001.yaml')))['status']
  end

  def test_forget_source_removes_dependents_and_summary
    commit([event, record])
    commit([{ 'change_id' => 'chg-forget', 'op' => 'forget', 'target_id' => 'evt-work-001' }])
    assert_equal 0, @os.status['record_count']
    assert_nil @os.open_context['summary']
    refute File.exist?(File.join(@path, 'timeline/2026/evt-work-001.yaml'))
    refute File.exist?(File.join(@path, 'model/goals/rec-work-001.yaml'))
  end

  def test_interrupted_multi_file_commit_recovers_old_state
    proposal = @os.prepare([event, record])
    assert_raises(WhoAmIOS::Error) { @os.apply!(proposal, approval_hash: proposal['patch_hash'], fault_after: 0) }
    reopened = WhoAmIOS::Store.new(@path)
    assert_equal 0, reopened.status['revision']
    assert_equal 0, reopened.status['record_count']
    assert_empty Dir.children(File.join(@path, '.transactions'))
  end

  def test_manual_edit_blocks_update_and_stale_summary
    commit(stable_preference)
    path = File.join(@path, 'model/preferences/rec-preference-001.yaml')
    File.open(path, 'a') { |f| f.write("# changed by editor\n") }
    assert_nil @os.open_context['summary']
    proposal = @os.prepare([{ 'change_id' => 'chg-retract', 'op' => 'retract', 'target_id' => 'rec-preference-001' }])
    assert_raises(WhoAmIOS::Conflict) { @os.apply!(proposal, approval_hash: proposal['patch_hash']) }
  end

  def test_manual_policy_expansion_cannot_authorize_reading
    commit([event, record])
    File.open(File.join(@path, 'policy.yaml'), 'a') { |f| f.write("# unauthorized edit\n") }
    assert_raises(WhoAmIOS::Conflict) do
      @os.recall(domain: 'career', purpose: 'personal-context', task_id: 'advice')
    end
    assert_raises(WhoAmIOS::Conflict) do
      @os.open_context
    end
  end

  def test_retracting_stable_record_invalidates_summary
    commit(stable_preference)
    assert_includes @os.open_context['summary'], '回答时先给结论'
    commit([{ 'change_id' => 'chg-retract-pref', 'op' => 'retract', 'target_id' => 'rec-preference-001' }])
    assert_nil @os.open_context['summary']
  end

  def test_task_scope_and_expired_grant_block_recall
    limited = record
    limited['grants'] = [{ 'actions' => %w[persist recall send], 'purpose' => 'personal-context',
                           'recipient' => 'codex-local', 'task_id' => 'approved-task',
                           'expires_at' => (Date.today + 1).iso8601, 'confirmation_id' => 'fictional-confirmation' }]
    commit([event, limited])
    assert_empty @os.recall(domain: 'career', purpose: 'personal-context', task_id: 'other-task')['records']
    assert_equal 1, @os.recall(domain: 'career', purpose: 'personal-context', task_id: 'approved-task')['records'].size
  end

  def test_record_budget_reports_partial_coverage
    changes = [event]
    10.times do |index|
      item = record("rec-budget-#{index}")
      item['change_id'] = "chg-budget-#{index}"
      changes << item
    end
    commit(changes)
    context = @os.recall(domain: 'career', purpose: 'personal-context', task_id: 'advice')
    assert_equal 'partial', context['coverage']
    assert_equal 'record_limit', context['truncated_by']
    assert_equal 8, context['records'].size
    assert_equal 2, context['unread_candidate_count']
  end

  def test_revoke_grant_removes_summary_without_deleting_record
    commit(stable_preference)
    assert_includes @os.open_context['summary'], '回答时先给结论'
    grant_id = @os.grants.find { |g| g['record_ids'].include?('rec-preference-001') }['id']
    commit([{ 'change_id' => 'chg-revoke', 'op' => 'revoke_grant', 'target_id' => grant_id }])
    assert_nil @os.open_context['summary']
    refute @os.recall(domain: 'career', purpose: 'personal-context', task_id: 'advice')['records'].any? { |r| r['id'] == 'rec-preference-001' }
    assert_equal 2, @os.status['record_count']
  end

  def test_default_location_is_outside_repository_and_requires_init
    env = { 'HOME' => @temp }
    command = File.expand_path('../bin/whoami', __dir__)
    expected = WhoAmIOS.default_memory_path(home: @temp)
    out, err, status = Open3.capture3(env, RbConfig.ruby, command, 'location')
    assert status.success?, err
    assert_equal expected, JSON.parse(out)['memory_path']
    _out, _err, status = Open3.capture3(env, RbConfig.ruby, command, 'status')
    refute status.success?
    refute File.exist?(expected)
    out, err, status = Open3.capture3(env, RbConfig.ruby, command, 'init')
    assert status.success?, err
    assert_equal expected, JSON.parse(out)['memory_path']
    assert File.file?(File.join(expected, 'manifest.yaml'))
  end

  def test_explicit_memory_path_overrides_default
    env = { 'HOME' => @temp }
    command = File.expand_path('../bin/whoami', __dir__)
    chosen = File.join(@temp, 'other-personal-memory')
    out, err, status = Open3.capture3(env, RbConfig.ruby, command, 'init', '--memory', chosen)
    assert status.success?, err
    assert_equal chosen, JSON.parse(out)['memory_path']
    refute File.exist?(WhoAmIOS.default_memory_path(home: @temp))
  end

  def test_default_path_follows_local_platform_convention
    assert_equal File.join(@temp, 'Library', 'Application Support', 'WhoAmI', 'personal-memory'),
                 WhoAmIOS.default_memory_path(home: @temp, platform: 'darwin')
    assert_equal File.join(@temp, 'data', 'whoami', 'personal-memory'),
                 WhoAmIOS.default_memory_path(home: @temp, platform: 'linux', xdg_data_home: File.join(@temp, 'data'))
  end
end
