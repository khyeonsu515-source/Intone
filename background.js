// ── background.js ──────────────────────────────────────────────
// Python 으로 치면 이 파일은 별도 프로세스(daemon)처럼 동작하는 서버입니다.
// content.js(웹페이지 안)에서는 chrome API 일부에 접근이 불가해서
// API 키 읽기, 외부 fetch 등을 모두 여기서 대신 처리합니다.

// ══════════════════════════════════════════════════════════════
// ★ API 키를 아래 따옴표 안에 붙여넣으세요 ★
// 예시: var GEMINI_API_KEY = 'AIzaSyABC123...';
// Python의 config.py 에서 API_KEY = '...' 설정하는 것과 같습니다.
// ══════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════
// ★ Groq API 키를 아래 따옴표 안에 붙여넣으세요 ★
// 발급: https://console.groq.com/keys
// 키 형식: gsk_...
// ══════════════════════════════════════════════════════════════
var GROQ_API_KEY = '여기에_API_키_붙여넣기';



// ── 확장 아이콘 클릭 → 독립 윈도우로 열기 ───────────────────
// default_popup 대신 직접 윈도우를 생성
// → 다른 곳 클릭해도 닫히지 않음
var monitorWindowId = null; // 현재 열린 모니터 윈도우 ID

chrome.action.onClicked.addListener(function() {
  // 이미 윈도우가 열려 있으면 앞으로 가져오기
  if (monitorWindowId !== null) {
    chrome.windows.get(monitorWindowId, function(win) {
      if (chrome.runtime.lastError || !win) {
        // 윈도우가 이미 닫혔으면 새로 열기
        monitorWindowId = null;
        openMonitorWindow();
      } else {
        chrome.windows.update(monitorWindowId, { focused: true });
      }
    });
    return;
  }
  openMonitorWindow();
});

function openMonitorWindow() {
  chrome.windows.create({
    url: chrome.runtime.getURL('options.html'),
    type: 'popup',   // 일반 브라우저 창이 아닌 팝업 윈도우
    width: 340,
    height: 560,
    focused: true
  }, function(win) {
    monitorWindowId = win.id;
  });
}

// 윈도우가 닫히면 ID 초기화
chrome.windows.onRemoved.addListener(function(windowId) {
  if (windowId === monitorWindowId) {
    monitorWindowId = null;
  }
});

// ── 상태 메시지를 options.html 팝업으로 전송 ──────────────────
// Python의 print() 또는 logging.info() 같은 역할
// options 팝업이 열려있을 때만 전달됨 (닫혀있으면 조용히 무시)
function sendStatus(payload) {
  // MV3 Service Worker 에서 sendMessage 는 Promise 를 반환하지 않음
  // 반드시 콜백 방식으로 써야 함 — Python의 try/except pass 역할
  try {
    chrome.runtime.sendMessage(
      Object.assign({ type: 'STATUS_UPDATE' }, payload),
      function() { void chrome.runtime.lastError; } // 팝업 닫혀있으면 무시
    );
  } catch(e) {}
}

// ── 메시지 수신 대기 ───────────────────────────────────────────
// Python의 if __name__ == "__main__": server.listen() 같은 역할
chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {

  // STATUS_UPDATE 는 options.js 가 받는 메시지 — background 에서는 무시
  if (msg.type === 'STATUS_UPDATE') {
    // content.js 가 보낸 STATUS_UPDATE 를 options 팝업으로 중계
    sendStatus(msg);
    return false;
  }

  // API 키가 기본값 그대로이면 오류 안내
  if (GROQ_API_KEY === '여기에_API_키_붙여넣기' || GROQ_API_KEY === '') {
    sendResponse({ ok: false, error: 'background.js 에 Groq API 키를 입력해 주세요' });
    return true;
  }

  // [1단계] 뉴스 여부만 먼저 확인
  // content.js 가 CHECK_NEWS 를 보내면 → 뉴스인지 true/false 만 반환
  if (msg.type === 'CHECK_NEWS') {
    checkIsNews(msg.url, GROQ_API_KEY)
      .then(function(isNews) { sendResponse({ ok: true, isNews: isNews }); })
      .catch(function(err)   { sendResponse({ ok: false, error: err.message }); });
    return true; // 비동기 응답을 쓰겠다는 선언 (이 줄 없으면 응답 전에 채널이 닫힘)
  }

  // [2단계] 뉴스임이 확인된 경우에만 상세 분석
  // content.js 가 ANALYZE_URL 을 보내면 → 신뢰도/어그로/요약 반환
  if (msg.type === 'ANALYZE_URL') {
    analyzeUrl(msg.url, msg.title, msg.body, GROQ_API_KEY)
      .then(function(data) { sendResponse({ ok: true, data: data }); })
      .catch(function(err) { sendResponse({ ok: false, error: err.message }); });
    return true;
  }
});


