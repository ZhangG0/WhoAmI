#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { Store, WhoAmIError, defaultMemoryPath, RECIPIENT } = require('./whoami_os');

function run(argv = process.argv.slice(2), stdin = () => fs.readFileSync(0, 'utf8')) {
  const [command, ...args] = argv;
  const options = { recipient: RECIPIENT, purpose: 'personal-context', limit: 8 };
  const fields = { '--memory': 'memory', '--domain': 'domain', '--purpose': 'purpose', '--recipient': 'recipient',
    '--task-id': 'taskId', '--limit': 'limit', '--approval-hash': 'approvalHash', '--id': 'id' };
  for (let i = 0; i < args.length; i++) {
    const key = fields[args[i]];
    if (!key || i + 1 >= args.length) throw new WhoAmIError(`无效选项：${args[i]}`);
    options[key] = args[++i];
  }
  if (options.limit !== 8) {
    if (!/^\d+$/.test(options.limit)) throw new WhoAmIError('读取条数必须为正整数');
    options.limit = Number(options.limit);
  }
  const store = new Store(options.memory || defaultMemoryPath());
  switch (command) {
    case 'location': return { memory_path: store.root };
    case 'init': return store.init();
    case 'status': return store.status();
    case 'grants': return store.grants();
    case 'open': return store.openContext(options);
    case 'prepare': {
      const input = JSON.parse(stdin());
      return store.prepare(input.changes, input.selected_change_ids, input.authorization);
    }
    case 'apply': {
      const proposal = JSON.parse(stdin());
      if (!options.approvalHash && !proposal.authorization) throw new WhoAmIError('apply 需要 --approval-hash 或有效持续授权');
      return store.apply(proposal, options.approvalHash);
    }
    case 'recall': {
      if (!options.domain || !options.taskId) throw new WhoAmIError('recall 需要 --domain 和 --task-id');
      return store.recall(options);
    }
    case 'evidence': {
      if (!options.id || !options.taskId) throw new WhoAmIError('evidence 需要 --id 和 --task-id');
      return store.evidence(options);
    }
    case 'recover': return store.recover();
    default: throw new WhoAmIError('用法: node scripts/whoami.js 操作 [--memory /path/to/personal-memory] [选项]');
  }
}

if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(run(), null, 2)}\n`); }
  catch (error) {
    process.stderr.write(`${JSON.stringify({ error: error.constructor.name, message: error.message })}\n`);
    process.exitCode = 2;
  }
}
module.exports = { run };
