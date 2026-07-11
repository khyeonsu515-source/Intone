// ─────────────────────────────────────────────
// Firebase(Firestore) 공유 캐시
// ─────────────────────────────────────────────

/*
  getFirebaseConfig: options.html에서 저장한 Firebase 프로젝트 ID와 웹 API Key를
  읽어옵니다. 저장된 값이 없으면 코드에 내장된 기본값(FIREBASE_DEFAULT_PROJECT_ID,
  FIREBASE_DEFAULT_API_KEY)을 사용합니다 — 즉 사용자가 아무것도 설정하지 않아도
  이 확장 프로그램은 항상 Firebase 공유 캐시를 사용합니다.
*/
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

/*
  sha256Hex: 문자열을 SHA-256 해시의 16진수 문자열로 바꿉니다. URL이나 키워드를
  그대로 Firestore 문서 ID로 쓰면 "/" 같은 문자가 경로 구분자와 충돌하고 길이
  제한도 넘기 쉬워서, 고정 길이 16진수 문자열로 변환해서 문서 ID로 사용합니다.
*/
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// URL 해시는 그대로 유지 (기존 이름을 쓰는 코드가 많아서 별칭으로 남겨둠)
async function hashUrlForFirestoreId(url) {
  return sha256Hex(url);
}

/*
  encodeFirestoreValue / objectToFirestoreFields:
  일반 JS 값을 Firestore REST API가 요구하는 { stringValue, integerValue, ... }
  형태로 감쌉니다. Firestore는 SDK 없이 REST(fetch)로도 완전히 사용할 수 있어서,
  Service Worker 환경(Manifest V3)에 SDK를 번들링하지 않고 이 방식을 씁니다.
*/
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

/*
  decodeFirestoreValue / firestoreFieldsToObject:
  Firestore REST 응답의 typed field 형식을 일반 JS 값으로 되돌립니다.
*/
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
  getFirestoreCachedResult: 이 URL을 (나든 다른 사용자든) 이미 분석해서
  Firestore에 저장해둔 기록이 있는지 확인합니다. 없거나, Firebase 설정이
  없거나, 네트워크 오류가 나면 조용히 null을 반환합니다 — Firebase가
  실패해도 분석 자체는 정상 진행되어야 하기 때문입니다.
*/
async function getFirestoreCachedResult(url) {
  const config = await getFirebaseConfig();
  if (!config || !url) {
    return null;
  }

  try {
    const docId = await hashUrlForFirestoreId(url);
    const endpoint = `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/(default)/documents/${FIRESTORE_COLLECTION}/${docId}?key=${config.apiKey}`;
    const response = await fetch(endpoint, { method: "GET" });

    if (response.status === 404) {
      return null; // 아직 아무도 이 URL을 분석한 적 없음
    }
    if (!response.ok) {
      console.warn("[Intone/Firestore] 읽기 실패", response.status, await response.text());
      return null;
    }

    const doc = await response.json();
    const record = firestoreFieldsToObject(doc.fields);

    if (!record || typeof record.savedAt !== "number") {
      return null;
    }
    if (Date.now() - record.savedAt > FIRESTORE_CACHE_TTL_MS) {
      return null; // 오래된 기록은 새로 분석하도록 무시
    }

    console.info("[Intone/Firestore] 기존 기록 사용", url);

    // url/savedAt은 저장용 메타 정보이므로 content.js에 돌려줄 결과에서는 제외합니다.
    const { url: _url, savedAt: _savedAt, ...result } = record;
    return result;
  } catch (error) {
    console.warn("[Intone/Firestore] 읽기 오류", error);
    return null;
  }
}

/*
  setFirestoreCachedResult: 새로 완료한 분석 결과를 Firestore에 저장해서
  다음에 같은 URL을 분석하려는 누구든(나 포함) 바로 재사용할 수 있게 합니다.
  실패해도 이미 사용자에게 결과를 보여준 뒤이므로 오류를 조용히 무시합니다.
*/
async function setFirestoreCachedResult(url, data) {
  const config = await getFirebaseConfig();
  if (!config || !url || !data) {
    return;
  }

  try {
    const docId = await hashUrlForFirestoreId(url);
    const endpoint = `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/(default)/documents/${FIRESTORE_COLLECTION}/${docId}?key=${config.apiKey}`;
    const body = JSON.stringify({
      fields: objectToFirestoreFields({
        url,
        savedAt: Date.now(),
        ...data
      })
    });

    const response = await fetch(endpoint, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body
    });

    if (!response.ok) {
      console.warn("[Intone/Firestore] 쓰기 실패", response.status, await response.text());
      return;
    }

    console.info("[Intone/Firestore] 저장 완료", url);
  } catch (error) {
    // 네트워크 오류 등은 무시합니다. 로컬 캐시에는 이미 저장되어 있습니다.
    console.warn("[Intone/Firestore] 쓰기 오류", error);
  }
}

