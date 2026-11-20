'use strict';
/**
 * 캐릭터 변신 스타일 목록
 *  - id: 내부 이름 (바꾸지 마세요)
 *  - name / desc / emoji: 학생 화면에 보이는 글자
 *  - prompt: AI에게 보내는 영어 지시문 (그림 모양은 그대로 두고 "재질·화풍"만 바꾸도록 씀)
 *
 * 스타일을 추가하고 싶으면 아래 배열에 같은 모양으로 한 줄 더 넣으면 됩니다.
 */
const STYLES = [
  {
    id: 'felt',
    emoji: '🧶',
    name: '양모펠트 인형',
    desc: '보송보송 털실 인형',
    prompt:
      'a handmade needle-felted wool doll. Soft fuzzy wool fibers visible on every surface, slightly imperfect handmade shapes, ' +
      'tiny bead eyes or stitched details, photographed like a real craft object on a soft pastel fabric background with gentle studio light',
  },
  {
    id: 'anime2d',
    emoji: '✏️',
    name: '2D 애니메이션',
    desc: 'TV 만화 주인공처럼',
    prompt:
      'a 2D cel-shaded TV animation character. Clean bold line art, flat bright colors with simple two-tone shading, ' +
      'big expressive eyes, cheerful energetic pose, plain light background like a character model sheet',
  },
  {
    id: 'anime3d',
    emoji: '🎬',
    name: '3D 애니메이션',
    desc: '극장판 3D 영화처럼',
    prompt:
      'a 3D animated family-movie character. Smooth stylized 3D render, soft global illumination, subsurface skin shading, ' +
      'rounded appealing proportions, big expressive eyes, cinematic but simple pastel background',
  },
  {
    id: 'clay',
    emoji: '🏺',
    name: '클레이 인형',
    desc: '찰흙으로 빚은 스톱모션',
    prompt:
      'a stop-motion clay animation puppet made of plasticine. Visible fingerprints and sculpting marks, glossy clay surface, ' +
      'handmade miniature look, photographed on a tiny handmade set with warm light',
  },
  {
    id: 'brick',
    emoji: '🧱',
    name: '블록 장난감',
    desc: '조립 블록 미니피규어',
    prompt:
      'a toy figure built from colorful plastic interlocking building bricks, glossy plastic, visible studs, ' +
      'chunky blocky shapes, photographed like a toy product shot on a clean white background',
  },
  {
    id: 'pixel',
    emoji: '👾',
    name: '픽셀 게임',
    desc: '레트로 게임 캐릭터',
    prompt:
      'a 16-bit retro video game sprite. Crisp pixel art with a limited color palette, clear dark outline, ' +
      'cute game hero idle pose, simple pixel-art background',
  },
  {
    id: 'storybook',
    emoji: '🎨',
    name: '수채화 동화책',
    desc: '그림책 속 주인공',
    prompt:
      'a watercolor picture-book illustration. Soft watercolor washes, gentle colored-pencil outlines, warm paper texture, ' +
      'dreamy friendly mood, simple storybook scenery behind the character',
  },
  {
    id: 'sticker',
    emoji: '⭐',
    name: '반짝 스티커',
    desc: '흰 테두리 다이컷 스티커',
    prompt:
      'a cute die-cut vinyl sticker. Bold clean outline, bright cheerful colors, glossy finish, ' +
      'thick white border around the whole character, on a plain light gray background',
  },
  {
    id: 'papercraft',
    emoji: '✂️',
    name: '종이 공예',
    desc: '색종이를 오려 붙인 입체',
    prompt:
      'a layered paper-craft cut-out. Made from colored construction paper layers with visible cut edges, ' +
      'small paper shadows giving depth, handmade craft look, on a light paper background',
  },
];

const BASE_PROMPT = (style, extra) =>
  [
    'This photo shows a character that an elementary school student drew by hand on a worksheet.',
    `Recreate exactly this character as ${style.prompt}.`,
    'Keep the child\'s original design: same overall shape and proportions, same pose, same colors, same clothes, ' +
      'same accessories, same facial expression and every distinctive detail the child drew. It must clearly look like the same character.',
    'Ignore the paper, printed lines, printed text, hands and the table in the photo.',
    'Show only this one character, full body, centered, filling most of the frame.',
    'Cute, friendly and suitable for young children.',
    'Do not add any text, letters, numbers, logos or watermarks.',
    extra ? `About the character (only for small hints, do not change the design): ${extra}` : '',
  ]
    .filter(Boolean)
    .join(' ');

function findStyle(id) {
  return STYLES.find((s) => s.id === id) || null;
}

module.exports = { STYLES, BASE_PROMPT, findStyle };
