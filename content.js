// ── content.js ──────────────────────────────────────────────────
// 모든 웹페이지에 자동으로 삽입됩니다.
//
// 동작 순서:
//   1) 링크에 마우스 올림
//   2) 1.5초 대기 → 즉시 팝업 표시 (로딩 상태)
//   3) background 에 분석 요청
//   4) 결과 받으면 팝업 업데이트
//   5) 링크 밖으로 나가면 팝업 사라짐

(function () {
  'use strict';

  var HOVER_DELAY_MS = 1000;
  var POPUP_ID = '__news_checker_popup__';

  var hoverTimer     = null;
  var currentHref    = null;  // 현재 호버 중인 링크 주소
  var popup          = null;
  var mouseX = 0, mouseY = 0;
  var isOverPopup    = false;
  var isOverAnchor   = false;

  // ── background 로 상태 전송 ───────────────────────────────────
  function sendStatus(payload) {
    try {
      chrome.runtime.sendMessage(
        Object.assign({ type: 'STATUS_UPDATE' }, payload),
        function() { void chrome.runtime.lastError; }
      );
    } catch(e) {}
  }

  // ── 팝업 DOM 생성 (처음 한 번만) ─────────────────────────────
  function ensurePopup() {
    if (popup && document.body.contains(popup)) return;
    popup = document.createElement('div');
    popup.id = POPUP_ID;
    popup.innerHTML =
      '<div class="nc-inner">' +
        '<div class="nc-header">' +
          '<span class="nc-badge" id="nc-badge">분석 중</span>' +
          '<span class="nc-domain" id="nc-domain"></span>' +
        '</div>' +
        '<div class="nc-loading" id="nc-loading">' +
          '<div class="nc-spinner"></div>' +
          '<span id="nc-loading-text">기사 확인 중…</span>' +
        '</div>' +
        '<div class="nc-content" id="nc-content" style="display:none">' +
          '<div class="nc-meters">' +
            '<div class="nc-meter-row">' +
              '<span class="nc-meter-label">신뢰도</span>' +
              '<div class="nc-bar-wrap"><div class="nc-bar" id="nc-trust-bar"></div></div>' +
              '<span class="nc-meter-val" id="nc-trust-val">-</span>' +
            '</div>' +
            '<div class="nc-meter-row">' +
              '<span class="nc-meter-label">어그로</span>' +
              '<div class="nc-bar-wrap"><div class="nc-bar" id="nc-aggro-bar"></div></div>' +
              '<span class="nc-meter-val" id="nc-aggro-val">-</span>' +
            '</div>' +
          '</div>' +
          '<p class="nc-aggro-reason" id="nc-aggro-reason"></p>' +
          '<p class="nc-cross-check" id="nc-cross-check" style="display:none"></p>' +
          '<div class="nc-divider"></div>' +
          '<p class="nc-summary" id="nc-summary"></p>' +
          '<p class="nc-verdict" id="nc-verdict"></p>' +
        '</div>' +
        '<div class="nc-error" id="nc-error" style="display:none">' +
          '<span id="nc-error-msg"></span>' +
        '</div>' +
      '</div>';
    document.body.appendChild(popup);
    popup.addEventListener('mouseenter', function() { isOverPopup = true; });
    popup.addEventListener('mouseleave', function() {
      isOverPopup = false;
      if (!isOverAnchor) hidePopup();
    });
  }

  // ── 팝업 위치 계산 ────────────────────────────────────────────
  function positionPopup(x, y) {
    if (!popup) return;
    // offsetWidth/Height 는 팝업이 보여야 값이 나옴
    // 먼저 visible 클래스 추가 후 크기 재계산
    var W  = popup.offsetWidth  || 320;
    var H  = popup.offsetHeight || 220;
    var vw = window.innerWidth;
    var scrollY = window.scrollY || window.pageYOffset;
    var vh = window.innerHeight + scrollY;
    var left = x + 18;
    var top  = y + 18;
    if (left + W > vw - 8)  left = x - W - 10;
    if (top  + H > vh - 8)  top  = y - H - 10;
    popup.style.left = Math.max(4, left) + 'px';
    popup.style.top  = Math.max(4, top)  + 'px';
  }

  function showPopup() {
    ensurePopup();
    popup.classList.add('nc-visible');
    positionPopup(mouseX, mouseY);
  }

  function hidePopup() {
    if (popup) popup.classList.remove('nc-visible');
  }

  // ── 팝업 상태 변경 ────────────────────────────────────────────
  function setLoading(msg) {
    ensurePopup();
    document.getElementById('nc-loading').style.display = 'flex';
    document.getElementById('nc-content').style.display = 'none';
    document.getElementById('nc-error').style.display   = 'none';
    document.getElementById('nc-loading-text').textContent = msg || '분석 중…';
    var badge = document.getElementById('nc-badge');
    badge.textContent = '분석 중';
    badge.className   = 'nc-badge nc-badge-loading';
  }

  function setDomain(url) {
    try {
      document.getElementById('nc-domain').textContent =
        new URL(url).hostname.replace('www.', '');
    } catch(e) {}
  }

  function setResult(data) {
    ensurePopup();
    document.getElementById('nc-loading').style.display = 'none';
    document.getElementById('nc-error').style.display   = 'none';
    document.getElementById('nc-content').style.display = 'block';

    var r = data.reliability || 0;
    var a = data.aggro || 0;
    var badge = document.getElementById('nc-badge');
    if      (r >= 70) { badge.textContent = '신뢰 높음'; badge.className = 'nc-badge nc-badge-good'; }
    else if (r >= 40) { badge.textContent = '보통';      badge.className = 'nc-badge nc-badge-mid';  }
    else              { badge.textContent = '주의 필요'; badge.className = 'nc-badge nc-badge-bad';  }

    var tb = document.getElementById('nc-trust-bar');
    tb.style.width      = r + '%';
    tb.style.background = r >= 70 ? '#1D9E75' : r >= 40 ? '#EF9F27' : '#E24B4A';
    document.getElementById('nc-trust-val').textContent = r;

    var ab = document.getElementById('nc-aggro-bar');
    ab.style.width      = a + '%';
    ab.style.background = a >= 70 ? '#E24B4A' : a >= 40 ? '#EF9F27' : '#1D9E75';
    document.getElementById('nc-aggro-val').textContent = a;

    document.getElementById('nc-aggro-reason').textContent = data.aggro_reason || '';
    var cc = document.getElementById('nc-cross-check');
    if (data.cross_check) {
      cc.textContent = '🔗 ' + data.cross_check;
      cc.style.display = 'block';
    } else {
      cc.style.display = 'none';
    }
    document.getElementById('nc-summary').textContent      = data.summary      || '';
    document.getElementById('nc-verdict').textContent      = data.verdict      || '';
  }

  function setError(msg) {
    ensurePopup();
    document.getElementById('nc-loading').style.display = 'none';
    document.getElementById('nc-content').style.display = 'none';
    document.getElementById('nc-error').style.display   = 'flex';
    document.getElementById('nc-error-msg').textContent = msg;
    var badge = document.getElementById('nc-badge');
    badge.textContent = '오류';
    badge.className   = 'nc-badge nc-badge-neutral';
  }

  function setNotNews() {
    ensurePopup();
    document.getElementById('nc-loading').style.display = 'none';
    document.getElementById('nc-content').style.display = 'none';
    document.getElementById('nc-error').style.display   = 'flex';
    document.getElementById('nc-error-msg').textContent = '뉴스 기사가 아닙니다.';
    var badge = document.getElementById('nc-badge');
    badge.textContent = '뉴스 아님';
    badge.className   = 'nc-badge nc-badge-neutral';
  }

  // ── 마우스 위치 추적 ──────────────────────────────────────────
  document.addEventListener('mousemove', function(e) {
    mouseX = e.clientX + (window.scrollX || window.pageXOffset);
    mouseY = e.clientY + (window.scrollY || window.pageYOffset);
    if (popup && popup.classList.contains('nc-visible')) {
      positionPopup(mouseX, mouseY);
    }
  }, true);

  // ── 링크 감지: mouseover ──────────────────────────────────────
  // capture:true → 이벤트 버블링 전에 먼저 잡음 (SPA 사이트에서도 동작)
  document.addEventListener('mouseover', function(e) {
    // e.target 또는 부모 중에서 <a href> 찾기
    var anchor = e.target.closest ? e.target.closest('a[href]') : null;
    if (!anchor) {
      // closest 미지원 브라우저 대비 수동 탐색
      var el = e.target;
      while (el && el !== document.body) {
        if (el.tagName === 'A' && el.href) { anchor = el; break; }
        el = el.parentElement;
      }
    }
    if (!anchor) return;

    var href = anchor.href || '';
    // 의미없는 링크 무시
    if (!href ||
        href.indexOf('javascript:') === 0 ||
        href.indexOf('mailto:') === 0 ||
        href === '#' ||
        href.indexOf('#') === 0) return;

    isOverAnchor = true;

    // 같은 링크를 이미 처리 중이면 무시
    if (href === currentHref) return;

    // 새 링크 → 이전 타이머 취소
    clearTimeout(hoverTimer);
    currentHref = href;

    hoverTimer = setTimeout(function() {
      // 1.5초 후: 팝업은 아직 안 띄우고 뉴스 여부만 먼저 확인
      // Python: if check_is_news(url): show_popup()
      sendStatus({ step: 'hover', url: href });

      chrome.runtime.sendMessage({ type: 'CHECK_NEWS', url: href }, function(response) {
        var lastErr = chrome.runtime.lastError;

        // 마우스가 이미 다른 링크로 이동했으면 무시
        if (href !== currentHref) return;

        if (lastErr) {
          // 오류는 팝업 없이 조용히 무시
          return;
        }
        if (!response || !response.ok) {
          // API 키 미설정 등 오류만 팝업으로 표시
          setDomain(href);
          setError((response && response.error) || '오류 발생');
          showPopup();
          return;
        }

        // 뉴스가 아니면 → 팝업 안 띄우고 조용히 종료
        // Python: if not is_news: return
        if (!response.isNews) {
          sendStatus({ step: 'cancelled', url: href });
          return;
        }

        // 뉴스 확인됨 → 이제 팝업 표시 + 상세 분석 시작
        setDomain(href);
        setLoading('신뢰도·어그로 분석 중…');
        showPopup();

        chrome.runtime.sendMessage({ type: 'ANALYZE_URL', url: href }, function(res2) {
          void chrome.runtime.lastError;
          if (href !== currentHref) return;
          if (!res2)       { setError('응답 없음'); return; }
          if (!res2.ok)    { setError(res2.error || '분석 실패'); return; }
          setResult(res2.data);
        });
      });

    }, HOVER_DELAY_MS);

  }, true); // capture:true

  // ── 링크 벗어남: mouseout ─────────────────────────────────────
  document.addEventListener('mouseout', function(e) {
    var anchor = e.target.closest ? e.target.closest('a[href]') : null;
    if (!anchor) {
      var el = e.target;
      while (el && el !== document.body) {
        if (el.tagName === 'A' && el.href) { anchor = el; break; }
        el = el.parentElement;
      }
    }
    if (!anchor) return;

    // relatedTarget: 마우스가 이동한 다음 요소
    // 링크 안의 자식으로 이동한 거면 무시 (링크 벗어난 게 아님)
    var related = e.relatedTarget;
    if (related && anchor.contains(related)) return;

    isOverAnchor = false;
    clearTimeout(hoverTimer);

    // 팝업 위로 이동한 경우 팝업 유지
    if (anchor.href === currentHref) {
      sendStatus({ step: 'cancelled', url: anchor.href });
      currentHref = null;
      setTimeout(function() {
        if (!isOverPopup && !isOverAnchor) hidePopup();
      }, 100);
    }
  }, true);

  window.addEventListener('scroll', hidePopup, { passive: true });

})();
