// ─────────────────────────────────────────────
// 확장 프로그램이 설치되거나 업데이트될 때 딱 한 번 실행
// ─────────────────────────────────────────────

/*
  chrome.runtime.onInstalled: 확장 프로그램이 브라우저에 처음 설치되거나
  버전이 업데이트될 때 자동으로 호출되는 이벤트입니다.
  여기서는 저장소에 초기 상태를 기록해 둡니다.
  이렇게 해두면 사용자가 아직 아무 링크에도 마우스를 올리지 않은 상태에서
  팝업을 열어도 "대기 중" 메시지가 정상적으로 표시됩니다.
*/
chrome.runtime.onInstalled.addListener(() => {
  updateStatus({
    stage: "idle",       // 현재 단계: 대기 중
    label: "대기 중",
    url: "",             // 분석 중인 URL 없음
    detail: "링크 위에 마우스를 1초 동안 올려두면 시작합니다."
  });
});


// ─────────────────────────────────────────────
// 다른 파일에서 보내는 메시지를 받아 처리하는 핵심 창구
// ─────────────────────────────────────────────

/*
  chrome.runtime.onMessage.addListener: content.js나 action_popup.js가
  chrome.runtime.sendMessage()로 메시지를 보낼 때마다 이 함수가 호출됩니다.
  마치 콜센터 교환원처럼, 어떤 종류의 요청인지 확인하고 알맞은 처리를 합니다.

  매개변수 설명:
    message     - 보내온 메시지 객체. type(요청 종류)과 payload(데이터)를 담고 있음
    sender      - 메시지를 보낸 쪽 정보. 어느 탭에서 왔는지 등을 알 수 있음
    sendResponse - "이 함수를 호출하면 메시지를 보낸 쪽에 결과가 전달됨"

  반환값의 의미:
    return false → 응답을 즉시 보내고 끝냄 (동기 처리)
    return true  → 나중에 비동기로 응답할 것임을 브라우저에게 알림 (채널 유지)
                   이 값을 빠뜨리면 비동기 응답이 도착하기 전에 채널이 닫혀 오류 발생
*/
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // ── 요청 종류 1: content.js가 현재 분석 단계를 알려줄 때 ──
  // content.js는 마우스 이벤트가 발생할 때마다 현재 단계를 여기로 전송합니다.
  // message?.type 의 ?. 는 "message가 null이나 undefined여도 오류 내지 말고 undefined를 반환해"라는 표현입니다.
  if (message?.type === "STATUS_UPDATE") {
    updateStatus({
      stage:  message.payload?.stage  || "idle",   // 단계 (없으면 "idle")
      label:  message.payload?.label  || "대기 중", // 화면에 표시할 텍스트
      url:    message.payload?.url    || "",         // 분석 중인 URL
      tabId:  sender.tab?.id          || null        // 어느 탭에서 보낸 메시지인지
    });
    sendResponse({ ok: true }); // "잘 받았어" 라고 즉시 응답
    return false;               // 동기 처리이므로 false 반환
  }

  // ── 요청 종류 2: action_popup.js가 팝업을 열면서 현재 상태를 요청할 때 ──
  // 팝업이 열리는 순간 "지금 뭐 하고 있어?"를 물어보는 것입니다.
  if (message?.type === "GET_CURRENT_STATUS") {
    // getStoredStatus()는 저장소 읽기가 완료된 후 결과를 줍니다 (비동기).
    // .then(결과 => ...) : 읽기가 완료되면 이 함수를 실행하라는 뜻입니다.
    getStoredStatus().then((status) => sendResponse({ ok: true, status }));
    return true; // 비동기 응답을 사용하므로 반드시 true 반환
  }

  // 위 두 가지가 아닌 알 수 없는 메시지는 무시
  if (message?.type === "CHECK_ANALYSIS_CACHE") {
    const url = normalizeUrl(message.payload?.url || "");
    getCachedResult(url)
      .then((cached) => {
        if (cached) {
          updateStatus({
            stage: "complete",
            label: "캐시 결과 표시",
            url,
            detail: "같은 URL의 이전 분석 결과를 표시합니다.",
            tabId: sender.tab?.id || null
          });
        }

        sendResponse({ ok: true, cached: cached || null });
      })
      .catch(() => sendResponse({ ok: true, cached: null }));
    return true;
  }

  if (message?.type === "CHECK_KNOWN_NEWS_LINK") {
    const url = normalizeUrl(message.payload?.url || "");
    isKnownNewsUrl(url)
      .then((isKnownNews) => sendResponse({ ok: true, is_known_news: isKnownNews }))
      .catch(() => sendResponse({ ok: true, is_known_news: false }));
    return true;
  }

  if (message?.type !== "ANALYZE_NEWS_LINK") {
    return false;
  }

  // ── 요청 종류 3: content.js가 "이 링크 분석해줘"라고 요청할 때 ──
  // handleAnalyzeRequest()가 실제 분석을 수행합니다.
  // .then() : 분석이 성공하면 결과를 응답으로 보냄
  // .catch(): 분석 도중 오류가 나면 오류 내용을 응답으로 보냄
  handleAnalyzeRequest(message.payload, sender)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => {
      const messageText = error.message || "분석 중 오류가 발생했습니다.";
      // 오류 상태도 저장해서 팝업에 표시될 수 있게 함
      updateStatus({
        stage: "error",
        label: "오류 발생",
        url:   message.payload?.url || "",
        detail: messageText,
        tabId: sender.tab?.id || null
      });
      sendResponse({ ok: false, error: messageText });
    });

  return true; // 분석은 시간이 걸리므로 비동기 응답 → true 반환
});


