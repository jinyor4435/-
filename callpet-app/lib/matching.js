import { checkEligibility } from './eligibility.js';

export const BLOOD_TYPES = {
  dog: ['DEA1.1+', 'DEA1.1-'],
  cat: ['A', 'B', 'AB'],
};

export function isValidBloodType(species, type) {
  return Boolean(BLOOD_TYPES[species]?.includes(type));
}

// 개: DEA 1.1 음성 공혈견은 양성·음성 수혈견 모두에게 줄 수 있고, 양성은 양성에게만 준다.
// 고양이: 혈액형이 같아야 한다.
export function isCompatible(species, donorType, neededType) {
  if (!isValidBloodType(species, donorType) || !isValidBloodType(species, neededType)) return false;
  if (species === 'dog') return donorType === 'DEA1.1-' || donorType === neededType;
  return donorType === neededType;
}

export function distanceKm(lat1, lng1, lat2, lng2) {
  const rad = (d) => (d * Math.PI) / 180;
  const a =
    Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

export const DEFAULT_RADIUS_KM = 30;
export const MAX_CANDIDATES = 20;

export function findCandidates(db, request, hospital, today, radiusKm = DEFAULT_RADIUS_KM) {
  if (hospital.lat == null || hospital.lng == null) return [];
  const rows = db.prepare(
    `SELECT p.*, d.last_donation_date, u.lat, u.lng, u.id AS guardian_id
     FROM donors d
     JOIN pets p ON p.id = d.pet_id
     JOIN users u ON u.id = p.owner_id
     WHERE d.active = 1 AND p.species = ?
       AND p.id NOT IN (SELECT pet_id FROM matches WHERE request_id = ?)`
  ).all(request.species, request.id);

  return rows
    .filter((r) => r.lat != null && r.lng != null)
    .filter((r) => r.blood_type_verified && isCompatible(request.species, r.blood_type, request.blood_type))
    .filter((r) => checkEligibility(r, { last_donation_date: r.last_donation_date }, today).eligible)
    .map((r) => ({ ...r, distance_km: distanceKm(hospital.lat, hospital.lng, r.lat, r.lng) }))
    .filter((r) => r.distance_km <= radiusKm)
    .sort((a, b) => a.distance_km - b.distance_km)
    .slice(0, MAX_CANDIDATES);
}
