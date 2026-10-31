import { checkEligibility, daysBetween } from './eligibility.js';

const KIND = { visit: '진료', vaccine: '접종', medication: '복약' };

// 병원 기록을 보호자가 읽기 쉬운 문장으로 정리한다. 규칙 기반 요약이며 AI 모델을 쓰지 않는다.
// 의학적 판단은 하지 않고, 기록에 있는 날짜와 메모를 그대로 풀어 쓴다.
export function buildReport(pet, records, donor, today) {
  const items = [];
  const day = (d) => new Date(d);
  const sorted = [...records].sort((a, b) => (a.date < b.date ? 1 : -1));

  const lastVisit = sorted.find((r) => r.kind === 'visit');
  if (lastVisit) {
    const ago = daysBetween(lastVisit.date, today);
    items.push({ title: '최근 진료', level: 'info', text: `${lastVisit.date}에 ${lastVisit.hospital_name} 진료를 받았어요 (${ago}일 전).${lastVisit.memo ? ` 메모: ${lastVisit.memo}` : ''}` });
  } else {
    items.push({ title: '최근 진료', level: 'muted', text: '연결된 병원의 진료 기록이 아직 없어요.' });
  }

  const lastVaccine = sorted.find((r) => r.kind === 'vaccine');
  if (lastVaccine) {
    const ago = daysBetween(lastVaccine.date, today);
    items.push(ago > 365
      ? { title: '접종', level: 'warn', text: `마지막 접종(${lastVaccine.date})이 1년이 지났어요. 추가 접종 시기는 병원과 상담해 보세요.` }
      : { title: '접종', level: 'ok', text: `마지막 접종은 ${lastVaccine.date}${lastVaccine.memo ? ` (${lastVaccine.memo})` : ''}이에요.` });
  } else {
    items.push({ title: '접종', level: 'muted', text: '접종 기록이 없어요.' });
  }

  const upcoming = sorted.filter((r) => r.next_date).map((r) => r.next_date).sort();
  const next = upcoming.find((d) => day(d) >= new Date(today.toISOString().slice(0, 10)));
  const overdue = upcoming.filter((d) => day(d) < new Date(today.toISOString().slice(0, 10))).pop();
  if (next) {
    const left = Math.ceil((day(next) - today) / 86400000);
    items.push({ title: '다음 일정', level: left <= 7 ? 'warn' : 'info', text: `${next}에 방문 예정이에요 (${left <= 0 ? '오늘' : `D-${left}`}).` });
  } else if (overdue) {
    items.push({ title: '다음 일정', level: 'warn', text: `예정일(${overdue})이 지났어요. 방문 일정을 잡아 보세요.` });
  }

  const recentMeds = sorted.filter((r) => r.kind === 'medication' && daysBetween(r.date, today) <= 14);
  if (recentMeds.length) {
    items.push({ title: '복약', level: 'info', text: `최근 2주 안에 복약 기록이 ${recentMeds.length}건 있어요.${recentMeds[0].memo ? ` 가장 최근: ${recentMeds[0].memo}` : ''}` });
  }

  const eligibility = checkEligibility(pet, donor, today);
  items.push(eligibility.eligible
    ? { title: '헌혈', level: 'ok', text: '현재 기준으로 헌혈 조건을 충족해요. 콜펫에서 헌혈 등록을 할 수 있어요.' }
    : { title: '헌혈', level: 'muted', text: `헌혈 참고 기준에 아직 못 미쳐요: ${eligibility.reasons[0]}` });

  const headline = lastVisit
    ? `${pet.name}의 건강 기록을 정리했어요`
    : `${pet.name}의 기록이 아직 많지 않아요`;
  return { headline, items, generated: 'rule-based', notice: '기록을 쉽게 풀어 쓴 자동 요약이며 진단이 아닙니다. 궁금한 점은 수의사에게 확인하세요.' };
}

export { KIND };
