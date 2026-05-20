// ── X 버튼 클릭 → 윈도우 닫기 ──────────────────────────────
document.getElementById('close-btn').onclick = function() {
  window.close();
};

// ── 통계 카운터 (Python의 딕셔너리와 같은 역할) ──────────────
var stats = { total: 0, news: 0, skip: 0, err: 0 };

// ── 시작 시각 표시 ────────────────────────────────────────────
document.getElementById('start-time').textContent = now();

function now() {
  var d = new Date();
  return d.getHours().toString().padStart(2,'0') + ':' +
         d.getMinutes().toString().padStart(2,'0') + ':' +
         d.getSeconds().toString().padStart(2,'0');
}

// ── 상태 카드 업데이트 ────────────────────────────────────────
// Python: def set_status(icon_class, emoji, title, sub): ...
function setStatus(iconClass, emoji, title, sub) {
  document.getElementById('status-icon').className = 'status-icon ' + iconClass;
  document.getElementById('status-icon').textContent = emoji;
  document.getElementById('status-title').textContent = title;
  document.getElementById('status-sub').textContent   = sub || '';
}

// ── 로그 한 줄 추가 ───────────────────────────────────────────
// dotClass: info / step / wait / success / skip / error
// html: 로그 내용 (hl 클래스로 강조 가능)
function addLog(dotClass, html) {
  var list = document.getElementById('log-list');
  var item = document.createElement('div');
  item.className = 'log-item';
  item.innerHTML =
    '<div class="log-dot ' + dotClass + '"></div>' +
    '<span class="log-text">' + html + '</span>' +
    '<span class="log-time">' + now() + '</span>';

  // 새 로그는 맨 위에 추가 (최신 순)
  // Python: log_list.insert(0, item)
  list.insertBefore(item, list.firstChild);

  // 50줄 넘으면 오래된 항목 제거 (메모리 절약)
  while (list.children.length > 50) {
    list.removeChild(list.lastChild);
  }
}

// ── 통계 업데이트 ─────────────────────────────────────────────
function updateStats() {
  document.getElementById('stat-total').textContent = stats.total;
  document.getElementById('stat-news').textContent  = stats.news;
  document.getElementById('stat-skip').textContent  = stats.skip;
  document.getElementById('stat-err').textContent   = stats.err;
}

// ── background.js 에서 오는 상태 메시지 수신 ──────────────────
// Python: for message in message_queue: handle(message)
chrome.runtime.onMessage.addListener(function(msg) {
  if (msg.type !== 'STATUS_UPDATE') return;

  var step = msg.step;   // 어떤 단계인지
  var url  = msg.url || '';
  // URL 에서 도메인만 추출해서 표시 (너무 길면 읽기 불편)
  var domain = '';
  try { domain = new URL(url).hostname.replace('www.', ''); } catch(e) {}

  // step 값에 따라 UI 업데이트
  // Python의 if/elif 체인과 동일
  if (step === 'hover') {
    // 링크에 마우스 올린 직후 (1.5초 대기 시작)
    stats.total++;
    updateStats();
    setStatus('running', '⏱', '호버 감지됨', domain);
    addLog('step', '링크 감지 → <span class="hl">' + domain + '</span> — 1.5초 대기 중');

  } else if (step === 'fetching') {
    // 기사 HTML 다운로드 중
    setStatus('running', '📡', '기사 다운로드 중', domain);
    addLog('wait', '<span class="hl">' + domain + '</span> — 기사 본문 가져오는 중…');

  } else if (step === 'checking') {
    // Gemini 에게 "뉴스인지" 묻는 중
    setStatus('running', '🤖', 'Gemini 답장 기다리는 중', '뉴스 여부 판단 중…');
    addLog('wait', 'Gemini API → <span class="hl-yellow">뉴스 여부 판단 중…</span>');

  } else if (step === 'not_news') {
    // 뉴스가 아님 → 팝업 안 띄움
    stats.skip++;
    updateStats();
    setStatus('idle', '💤', '대기 중', '뉴스 아님 — 무시됨');
    addLog('skip', '<span class="hl">' + domain + '</span> → <span class="hl-yellow">뉴스 아님</span>, 무시');

  } else if (step === 'searching') {
    // 교차 검증용 관련 기사 검색 중
    setStatus('running', '🔎', '교차 검증 중', '관련 기사 검색 중…');
    addLog('wait', 'Google 검색 → <span class="hl-yellow">관련 기사·반대 기사 탐색 중…</span>');

  } else if (step === 'analyzing') {
    // 뉴스 확인됨 → 상세 분석 요청 중
    setStatus('running', '🔬', '상세 분석 중', 'Gemini 답장 기다리는 중…');
    addLog('wait', 'Gemini API → <span class="hl-green">뉴스 확인됨</span>, 신뢰도·어그로 분석 중…');

  } else if (step === 'done') {
    // 분석 완료
    stats.news++;
    updateStats();
    var r = msg.reliability; var a = msg.aggro;
    var rColor = r >= 70 ? 'hl-green' : r >= 40 ? 'hl-yellow' : 'hl-red';
    var aColor = a >= 70 ? 'hl-red'   : a >= 40 ? 'hl-yellow' : 'hl-green';
    setStatus('done', '✅', '분석 완료', '신뢰도 ' + r + ' · 어그로 ' + a);
    addLog('success',
      '<span class="hl">' + domain + '</span> 분석 완료 — ' +
      '신뢰도 <span class="' + rColor + '">' + r + '</span> · ' +
      '어그로 <span class="' + aColor + '">' + a + '</span>');

  } else if (step === 'error') {
    // 오류 발생
    stats.err++;
    updateStats();
    setStatus('error', '⚠️', '오류 발생', msg.error || '');
    addLog('error', '오류: <span class="hl-red">' + (msg.error || '알 수 없는 오류') + '</span>');

  } else if (step === 'cancelled') {
    // 마우스가 1.5초 전에 링크에서 벗어남
    setStatus('idle', '💤', '대기 중', '취소됨 — 다시 호버해보세요');
    addLog('info', '<span class="hl">' + domain + '</span> — 호버 취소됨');
  }
});

// ── 로그 초기화 버튼 ──────────────────────────────────────────
document.getElementById('clear-btn').onclick = function() {
  var list = document.getElementById('log-list');
  list.innerHTML =
    '<div class="log-item">' +
    '<div class="log-dot info"></div>' +
    '<span class="log-text">로그가 초기화됐습니다.</span>' +
    '<span class="log-time">' + now() + '</span>' +
    '</div>';
  stats = { total: 0, news: 0, skip: 0, err: 0 };
  updateStats();
  setStatus('idle', '💤', '대기 중', '링크에 마우스를 올려보세요');
};