// ── 1단계 함수: 뉴스인지만 판단 ──────────────────────────────
// Python으로 치면:
//   def check_is_news(url: str, api_key: str) -> bool:
//       html = requests.get(url).text
//       title, body = parse_article(html)
//       return gemini_ask_is_news(title, body, api_key)
async function checkIsNews(url, apiKey) {
  // [상태 전송] 기사 다운로드 시작
  sendStatus({ step: 'fetching', url: url });

  // 기사 본문 가져오기
  // background 는 host_permissions 덕분에 CORS 없이 모든 URL fetch 가능
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(8000)
  });
  const html = await res.text();
  const parsed = parseArticle(html);

  // 본문이 너무 짧으면 뉴스 아님으로 처리 (API 호출 절약)
  // Python: if len(body) < 100: return False
  if (!parsed.body || parsed.body.length < 100) {
    sendStatus({ step: 'not_news', url: url });
    return false;
  }

  // [상태 전송] Groq 에 뉴스 여부 판단 요청
  sendStatus({ step: 'checking', url: url });

  // Gemini 에게 뉴스 여부만 물어봄 (짧은 프롬프트 → 빠르고 토큰 절약)
  const prompt = `다음 웹 페이지 제목과 본문 일부를 보고,
이것이 뉴스 기사인지 판단하세요.

제목: ${parsed.title}
본문 앞부분: ${parsed.body.slice(0, 500)}

JSON 으로만 답하세요: {"is_news": true} 또는 {"is_news": false}`;

  // Groq API — OpenAI 와 동일한 형식 사용 (Python의 openai 라이브러리와 호환)
  // Authorization: Bearer 키 → Python의 headers={'Authorization': f'Bearer {api_key}'} 와 동일
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile', // 무료 고성능 모델
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,       // 가장 확정적인 답변
      max_tokens: 20        // {"is_news": true} 정도만 받으면 충분
    })
  });

  if (!response.ok) {
    const err = await response.json().catch(function() { return {}; });
    throw new Error(err.error && err.error.message ? err.error.message : 'API 오류 ' + response.status);
  }

  const data = await response.json();
  // Groq 응답 구조: data.choices[0].message.content
  // Gemini:         data.candidates[0].content.parts[0].text
  // Python: reply = data['choices'][0]['message']['content']
  const raw = data.choices &&
              data.choices[0] &&
              data.choices[0].message &&
              data.choices[0].message.content || '';

  const clean = raw.replace(/```json|```/g, '').trim();
  const match = clean.match(/{[\s\S]*}/);
  if (!match) return false;

  // Python: result = json.loads(match[0]); return result.get('is_news', False)
  const result = JSON.parse(match[0]);
  if (!result.is_news) {
    sendStatus({ step: 'not_news', url: url });
  }
  return result.is_news === true;
}


// ── 2단계 함수: 교차 검증용 관련 기사 검색 ──────────────────
// 같은 주제의 다른 기사, 반대 입장 기사를 Google에서 검색
// Python: related = requests.get(f"https://www.google.com/search?q={title}").text
async function fetchRelatedArticles(title) {
  const results = { confirming: [], contradicting: [] };
  try {
    // 제목 핵심어 추출 (앞 30자) 로 구글 검색
    const query = encodeURIComponent(title.slice(0, 40));
    const searchUrl = 'https://www.google.com/search?q=' + query + '&num=5&hl=ko';

    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(5000)
    });
    const html = await res.text();

    // 구글 검색결과에서 도메인 추출 (중복 교차 보도 확인용)
    // Python: domains = re.findall(r'https?://([^/]+)', html)
    const domainMatches = html.match(/https?:\/\/([a-zA-Z0-9.\-]+)\/[^"'\s]*/g) || [];
    const domains = [...new Set(
      domainMatches
        .map(function(u) { try { return new URL(u).hostname.replace('www.',''); } catch(e){ return ''; } })
        .filter(function(d) { return d && !d.includes('google') && d.length > 4; })
    )].slice(0, 5);

    results.confirming = domains;
  } catch(e) {
    // 검색 실패해도 분석은 계속 진행
  }
  return results;
}

