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
  hashUrlForFirestoreId: URL을 Firestore 문서 ID로 쓸 수 있게 SHA-256 해시로 바꿉니다.
  URL을 그대로 문서 ID로 쓰면 "/"가 경로 구분자와 충돌하고 길이 제한도 넘기 쉬워서,
  고정 길이 16진수 문자열로 변환해서 사용합니다.
*/
async function hashUrlForFirestoreId(url) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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

