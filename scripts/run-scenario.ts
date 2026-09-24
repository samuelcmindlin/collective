import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { runWorkCycle } from './scenarios/work-cycle.js';

const args = process.argv.slice(2);
if (args.length > 3 || (args[0] && !['correct', 'wrong'].includes(args[0])) || (args[1] && args[1] !== '--output') || (args[1] && !args[2])) {
  throw new Error('Usage: npm run scenario:run -- [correct|wrong] [--output path]');
}
const variant = args[0] === 'wrong' ? 'wrong' : 'correct';
const controller = new AbortController(), cancel = () => controller.abort();
process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
const report = await runWorkCycle(variant, controller.signal);
process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
const output = resolve(args[2] ?? `test-results/work-cycle-${variant}.json`);
mkdirSync(dirname(output), { recursive: true });
const temporary = `${output}.${process.pid}.tmp`;
writeFileSync(temporary, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); renameSync(temporary, output);
console.log(JSON.stringify({ status: report.status, worker: report.worker, modelInvoked: false, output, error: report.error }));
if (report.status !== 'pass') process.exitCode = 1;
