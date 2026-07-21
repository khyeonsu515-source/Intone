// ─────────────────────────────────────────────
// 같은 사건을 다룬 기사끼리 묶기 (주제 클러스터링)
// AI API는 전혀 호출하지 않는다 — 키워드 추출은 빈도 기반 로컬 연산,
// 매칭은 Firestore 쿼리 + 로컬 자카드 유사도 계산만으로 처리한다.
// ─────────────────────────────────────────────

/*
  한국어 조사/어미 접미사 목록입니다. 형태소 분석기 없이 문자열 규칙만으로
  단어의 뒷부분을 잘라내는 방식이라 완벽하지 않지만, AI 호출 없이 "제목/본문에
  자주 등장하는 핵심 단어"를 뽑아내는 데는 충분합니다. 긴 접미사부터 검사해야
  "으로서는" 같은 긴 조사가 "는"만 잘리고 마는 실수를 피할 수 있습니다.
*/
const LOCAL_PARTICLE_SUFFIXES = [
  "으로서는", "으로써는", "이라고는", "이라면서", "라고까지", "에서부터", "으로부터", "에게서는",
  "이라고", "라고는", "까지는", "부터는", "에서는", "에게는", "한테는", "으로는", "로서는", "로써는",
  "이지만", "였지만", "했지만", "라며", "이며", "에는", "에도", "와도", "과도", "이나", "라도",
  "이라", "으로", "에서", "에게", "한테", "까지", "부터", "조차", "마저", "밖에", "처럼", "만큼", "보다",
  "라서", "여서", "해서", "되어", "돼서",
  "은", "는", "이", "가", "을", "를", "의", "도", "만", "과", "와", "에", "로", "나", "랑"
];

/*
  어느 기사에나 흔히 등장해서 "이 사건만의" 식별력이 없는 단어들입니다.
  조사를 뗀 뒤의 형태(어간)를 기준으로 등록합니다.
*/
const LOCAL_KEYWORD_STOPWORDS = new Set([
  "정부", "오늘", "최근", "발표", "관련", "대한", "통해", "위해", "이번", "지난", "지난해", "올해",
  "기자", "사진", "연합뉴스", "뉴스", "기사", "내용", "경우", "때문", "모습", "생각", "사람", "문제",
  "상황", "이후", "현재", "진행", "계획", "예정", "입장", "설명", "강조", "전망", "분석", "확인",
  "공개", "공식", "전체", "일부", "다양", "다수", "각각", "해당", "우리", "국민", "사회", "경제",
  "정치", "세계", "국내", "국제", "오전", "오후", "이날", "한편", "가운데", "무단", "전재", "재배포",
  "금지", "제공", "출처", "영상", "캡처"
]);

// 조사를 뗀 형태가 여전히 서술형 어미(했다/한다/된다/있다/없다 등)로 끝나면 제외합니다.
const LOCAL_VERB_ENDING_PATTERN = /(했다|였다|한다|된다|있다|없다|됐다|간다|온다|든다|낸다|났다|졌다)$/;

/*
  stripLocalParticle: 단어 끝에서 가장 먼저 매칭되는 조사를 하나 떼어냅니다.
  (긴 접미사부터 검사) 뗀 뒤 남는 부분이 2글자 미만이면 원래 단어를 그대로 둡니다
  — 짧은 어간만 남기면 오히려 의미를 알아볼 수 없는 조각이 되기 때문입니다.
*/
function stripLocalParticle(token) {
  for (const suffix of LOCAL_PARTICLE_SUFFIXES) {
    if (token.length - suffix.length >= 2 && token.endsWith(suffix)) {
      return token.slice(0, -suffix.length);
    }
  }
  return token;
}

