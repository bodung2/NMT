/* 교사 1명 + 학생 3명으로 전체 흐름을 자동 점검한다: node test/smoke.js */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { io } = require('socket.io-client');
const assert = require('assert');
const { normalize, isCorrect, calcPoints } = require('../lib/grading');

const PORT = 3999;
const URL = `http://localhost:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (s, ev, d = {}) => new Promise((r) => s.emit(ev, d, r));
const once = (s, ev) => new Promise((r) => s.once(ev, r));

(async () => {
  // 채점 단위 테스트
  assert.strictEqual(normalize(' 서 울 '), '서울');
  assert.ok(isCorrect({ type: 'short', answer: '서울, 서울특별시' }, '서울 특별시'));
  assert.ok(!isCorrect({ type: 'short', answer: '서울' }, '부산'));
  assert.ok(isCorrect({ type: 'choice', answer: 2 }, 2));
  assert.ok(isCorrect({ type: 'sentence', answer: '식물은 광합성을 한다', keywords: '햇빛, 광합성' }, '햇빛을 받아 광합성을 해요'));
  assert.ok(!isCorrect({ type: 'sentence', answer: '식물은 광합성을 한다', keywords: '햇빛, 광합성' }, '광합성을 해요'));
  assert.deepStrictEqual(calcPoints(true, 0, 20000, 1), { base: 100, speed: 100, streak: 0, total: 200 });
  assert.deepStrictEqual(calcPoints(true, 10000, 20000, 3), { base: 100, speed: 50, streak: 40, total: 190 });
  assert.strictEqual(calcPoints(false, 0, 20000, 0).total, 0);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-'));
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, DATA_DIR: dataDir }, stdio: 'inherit' });
  await wait(800);
  try {
    const t = io(URL, { transports: ['websocket'] });
    const room = await emit(t, 'teacher:create');
    assert.ok(room.ok && /^\d{4}$/.test(room.code));

    const names = ['하늘', '바다', '구름'];
    const kids = [];
    for (const name of names) {
      const s = io(URL, { transports: ['websocket'] });
      const r = await emit(s, 'student:join', { code: room.code, name });
      assert.ok(r.ok, r.error);
      kids.push(s);
    }
    // 같은 이름 거절
    const dup = io(URL, { transports: ['websocket'] });
    assert.strictEqual((await emit(dup, 'student:join', { code: room.code, name: '하늘' })).ok, false);
    dup.close();

    // 문제 만들기
    const qs = [
      { type: 'short', text: '우리나라 수도는?', answer: '서울' },
      { type: 'choice', text: '2+2=?', choices: ['1', '2', '3', '4'], answer: 3 },
      { type: 'sentence', text: '광합성이란?', answer: '햇빛으로 양분을 만드는 것', keywords: '햇빛, 양분' },
    ];
    for (let i = 0; i < 3; i++) assert.ok((await emit(kids[i], 'question:create', qs[i])).ok);
    const bad = await emit(kids[0], 'question:create', { type: 'choice', text: 'x', choices: ['a', 'b', '', 'd'], answer: 0 });
    assert.strictEqual(bad.ok, false);

    // PLAY
    const firstQ = kids.map((k) => once(k, 'question'));
    assert.ok((await emit(t, 'teacher:phase', { phase: 'play' })).ok);
    const got = await Promise.all(firstQ);
    for (const [i, q] of got.entries()) {
      assert.strictEqual(q.answer, undefined, '정답이 학생에게 새면 안 됨');
      assert.notStrictEqual(q.text, qs[i].text, '자기 문제는 나오면 안 됨');
    }
    const answerFor = (q) => {
      const src = qs.find((x) => x.text === q.text);
      return src.type === 'choice' ? src.answer : src.type === 'short' ? src.answer : '햇빛을 받아 양분을 만들어요';
    };
    // 학생0: 2문제 연속 정답 → 연속 보너스
    let r1 = await emit(kids[0], 'play:answer', { qid: got[0].id, answer: answerFor(got[0]) });
    assert.ok(r1.ok && r1.result.correct, JSON.stringify(r1));
    assert.ok(r1.result.points.speed > 80, '빨리 맞히면 스피드 보너스');
    const q2p = once(kids[0], 'question');
    kids[0].emit('play:next', {}, () => {});
    const q2 = await q2p;
    assert.notStrictEqual(q2.id, got[0].id);
    const r2 = await emit(kids[0], 'play:answer', { qid: q2.id, answer: answerFor(q2) });
    assert.ok(r2.result.correct && r2.result.streak === 2 && r2.result.points.streak === 20);
    // 다 풀면 done
    const doneP = once(kids[0], 'done');
    kids[0].emit('play:next', {}, () => {});
    await doneP;
    // 같은 문제 두 번 답하기 방지
    assert.strictEqual((await emit(kids[0], 'play:answer', { qid: q2.id, answer: answerFor(q2) })).ok, false);

    // 학생1: 오답
    const r3 = await emit(kids[1], 'play:answer', { qid: got[1].id, answer: got[1].type === 'choice' ? 0 : '틀린답' });
    assert.ok(r3.ok && !r3.result.correct && r3.result.points.total === 0);
    // 학생2: 시간초과
    const r4 = await emit(kids[2], 'play:answer', { qid: got[2].id, timeout: true });
    assert.ok(r4.result.timedOut && !r4.result.correct);

    // 교사 상태 / 순위
    const tsP = once(t, 'teacher:state');
    await emit(t, 'teacher:phase', { phase: 'ended' });
    const ts = await tsP;
    assert.strictEqual(ts.phase, 'ended');
    assert.strictEqual(ts.leaderboard[0].name, '하늘');
    assert.ok(ts.leaderboard[0].score >= 400);
    assert.ok(ts.questions.every((q) => q.answer !== undefined));

    // 재접속(토큰) 시 같은 학생으로 복귀
    const back = io(URL, { transports: ['websocket'] });
    const tok = (await emit(kids[1], 'student:join', { code: room.code, name: '바다' })).token;
    const rb = await emit(back, 'student:join', { code: room.code, token: tok });
    assert.ok(rb.ok && rb.name === '바다');
    back.close();

    // 점수 초기화
    await emit(t, 'teacher:resetScores');
    [t, ...kids].forEach((s) => s.close());
    console.log('\n✅ 모든 테스트 통과');
  } finally {
    srv.kill();
  }
})().catch((e) => {
  console.error('❌ 테스트 실패:', e);
  process.exit(1);
});