/*
  getSharedCachedResult: 로컬 캐시를 먼저 확인하고(빠름), 없으면 Firestore를
  확인합니다(다른 사용자가 이미 분석했을 수 있음). Firestore에서 찾으면
  다음 확인이 빠르도록 로컬 캐시에도 채워 넣습니다.
*/
async function getSharedCachedResult(url) {
  const local = await getCachedResult(url);
  if (local) {
    return { data: local, source: "local" };
  }

  const remote = await getFirestoreCachedResult(url);
  if (remote) {
    await setCachedResult(url, remote);
    return { data: remote, source: "firebase" };
  }

  return null;
}

/*
  findTopicMatchForArticle: 기사를 AI로 분석하기 "전에" 먼저 호출합니다.
  최근 등록된 키워드들을 keywordIndex에서 가져와서, 이 기사의 텍스트
  (제목/메타/본문 일부를 합친 문자열) 안에 그 키워드가 그대로(부분 문자열로)
  등장하는지 하나씩 확인합니다. AI에게 매번 새로 키워드를 지어내게 하는 대신,
  이미 알고 있는 키워드가 실제로 이 기사에 등장하는지를 코드로 직접 확인하는
  방식이라 훨씬 안정적으로 같은 사건을 찾아낼 수 있습니다.

  반환값:
    matchedTopic   - 후보 주제가 정확히 하나로 좁혀지면 그 주제 문서(확실한
                      매칭). 이 경우 buildAnalysisPrompt는 AI에게 topic/
                      core_keywords를 아예 요청하지 않습니다.
    candidateTopics - 겹치는 키워드로 찾은 모든 후보 주제(0개, 1개, 여러 개
                      모두 가능). matchedTopic이 없을 때 AI에게 참고자료로
                      건네줍니다.
*/
async function findTopicMatchForArticle(searchableText, maxKeywords = TOPIC_CANDIDATE_LIMIT) {
  const config = await getFirebaseConfig();
  const text = typeof searchableText === "string" ? searchableText : "";
  if (!config || !text) {
    return { matchedTopic: null, candidateTopics: [] };
  }

  try {
    const endpoint = `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/(default)/documents:runQuery?key=${config.apiKey}`;
    const body = JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: KEYWORD_INDEX_COLLECTION }],
        orderBy: [{ field: { fieldPath: "updatedAt" }, direction: "DESCENDING" }],
        limit: maxKeywords
      }
    });

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body
    });

    if (!response.ok) {
      console.warn("[Intone/Firestore] 키워드 매칭 조회 실패", response.status, await response.text());
      return { matchedTopic: null, candidateTopics: [] };
    }

    const rows = await response.json();
    const matchedTopicIds = new Set();

    for (const row of Array.isArray(rows) ? rows : []) {
      const record = row?.document?.fields ? firestoreFieldsToObject(row.document.fields) : null;
      const keyword = typeof record?.keyword === "string" ? record.keyword.trim() : "";
      if (!keyword || !text.includes(keyword)) {
        continue;
      }
      (record.topicIds || []).forEach((id) => matchedTopicIds.add(id));
    }

    if (!matchedTopicIds.size) {
      return { matchedTopic: null, candidateTopics: [] };
    }

    const candidateTopicDocs = (await Promise.all([...matchedTopicIds].map((id) => getTopicById(id)))).filter(Boolean);
    const candidateTopics = candidateTopicDocs.map((doc) => ({
      topic: doc.topic,
      core_keywords: Array.isArray(doc.keywords) ? doc.keywords : []
    }));

    // 후보가 정확히 하나로 좁혀졌을 때만 "확실한 매칭"으로 보고 AI에게
    // 재질문 없이 그대로 재사용합니다. 여러 개면 AI에게 판단을 맡깁니다.
    const matchedTopic = candidateTopicDocs.length === 1 ? candidateTopics[0] : null;

    return { matchedTopic, candidateTopics };
  } catch (error) {
    console.warn("[Intone/Firestore] 키워드 매칭 조회 오류", error);
    return { matchedTopic: null, candidateTopics: [] };
  }
}