/*
  isLocalKeywordCandidate: 조사를 뗀 단어가 키워드 후보로 쓸 만한지 검사합니다.
  너무 짧거나, 불용어이거나, 서술형 어미로 끝나거나, 4자리가 아닌 순수 숫자면 제외합니다.
  (4자리 숫자는 "2026년"처럼 연도를 나타내는 경우가 많아 남겨둡니다.)
*/
function isLocalKeywordCandidate(token) {
  if (token.length < 2) {
    return false;
  }
  if (LOCAL_KEYWORD_STOPWORDS.has(token)) {
    return false;
  }
  if (LOCAL_VERB_ENDING_PATTERN.test(token)) {
    return false;
  }
  if (/^\d+$/.test(token) && token.length !== 4) {
    return false;
  }
  return true;
}

/*
  tokenizeLocalText: 텍스트를 한글/영문/숫자가 아닌 문자(공백, 문장부호 등) 기준으로
  나눈 뒤, 각 조각에서 조사를 떼고 후보 검사를 통과한 단어만 남깁니다.
*/
function tokenizeLocalText(text) {
  return String(text || "")
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => stripLocalParticle(token))
    .filter((token) => isLocalKeywordCandidate(token));
}

/*
  CATEGORY_KEYWORD_DICTIONARY: 9개 대분류마다 그 분야를 대표하는 단어 목록입니다.
  classifyLocalCategory가 이 사전으로 새 주제의 카테고리를 로컬에서 판단합니다
  (AI 호출 없음). 완벽한 분류기가 아니라 "대략 어느 분야인가"를 가늠하는
  용도이며, 어느 사전에도 뚜렷이 걸리지 않으면 "기타"로 분류됩니다.
*/
const CATEGORY_KEYWORD_DICTIONARY = {
  "정치": ["대통령", "국회", "국무총리", "여당", "야당", "국민의힘", "민주당", "법안", "탄핵", "총선", "대선", "청와대", "국정감사", "외교부", "국방부", "의원", "정당", "개헌", "특검", "여야"],
  "경제": ["금리", "증시", "코스피", "코스닥", "환율", "물가", "수출", "수입", "기업", "실적", "부동산", "세제", "종합부동산세", "고용", "실업률", "투자", "주가", "한국은행", "금융위", "경기", "무역수지", "다주택자"],
  "사회": ["검찰", "경찰", "화재", "교육부", "학교", "노동조합", "파업", "복지", "연금", "범죄", "판결", "법원", "사건", "사고", "재판", "시위", "집회"],
  "국제": ["미국", "중국", "일본", "러시아", "우크라이나", "유엔", "정상회담", "외신", "나토", "유럽연합", "이스라엘", "팔레스타인", "대만", "북한"],
  "문화": ["전시", "공연", "출판", "축제", "종교", "박물관", "문화재", "도서", "미술관", "문학"],
  "과학기술": ["인공지능", "우주", "연구", "과학", "기술", "반도체", "로봇", "양자", "나사", "위성", "개발자", "소프트웨어", "스타트업"],
  "스포츠": ["축구", "야구", "농구", "배구", "올림픽", "월드컵", "프로야구", "국가대표", "선수", "감독", "경기", "리그", "챔피언스리그", "메달", "태권도"],
  "연예": ["배우", "가수", "드라마", "영화", "아이돌", "예능", "콘서트", "앨범", "컴백", "방송", "연예인", "캐스팅"]
};

