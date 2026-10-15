import test from 'node:test';
import assert from 'node:assert/strict';
import { assess, counts } from '../scripts/deterministic_security_gate.mjs';

const clean = () => ({
  gitleaks: { exit: 0, data: [] },
  semgrep: { exit: 0, data: { results: [], errors: [] } },
  trivy: { exit: 0, data: { Results: [] } },
});

test('no findings on all three completed scanners => scoped PASS', () => {
  assert.equal(assess({ sourceOk: true, scans: clean() }), 'PASS');
});

test('missing result or failed scanner => INCOMPLETE, never PASS', () => {
  assert.equal(assess({ sourceOk: false, scans: clean() }), 'INCOMPLETE');
  assert.equal(assess({ sourceOk: true, scans: null }), 'INCOMPLETE');
  for (const tool of ['gitleaks', 'semgrep', 'trivy']) {
    const scans = clean();
    scans[tool].data = null;
    assert.equal(assess({ sourceOk: true, scans }), 'INCOMPLETE');
  }
  {
    const scans = clean();
    scans.gitleaks.exit = 99;
    assert.equal(assess({ sourceOk: true, scans }), 'INCOMPLETE');
  }
  {
    const scans = clean();
    scans.trivy.exit = 99;
    assert.equal(assess({ sourceOk: true, scans }), 'INCOMPLETE');
  }
  {
    const scans = clean();
    scans.semgrep.data.errors = [{ code: 1 }];
    assert.equal(assess({ sourceOk: true, scans }), 'INCOMPLETE');
  }
});

test('secrets are release blockers, including an expected Gitleaks finding exit 1', () => {
  const scans = clean();
  scans.gitleaks.exit = 1;
  scans.gitleaks.data = [{ RuleID: 'generic-api-key', Secret: 'NEVER_ECHO' }];
  assert.equal(assess({ sourceOk: true, scans }), 'BLOCKED');
  assert.equal(counts(scans).leaked_secrets, 1);
});

test('Semgrep ERROR blocks; warning does not block by default', () => {
  const scans = clean();
  scans.semgrep.exit = 1;
  scans.semgrep.data.results = [{ extra: { severity: 'WARNING' } }];
  assert.equal(assess({ sourceOk: true, scans }), 'PASS');
  scans.semgrep.data.results.push({ extra: { severity: 'ERROR' } });
  assert.equal(assess({ sourceOk: true, scans }), 'BLOCKED');
  assert.equal(counts(scans).sast_high_or_critical, 1);
});

test('Trivy HIGH/CRITICAL dependency or misconfiguration blocks', () => {
  const scans = clean();
  scans.trivy.data.Results = [
    { Vulnerabilities: [{ Severity: 'HIGH' }, { Severity: 'LOW' }] },
    { Misconfigurations: [{ Severity: 'CRITICAL' }] },
  ];
  assert.equal(assess({ sourceOk: true, scans }), 'BLOCKED');
  assert.equal(counts(scans).vulnerable_dependencies_high_or_critical, 1);
  assert.equal(counts(scans).misconfigurations_high_or_critical, 1);
});

test('unexpected scanner exit without corresponding findings => INCOMPLETE', () => {
  const scans = clean();
  scans.gitleaks.exit = 1;
  assert.equal(assess({ sourceOk: true, scans }), 'INCOMPLETE');
  scans.gitleaks.exit = 0;
  scans.semgrep.exit = 1;
  assert.equal(assess({ sourceOk: true, scans }), 'INCOMPLETE');
});

test('low severity dependencies remain report-only', () => {
  const scans = clean();
  scans.trivy.data.Results = [{ Vulnerabilities: [{ Severity: 'LOW' }, { Severity: 'MEDIUM' }] }];
  assert.equal(assess({ sourceOk: true, scans }), 'PASS');
});
