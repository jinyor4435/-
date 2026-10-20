import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkEligibility } from '../lib/eligibility.js';
import { isCompatible, distanceKm } from '../lib/matching.js';

const today = new Date('2026-10-20T00:00:00Z');
const healthyDog = { species: 'dog', birth_date: '2022-01-01', weight_kg: 25, vaccinated: 1, healthy: 1, blood_type: 'DEA1.1-' };

test('조건을 모두 갖춘 개는 헌혈 가능', () => {
  assert.equal(checkEligibility(healthyDog, null, today).eligible, true);
});

test('체중·접종·나이 미달이면 사유를 알려준다', () => {
  const r = checkEligibility({ ...healthyDog, weight_kg: 10, vaccinated: 0, birth_date: '2026-01-01' }, null, today);
  assert.equal(r.eligible, false);
  assert.equal(r.reasons.length, 3);
});

test('고양이 헌혈 간격은 84일', () => {
  const cat = { species: 'cat', birth_date: '2022-01-01', weight_kg: 5, vaccinated: 1, healthy: 1, blood_type: 'A' };
  assert.equal(checkEligibility(cat, { last_donation_date: '2026-08-15' }, today).eligible, false);
  assert.equal(checkEligibility(cat, { last_donation_date: '2026-07-01' }, today).eligible, true);
});

test('혈액형 호환: 개 음성 공혈견은 양성에게도, 양성은 음성에게 못 준다', () => {
  assert.equal(isCompatible('dog', 'DEA1.1-', 'DEA1.1+'), true);
  assert.equal(isCompatible('dog', 'DEA1.1+', 'DEA1.1-'), false);
  assert.equal(isCompatible('cat', 'A', 'B'), false);
  assert.equal(isCompatible('cat', 'AB', 'AB'), true);
  assert.equal(isCompatible('dog', 'A', 'A'), false);
});

test('거리 계산: 서울-부산 약 325km', () => {
  const d = distanceKm(37.5665, 126.978, 35.1796, 129.0756);
  assert.ok(d > 315 && d < 335, String(d));
});