/*
  classifyLocalCategory: 이 기사의 키워드와 원문 텍스트를 CATEGORY_KEYWORD_DICTIONARY와
  대조해서 가장 점수가 높은 카테고리를 고릅니다. 사전 단어가 이 사건의 대표
  키워드로 이미 뽑혔으면(더 확실한 신호) 2점, 원문에 등장만 했으면 1점을 줍니다.
  어느 카테고리도 CATEGORY_MIN_SCORE를 못 넘으면 "기타"를 반환합니다.
*/
function classifyLocalCategory(keywords, combinedText) {
  const text = String(combinedText || "");
  const keywordSet = new Set(keywords);
  let bestCategory = null;
  let bestScore = 0;

  for (const [category, dictionaryWords] of Object.entries(CATEGORY_KEYWORD_DICTIONARY)) {
    let score = 0;
    for (const dictWord of dictionaryWords) {
      if (keywordSet.has(dictWord)) {
        score += 2;
      } else if (text.includes(dictWord)) {
        score += 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestCategory = category;
    }
  }

  return bestScore >= CATEGORY_MIN_SCORE ? bestCategory : "기타";
}

/*
  STANCE_NEGATIVE_WORDS / STANCE_POSITIVE_WORDS: 감성 단어 사전 기반으로 기사의
  논조를 가늠하기 위한 목록입니다. computeLocalStance가 본문에서 이 단어들의
  등장 횟수를 세어 순(긍정-부정) 점수를 계산합니다.

  한계: 이건 단어 등장만 세는 방식이라 부정어("문제가 없다"의 "없다"를 긍정으로
  잘못 셀 수 있음)나 문맥(비판 대상이 누구인지)을 이해하지 못합니다. AI 기반
  논조 판단보다 정확도가 확실히 낮습니다 — API 호출 없이 대략적인 신호만
  주는 용도로만 쓰세요.
*/
const STANCE_NEGATIVE_WORDS = [
  "논란", "우려", "비판", "반발", "불만", "항의", "혼란", "피해", "사고", "실패", "부작용", "저하",
  "악화", "위기", "갈등", "의혹", "잘못", "책임", "규탄", "반대", "충격", "참사", "폭로", "파문",
  "분노", "불안", "침체", "폭락", "적자", "부실", "은폐", "조작", "왜곡", "질타", "경고", "제재",
  "기소", "구속", "해고", "붕괴"
];
const STANCE_POSITIVE_WORDS = [
  "성과", "호평", "환영", "기대", "개선", "성공", "협력", "합의", "지지", "극복", "회복", "안정",
  "성장", "발전", "혁신", "모범", "감사", "축하", "화답", "쾌거", "수상", "달성", "호조", "해결", "박수"
];

function countOccurrences(text, word) {
  if (!word) {
    return 0;
  }
  let count = 0;
  let index = text.indexOf(word);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(word, index + word.length);
  }
  return count;
}

/*
  computeLocalStance: 본문에서 부정/긍정 단어 등장 횟수를 세어 순 점수를 구하고,
  STANCE_WEAK_THRESHOLD/STANCE_STRONG_THRESHOLD 기준으로 5단계 중 하나로
  매핑합니다. AI 호출 없이 기사마다 로컬에서 계산합니다.
*/
function computeLocalStance(text) {
  const normalized = String(text || "");
  let negativeCount = 0;
  let positiveCount = 0;

  for (const word of STANCE_NEGATIVE_WORDS) {
    negativeCount += countOccurrences(normalized, word);
  }
  for (const word of STANCE_POSITIVE_WORDS) {
    positiveCount += countOccurrences(normalized, word);
  }

  const netScore = positiveCount - negativeCount;

  if (netScore <= -STANCE_STRONG_THRESHOLD) return "매우 부정적";
  if (netScore <= -STANCE_WEAK_THRESHOLD) return "약간 부정적";
  if (netScore >= STANCE_STRONG_THRESHOLD) return "매우 긍정적";
  if (netScore >= STANCE_WEAK_THRESHOLD) return "약간 긍정적";
  return "중립적";
}

/*
  keywordsEquivalent: 두 키워드를 "같은 대상"으로 볼지 판단합니다. 완전히
  같으면 당연히 같은 것이고, 그렇지 않더라도 한쪽이 다른 쪽의 접두어이면 같은
  것으로 봅니다 — 한국어 기관/학교명은 뒷부분을 잘라 줄여 쓰는 경우가 많아서
  ("배재고등학교" → "배재고") 문자열이 완전히 같지 않아도 실제로는 같은 대상을
  가리키는 경우가 흔하기 때문입니다. 접두어가 너무 짧으면(1글자) 우연히 겹칠
  수 있으므로 최소 2글자는 되어야 인정합니다.
*/
function keywordsEquivalent(a, b) {
  if (a === b) {
    return true;
  }
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return shorter.length >= 2 && longer.startsWith(shorter);
}

