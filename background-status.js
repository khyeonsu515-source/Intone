// ─────────────────────────────────────────────
// 현재 분석 상태를 저장하고, 해당 탭에 알리는 함수
// ─────────────────────────────────────────────

/*
  updateStatus: 지금 어느 단계를 진행 중인지를
  ① 브라우저 저장소에 기록하고 (action_popup.js가 나중에 읽을 수 있도록)
  ② 현재 분석 중인 탭의 content.js에도 직접 메시지로 전달합니다.

  이 함수를 통해 팝업의 단계 표시가 실시간으로 업데이트됩니다.

  매개변수 status 객체의 구성:
    stage   - 단계 식별자 (예: "analyzing", "complete")
    label   - 화면에 보여줄 텍스트 (예: "분석 중")
    url     - 현재 분석 중인 링크 주소
    detail  - 부가 설명 (선택)
    tabId   - 메시지를 보낼 탭 번호 (없으면 null)
*/
function updateStatus(status) {
  // 빠진 항목은 기본값으로 채워서 항상 완전한 객체가 저장되도록 함
  const nextStatus = {
    stage:     status.stage     || "idle",
    label:     status.label     || "대기 중",
    url:       status.url       || "",
    detail:    status.detail    || "",
    tabId:     status.tabId     || null,
    updatedAt: Date.now()        // 현재 시각을 밀리초로 기록 (업데이트 시간 표시용)
  };

  // chrome.storage.local.set: 브라우저의 로컬 저장소에 데이터를 저장합니다.
  // [STATUS_STORAGE_KEY]는 변수를 키 이름으로 사용하는 문법입니다.
  // 저장된 데이터는 확장 프로그램이 꺼졌다 켜져도 유지됩니다.
  chrome.storage.local.set({ [STATUS_STORAGE_KEY]: nextStatus });

  // tabId가 있다면 해당 탭의 content.js에도 즉시 메시지 전송
  // content.js는 이 메시지를 받아 로딩 팝업의 텍스트를 실시간으로 바꿉니다.
  if (nextStatus.tabId) {
    chrome.tabs.sendMessage(nextStatus.tabId, {
      type: "STATUS_BROADCAST",
      status: nextStatus
    }).catch(() => {}); // 탭이 이미 닫혔거나 content.js가 없으면 오류를 그냥 무시
  }
}


// ─────────────────────────────────────────────
// 브라우저 저장소에서 현재 상태를 읽어오는 함수
// ─────────────────────────────────────────────

/*
  getStoredStatus: action_popup.js가 팝업을 열 때 "지금 상태가 뭐야?"를 물어보면
  저장소에서 상태 데이터를 꺼내서 돌려주는 함수입니다.

  chrome.storage.local.get은 콜백 방식으로 동작하는데,
  이를 Promise로 감싸서 await와 함께 쓸 수 있도록 변환했습니다.
  Promise는 "이 작업이 끝나면 결과를 줄게"라는 약속 객체입니다.
*/
function getStoredStatus() {
  return new Promise((resolve) => {
    // 저장소에서 STATUS_STORAGE_KEY에 해당하는 값을 가져옴
    // items는 { currentAnalysisStatus: { stage: ..., label: ... } } 형태
    chrome.storage.local.get([STATUS_STORAGE_KEY], (items) => {
      // 저장된 값이 있으면 그것을 반환하고, 없으면 기본 초기값 반환
      resolve(items[STATUS_STORAGE_KEY] || {
        stage:     "idle",
        label:     "대기 중",
        url:       "",
        detail:    "링크 위에 마우스를 1초 동안 올려두면 시작합니다.",
        updatedAt: Date.now()
      });
    });
  });
}


// ─────────────────────────────────────────────
// 브라우저 저장소에서 Groq API 키를 읽어오는 함수
// ─────────────────────────────────────────────

/*
  getGroqApiKey: options.js가 저장해둔 Groq API 키를 꺼내옵니다.
  API 키는 options.html 설정 페이지에서 사용자가 직접 입력해서 저장한 값입니다.
  키가 없거나 문자열이 아닌 값이면 빈 문자열을 반환합니다.
*/
function getAiCredentials() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["groqApiKey", "groqApiKeys", "cerebrasApiKeys"], (items) => {
      const groqKeys = Array.isArray(items.groqApiKeys)
        ? items.groqApiKeys
        : [];
      const legacyKeys = typeof items.groqApiKey === "string"
        ? [items.groqApiKey]
        : [];
      const cerebrasKeys = Array.isArray(items.cerebrasApiKeys)
        ? items.cerebrasApiKeys
        : [];

      resolve([
        ...normalizeApiKeys([...groqKeys, ...legacyKeys]).map((key) => ({
          provider: "Groq",
          key,
          endpoint: GROQ_ENDPOINT,
          model: GROQ_MODEL
        })),
        ...normalizeApiKeys(cerebrasKeys).map((key) => ({
          provider: "Cerebras",
          key,
          endpoint: CEREBRAS_ENDPOINT,
          model: CEREBRAS_MODEL
        }))
      ]);
    });
  });
}


