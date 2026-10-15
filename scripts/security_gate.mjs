#!/usr/bin/env node
// Public-repository gate controller. Never print or upload private source, prompts or findings.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const TARGETS = Object.freeze({
  vhv: 'qdip-ai/qdip-personal-secretary',
  core: 'qdip-ai/qdip-core',
  web: 'qdip-ai/qdip-web',
  doctor: 'qdip-ai/qdip-model-doctor',
});
const REQUIRED = [
  'run-metadata.json', 'architecture.md', 'coverage-ledger.json',
  'findings.json', 'REPORT.md', 'FINDINGS-DETAIL.md', 'NEEDS-VALIDATION.md',
];
const SHA_PATTERN = /^[a-f0-9]{40}$/;

export function validateInputs({ target, sourceRef, expectedSha }) {
  if (!Object.hasOwn(TARGETS, target)) throw Error('Unsupported source repository');
  if (!sourceRef || sourceRef.length > 128 || /[\s\\~^:?*\[\]{}]/.test(sourceRef) || sourceRef.startsWith('-')) {
    throw Error('Invalid source ref');
  }
  if (expectedSha && !SHA_PATTERN.test(expectedSha)) throw Error('Expected SHA must be 40 lowercase hex characters');
  return TARGETS[target];
}

export function classify({ agentExit, requiredPresent, schemaValid, sourceClean, findings, ledger }) {
  // Missing evidence is never interpreted as a clean audit.
  if (agentExit !== 0 || !requiredPresent || !schemaValid || !sourceClean ||
      !Array.isArray(findings) || !Array.isArray(ledger) || ledger.length === 0) {
    return 'INCOMPLETE';
  }
  const confirmedBlocking = findings.some(f => f?.verdict === 'confirmed' &&
    ['critical', 'high'].includes(f?.severity?.overall_severity));
  if (confirmedBlocking) return 'BLOCKED';
  if (findings.some(f => f?.verdict === 'needs_validation')) return 'INCOMPLETE';
  if (ledger.some(u => !['covered', 'candidate', 'not_applicable', 'out_of_scope'].includes(u?.status) ||
    (Array.isArray(u?.unresolved) ? u.unresolved.length > 0 : Boolean(u?.unresolved)))) {
    return 'INCOMPLETE';
  }
  return 'PASS';
}

function readJson(filename) {
  try {
    const value = fs.readFileSync(filename);
    if (value.length > 5 * 1024 * 1024) return null;
    return JSON.parse(value.toString('utf8'));
  } catch { return null; }
}
function validateWithUpstream(skill, name, filename) {
  try {
    execFileSync(process.execPath, [path.join(skill, name), filename], {
      timeout: 30000, stdio: 'pipe', maxBuffer: 1024 * 1024,
    });
    return true;
  } catch { return false; }
}
function shaOf(repo) {
  try {
    return execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim();
  } catch { return null; }
}
function isSourceClean(repo) {
  try {
    return execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim() === '';
  } catch { return false; }
}
function safeEnv(name) { return process.env[name] || ''; }

function emitSummary(verdict) {
  const file = safeEnv('GITHUB_STEP_SUMMARY');
  if (!file) return;
  fs.appendFileSync(file,
    '### QDIP Security Gate: ' + verdict.status + '\n' +
    '- Target: ' + verdict.target + '\n' +
    '- Source SHA: ' + (verdict.source_sha || 'UNKNOWN') + '\n' +
    '- Cloudflare Skill SHA: ' + verdict.skill_sha + '\n' +
    '- Confirmed high/critical: ' + verdict.confirmed_blocking + '\n' +
    '- Unresolved leads: ' + verdict.unresolved + '\n' +
    '- Evidence: sanitized status only; private report not retained in public artifacts.\n');
}

function main() {
  const command = process.argv[2];
  if (command === 'validate-input') {
    validateInputs({
      target: safeEnv('SECURITY_TARGET'), sourceRef: safeEnv('SOURCE_REF'),
      expectedSha: safeEnv('EXPECTED_SHA'),
    });
    console.log('SECURITY_GATE_INPUTS=VALID');
    return;
  }
  if (command !== 'evaluate') throw Error('Unknown command');
  const target = safeEnv('SECURITY_TARGET');
  const sourceRef = safeEnv('SOURCE_REF');
  const expectedSha = safeEnv('EXPECTED_SHA');
  const skillSha = safeEnv('SKILL_SHA');
  const base = safeEnv('GATE_REPORT_DIR');
  const source = safeEnv('SOURCE_DIR');
  const skill = safeEnv('SKILL_DIR');
  const sanitized = safeEnv('SANITIZED_DIR');
  // Do not use agent output to calculate or overwrite output paths.
  validateInputs({ target, sourceRef, expectedSha });
  if (!SHA_PATTERN.test(skillSha)) throw Error('Skill SHA must be pinned');
  if (!base || !source || !skill || !sanitized) throw Error('Missing gate directory');
  const actualSha = shaOf(source);
  const expectedMatches = actualSha !== null && (!expectedSha || actualSha === expectedSha);
  const paths = REQUIRED.map(f => path.join(base, f));
  const requiredPresent = paths.every(f => fs.existsSync(f) && fs.statSync(f).isFile());
  const findings = readJson(path.join(base, 'findings.json'));
  const ledger = readJson(path.join(base, 'coverage-ledger.json'));
  const schemaValid = requiredPresent &&
    validateWithUpstream(skill, 'validate-findings.cjs', path.join(base, 'findings.json')) &&
    validateWithUpstream(skill, 'validate-coverage-ledger.cjs', path.join(base, 'coverage-ledger.json'));
  const sourceClean = expectedMatches && isSourceClean(source);
  const agentExit = Number(safeEnv('AGENT_EXIT_CODE') || 99);
  const status = classify({ agentExit, requiredPresent, schemaValid, sourceClean, findings, ledger });
  const confirmed = Array.isArray(findings) ? findings.filter(f => f?.verdict === 'confirmed') : [];
  const sanitizedResult = {
    schema_version: 1,
    status,
    target: TARGETS[target],
    source_sha: actualSha,
    expected_sha_match: expectedMatches,
    skill_sha: skillSha,
    coverage_units: Array.isArray(ledger) ? ledger.length : 0,
    confirmed_total: confirmed.length,
    confirmed_blocking: confirmed.filter(f => ['high', 'critical'].includes(f?.severity?.overall_severity)).length,
    unresolved: Array.isArray(findings) ? findings.filter(f => f?.verdict === 'needs_validation').length : 0,
    evidence_complete: requiredPresent && schemaValid && sourceClean && agentExit === 0,
    timestamp_utc: new Date().toISOString(),
  };
  fs.mkdirSync(sanitized, { recursive: true });
  fs.writeFileSync(path.join(sanitized, 'verdict.json'), JSON.stringify(sanitizedResult, null, 2) + '\n', { mode: 0o600 });
  emitSummary(sanitizedResult);
  console.log('SECURITY_GATE_VERDICT=' + status + '; source_sha=' + (actualSha || 'UNKNOWN'));
  process.exitCode = status === 'PASS' ? 0 : (status === 'BLOCKED' ? 1 : 2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); } catch (error) {
    // Do not echo paths or contents from private repositories.
    console.error('SECURITY_GATE=INCOMPLETE (configuration or evaluation failed)');
    process.exitCode = 2;
  }
}