/*
  compareKeywordSets: 두 키워드 배열 사이에서 keywordsEquivalent 기준으로 서로
  짝지어지는 개수(overlapCount)와 합집합 크기(unionSize)를 구합니다. 각 단어는
  최대 한 번만 짝지어지도록(bUsed) 해서 같은 상대와 중복으로 여러 번 겹친 것으로
  잘못 세지 않게 합니다.
*/
function compareKeywordSets(a, b) {
  const bMatched = new Array(b.length).fill(false);
  let overlapCount = 0;

  for (const wordA of a) {
    const matchIndex = b.findIndex((wordB, idx) => !bMatched[idx] && keywordsEquivalent(wordA, wordB));
    if (matchIndex !== -1) {
      bMatched[matchIndex] = true;
      overlapCount += 1;
    }
  }

  return { overlapCount, unionSize: a.length + b.length - overlapCount };
}

/*
  mergeKeywordLists: 기존 주제의 키워드 목록에 이 기사의 키워드를 합칩니다.
  Set으로 단순 합치면 "배재고"와 "배재고등학교"가 서로 다른 항목으로 둘 다
  남아서 목록만 계속 늘어나므로, keywordsEquivalent로 이미 있는 항목과 같은
  대상이면 추가하지 않고, 대신 더 긴(더 구체적인) 표기로 교체합니다.
*/
function mergeKeywordLists(existing, incoming, cap) {
  const merged = [...existing];

  for (const word of incoming) {
    const matchIndex = merged.findIndex((existingWord) => keywordsEquivalent(existingWord, word));
    if (matchIndex === -1) {
      merged.push(word);
    } else if (word.length > merged[matchIndex].length) {
      merged[matchIndex] = word;
    }
  }

  return merged.slice(0, cap);
}

/*
  extractLocalKeywords: AI 없이 제목/본문에서 이 기사를 대표할 만한 키워드를
  뽑습니다. 두 단계로 나뉩니다.

  ① 빈도 기반 1차 후보 선정: 제목(og_title/page_title/link_text)에 등장한
     단어는 본문 단어보다 LOCAL_KEYWORD_TITLE_WEIGHT배 더 중요하게 취급하고,
     점수가 높은 순으로 LOCAL_KEYWORD_CANDIDATE_POOL개까지만 추립니다.

  ② IDF(역문서빈도) 재가중: "이 기사에 얼마나 자주 나왔는가"만으로는 "정부",
     "발표"처럼 어느 기사에나 흔한 단어가 상위권에 오를 수 있습니다. 그래서
     Firestore의 wordStats 컬렉션에서 "지금까지 분석한 기사들 중 이 단어가
     키워드로 뽑힌 횟수"를 조회해서, 그 횟수가 많을수록(=흔한 단어일수록)
     점수를 나눠서 깎습니다. 아직 한 번도 안 나온 단어(문서 빈도 0)는 나누는
     값이 가장 작아서(log2(2)=1) 원래 점수 그대로 유지되고, 자주 나온 단어일수록
     점수가 로그 스케일로 줄어듭니다. Firestore 조회가 실패해도(오프라인 등)
     조용히 건너뛰고 빈도 점수만으로 순위를 매깁니다 — AI 호출은 어느 경우에도
     발생하지 않습니다.
*/
async function extractLocalKeywords(analysisInput) {
  const titleText = [analysisInput?.og_title, analysisInput?.page_title, analysisInput?.link_text]
    .filter(Boolean)
    .join(" ");
  const bodyText = analysisInput?.article_text || "";

  const titleTokens = tokenizeLocalText(titleText);
  const bodyTokens = tokenizeLocalText(bodyText);
  const titleTokenSet = new Set(titleTokens);

  const scoreByToken = new Map();
  const addScore = (token, weight) => {
    scoreByToken.set(token, (scoreByToken.get(token) || 0) + weight);
  };
  titleTokens.forEach((token) => addScore(token, LOCAL_KEYWORD_TITLE_WEIGHT));
  bodyTokens.forEach((token) => addScore(token, 1));

  const candidates = [...scoreByToken.entries()]
    .filter(([token, score]) => score >= LOCAL_KEYWORD_MIN_SCORE || titleTokenSet.has(token))
    .sort((a, b) => b[1] - a[1])
    .slice(0, LOCAL_KEYWORD_CANDIDATE_POOL);

  const docFrequencies = await fetchCandidateDocumentFrequencies(candidates.map(([token]) => token));

  return candidates
    .map(([token, score]) => [token, score / Math.log2(2 + (docFrequencies.get(token) || 0))])
    .sort((a, b) => b[1] - a[1])
    .map(([token]) => token)
    .slice(0, LOCAL_KEYWORD_MAX_COUNT);
}