// ─────────────────────────────────────────────
// 링크 하나를 분석하는 전체 과정을 순서대로 실행하는 함수
// ─────────────────────────────────────────────

/*
  handleAnalyzeRequest: 분석 요청을 받아 완료까지 이끄는 함수입니다.
  async 키워드가 붙어 있어서 내부에서 await를 사용할 수 있습니다.
  await는 "이 작업이 끝날 때까지 기다린 후 다음 줄로 넘어가라"는 의미입니다.

  전체 흐름:
    ① URL 유효성 검사
    ② 캐시(이전 결과)가 있으면 바로 반환
    ③ API 키 확인
    ④ 기사 본문 다운로드 및 추출
    ⑤ AI에게 "뉴스 기사가 맞아?"라고 1차 질문
    ⑥ 기사가 맞으면 AI에게 신뢰도·어그로도 분석 요청
    ⑦ 결과를 캐시에 저장하고 반환

  매개변수:
    payload - content.js가 보낸 {url, link_text, force_refresh} 객체
    sender  - 메시지를 보낸 탭 정보
*/
async function handleAnalyzeRequest(payload, sender) {
  // URL을 표준 형식으로 정리 (해시 제거 등)
  const url   = normalizeUrl(payload?.url || "");
  const tabId = sender.tab?.id || null;

  // URL이 비어 있거나 올바르지 않으면 분석 불가능 → 오류 발생시켜 중단
  // throw new Error()는 "문제가 생겼으니 catch 쪽으로 넘겨라"는 신호입니다.
  if (!url) {
    throw new Error("분석할 URL이 올바르지 않습니다.");
  }

  // 팝업에 "링크 인식" 단계 표시
  updateStatus({ stage: "link_detected", label: "링크 인식", url, tabId });

  // force_refresh가 true면 캐시를 무시하고 새로 분석
  // force_refresh가 false(기본값)이면 캐시에 결과가 있는지 먼저 확인
  const cached = payload?.force_refresh ? null : await getCachedResult(url);
  if (cached) {
    // 캐시된 결과가 있으면 AI 호출 없이 바로 반환 (빠르고 API 사용량 절약)
    updateStatus({
      stage: "complete",
      label: "캐시 결과 표시",
      url,
      detail: "같은 URL의 이전 분석 결과를 표시합니다.",
      tabId
    });
    return cached;
  }

  // 브라우저 저장소에서 Groq API 키를 가져옴
  const credentials = await getAiCredentials();
  if (!credentials.length) {
    // API 키가 없으면 분석 불가 → 사용자에게 설정 안내
    throw new Error("API Key를 options에서 설정하세요.");
  }

  // 팝업에 "본문 가져오는 중" 단계 표시 후, 해당 URL의 HTML을 실제로 다운로드해서 본문 추출
  updateStatus({ stage: "extracting", label: "본문 정보 가져오는 중", url, tabId });
  const extracted = await fetchArticlePreview(url);

  // AI에게 넘길 입력 데이터를 하나의 객체로 정리
  // truncate()는 텍스트가 너무 길면 잘라냄 (AI 입력 한도 때문에)
  const analysisInput = {
    url,
    link_text:         truncate(payload?.link_text        || "", 500),
    page_title:        truncate(extracted.page_title,          500),
    meta_description:  truncate(extracted.meta_description,   1000),
    og_title:          truncate(extracted.og_title,            500),
    article_text:      truncate(extracted.article_text,       6000),
    extraction_error:  truncate(extracted.extraction_error,    500)
  };

  // 팝업에 "뉴스 판별 중" 단계 표시 후, AI에게 1차 판별 요청
  // validateArticleCheck()는 AI 응답이 예상 형식인지 검사하고 정제
  updateStatus({ stage: "news_checking", label: "뉴스인지 판별 중", url, tabId });
  const skipArticleCheck = Boolean(payload?.skip_article_check);
  const articleCheck = skipArticleCheck
    ? { is_article: true, confidence: 100, reason: "알려진 언론사 기사 URL 패턴과 일치" }
    : validateArticleCheck(await requestArticleCheck(credentials, analysisInput));

  // AI가 "뉴스 기사가 아니다"라고 판단한 경우
  if (!articleCheck.is_article) {
    const result = buildNotArticleResult(articleCheck); // 빈 점수 결과 객체 생성
    await setCachedResult(url, result);                        // 이것도 캐시에 저장
    updateStatus({
      stage: "not_article",
      label: "뉴스 기사 아님",
      url,
      detail: articleCheck.reason,
      tabId
    });
    return result; // 분석 없이 반환
  }

  // 뉴스 기사가 맞다고 판별됐으면 신뢰도·어그로도 본 분석 진행
  updateStatus({ stage: "analyzing", label: "뉴스 신뢰도·어그로도 분석 중", url, tabId });
  if (!skipArticleCheck) {
    await learnNewsPatternFromConfirmedArticle(credentials, analysisInput).catch(() => {});
  }

  const analysis  = await requestGroqAnalysis(credentials, analysisInput);
  // validateAnalysis()는 점수를 유효 범위로 보정하고 텍스트를 정제
  const validated = validateAnalysis(analysis);
  // 실제 기사 제목은 AI 분석과 무관하게 페이지에서 그대로 뽑아온 값이라 별도로
  // 붙입니다. og:title(SNS 공유용이라 보통 사이트명 접미사 없이 깔끔함)을
  // 우선 쓰고, 없으면 <title> 태그 값을 씁니다.
  validated.article_title = sanitizeText(extracted.og_title || extracted.page_title || "", 200);

  // 분석 결과를 캐시에 저장 (6시간 동안 같은 URL 재분석 시 재사용)
  setCachedResult(url, validated);

  // 최종 완료 상태 표시
  updateStatus({
    stage: "complete",
    label: "분석 완료",
    url,
    detail: `신뢰도 ${validated.credibility_score}/100, 어그로도 ${validated.clickbait_score}/100`,
    tabId
  });

  return validated; // content.js에게 최종 결과 전달
}


