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
  extractLocalKeywords: AI 없이 제목/본문에서 이 기사를 대표할 만한 키워드를
  뽑습니다. 제목(og_title/page_title/link_text)에 등장한 단어는 본문 단어보다
  LOCAL_KEYWORD_TITLE_WEIGHT배 더 중요하게 취급합니다 — 제목이 본문보다 주제를
  압축적으로 담고 있기 때문입니다. 최종적으로 가중치 점수가 높은 순서대로
  최대 LOCAL_KEYWORD_MAX_COUNT개를 반환합니다.
*/
function extractLocalKeywords(analysisInput) {
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

  return [...scoreByToken.entries()]
    .filter(([token, score]) => score >= LOCAL_KEYWORD_MIN_SCORE || titleTokenSet.has(token))
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

async function saveTopicDoc(config, topicId, data) {
  const endpoint = `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/(default)/documents/${TOPICS_COLLECTION}/${topicId}?key=${config.apiKey}`;
  const response = await fetch(endpoint, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields: objectToFirestoreFields(data) })
  });

  if (!response.ok) {
    console.warn("[Intone/Topics] 주제 저장 실패", response.status, await response.text());
  }
}

/*
  pickBestTopicMatch: 후보 주제들 중 이 기사의 키워드와 가장 많이 겹치는 것을
  고릅니다. 겹치는 개수가 TOPIC_MATCH_MIN_OVERLAP 미만이거나 자카드 유사도가
  TOPIC_MATCH_MIN_JACCARD 미만이면 후보에서 제외합니다 — 로컬 키워드 추출은
  AI보다 노이즈가 많아서, 흔한 단어 하나만 겹쳐도 묶이면 전혀 다른 사건까지
  잘못 합쳐질 수 있기 때문입니다.
*/
function pickBestTopicMatch(candidates, keywords) {
  const keywordSet = new Set(keywords);
  let best = null;
  let bestJaccard = -1;

  for (const candidate of candidates) {
    const candidateKeywords = Array.isArray(candidate.keywords) ? candidate.keywords : [];
    const overlap = candidateKeywords.filter((kw) => keywordSet.has(kw)).length;
    if (overlap < TOPIC_MATCH_MIN_OVERLAP) {
      continue;
    }

    const unionSize = new Set([...candidateKeywords, ...keywords]).size;
    const jaccard = unionSize ? overlap / unionSize : 0;
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
  겹치는 키워드를 가진 기존 주제가 있고 자카드 유사도 기준을 넘으면 그 주제에
  합류시키고, 아니면 새 주제를 만듭니다. handleAnalyzeRequest가 분석 완료 후
  결과를 보여준 뒤 조용히 호출합니다(실패해도 사용자에게 보여줄 결과에는 영향 없음).
  AI API는 호출하지 않습니다 — Firestore 읽기/쓰기만 사용합니다.
*/
async function indexArticleLocalTopic(url, keywords) {
  const config = await getFirebaseConfig();
  const cleanKeywords = Array.isArray(keywords) ? keywords.filter((kw) => typeof kw === "string" && kw) : [];
  if (!config || !url || cleanKeywords.length < TOPIC_MATCH_MIN_KEYWORDS) {
    return; // 색인 재료(키워드)가 부족하면 건너뜀 — 오분류를 막기 위함
  }

  try {
    const candidates = await queryTopicsByKeywords(config, cleanKeywords);
    const matched = pickBestTopicMatch(candidates, cleanKeywords);

    if (matched) {
      const articleUrls = Array.isArray(matched.articleUrls) ? matched.articleUrls : [];
      const mergedKeywords = Array.from(new Set([...(matched.keywords || []), ...cleanKeywords])).slice(0, TOPIC_KEYWORD_CAP);
      await saveTopicDoc(config, matched.id, {
        topic: matched.topic || cleanKeywords.slice(0, 2).join(" · "),
        keywords: mergedKeywords,
        articleUrls: articleUrls.includes(url) ? articleUrls : [...articleUrls, url],
        createdAt: typeof matched.createdAt === "number" ? matched.createdAt : Date.now(),
        updatedAt: Date.now()
      });
    } else {
      const topicId = crypto.randomUUID();
      await saveTopicDoc(config, topicId, {
        topic: cleanKeywords.slice(0, 2).join(" · "),
        keywords: cleanKeywords,
        articleUrls: [url],
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
    }
  } catch (error) {
    console.warn("[Intone/Topics] 주제 색인 오류", error);
  }
}