// ─────────────────────────────────────────────
// Firestore REST 헬퍼 (클러스터링 전용, 최소 구성)
// ─────────────────────────────────────────────

async function getFirebaseConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      [FIREBASE_PROJECT_ID_STORAGE_KEY, FIREBASE_API_KEY_STORAGE_KEY],
      (items) => {
        const projectId = (typeof items[FIREBASE_PROJECT_ID_STORAGE_KEY] === "string"
          ? items[FIREBASE_PROJECT_ID_STORAGE_KEY].trim()
          : "") || FIREBASE_DEFAULT_PROJECT_ID;
        const apiKey = (typeof items[FIREBASE_API_KEY_STORAGE_KEY] === "string"
          ? items[FIREBASE_API_KEY_STORAGE_KEY].trim()
          : "") || FIREBASE_DEFAULT_API_KEY;
        resolve(projectId && apiKey ? { projectId, apiKey } : null);
      }
    );
  });
}

function encodeFirestoreValue(value) {
  if (value === null || value === undefined) {
    return { nullValue: null };
  }
  if (typeof value === "boolean") {
    return { booleanValue: value };
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(encodeFirestoreValue) } };
  }
  if (typeof value === "object") {
    return { mapValue: { fields: objectToFirestoreFields(value) } };
  }
  return { stringValue: String(value) };
}

function objectToFirestoreFields(obj) {
  const fields = {};
  for (const [key, value] of Object.entries(obj || {})) {
    fields[key] = encodeFirestoreValue(value);
  }
  return fields;
}

function decodeFirestoreValue(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  if ("stringValue" in value) return value.stringValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("booleanValue" in value) return Boolean(value.booleanValue);
  if ("nullValue" in value) return null;
  if ("mapValue" in value) return firestoreFieldsToObject(value.mapValue?.fields);
  if ("arrayValue" in value) return (value.arrayValue?.values || []).map(decodeFirestoreValue);
  return null;
}

function firestoreFieldsToObject(fields) {
  const obj = {};
  for (const [key, value] of Object.entries(fields || {})) {
    obj[key] = decodeFirestoreValue(value);
  }
  return obj;
}