/*
  getKeywordIndexEntry: 이 키워드가 이미 다른 기사에서 등장한 적이 있는지
  keywordIndex 컬렉션에서 확인합니다. 없으면 null을 반환합니다.
*/
async function getKeywordIndexEntry(keyword) {
  const config = await getFirebaseConfig();
  const normalized = typeof keyword === "string" ? keyword.trim() : "";
  if (!config || !normalized) {
    return null;
  }

  try {
    const docId = await sha256Hex(normalized);
    const endpoint = `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/(default)/documents/${KEYWORD_INDEX_COLLECTION}/${docId}?key=${config.apiKey}`;
    const response = await fetch(endpoint, { method: "GET" });

    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      console.warn("[Intone/Firestore] 키워드 조회 실패", response.status, await response.text());
      return null;
    }

    const doc = await response.json();
    return { id: docId, ...firestoreFieldsToObject(doc.fields) };
  } catch (error) {
    console.warn("[Intone/Firestore] 키워드 조회 오류", error);
    return null;
  }
}

/*
  getTopicById: topics 컬렉션에서 topicId로 주제 문서 하나를 가져옵니다.
*/
async function getTopicById(topicId) {
  const config = await getFirebaseConfig();
  if (!config || !topicId) {
    return null;
  }

  try {
    const endpoint = `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/(default)/documents/${TOPICS_COLLECTION}/${topicId}?key=${config.apiKey}`;
    const response = await fetch(endpoint, { method: "GET" });

    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      console.warn("[Intone/Firestore] 주제 조회 실패", response.status, await response.text());
      return null;
    }

    const doc = await response.json();
    return { id: topicId, ...firestoreFieldsToObject(doc.fields) };
  } catch (error) {
    console.warn("[Intone/Firestore] 주제 조회 오류", error);
    return null;
  }
}

/*
  saveTopicDoc: topics/{topicId} 문서를 통째로 써넣습니다(PATCH — 없으면 생성,
  있으면 덮어씀).
*/
async function saveTopicDoc(topicId, data) {
  const config = await getFirebaseConfig();
  if (!config || !topicId) {
    return false;
  }

  try {
    const endpoint = `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/(default)/documents/${TOPICS_COLLECTION}/${topicId}?key=${config.apiKey}`;
    const response = await fetch(endpoint, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields: objectToFirestoreFields(data) })
    });

    if (!response.ok) {
      console.warn("[Intone/Firestore] 주제 저장 실패", response.status, await response.text());
      return false;
    }
    return true;
  } catch (error) {
    console.warn("[Intone/Firestore] 주제 저장 오류", error);
    return false;
  }
}

/*
  linkKeywordToTopic: keywordIndex/{hash(keyword)} 문서에 topicId를 연결합니다.
  키워드가 처음 등장했으면 새로 만들고, 이미 있으면 topicIds 배열에 그
  topicId가 없을 때만 추가합니다(있으면 아무것도 하지 않음).
*/
async function linkKeywordToTopic(keyword, topicId) {
  const config = await getFirebaseConfig();
  const normalized = typeof keyword === "string" ? keyword.trim() : "";
  if (!config || !normalized || !topicId) {
    return;
  }

  try {
    const existing = await getKeywordIndexEntry(normalized);
    const topicIds = Array.isArray(existing?.topicIds) ? existing.topicIds : [];

    if (topicIds.includes(topicId)) {
      return; // 이미 연결되어 있음
    }

    const docId = await sha256Hex(normalized);
    const endpoint = `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/(default)/documents/${KEYWORD_INDEX_COLLECTION}/${docId}?key=${config.apiKey}`;
    const response = await fetch(endpoint, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: objectToFirestoreFields({
          keyword: normalized,
          topicIds: [...topicIds, topicId],
          updatedAt: Date.now()
        })
      })
    });

    if (!response.ok) {
      console.warn("[Intone/Firestore] 키워드 연결 실패", response.status, await response.text());
    }
  } catch (error) {
    console.warn("[Intone/Firestore] 키워드 연결 오류", error);
  }
}

