'use strict';
/** 채점과 점수 계산 */

// ───────── 점수 규칙 ─────────
const SCORE = {
  base: 100, // 정답 기본 점수
  speedMax: 100, // 빨리 맞힐수록 최대 +100
  streakStep: 20, // 연속 정답 1회마다 +20
  streakMax: 100, // 연속 보너스 최대 +100
};

// ───────── 채점 ─────────
function normalize(s) {
  return String(s ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\s.,!?~'"`·…\-_()[\]{}:;]/g, '');
}

function splitList(s) {
  return String(s ?? '')
    .split(/[,/|]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function isCorrect(q, input) {
  if (q.type === 'choice') return Number(input) === q.answer;
  const given = normalize(input);
  if (!given) return false;
  if (q.type === 'short') return splitList(q.answer).some((a) => normalize(a) === given);
  // 문장형: 핵심 단어가 모두 들어 있으면 정답 (모범답안과 똑같아도 정답)
  if (normalize(q.answer) === given) return true;
  const kws = splitList(q.keywords).map(normalize).filter(Boolean);
  return kws.length > 0 && kws.every((k) => given.includes(k));
}


function calcPoints(correct, elapsedMs, limitMs, streak) {
  if (!correct) return { base: 0, speed: 0, streak: 0, total: 0 };
  const ratio = Math.max(0, Math.min(1, 1 - elapsedMs / limitMs));
  const base = SCORE.base;
  const speed = Math.round(SCORE.speedMax * ratio);
  const st = streak >= 2 ? Math.min((streak - 1) * SCORE.streakStep, SCORE.streakMax) : 0;
  return { base, speed, streak: st, total: base + speed + st };
}

module.exports = { SCORE, normalize, splitList, isCorrect, calcPoints };
