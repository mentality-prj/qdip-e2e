import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, validateInputs } from '../scripts/security_gate.mjs';

const complete = {
  agentExit: 0,
  requiredPresent: true,
  schemaValid: true,
  sourceClean: true,
  findings: [],
  ledger: [{ status: 'covered', unresolved: [] }],
};

test('allowlist prevents arbitrary repository checkout', () => {
  assert.equal(validateInputs({ target: 'vhv', sourceRef: 'security/vhv-gdpr-rights-and-hardening',
    expectedSha: 'a'.repeat(40) }), 'qdip-ai/qdip-personal-secretary');
  assert.throws(() => validateInputs({ target: '../evil', sourceRef: 'main', expectedSha: '' }));
  assert.throws(() => validateInputs({ target: 'core', sourceRef: '-b', expectedSha: '' }));
  assert.throws(() => validateInputs({ target: 'core', sourceRef: 'main\nother', expectedSha: '' }));
  assert.throws(() => validateInputs({ target: 'core', sourceRef: 'dev', expectedSha: 'abc' }));
});

test('complete and independently covered audit passes', () => {
  assert.equal(classify(complete), 'PASS');
  assert.equal(classify({ ...complete, findings: [{
    verdict: 'confirmed', severity: { overall_severity: 'medium' },
  }] }), 'PASS');
});

test('confirmed high and critical risk block release', () => {
  for (const severity of ['high', 'critical']) {
    assert.equal(classify({ ...complete, findings: [{
      verdict: 'confirmed', severity: { overall_severity: severity },
    }] }), 'BLOCKED');
  }
});

test('unknown, missing, stale, or unresolved evidence is INCOMPLETE', () => {
  assert.equal(classify({ ...complete, agentExit: 1 }), 'INCOMPLETE');
  assert.equal(classify({ ...complete, requiredPresent: false }), 'INCOMPLETE');
  assert.equal(classify({ ...complete, schemaValid: false }), 'INCOMPLETE');
  assert.equal(classify({ ...complete, sourceClean: false }), 'INCOMPLETE');
  assert.equal(classify({ ...complete, metadataValid: false }), 'INCOMPLETE');
  assert.equal(classify({ ...complete, ledger: [] }), 'INCOMPLETE');
  assert.equal(classify({ ...complete, findings: null }), 'INCOMPLETE');
  assert.equal(classify({ ...complete, findings: [{ verdict: 'needs_validation' }] }), 'INCOMPLETE');
  assert.equal(classify({ ...complete, ledger: [{ status: 'deferred', unresolved: [] }] }), 'INCOMPLETE');
  assert.equal(classify({ ...complete, ledger: [{ status: 'covered', unresolved: ['blocked'] }] }), 'INCOMPLETE');
});

test('incomplete evidence cannot be converted into clean PASS by findings', () => {
  assert.equal(classify({ ...complete, agentExit: 42,
    findings: [{ verdict: 'confirmed', severity: { overall_severity: 'high' } }] }), 'INCOMPLETE');
});
