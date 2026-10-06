'use strict';
// 금지어 필터: 이름은 막고, 채팅/방명록은 *** 로 가림
// 띄어쓰기·숫자·특수문자·전각문자·대소문자를 무시하고 비교해서 "시 발", "시1발", "ＦＵＣＫ" 같은 변형도 잡음

// 관리자 페이지에서 한 번도 저장하지 않았을 때 쓰는 기본 목록
// 일상 표현과 겹치는 단어(꺼져 → "촛불이 꺼져요", 보지 → "보지 마", 새끼 → "새끼손가락")는 일부러 뺐음
const DEFAULT_BANNED = [
  '시발', '씨발', '씨빨', '씨팔', '시팔', '씨바', 'ㅅㅂ', 'ㅆㅂ', 'ㅆㅃ',
  '병신', '븅신', '빙신', 'ㅂㅅ', '등신',
  '좆', '존나', '졸라', 'ㅈㄴ', 'ㅈㄹ', '지랄',
  '개새끼', '개새', 'ㅅㄲ', '개년', '썅',
  '미친놈', '미친년', '미친새끼', '또라이', '닥쳐', '엿먹어', '염병',
  '니애미', '느금마', '느그애미', '애미뒤진', '애비없는',
  '섹스',
  'fuck', 'shit', 'bitch', 'asshole', 'pussy',
];

const HANGUL = /[가-힣ㄱ-ㆎ]/; // 완성형 글자, 호환 자모(ㄱ, ㅏ …)
const KEEP = /[가-힣ㄱ-ㆎa-z]/;

// 비교용 글자 목록: [{ ch, at }] — at은 원래 문자열에서의 위치(코드포인트 기준)
function normChars(text) {
  const chars = Array.from(String(text ?? '').normalize('NFC'));
  const out = [];
  chars.forEach((c, at) => {
    // 한글은 그대로(NFKC를 쓰면 ㅅ 같은 자모가 다른 코드로 바뀜), 나머지는 전각→반각 + 소문자
    const n = HANGUL.test(c) ? c : c.normalize('NFKC').toLowerCase();
    for (const ch of n) if (KEEP.test(ch)) out.push({ ch, at });
  });
  return { chars, out };
}

const normalizeWord = (w) => normChars(w).out.map((x) => x.ch).join('');

function createFilter(initial = DEFAULT_BANNED) {
  let words = [];
  const set = (list) => {
    words = [...new Set((list || []).map(normalizeWord).filter((w) => w && Array.from(w).length <= 20))].slice(0, 300);
  };
  set(initial);

  // 정규화된 문자열에서 금지어가 나오는 구간들 [시작, 끝)
  function ranges(norm) {
    const found = [];
    for (const w of words) {
      let from = 0;
      for (;;) {
        const i = norm.indexOf(w, from);
        if (i === -1) break;
        found.push([i, i + w.length]);
        from = i + 1;
      }
    }
    return found;
  }

  return {
    get words() { return words.slice(); },
    set,
    has(text) {
      const { out } = normChars(text);
      return ranges(out.map((x) => x.ch).join('')).length > 0;
    },
    // 금지어 부분(사이에 끼운 기호 포함)을 *로 바꿈. 띄어쓰기·줄바꿈은 유지
    mask(text) {
      const { chars, out } = normChars(text);
      // 정규화 문자열의 인덱스 = UTF-16 인덱스이므로 글자 단위 위치로 다시 매핑
      const units = [];
      out.forEach((x, k) => { for (let u = 0; u < x.ch.length; u++) units.push(k); });
      const found = ranges(out.map((x) => x.ch).join(''));
      if (!found.length) return chars.join('');
      const hide = new Array(chars.length).fill(false);
      for (const [s, e] of found) {
        const a = out[units[s]].at;
        const b = out[units[e - 1]].at;
        for (let i = a; i <= b; i++) hide[i] = true;
      }
      return chars.map((c, i) => (hide[i] && !/\s/.test(c) ? '*' : c)).join('');
    },
  };
}

module.exports = { createFilter, normalizeWord, DEFAULT_BANNED };