// ── 2단계 함수: 상세 분석 ─────────────────────────────────────
// 어그로 지수: 제목-내용 불일치 + 착각 유도 여부 동시 판단
// 신뢰성: 교차 보도 존재 여부 + 반대 입장 기사 존재 여부 반영
// Python으로 치면:
//   def analyze_url(title, body, api_key) -> dict:
//       related = fetch_related_articles(title)
//       return groq_full_analysis(title, body, related, api_key)
async function analyzeUrl(url, title, body, apiKey) {
  // [상태 전송] 상세 분석 시작
  sendStatus({ step: 'analyzing', url: url });

  // title/body 가 없으면 다시 fetch (안전장치)
  if (!body) {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000)
    });
    const html = await res.text();
    const parsed = parseArticle(html);
    title = parsed.title;
    body  = parsed.body;
  }

  // 교차 검증용 관련 기사 검색 (신뢰성 판단에 활용)
  sendStatus({ step: 'searching', url: url });
  const related = await fetchRelatedArticles(title);
  const relatedInfo = related.confirming.length > 0
    ? '같은 내용을 보도한 다른 매체: ' + related.confirming.join(', ')
    : '같은 내용을 보도한 다른 매체를 찾지 못했습니다.';

  const prompt = `당신은 뉴스 기사 팩트체크 전문가입니다. 아래 기사를 분석하세요.

[기사 제목]
${title}

[기사 본문 일부]
${body.slice(0, 3000)}

[교차 검증 정보]
${relatedInfo}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【어그로 지수 산정 기준】 (0~100, 높을수록 어그로)
다음 항목을 종합적으로 판단하세요:

1. 제목-내용 불일치
   - 제목이 주장하는 내용이 본문에 실제로 있는가?
   - 제목의 핵심 주장이 본문에서 축소·번복되지는 않는가?

2. 착각 유도 (매우 중요)
   - 제목만 보면 독자가 전혀 다른 상황으로 오해할 수 있는가?
   - 예시: "아이유 결혼" → 실제로는 드라마 배역 이야기
   - 예시: "삼성 파산" → 실제로는 해외 소규모 계열사 이야기
   - 이처럼 실제 인물/기업/사건인 것처럼 제목을 써놓고
     본문에서 드라마·영화·가상 시나리오임이 밝혀지는 경우 → 90점 이상
   - 유명인 이름/유명 기업을 제목에 내세웠지만
     본문 내용과 직접적 관련이 없는 경우 → 70점 이상

3. 과장·선정성
   - "충격", "경악", "발칵", "역대급" 등 자극적 표현 사용
   - 사실보다 훨씬 심각하게 부풀린 표현

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【신뢰도 산정 기준】 (0~100, 높을수록 신뢰)
다음 항목을 종합적으로 판단하세요:

1. 교차 보도 여부 (+30점 요인)
   - 위 교차 검증 정보에 다른 매체가 있으면 신뢰도 상향
   - 여러 매체가 같은 내용을 보도했다면 사실일 가능성 높음

2. 출처·근거 명시 여부
   - 익명 소식통만 있고 공식 출처가 없으면 신뢰도 하향
   - 공식 발표, 논문, 실명 인터뷰 등이 있으면 상향

3. 균형성
   - 한쪽 입장만 일방적으로 전달하면 신뢰도 하향
   - 반론·복수 입장을 포함하면 상향

4. 착각 유도 여부 (-40점 요인)
   - 어그로 지수에서 착각 유도로 판단된 경우 신뢰도 대폭 하향

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
마크다운 없이 순수 JSON으로만 답하세요:
{
  "reliability": 숫자,
  "aggro": 숫자,
  "aggro_reason": "어그로 판단 이유 — 착각 유도 여부 포함하여 한 줄 (한국어)",
  "summary": "기사 핵심 내용 2~3문장 (한국어)",
  "verdict": "한 줄 총평 (한국어)",
  "cross_check": "교차 보도 검증 결과 한 줄 (한국어)"
}`;

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens: 600
    })
  });

  if (!response.ok) {
    const err = await response.json().catch(function() { return {}; });
    throw new Error(err.error && err.error.message ? err.error.message : 'API 오류 ' + response.status);
  }

  const data = await response.json();
  const raw = data.choices &&
              data.choices[0] &&
              data.choices[0].message &&
              data.choices[0].message.content || '';

  const clean = raw.replace(/```json|```/g, '').trim();
  const match = clean.match(/{[\s\S]*}/);
  if (!match) throw new Error('AI 응답 파싱 실패: ' + raw.slice(0, 100));
  const result = JSON.parse(match[0]);

  // [상태 전송] 분석 완료
  sendStatus({
    step: 'done',
    url: url,
    reliability: result.reliability || 0,
    aggro: result.aggro || 0
  });
  return result;
}


// ── HTML 파서 유틸 ────────────────────────────────────────────
// 외부 라이브러리 없이 정규식으로 제목·본문 추출
// Python의 BeautifulSoup 역할을 간단히 흉내낸 함수
function parseArticle(html) {
  // <title> 태그에서 제목 추출
  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/si);
  const title = titleMatch ? decodeHtml(titleMatch[1].trim()) : '';

  // <p> 태그 안의 텍스트를 모두 모아서 본문으로 사용
  // Python: body = " ".join([p.get_text() for p in soup.find_all("p") if len(p.get_text()) > 30])
  const paragraphs = [];
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = pRegex.exec(html)) !== null) {
    const text = stripTags(m[1]).trim();
    if (text.length > 30) paragraphs.push(text);
  }

  let body = paragraphs.join(' ');

  // <p> 태그가 없으면 og:description 메타 태그에서 대신 가져옴
  if (!body) {
    const ogDesc = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
    if (ogDesc) body = decodeHtml(ogDesc[1]);
  }

  return { title: title, body: body };
}

// HTML 태그 제거: <b>굵게</b> → "굵게"
// Python: re.sub(r'<[^>]+>', ' ', html)
function stripTags(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// HTML 특수문자 디코딩: &amp; → &, &lt; → < 등
// Python: html.unescape(str)
function decodeHtml(str) {
  return str
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&nbsp;/g, ' ');
}