/*
  queryTopicsByKeywords: topics 컬렉션에서 keywords 배열이 이 기사의 키워드 중
  하나라도 포함하는 문서를 찾습니다. Firestore의 ARRAY_CONTAINS_ANY는 값을
  최대 10개까지만 받으므로 상위 10개만 사용합니다.
*/
async function queryTopicsByKeywords(config, keywords) {
  const endpoint = `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/(default)/documents:runQuery?key=${config.apiKey}`;
  const body = JSON.stringify({
    structuredQuery: {
      from: [{ collectionId: TOPICS_COLLECTION }],
      where: {
        fieldFilter: {
          field: { fieldPath: "keywords" },
          op: "ARRAY_CONTAINS_ANY",
          value: { arrayValue: { values: keywords.slice(0, 10).map((kw) => ({ stringValue: kw })) } }
        }
      },
      limit: TOPIC_QUERY_LIMIT
    }
  });

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
  });

  if (!response.ok) {
    console.warn("[Intone/Topics] 후보 주제 조회 실패", response.status, await response.text());
    return [];
  }

  const rows = await response.json();
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row?.document?.fields)
    .map((row) => {
      const id = String(row.document.name || "").split("/").pop();
      return { id, ...firestoreFieldsToObject(row.document.fields) };
    });
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/*
  saveFirestoreDoc: {collection}/{docId} 문서를 통째로 써넣습니다(PATCH — 없으면
  생성, 있으면 덮어씀). topics/articles/wordStats 세 컬렉션이 모두 이 함수를
  공유합니다.
*/
async function saveFirestoreDoc(config, collection, docId, data) {
  const endpoint = `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/(default)/documents/${collection}/${docId}?key=${config.apiKey}`;
  const response = await fetch(endpoint, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields: objectToFirestoreFields(data) })
  });

  if (!response.ok) {
    console.warn("[Intone/Topics] 문서 저장 실패", collection, response.status, await response.text());
  }
}

/*
  getFirestoreDoc: {collection}/{docId} 문서 하나를 읽습니다. 없으면(404) null을
  반환합니다.
*/
async function getFirestoreDoc(config, collection, docId) {
  const endpoint = `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/(default)/documents/${collection}/${docId}?key=${config.apiKey}`;
  const response = await fetch(endpoint, { method: "GET" });

  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    console.warn("[Intone/Topics] 문서 조회 실패", collection, response.status, await response.text());
    return null;
  }

  const doc = await response.json();
  return firestoreFieldsToObject(doc.fields);
}