/*
  indexArticleTopic: 방금 분석을 마친 기사를 키워드 색인에 등록하고, 같은
  사건을 다루는 기존 주제가 있으면 그 주제에 묶고 없으면 새 주제를 만듭니다.
  handleAnalyzeRequest가 분석 완료 후 결과를 보여준 뒤 조용히 호출합니다
  (실패해도 사용자에게 보여줄 결과에는 영향 없음).

  알고리즘:
    ① 이 기사의 core_keywords 각각으로 keywordIndex를 조회해서, 이미 연결된
       topicId 후보들을 모은다.
    ② 후보 주제들 중 topic 라벨이 이 기사의 topic과 정확히 같은 게 있으면
       "같은 사건"으로 보고 그 주제에 기사를 추가한다.
    ③ 정확히 같은 라벨이 없으면(키워드는 겹쳤지만 다른 사건이거나, 아예
       겹치는 키워드가 없으면) 새 주제를 만든다.
    ④ 이 기사의 키워드들을 모두 최종 topicId에 연결한다 — 기존 키워드인데
       이 topicId가 아직 없으면 추가되므로, "같은 키워드, 다른 주제" 상황도
       자연히 그 키워드 아래에 주제가 하나 더 늘어나는 식으로 처리된다.
*/
async function indexArticleTopic(url, validated) {
  const config = await getFirebaseConfig();
  const topic = typeof validated?.topic === "string" ? validated.topic.trim() : "";
  const keywords = Array.isArray(validated?.core_keywords)
    ? validated.core_keywords.filter((kw) => typeof kw === "string" && kw.trim())
    : [];

  if (!config || !url || !topic || !keywords.length) {
    return; // 색인할 재료(주제/키워드)가 부족하면 건너뜀
  }

  try {
    // ① 키워드로 후보 주제 모으기
    const keywordEntries = await Promise.all(keywords.map((kw) => getKeywordIndexEntry(kw)));
    const candidateTopicIds = new Set();
    keywordEntries.forEach((entry) => {
      (entry?.topicIds || []).forEach((id) => candidateTopicIds.add(id));
    });
    const candidateTopics = await Promise.all([...candidateTopicIds].map((id) => getTopicById(id)));

    // ② 정확히 같은 topic 라벨을 가진 후보 찾기
    const matched = candidateTopics.find((candidate) => candidate?.topic === topic);

    let topicId;
    if (matched) {
      // 같은 사건 → 기존 주제에 기사 추가
      topicId = matched.id;
      const articleUrls = Array.isArray(matched.articleUrls) ? matched.articleUrls : [];
      const mergedKeywords = Array.from(new Set([...(matched.keywords || []), ...keywords]));
      await saveTopicDoc(topicId, {
        topic: matched.topic,
        keywords: mergedKeywords,
        articleUrls: articleUrls.includes(url) ? articleUrls : [...articleUrls, url],
        createdAt: typeof matched.createdAt === "number" ? matched.createdAt : Date.now(),
        updatedAt: Date.now()
      });
    } else {
      // ③ 새 사건 → 새 주제 생성
      topicId = crypto.randomUUID();
      await saveTopicDoc(topicId, {
        topic,
        keywords,
        articleUrls: [url],
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
    }

    // ④ 이 기사의 키워드들을 최종 topicId에 연결
    await Promise.all(keywords.map((kw) => linkKeywordToTopic(kw, topicId)));
  } catch (error) {
    console.warn("[Intone/Firestore] 주제 색인 오류", error);
  }
}

/*
  describeFirestoreError: Firestore REST 응답의 HTTP 상태 코드를 사람이 읽을 수
  있는 원인/해결 방법 설명으로 바꿉니다. 옵션 페이지의 "연결 테스트" 결과나
  콘솔 로그에서 무엇이 잘못됐는지 바로 알 수 있게 하기 위한 것입니다.
*/
function describeFirestoreError(status, bodyText) {
  if (status === 403) {
    return "권한 거부(403) — Firestore 보안 규칙(규칙 탭)이 올바르게 게시됐는지 확인하세요.";
  }
  if (status === 404) {
    return "찾을 수 없음(404) — 프로젝트 ID가 정확한지, Firestore Database를 만들었는지 확인하세요.";
  }
  if (status === 400) {
    return `잘못된 요청(400) — 웹 API Key가 정확한지 확인하세요. (${truncate(bodyText, 200)})`;
  }
  return `HTTP ${status} 오류 (${truncate(bodyText, 200)})`;
}

/*
  testFirebaseConnection: options.html의 "연결 테스트" 버튼에서 호출됩니다.
  실제 분석 흐름과 똑같이 Firestore에 테스트 문서를 하나 쓰고, 다시 읽어서
  방금 쓴 값과 일치하는지 확인합니다. 이렇게 하면 "저장은 되는데 규칙 때문에
  못 읽는" 것처럼 쓰기/읽기 중 한쪽만 실패하는 경우도 구분해서 알려줄 수 있습니다.
  테스트가 끝나면 문서는 그대로 두지 않고 지우려고 시도합니다(실패해도 무시).

  overrideConfig가 주어지면(옵션 페이지에 방금 입력했지만 아직 저장 버튼을
  누르지 않은 값) 그 값을 우선 사용하고, 없으면 저장된 설정을 읽습니다.
*/
async function testFirebaseConnection(overrideConfig) {
  const overrideProjectId = typeof overrideConfig?.projectId === "string" ? overrideConfig.projectId.trim() : "";
  const overrideApiKey = typeof overrideConfig?.apiKey === "string" ? overrideConfig.apiKey.trim() : "";
  const config = overrideProjectId && overrideApiKey
    ? { projectId: overrideProjectId, apiKey: overrideApiKey }
    : await getFirebaseConfig();
  if (!config) {
    return { ok: false, step: "config", error: "Firebase 프로젝트 ID와 웹 API Key를 먼저 저장하세요." };
  }

  const testUrl = `https://intone-connection-test.local/${Date.now()}`;
  const testRecord = {
    is_article: true,
    credibility_score: 1,
    clickbait_score: 1,
    credibility_breakdown: { source_clarity: 1, title_body_match: 0, evidence_quality: 0, neutrality: 0, context: 0 },
    clickbait_breakdown: { exaggeration: 1, curiosity_gap: 0, title_body_mismatch: 0, emotional_trigger: 0, hidden_key_info: 0 },
    article_summary: "Intone 연결 테스트 문서",
    summary: "Intone 연결 테스트 문서",
    warning: "이 문서는 연결 테스트로 자동 생성되었으며 곧 삭제됩니다."
  };

  let docId;
  let endpoint;

  try {
    docId = await hashUrlForFirestoreId(testUrl);
    endpoint = `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/(default)/documents/${FIRESTORE_COLLECTION}/${docId}?key=${config.apiKey}`;
  } catch (error) {
    return { ok: false, step: "setup", error: error.message || String(error) };
  }

  // ① 쓰기 테스트
  let writeMs;
  try {
    const writeStart = Date.now();
    const writeResponse = await fetch(endpoint, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: objectToFirestoreFields({ url: testUrl, savedAt: Date.now(), ...testRecord })
      })
    });
    writeMs = Date.now() - writeStart;

    if (!writeResponse.ok) {
      const bodyText = await writeResponse.text();
      return { ok: false, step: "write", status: writeResponse.status, error: describeFirestoreError(writeResponse.status, bodyText) };
    }
  } catch (error) {
    return { ok: false, step: "write", error: `네트워크 오류: ${error.message || error}` };
  }

  // ② 읽기 테스트 — 방금 쓴 문서를 다시 읽어서 값이 그대로인지 확인
  let readMs;
  let record;
  try {
    const readStart = Date.now();
    const readResponse = await fetch(endpoint, { method: "GET" });
    readMs = Date.now() - readStart;

    if (!readResponse.ok) {
      const bodyText = await readResponse.text();
      return { ok: false, step: "read", status: readResponse.status, error: describeFirestoreError(readResponse.status, bodyText) };
    }

    const doc = await readResponse.json();
    record = firestoreFieldsToObject(doc.fields);
  } catch (error) {
    return { ok: false, step: "read", error: `네트워크 오류: ${error.message || error}` };
  }

  // ③ 테스트 문서 정리 (실패해도 결과에는 영향 없음)
  fetch(endpoint, { method: "DELETE" }).catch(() => {});

  const matches = record?.credibility_score === testRecord.credibility_score
    && record?.summary === testRecord.summary;

  if (!matches) {
    return { ok: false, step: "verify", error: "저장한 값과 다시 읽은 값이 일치하지 않습니다." };
  }

  return { ok: true, writeMs, readMs, projectId: config.projectId };
}

