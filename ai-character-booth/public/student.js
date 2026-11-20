(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const TOKEN_KEY = 'booth-token';
  let token = localStorage.getItem(TOKEN_KEY);
  if (!token) {
    token = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(TOKEN_KEY, token);
  }

  const state = { config: null, photo: null, styleId: null, item: null };

  // 이름은 기기에 기억(다시 들어와도 편하게)
  for (const id of ['name', 'charName', 'intro']) {
    const el = $('#' + id);
    el.value = localStorage.getItem('booth-' + id) || '';
    el.addEventListener('input', () => localStorage.setItem('booth-' + id, el.value));
  }

  function msg(text, kind = 'bad') {
    $('#global-msg').innerHTML = text ? `<div class="notice ${kind}"></div>` : '';
    if (text) $('#global-msg .notice').textContent = text;
    if (text) window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function show(step) {
    document.querySelectorAll('.step').forEach((s) => s.classList.toggle('hidden', s.dataset.step !== String(step)));
    const n = step === 'wait' ? 3 : Number(step);
    document.querySelectorAll('#steps span').forEach((el, i) => {
      el.className = i + 1 === n ? 'on' : i + 1 < n ? 'done' : '';
    });
    window.scrollTo({ top: 0 });
  }

  async function api(path, body) {
    const res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
    let data = {};
    try {
      data = await res.json();
    } catch {
      /* */
    }
    if (!res.ok) throw new Error(data.error || '인터넷 연결을 확인해 주세요.');
    return data;
  }

  function renderTries(left) {
    const t = `남은 변신 횟수: ${left} / ${state.config.maxTries}`;
    $('#triesInfo').textContent = t;
    $('#triesInfo2').textContent = left > 0 ? t : '변신 횟수를 다 썼어요. 마음에 들면 패들렛에 보내 주세요!';
    $('#again').disabled = left <= 0;
    $('#go').disabled = left <= 0 || !state.styleId;
  }

  async function loadConfig() {
    try {
      state.config = await api('/api/config?token=' + token);
    } catch (e) {
      msg(e.message);
      return;
    }
    const c = state.config;
    $('#title').textContent = c.title;
    document.title = c.title;
    if (!c.aiReady) msg('아직 부스 준비 중이에요. 선생님이 AI를 연결하면 시작할 수 있어요!', 'warn');
    if (!c.padletOn) $('#send').textContent = '📤 선생님께 보내기';
    const box = $('#styles');
    box.innerHTML = '';
    for (const s of c.styles) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'style-card';
      b.dataset.id = s.id;
      b.innerHTML = `<span class="emoji"></span><span class="name"></span><span class="desc"></span>`;
      b.querySelector('.emoji').textContent = s.emoji;
      b.querySelector('.name').textContent = s.name;
      b.querySelector('.desc').textContent = s.desc;
      b.addEventListener('click', () => {
        state.styleId = s.id;
        box.querySelectorAll('.style-card').forEach((x) => x.classList.toggle('on', x === b));
        renderTries(state.config.triesLeft);
      });
      box.appendChild(b);
    }
    renderTries(c.triesLeft);
  }

  // ── 1단계
  $('#to2').addEventListener('click', () => {
    if (!$('#name').value.trim()) {
      msg('이름(별명)을 적어 주세요!');
      $('#name').focus();
      return;
    }
    msg('');
    show(2);
  });

  // ── 2단계: 사진 (긴 변 1280px JPEG로 줄여서 보냄)
  async function resize(file, max = 1280) {
    let src;
    try {
      src = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      src = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('사진을 열 수 없어요. 다른 사진으로 해 볼까요?'));
        img.src = URL.createObjectURL(file);
      });
    }
    const w = src.width, h = src.height;
    const k = Math.min(1, max / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * k);
    c.height = Math.round(h * k);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(src, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.88);
  }

  async function onFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      state.photo = await resize(file);
      $('#photoBox').innerHTML = '';
      const img = document.createElement('img');
      img.src = state.photo;
      img.alt = '내가 찍은 그림';
      $('#photoBox').appendChild(img);
      $('#shoot').textContent = '📷 다시 찍기';
      $('#to3').disabled = false;
      msg('');
    } catch (err) {
      msg(err.message);
    }
  }
  $('#camera').addEventListener('change', onFile);
  $('#album').addEventListener('change', onFile);
  $('#shoot').addEventListener('click', () => $('#camera').click());
  $('#pick').addEventListener('click', () => $('#album').click());
  $('#back1').addEventListener('click', () => show(1));
  $('#to3').addEventListener('click', () => state.photo && show(3));

  // ── 3단계: 변신
  $('#back2').addEventListener('click', () => show(2));

  const WAIT_MSGS = [
    'AI가 그림을 살펴보는 중…',
    '캐릭터의 특징을 기억하는 중…',
    '재료를 고르는 중…',
    '색을 칠하는 중…',
    '반짝반짝 마무리 중…',
    '거의 다 됐어요!',
  ];

  $('#go').addEventListener('click', async () => {
    if (!state.photo || !state.styleId) return;
    msg('');
    show('wait');
    let i = 0;
    let pct = 3;
    $('#bar').style.width = pct + '%';
    $('#waitMsg').textContent = WAIT_MSGS[0];
    const timer = setInterval(() => {
      i++;
      pct = Math.min(95, pct + (95 - pct) * 0.08);
      $('#bar').style.width = pct + '%';
      if (i % 5 === 0) $('#waitMsg').textContent = WAIT_MSGS[Math.min(WAIT_MSGS.length - 1, i / 5)];
    }, 1000);
    try {
      const item = await api('/api/generate', {
        token,
        name: $('#name').value,
        charName: $('#charName').value,
        intro: $('#intro').value,
        styleId: state.styleId,
        image: state.photo,
      });
      state.item = item;
      state.config.triesLeft = item.triesLeft;
      $('#bar').style.width = '100%';
      $('#resOrig').src = state.photo;
      $('#resAi').src = item.resultUrl;
      $('#resStyle').textContent = `${item.styleEmoji} ${item.styleName}`;
      $('#sendArea').classList.remove('hidden');
      $('#doneArea').classList.add('hidden');
      $('#send').disabled = false;
      renderTries(item.triesLeft);
      show(4);
    } catch (e) {
      show(3);
      msg(e.message);
    } finally {
      clearInterval(timer);
    }
  });

  // ── 4단계: 보내기
  $('#again').addEventListener('click', () => {
    msg('');
    show(3);
  });

  $('#send').addEventListener('click', async () => {
    if (!state.item) return;
    $('#send').disabled = true;
    $('#send').textContent = '📤 보내는 중…';
    try {
      const r = await api('/api/send', { token, id: state.item.id });
      $('#sendArea').classList.add('hidden');
      $('#doneArea').classList.remove('hidden');
      if (r.padlet.status === 'error') {
        $('#doneMsg').textContent = '선생님 화면에는 잘 도착했어요! (패들렛은 선생님이 다시 올려 줄 거예요) 사진으로 뽑아 줄 때까지 기다려 주세요!';
      }
      const a = $('#save');
      a.href = state.item.resultUrl;
      a.download = `내캐릭터-${state.item.styleName}.${state.item.resultUrl.split('.').pop()}`;
    } catch (e) {
      msg(e.message);
      $('#send').disabled = false;
    } finally {
      $('#send').textContent = state.config.padletOn ? '📤 패들렛에 보내기' : '📤 선생님께 보내기';
    }
  });

  $('#restart').addEventListener('click', () => {
    state.photo = null;
    state.item = null;
    state.styleId = null;
    $('#photoBox').innerHTML = '<div class="muted"><div class="big-emoji">🖼️</div>아래 버튼을 눌러<br />학습지의 캐릭터를 찍어 주세요</div>';
    $('#shoot').textContent = '📷 카메라로 찍기';
    $('#to3').disabled = true;
    document.querySelectorAll('.style-card').forEach((x) => x.classList.remove('on'));
    loadConfig();
    show(1);
  });

  loadConfig();
  show(1);
})();
