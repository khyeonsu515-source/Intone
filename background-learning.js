// ─────────────────────────────────────────────
// 알려지지 않은 뉴스 사이트를 학습하고, API 키/자격 증명을 관리하는 함수들
// ─────────────────────────────────────────────

function normalizeApiKeys(keys) {
  const seen = new Set();
  return keys
    .map((key) => String(key || "").trim())
    .filter(Boolean)
    .filter((key) => {
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

async function isKnownNewsUrl(url) {
  const normalizedUrl = normalizeUrl(url).toLowerCase();
  if (!normalizedUrl) {
    return false;
  }

  const defaultPrefixes = Array.isArray(self.KNOWN_NEWS_URL_PREFIXES)
    ? self.KNOWN_NEWS_URL_PREFIXES
    : [];
  const learnedPrefixes = await getLearnedNewsPrefixes();
  const prefixes = defaultPrefixes.concat(learnedPrefixes);

  return prefixes.some((prefix) => normalizedUrl.startsWith(String(prefix || "").toLowerCase()));
}

async function learnNewsPatternFromConfirmedArticle(credentials, analysisInput) {
  const url = normalizeUrl(analysisInput?.url || "");
  if (!url || await isKnownNewsUrl(url)) {
    return;
  }

  const site = getUrlSiteInfo(url);
  if (!site.hostname) {
    return;
  }

  const observations = await getStorageObject(NEWS_SITE_OBSERVATIONS_STORAGE_KEY);
  const existing = observations[site.hostname] || {};
  if (existing.status === "learned" || existing.status === "rejected") {
    return;
  }

  const urls = Array.isArray(existing.urls) ? existing.urls.slice(0, 8) : [];
  if (!urls.includes(url)) {
    urls.push(url);
  }

  observations[site.hostname] = {
    count: urls.length,
    urls,
    status: existing.status || "observing",
    lastSeenAt: Date.now()
  };
  await setStorageValues({ [NEWS_SITE_OBSERVATIONS_STORAGE_KEY]: observations });

  if (urls.length < NEWS_SITE_LEARNING_THRESHOLD) {
    return;
  }

  observations[site.hostname].status = "checking";
  observations[site.hostname].lastCheckedAt = Date.now();
  await setStorageValues({ [NEWS_SITE_OBSERVATIONS_STORAGE_KEY]: observations });

  const patternCheck = validateNewsSitePattern(await requestNewsSitePattern(credentials, {
    host: site.hostname,
    origin: site.origin,
    confirmed_article_urls: urls,
    current_article: analysisInput
  }), site);

  if (!patternCheck.is_news_site || !patternCheck.url_prefixes.length) {
    observations[site.hostname].status = "rejected";
    observations[site.hostname].reason = patternCheck.reason;
    await setStorageValues({ [NEWS_SITE_OBSERVATIONS_STORAGE_KEY]: observations });
    return;
  }

  const learnedPrefixes = await getLearnedNewsPrefixes();
  const mergedPrefixes = mergeUrlPrefixes(learnedPrefixes, patternCheck.url_prefixes);
  observations[site.hostname].status = "learned";
  observations[site.hostname].learnedPrefixes = patternCheck.url_prefixes;
  observations[site.hostname].reason = patternCheck.reason;
  await setStorageValues({
    [LEARNED_NEWS_PATTERNS_STORAGE_KEY]: mergedPrefixes,
    [NEWS_SITE_OBSERVATIONS_STORAGE_KEY]: observations
  });
}

function validateNewsSitePattern(value, site) {
  const prefixes = Array.isArray(value?.url_prefixes)
    ? value.url_prefixes
        .map((prefix) => normalizeUrlPrefix(prefix))
        .filter((prefix) => isAcceptableLearnedPrefix(prefix, site))
    : [];

  return {
    is_news_site: Boolean(value?.is_news_site) && clampScore(value?.confidence) >= 65,
    confidence: clampScore(value?.confidence),
    url_prefixes: prefixes,
    reason: sanitizeText(value?.reason || "사이트 성격을 충분히 확인하지 못했습니다.", 180)
  };
}

function isAcceptableLearnedPrefix(prefix, site) {
  if (!prefix) {
    return false;
  }

  const info = getUrlSiteInfo(prefix);
  if (info.hostname !== site.hostname) {
    return false;
  }

  try {
    const parsed = new URL(prefix);
    return parsed.pathname !== "/";
  } catch (error) {
    return false;
  }
}

function normalizeUrlPrefix(prefix) {
  const normalized = normalizeUrl(String(prefix || "").trim());
  if (!normalized) {
    return "";
  }

  const parsed = new URL(normalized);
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function mergeUrlPrefixes(currentPrefixes, nextPrefixes) {
  const seen = new Set();
  return currentPrefixes
    .concat(nextPrefixes)
    .map((prefix) => normalizeUrlPrefix(prefix))
    .filter(Boolean)
    .filter((prefix) => {
      const key = prefix.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

async function getLearnedNewsPrefixes() {
  const prefixes = await getStorageValue(LEARNED_NEWS_PATTERNS_STORAGE_KEY, []);
  return Array.isArray(prefixes) ? prefixes.filter((prefix) => typeof prefix === "string" && prefix.trim()) : [];
}

function getUrlSiteInfo(url) {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
    return {
      hostname,
      origin: `${parsed.protocol}//${parsed.hostname}`
    };
  } catch (error) {
    return { hostname: "", origin: "" };
  }
}

function getStorageValue(key, fallbackValue) {
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (items) => {
      resolve(items[key] === undefined ? fallbackValue : items[key]);
    });
  });
}

async function getStorageObject(key) {
  const value = await getStorageValue(key, {});
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function setStorageValues(values) {
  return new Promise((resolve) => {
    chrome.storage.local.set(values, resolve);
  });
}

function getActiveCredentialIndex(keyCount) {
  return new Promise((resolve) => {
    if (!keyCount) {
      resolve(0);
      return;
    }

    chrome.storage.local.get([AI_ACTIVE_CREDENTIAL_INDEX_STORAGE_KEY], (items) => {
      const index = Number(items[AI_ACTIVE_CREDENTIAL_INDEX_STORAGE_KEY]);
      resolve(Number.isInteger(index) && index >= 0 ? index % keyCount : 0);
    });
  });
}

function setActiveCredentialIndex(index) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [AI_ACTIVE_CREDENTIAL_INDEX_STORAGE_KEY]: index }, resolve);
  });
}

function isRetryableGroqError(error) {
  const status = Number(error?.status);
  return [401, 403, 408, 409, 429, 500, 502, 503, 504].includes(status);
}


