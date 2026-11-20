'use strict';
/**
 * Google Gemini 이미지 모델(나노바나나)로 "그림 사진 + 지시문 → 새 이미지"를 만든다.
 * REST: POST {base}/v1beta/models/{model}:generateContent   (헤더 x-goog-api-key)
 *
 * 모델 이름은 자주 바뀌므로 GEMINI_MODEL 로 지정할 수 있고,
 * 지정한 모델이 없다는 응답(404)이 오면 아래 후보를 차례로 시도한다.
 */
const FALLBACK_MODELS = ['gemini-3.1-flash-image-preview', 'gemini-3.1-flash-image', 'gemini-2.5-flash-image'];

let workingModel = null; // 한 번 성공한 모델은 기억해 두고 계속 쓴다

class AiError extends Error {
  constructor(message, { status = 500, userMessage } = {}) {
    super(message);
    this.status = status;
    this.userMessage = userMessage || 'AI가 그림을 만들지 못했어요. 잠시 후 다시 해 볼까요?';
  }
}

function pickImagePart(json) {
  const cands = json && json.candidates;
  if (!Array.isArray(cands)) return null;
  for (const c of cands) {
    const parts = (c.content && c.content.parts) || [];
    for (const p of parts) {
      const inline = p.inlineData || p.inline_data;
      if (inline && inline.data) return { data: inline.data, mime: inline.mimeType || inline.mime_type || 'image/png' };
    }
  }
  return null;
}

async function callOnce({ base, apiKey, model, prompt, imageB64, mime, aspectRatio, timeoutMs }) {
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: imageB64 } }] }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
  };
  if (aspectRatio) body.generationConfig.imageConfig = { aspectRatio };
  const res = await fetch(`${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 아래에서 처리 */
  }
  return { status: res.status, json, text };
}

/**
 * @returns {Promise<{data: string, mime: string, model: string}>} base64 이미지
 */
async function generateImage({
  apiKey,
  model,
  prompt,
  imageB64,
  mime = 'image/jpeg',
  aspectRatio = '2:3',
  timeoutMs = 120000,
  base = process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com',
}) {
  if (!apiKey) throw new AiError('GEMINI_API_KEY 없음', { status: 503, userMessage: '선생님이 아직 AI 연결을 안 했어요.' });

  const candidates = [...new Set([workingModel, model, ...FALLBACK_MODELS].filter(Boolean))];
  let lastErr = null;

  for (const m of candidates) {
    let useAspect = aspectRatio;
    for (let attempt = 0; attempt < 2; attempt++) {
      let r;
      try {
        r = await callOnce({ base, apiKey, model: m, prompt, imageB64, mime, aspectRatio: useAspect, timeoutMs });
      } catch (e) {
        if (e.name === 'TimeoutError' || e.name === 'AbortError') {
          throw new AiError('Gemini 시간 초과', { status: 504, userMessage: 'AI가 너무 오래 걸렸어요. 한 번만 다시 눌러 볼까요?' });
        }
        throw new AiError(`Gemini 연결 실패: ${e.message}`, { status: 502 });
      }
      const apiMsg = (r.json && r.json.error && r.json.error.message) || r.text.slice(0, 300);

      if (r.status === 200) {
        const img = pickImagePart(r.json);
        if (img) {
          workingModel = m;
          return { ...img, model: m };
        }
        const block = (r.json && r.json.promptFeedback && r.json.promptFeedback.blockReason) ||
          (r.json && r.json.candidates && r.json.candidates[0] && r.json.candidates[0].finishReason);
        throw new AiError(`이미지 없음 (${block || 'unknown'})`, {
          status: 422,
          userMessage: '이 사진으로는 그림을 못 만들었어요. 캐릭터가 화면 가득 나오게 다시 찍어 볼까요?',
        });
      }
      // 화면 비율 옵션을 모르는 모델이면 비율 없이 한 번 더
      if (r.status === 400 && useAspect && /imageConfig|aspect/i.test(apiMsg)) {
        useAspect = null;
        continue;
      }
      if (r.status === 404 || (r.status === 400 && /not found|not supported|unknown model/i.test(apiMsg))) {
        lastErr = new AiError(`모델 ${m} 사용 불가: ${apiMsg}`, { status: 502 });
        break; // 다음 모델
      }
      if (r.status === 429) {
        throw new AiError(`Gemini 사용량 초과: ${apiMsg}`, {
          status: 429,
          userMessage: '지금 친구들이 너무 많이 만들고 있어요! 10초 뒤에 다시 눌러 주세요.',
        });
      }
      if (r.status === 401 || r.status === 403) {
        throw new AiError(`Gemini 키 오류: ${apiMsg}`, { status: 503, userMessage: 'AI 연결 설정에 문제가 있어요. 선생님께 알려 주세요.' });
      }
      throw new AiError(`Gemini 오류 ${r.status}: ${apiMsg}`, { status: 502 });
    }
  }
  throw lastErr || new AiError('사용 가능한 모델 없음', { status: 502 });
}

/** 동시에 너무 많이 보내면 429가 나므로 줄을 세운다 */
function createLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => {
      active--;
      next();
    });
  };
  const run = (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
  run.stats = () => ({ active, waiting: queue.length });
  return run;
}

module.exports = { generateImage, createLimiter, AiError, FALLBACK_MODELS };
