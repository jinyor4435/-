// 헌혈 가능 여부 참고 기준. 수치는 일반적으로 알려진 범위를 기본값으로 둔 것이며
// 출시 전 수의사 검토로 확정해야 한다. 앱은 참고 정보만 제공하고 최종 판단은 수의사가 한다.
export const RULES = {
  dog: { minAgeYears: 1, maxAgeYears: 8, minWeightKg: 20, intervalDays: 56 },
  cat: { minAgeYears: 1, maxAgeYears: 8, minWeightKg: 4, intervalDays: 84 },
};

export function ageInYears(birthDate, today) {
  if (!birthDate) return null;
  const birth = new Date(birthDate);
  if (Number.isNaN(birth.getTime())) return null;
  return (today - birth) / (365.25 * 86400000);
}

export function daysBetween(fromDate, today) {
  return Math.floor((today - new Date(fromDate)) / 86400000);
}

export function checkEligibility(pet, donor, today) {
  const rule = RULES[pet.species];
  const reasons = [];
  if (!rule) return { eligible: false, reasons: ['지원하지 않는 종입니다.'], nextDate: null };

  const age = ageInYears(pet.birth_date, today);
  if (age === null) reasons.push('생년월일을 입력해 주세요.');
  else if (age < rule.minAgeYears || age > rule.maxAgeYears) {
    reasons.push(`나이가 ${rule.minAgeYears}~${rule.maxAgeYears}세 범위를 벗어납니다.`);
  }
  if (!pet.weight_kg || pet.weight_kg < rule.minWeightKg) {
    reasons.push(`체중이 ${rule.minWeightKg}kg 이상이어야 합니다.`);
  }
  if (!pet.vaccinated) reasons.push('예방접종을 완료해야 합니다.');
  if (!pet.healthy) reasons.push('건강 상태 자가 확인이 필요합니다.');
  if (!pet.blood_type) reasons.push('혈액형이 등록되어야 합니다.');

  let nextDate = null;
  if (donor?.last_donation_date) {
    const elapsed = daysBetween(donor.last_donation_date, today);
    if (elapsed < rule.intervalDays) {
      const next = new Date(new Date(donor.last_donation_date).getTime() + rule.intervalDays * 86400000);
      nextDate = next.toISOString().slice(0, 10);
      reasons.push(`마지막 헌혈 후 ${rule.intervalDays}일이 지나지 않았습니다. (${nextDate} 이후 가능)`);
    }
  }
  return { eligible: reasons.length === 0, reasons, nextDate };
}
