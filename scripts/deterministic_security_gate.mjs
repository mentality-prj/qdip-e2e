#!/usr/bin/env node
// Offline, deterministic release security gate. Never copy private findings into public logs/artifacts.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { validateInputs } from './security_gate.mjs';

const REPO_SHA = /^[a-f0-9]{40}$/;
const TOOLS = ['gitleaks', 'semgrep', 'trivy'];

function reportJson(dir, name) {
  try {
    const data = fs.readFileSync(path.join(dir, name));
    if (data.length > 20 * 1024 * 1024) return null;
    return JSON.parse(data.toString('utf8'));
  } catch { return null; }
}
function resultCode(dir, name) {
  try {
    const raw = fs.readFileSync(path.join(dir, name + '.exit'), 'utf8').trim();
    return /^(?:0|1|2|3|[4-9]|[1-9][0-9]{1,2})$/.test(raw) ? Number(raw) : null;
  } catch { return null; }
}
function shaOf(repo) {
  try {
    return execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {
      encoding: 'utf8', timeout: 10000, stdio: ['ignore','pipe','ignore'],
    }).trim();
  } catch { return null; }
}
function gitClean(repo) {
  try {
    return execFileSync('git', ['-C', repo, 'status', '--porcelain'], {
      encoding: 'utf8', timeout: 10000, stdio: ['ignore','pipe','ignore'],
    }).trim() === '';
  } catch { return false; }
}
const isArr = Array.isArray;
const severity = s => String(s || '').toUpperCase();
const high = s => ['HIGH', 'CRITICAL', 'ERROR'].includes(severity(s));

export function assess({ sourceOk, scans }) {
  if (!sourceOk || !scans || TOOLS.some(t => !scans[t])) return 'INCOMPLETE';
  const g = scans.gitleaks, s = scans.semgrep, t = scans.trivy;
  if (!isArr(g.data) || !s.data || !isArr(s.data.results) ||
      !isArr(s.data.errors) || !t.data || !isArr(t.data.Results) ||
      g.exit === null || s.exit === null || t.exit === null ||
      g.exit > 1 || s.exit > 1 || t.exit !== 0 ||
      s.data.errors.length > 0) return 'INCOMPLETE';
  if ((g.exit === 1 && g.data.length === 0) ||
      (s.exit === 1 && s.data.results.length === 0)) return 'INCOMPLETE';
  if (g.data.length > 0) return 'BLOCKED';
  if (s.data.results.some(f => high(f?.extra?.severity))) return 'BLOCKED';
  if (t.data.Results.some(r =>
    (isArr(r?.Vulnerabilities) && r.Vulnerabilities.some(f => high(f?.Severity))) ||
    (isArr(r?.Misconfigurations) && r.Misconfigurations.some(f => high(f?.Severity))))) return 'BLOCKED';
  return 'PASS';
}

export function counts(scans) {
  const g = scans?.gitleaks?.data, s = scans?.semgrep?.data, t = scans?.trivy?.data;
  const results = isArr(t?.Results) ? t.Results : [];
  return {
    leaked_secrets: isArr(g) ? g.length : null,
    sast_high_or_critical: isArr(s?.results) ? s.results.filter(f => high(f?.extra?.severity)).length : null,
    vulnerable_dependencies_high_or_critical: isArr(t?.Results) ?
      results.reduce((n,r) => n + (isArr(r?.Vulnerabilities) ?
        r.Vulnerabilities.filter(f => high(f?.Severity)).length : 0), 0) : null,
    misconfigurations_high_or_critical: isArr(t?.Results) ?
      results.reduce((n,r) => n + (isArr(r?.Misconfigurations) ?
        r.Misconfigurations.filter(f => high(f?.Severity)).length : 0), 0) : null,
  };
}
function writeVerdict(dir, verdict) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'verdict.json'), JSON.stringify(verdict, null, 2) + '\n', { mode: 0o600 });
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    fs.appendFileSync(summary, [
      '### QDIP deterministic Security Gate: ' + verdict.status,
      '- Target: ' + verdict.target,
      '- Source SHA: ' + (verdict.source_sha || 'UNKNOWN'),
      '- Scanner status: ' + JSON.stringify(verdict.scanner_complete),
      '- AI audit: NOT_RUN (optional separate review)',
      '- E2E / production release approval: NOT_EVALUATED',
      '- Detailed private findings are not uploaded to this public repository.',
      '',
    ].join('\n'));
  }
}

function main() {
  const target = process.env.SECURITY_TARGET || '';
  const sourceRef = process.env.SOURCE_REF || '';
  const expectedSha = process.env.EXPECTED_SHA || '';
  const sourceDir = process.env.SOURCE_DIR || '';
  const reportDir = process.env.GATE_REPORT_DIR || '';
  const sanitizedDir = process.env.SANITIZED_DIR || '';
  if (!reportDir || !sanitizedDir || !sourceDir) throw Error('Missing runner paths');
  const targetRepo = validateInputs({ target, sourceRef, expectedSha });
  const actualSha = shaOf(sourceDir);
  const sourceOk = Boolean(actualSha && REPO_SHA.test(actualSha) &&
    (!expectedSha || actualSha === expectedSha) && gitClean(sourceDir));
  const scans = {
    gitleaks: { exit: resultCode(reportDir, 'gitleaks'), data: reportJson(reportDir, 'gitleaks.json') },
    semgrep: { exit: resultCode(reportDir, 'semgrep'), data: reportJson(reportDir, 'semgrep.json') },
    trivy: { exit: resultCode(reportDir, 'trivy'), data: reportJson(reportDir, 'trivy.json') },
  };
  const status = assess({ sourceOk, scans });
  const verdict = {
    schema_version: 2,
    mode: 'deterministic-static-security',
    status,
    target: targetRepo,
    source_sha: actualSha,
    expected_sha_match: Boolean(actualSha && (!expectedSha || actualSha === expectedSha)),
    source_clean: sourceOk,
    scanner_complete: Object.fromEntries(TOOLS.map(t => [t,
      scans[t].exit !== null && scans[t].data !== null])),
    ...counts(scans),
    ai_audit: 'NOT_RUN',
    e2e_gate: 'NOT_EVALUATED',
    production_qualified: false,
    recorded_at_utc: new Date().toISOString(),
  };
  writeVerdict(sanitizedDir, verdict);
  console.log('QDIP_DETERMINISTIC_SECURITY_GATE=' + status);
  process.exitCode = status === 'PASS' ? 0 : status === 'BLOCKED' ? 1 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); }
  catch {
    // No stacktrace, paths, scan results, or secrets on the public runner.
    const dir = process.env.SANITIZED_DIR || '';
    if (dir) writeVerdict(dir, {
      schema_version: 2, mode: 'deterministic-static-security', status: 'INCOMPLETE',
      target: 'UNKNOWN', source_sha: null, ai_audit: 'NOT_RUN',
      e2e_gate: 'NOT_EVALUATED', production_qualified: false,
    });
    console.error('QDIP_DETERMINISTIC_SECURITY_GATE=INCOMPLETE');
    process.exitCode = 2;
  }
}
