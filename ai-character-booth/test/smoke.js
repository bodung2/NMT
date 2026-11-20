'use strict';
/**
 * 가짜 Gemini 서버 + 가짜 Padlet 서버를 띄워 놓고 전체 흐름을 점검한다.
 *   학생 사진 업로드 → AI 변신 → 패들렛 전송 → 교사 화면 → 인쇄 표시 → 전시 벽
 */
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const JPEG_DATA_URL = 'data:image/jpeg;base64,' + Buffer.from('fake-jpeg-bytes').toString('base64');

function listen(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(s));
  });
}
const readBody = (req) =>
  new Promise((r) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => r(b ? JSON.parse(b) : null));
  });

(async () => {
  const geminiCalls = [];
  const gemini = await listen(async (req, res) => {
    const body = await readBody(req);
    geminiCalls.push({ url: req.url, key: req.headers['x-goog-api-key'], body });
    if (req.url.includes('gemini-3.1-flash-image-preview')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'models/x is not found' } }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }, { inlineData: { mimeType: 'image/png', data: PNG_1PX } }] } }] }));
  });

  const padletCalls = [];
  const padletSrv = await listen(async (req, res) => {
    const body = await readBody(req);
    padletCalls.push({ method: req.method, url: req.url, key: req.headers['x-api-key'], body });
    res.writeHead(req.method === 'POST' ? 201 : 200, { 'content-type': 'application/vnd.api+json' });
    if (req.method === 'GET') return res.end(JSON.stringify({ data: { id: 'board123', attributes: { title: '우리 부스' } } }));
    res.end(JSON.stringify({ data: { id: 'post1', type: 'post', attributes: { webUrl: { live: 'https://padlet.com/x/post1' } } } }));
  });

  Object.assign(process.env, {
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'booth-')),
    GEMINI_API_KEY: 'test-gemini',
    GEMINI_API_BASE: `http://127.0.0.1:${gemini.address().port}`,
    PADLET_API_KEY: 'test-padlet',
    PADLET_API_BASE: `http://127.0.0.1:${padletSrv.address().port}/v1`,
    PADLET_BOARD_ID: 'https://padlet.com/teacher/booth-abcd1234efgh5678',
    TEACHER_PASSWORD: 'pw',
    MAX_TRIES: '2',
    PUBLIC_URL: 'https://booth.example.com',
  });
  const { app } = require('../server');
  const srv = await listen(app);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (p, body, headers = {}) => {
    const res = await fetch(base + p, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const T = { 'x-teacher-key': 'pw' };
  const token = 'student-token-1';

  // 1) 설정
  let r = await call('/api/config?token=' + token);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.styles.length, 9);
  assert.strictEqual(r.json.triesLeft, 2);
  console.log('✓ 학생 설정 (스타일 9개, 변신 2회)');

  // 2) 입력 검증
  r = await call('/api/generate', { token, name: '', styleId: 'felt', image: JPEG_DATA_URL });
  assert.strictEqual(r.status, 400);
  r = await call('/api/generate', { token, name: '하늘', styleId: 'nope', image: JPEG_DATA_URL });
  assert.strictEqual(r.status, 400);
  r = await call('/api/generate', { token, name: '하늘', styleId: 'felt', image: 'data:text/html;base64,AAAA' });
  assert.strictEqual(r.status, 400);
  console.log('✓ 잘못된 입력 거절');

  // 3) 변신 (첫 모델 404 → 다음 모델로 자동 전환)
  r = await call('/api/generate', { token, name: '하늘', charName: '번개', intro: '축구를 좋아해요', styleId: 'felt', image: JPEG_DATA_URL });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  const item = r.json;
  assert.strictEqual(item.triesLeft, 1);
  assert.ok(item.resultUrl.startsWith('https://booth.example.com/img/') && item.resultUrl.endsWith('.png'));
  assert.strictEqual(geminiCalls.length, 2);
  const g = geminiCalls[1];
  assert.ok(g.url.includes('gemini-3.1-flash-image:generateContent'));
  assert.strictEqual(g.key, 'test-gemini');
  assert.strictEqual(g.body.contents[0].parts[1].inline_data.mime_type, 'image/jpeg');
  assert.ok(/wool/.test(g.body.contents[0].parts[0].text));
  assert.ok(/축구를 좋아해요/.test(g.body.contents[0].parts[0].text));
  assert.deepStrictEqual(g.body.generationConfig.responseModalities, ['TEXT', 'IMAGE']);
  console.log('✓ AI 변신 + 모델 자동 전환');

  // 결과 이미지가 실제로 열리는지
  const imgPath = new URL(item.resultUrl).pathname;
  const imgRes = await fetch(base + imgPath);
  assert.strictEqual(imgRes.status, 200);
  assert.strictEqual(imgRes.headers.get('content-type'), 'image/png');
  console.log('✓ 결과 이미지 공개 주소');

  // 4) 횟수 제한
  r = await call('/api/generate', { token, name: '하늘', styleId: 'anime3d', image: JPEG_DATA_URL });
  assert.strictEqual(r.status, 200);
  r = await call('/api/generate', { token, name: '하늘', styleId: 'pixel', image: JPEG_DATA_URL });
  assert.strictEqual(r.status, 429);
  console.log('✓ 1인당 변신 횟수 제한');

  // 5) 남의 작품은 못 보냄
  r = await call('/api/send', { token: 'other-token-xx', id: item.id });
  assert.strictEqual(r.status, 404);

  // 6) 패들렛 전송
  r = await call('/api/send', { token, id: item.id });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.padlet.status, 'ok');
  const post = padletCalls.find((c) => c.method === 'POST');
  assert.strictEqual(post.url, '/v1/boards/abcd1234efgh5678/posts');
  assert.strictEqual(post.key, 'test-padlet');
  assert.strictEqual(post.body.data.type, 'post');
  assert.strictEqual(post.body.data.attributes.content.attachment.url, item.resultUrl);
  assert.ok(post.body.data.attributes.content.subject.includes('번개'));
  // 두 번 눌러도 중복으로 안 올라감
  await call('/api/send', { token, id: item.id });
  assert.strictEqual(padletCalls.filter((c) => c.method === 'POST').length, 1);
  console.log('✓ 패들렛 전송 (중복 방지, 보드 주소 → ID 자동 추출)');

  // 7) 교사 화면
  r = await call('/api/teacher/state');
  assert.strictEqual(r.status, 401);
  r = await call('/api/teacher/state', null, T);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.items.length, 2);
  assert.strictEqual(r.json.items.filter((x) => x.sent).length, 1);
  assert.strictEqual(r.json.status.ai, 'ready');
  assert.strictEqual(r.json.status.padletReady, true);
  r = await call('/api/teacher/padlet-test', {}, T);
  assert.strictEqual(r.json.title, '우리 부스');
  r = await call(`/api/teacher/items/${item.id}/printed`, {}, T);
  assert.strictEqual(r.json.printed, 1);
  r = await call('/api/teacher/settings', { maxTries: 5, enabledStyles: ['felt', 'pixel', 'bogus'], padletOn: false }, T);
  assert.deepStrictEqual(r.json.settings.enabledStyles, ['felt', 'pixel']);
  r = await call('/api/config?token=' + token);
  assert.strictEqual(r.json.styles.length, 2);
  assert.strictEqual(r.json.triesLeft, 3);
  console.log('✓ 교사 화면 (비밀번호, 연결 테스트, 인쇄 표시, 설정)');

  // 8) 전시 벽 / QR / 화면들
  r = await call('/api/wall');
  assert.strictEqual(r.json.items.length, 1);
  for (const p of ['/', '/teacher', '/print', '/wall', '/qr.svg']) {
    const res = await fetch(base + p);
    assert.strictEqual(res.status, 200, p);
  }
  console.log('✓ 전시 벽, QR, 화면 주소');

  // 8-1) 전체 내려받기 ZIP
  {
    const z = await fetch(base + '/api/teacher/download.zip?key=pw');
    assert.strictEqual(z.status, 200);
    const buf = Buffer.from(await z.arrayBuffer());
    assert.strictEqual(buf.readUInt32LE(0), 0x04034b50);
    fs.writeFileSync(path.join(process.env.DATA_DIR, 'out.zip'), buf);
    assert.strictEqual((await fetch(base + '/api/teacher/download.zip?key=wrong')).status, 401);
    console.log('✓ 작품 ZIP 내려받기');
  }

  // 9) 삭제
  r = await fetch(`${base}/api/teacher/items/${item.id}`, { method: 'DELETE', headers: T });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await fetch(base + imgPath)).status, 404);
  console.log('✓ 작품 삭제');

  console.log('\n모든 점검 통과 🎉');
  console.log('ZIP:', path.join(process.env.DATA_DIR, 'out.zip'));
  for (const s of [srv, gemini, padletSrv]) s.close();
  process.exit(0);
})().catch((e) => {
  console.error('❌ 실패:', e);
  process.exit(1);
});