/*
  fetchWordDocumentFrequencies: wordStats 컬렉션에서 주어진 단어들의 누적 등장
  문서 수(count)를 한 번의 batchGet 요청으로 모두 가져옵니다. 등록된 적 없는
  단어는 결과에 아예 나타나지 않으므로(=문서 빈도 0으로 취급) 별도 처리가
  필요 없습니다.
*/
async function fetchWordDocumentFrequencies(config, words) {
  if (!words.length) {
    return new Map();
  }

  const docIds = await Promise.all(words.map((word) => sha256Hex(word)));
  const documents = docIds.map(
    (docId) => `projects/${config.projectId}/databases/(default)/documents/${WORD_STATS_COLLECTION}/${docId}`
  );

  const endpoint = `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/(default)/documents:batchGet?key=${config.apiKey}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ documents })
  });

  if (!response.ok) {
    console.warn("[Intone/Topics] 단어 문서 빈도 조회 실패", response.status, await response.text());
    return new Map();
  }

  const rows = await response.json();
  const freqByWord = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row?.found) {
      continue;
    }
    const fields = firestoreFieldsToObject(row.found.fields);
    if (typeof fields.word === "string") {
      freqByWord.set(fields.word, Number(fields.count) || 0);
    }
  }
  return freqByWord;
}

/*
  fetchCandidateDocumentFrequencies: extractLocalKeywords 안에서만 쓰는 얇은
  래퍼입니다. Firebase 설정이 없거나 네트워크 오류가 나면 조용히 빈 Map을
  반환해서, IDF 재가중 없이 빈도 점수만으로도 키워드 추출이 정상적으로
  이어지게 합니다(클러스터링과 마찬가지로 실패해도 분석 자체는 막지 않음).
*/
async function fetchCandidateDocumentFrequencies(words) {
  if (!words.length) {
    return new Map();
  }
  try {
    const config = await getFirebaseConfig();
    if (!config) {
      return new Map();
    }
    return await fetchWordDocumentFrequencies(config, words);
  } catch (error) {
    console.warn("[Intone/Topics] 단어 문서 빈도 조회 오류", error);
    return new Map();
  }
}

/*
  bumpWordStats: 최종적으로 이 기사의 키워드로 선택된 단어들의 누적 등장
  문서 수를 1씩 늘립니다. 읽고-다시 쓰는 방식이라 완벽하게 원자적이지는
  않지만(동시에 같은 단어가 여러 번 색인되면 카운트가 한두 번 덜 늘 수 있음),
  이 값은 "대략 얼마나 흔한 단어인가"를 가늠하는 휴리스틱일 뿐이라 약간의
  오차는 문제가 되지 않습니다.
*/
async function bumpWordStats(config, words) {
  await Promise.all(words.map(async (word) => {
    try {
      const docId = await sha256Hex(word);
      const existing = await getFirestoreDoc(config, WORD_STATS_COLLECTION, docId);
      const nextCount = (Number(existing?.count) || 0) + 1;
      await saveFirestoreDoc(config, WORD_STATS_COLLECTION, docId, { word, count: nextCount });
    } catch (error) {
      console.warn("[Intone/Topics] 단어 통계 갱신 오류", word, error);
    }
  }));
}

/*
  pickBestTopicMatch: 후보 주제들 중 이 기사의 키워드와 가장 많이 겹치는 것을
  고릅니다. compareKeywordSets가 keywordsEquivalent(완전 일치 또는 접두어 관계)
  기준으로 겹침을 셉니다. 겹치는 개수가 TOPIC_MATCH_MIN_OVERLAP 미만이거나
  자카드 유사도가 TOPIC_MATCH_MIN_JACCARD 미만이면 후보에서 제외합니다 —
  로컬 키워드 추출은 AI보다 노이즈가 많아서, 흔한 단어 하나만 겹쳐도 묶이면
  전혀 다른 사건까지 잘못 합쳐질 수 있기 때문입니다.
*/
function pickBestTopicMatch(candidates, keywords) {
  let best = null;
  let bestJaccard = -1;

  for (const candidate of candidates) {
    const candidateKeywords = Array.isArray(candidate.keywords) ? candidate.keywords : [];
    const { overlapCount, unionSize } = compareKeywordSets(candidateKeywords, keywords);
    if (overlapCount < TOPIC_MATCH_MIN_OVERLAP) {
      continue;
    }

    const jaccard = unionSize ? overlapCount / unionSize : 0;
    if (jaccard < TOPIC_MATCH_MIN_JACCARD) {
      continue;
    }

    if (jaccard > bestJaccard) {
      bestJaccard = jaccard;
      best = candidate;
    }
  }

  return best;
}

/*
  indexArticleLocalTopic: 방금 분석을 마친 기사를 로컬 키워드로 색인합니다.
  analysisInput(제목/본문)에서 키워드를 직접 뽑는 것부터 이 함수 안에서
  처리합니다(extractLocalKeywords는 IDF 재가중을 위해 Firestore 조회가 필요한
  비동기 함수라서, 호출 지점을 이 함수 하나로 모아둡니다).

  겹치는 키워드를 가진 기존 주제가 있고 자카드 유사도 기준을 넘으면 그 주제에
  합류시키고, 아니면 새 주제를 만듭니다. 새 주제일 때만 두 가지를 추가로
  합니다 — ① classifyLocalCategory로 9개 대분류 중 하나를 로컬에서 매기고
  (AI 호출 없음, 기존 주제에 합류할 때는 이미 정해진 category를 그대로 유지),
  ② credentials가 있으면 AI에게 자연스러운 한 문장 라벨을 딱 한 번 물어봅니다
  (실패하거나 credentials가 없으면 키워드를 이어붙인 라벨로 대체) — 이 AI
  호출은 기사마다가 아니라 "새로 생기는 사건 수"만큼만 발생합니다.

  이 기사 자체는 topicId를 붙여 별도의 articles 컬렉션에 저장하며, 여기에는
  computeLocalStance로 계산한 논조(stance)도 함께 담습니다(이건 기사마다
  다를 수 있어 매번 로컬에서 다시 계산). 마지막으로 이 기사의 키워드들을
  wordStats에 반영해서 다음 기사의 IDF 계산에 쓰입니다. handleAnalyzeRequest가
  분석 완료 후 결과를 보여준 뒤 조용히 호출합니다(실패해도 사용자에게 보여줄
  결과에는 영향 없음).
*/
async function indexArticleLocalTopic(url, validated, analysisInput, credentials) {
  const keywords = await extractLocalKeywords(analysisInput);
  const cleanKeywords = Array.isArray(keywords) ? keywords.filter((kw) => typeof kw === "string" && kw) : [];

  const config = await getFirebaseConfig();
  if (!config || !url || cleanKeywords.length < TOPIC_MATCH_MIN_KEYWORDS) {
    return; // 색인 재료(키워드)가 부족하면 건너뜀 — 오분류를 막기 위함
  }

  const combinedText = [
    analysisInput?.og_title,
    analysisInput?.page_title,
    analysisInput?.link_text,
    analysisInput?.article_text
  ].filter(Boolean).join(" ");

  try {
    const candidates = await queryTopicsByKeywords(config, cleanKeywords);
    const matched = pickBestTopicMatch(candidates, cleanKeywords);

    let topicId;
    let topicLabel;
    let category;

    if (matched) {
      topicId = matched.id;
      topicLabel = matched.topic || cleanKeywords.slice(0, 2).join(" · ");
      category = TOPIC_CATEGORY_VALUES.includes(matched.category) ? matched.category : "기타";
      const articleUrls = Array.isArray(matched.articleUrls) ? matched.articleUrls : [];
      const mergedKeywords = mergeKeywordLists(matched.keywords || [], cleanKeywords, TOPIC_KEYWORD_CAP);
      await saveFirestoreDoc(config, TOPICS_COLLECTION, topicId, {
        topic: topicLabel,
        category,
        keywords: mergedKeywords,
        articleUrls: articleUrls.includes(url) ? articleUrls : [...articleUrls, url],
        createdAt: typeof matched.createdAt === "number" ? matched.createdAt : Date.now(),
        updatedAt: Date.now()
      });
    } else {
      topicId = crypto.randomUUID();
      category = classifyLocalCategory(cleanKeywords, combinedText);

      const fallbackLabel = cleanKeywords.slice(0, 2).join(" · ");
      const labelResult = Array.isArray(credentials) && credentials.length
        ? await requestTopicLabel(credentials, {
            keywords: cleanKeywords,
            article_title: validated?.article_title,
            article_summary: validated?.article_summary
          }).catch(() => null)
        : null;
      topicLabel = sanitizeText(labelResult?.label || fallbackLabel, 60);

      await saveFirestoreDoc(config, TOPICS_COLLECTION, topicId, {
        topic: topicLabel,
        category,
        keywords: cleanKeywords,
        articleUrls: [url],
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
    }

    const stance = computeLocalStance(combinedText);

    const articleDocId = await sha256Hex(url);
    await saveFirestoreDoc(config, ARTICLES_COLLECTION, articleDocId, {
      url,
      topicId,
      topic: topicLabel,
      keywords: cleanKeywords,
      credibility_score: clampScore(validated?.credibility_score),
      clickbait_score:   clampScore(validated?.clickbait_score),
      article_title:     sanitizeText(validated?.article_title    || "", 200),
      article_summary:   sanitizeText(validated?.article_summary  || "", 120),
      summary:           sanitizeText(validated?.summary          || "", 180),
      stance,
      analyzedAt: Date.now()
    });

    await bumpWordStats(config, cleanKeywords);
  } catch (error) {
    console.warn("[Intone/Topics] 주제/기사 색인 오류", error);
  }
}
