'use strict';
/**
 * Padlet 공개 API (v1)
 *  - 문서: https://docs.padlet.dev/reference/introduction
 *  - 키: 유료 요금제 계정의 설정 → 개발자(Developer) 화면에서 발급, 헤더 X-Api-Key
 *  - 글 올리기: POST /v1/boards/{board_id}/posts   (JSON:API 형식)
 *  - 첨부는 "파일 업로드"가 아니라 "이미지 주소(URL)" 로만 넣을 수 있다.
 *    그래서 이 앱이 이미지를 인터넷 주소로 열어 두고, 그 주소를 패들렛에 넘긴다.
 */
const DEFAULT_BASE = 'https://api.padlet.dev/v1';

function base() {
  return (process.env.PADLET_API_BASE || DEFAULT_BASE).replace(/\/$/, '');
}

async function request(method, path, apiKey, body) {
  const res = await fetch(base() + path, {
    method,
    headers: {
      'X-Api-Key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.api+json, application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 무시 */
  }
  if (!res.ok) {
    const detail =
      (json && json.errors && json.errors.map((e) => e.detail || e.title).join(', ')) ||
      (json && (json.message || json.error)) ||
      text.slice(0, 200);
    const err = new Error(`Padlet ${res.status}: ${detail}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

function boardIdFrom(input) {
  // 보드 ID만 넣는 게 정석이지만, 실수로 주소를 붙여 넣어도 마지막 조각을 쓴다
  const s = String(input || '').trim();
  if (!s) return '';
  const tail = s.split(/[/?#]/).filter(Boolean).pop() || '';
  const m = tail.match(/([a-z0-9]{12,})$/i);
  return m ? m[1] : tail;
}

async function getBoard({ apiKey, boardId }) {
  const json = await request('GET', `/boards/${encodeURIComponent(boardId)}`, apiKey);
  const a = (json && json.data && json.data.attributes) || {};
  return { id: (json && json.data && json.data.id) || boardId, title: a.title || '(제목 없음)', raw: a };
}

async function createPost({ apiKey, boardId, subject, body, attachmentUrl, caption }) {
  const content = {};
  if (subject) content.subject = subject;
  if (body) content.body = body;
  if (attachmentUrl) content.attachment = { url: attachmentUrl, caption: caption || '' };
  const json = await request('POST', `/boards/${encodeURIComponent(boardId)}/posts`, apiKey, {
    data: { type: 'post', attributes: { content } },
  });
  const d = (json && json.data) || {};
  const web = d.attributes && d.attributes.webUrl;
  return { id: d.id || null, url: (web && (web.live || web.edit)) || (typeof web === 'string' ? web : null) };
}

module.exports = { getBoard, createPost, boardIdFrom };
