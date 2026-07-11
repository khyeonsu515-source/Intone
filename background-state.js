// ─────────────────────────────────────────────
// 프로그램 전체에서 바뀌지 않는 고정 값들
// ─────────────────────────────────────────────

// Groq AI에 분석 요청을 보낼 주소 (URL)
const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

// 사용할 AI 모델의 이름 (Llama 3.1 8B 모델)
const GROQ_MODEL = "llama-3.1-8b-instant";

const CEREBRAS_ENDPOINT = "https://api.cerebras.ai/v1/chat/completions";

const CEREBRAS_MODEL = "gpt-oss-120b";

// 캐시(기억)를 얼마나 오래 유지할지: 6시간을 밀리초로 표현
// 계산: 1000ms(1초) × 60(1분) × 60(1시간) × 6(6시간)
const CACHE_TTL_MS = 1000 * 60 * 60 * 6;

// 브라우저 저장소에 상태를 저장할 때 사용하는 이름표(키)
const STATUS_STORAGE_KEY = "currentAnalysisStatus";

const ANALYSIS_CACHE_STORAGE_KEY = "intoneAnalysisCache";
const ANALYSIS_CACHE_MAX_ENTRIES = 160;

// Firebase(Firestore) 설정은 options.html에서 저장한 값을 우선 사용하고,
// 저장된 값이 없으면 아래 기본값을 사용합니다. 즉, 사용자가 직접 설정하지
// 않아도 이 확장 프로그램은 항상 이 Firebase 프로젝트를 공유 캐시로 씁니다.
const FIREBASE_PROJECT_ID_STORAGE_KEY = "firebaseProjectId";
const FIREBASE_API_KEY_STORAGE_KEY = "firebaseApiKey";
const FIREBASE_DEFAULT_PROJECT_ID = "intone-analysis";
const FIREBASE_DEFAULT_API_KEY = "AIzaSyBQT-UNNgB5Ujlkw_RFsPNsfKfj0jIXQnY";
const FIRESTORE_COLLECTION = "analysisResults";

// 같은 사건을 다룬 기사끼리 묶기 위한 색인용 컬렉션 두 개.
// keywordIndex: 키워드 하나당 문서 하나, 그 키워드가 등장한 topic들의 ID 목록을 가짐.
// topics: 사건/이슈 하나당 문서 하나, 대표 topic 라벨 + 연결된 키워드 + 소속 기사 URL 목록을 가짐.
const KEYWORD_INDEX_COLLECTION = "keywordIndex";
const TOPICS_COLLECTION = "topics";

// Firestore는 여러 사용자가 함께 쓰는 공유 캐시라서 로컬 캐시(6시간)보다 오래 유지합니다.
const FIRESTORE_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7일

// 새 기사를 분석하기 전에 "이미 같은 사건을 다룬 기사가 있는지" AI에게 참고시킬
// 기존 topic/core_keywords 후보를 Firestore에서 몇 개까지 가져올지.
const TOPIC_CANDIDATE_LIMIT = 40;

const AI_ACTIVE_CREDENTIAL_INDEX_STORAGE_KEY = "aiActiveCredentialIndex";

const LEARNED_NEWS_PATTERNS_STORAGE_KEY = "learnedNewsUrlPrefixes";

const NEWS_SITE_OBSERVATIONS_STORAGE_KEY = "newsSiteObservations";

const NEWS_SITE_LEARNING_THRESHOLD = 2;

// 분석 결과를 임시로 보관하는 메모리 저장소 (Map = 키-값 쌍을 저장하는 자료구조)
// 키: URL 문자열, 값: 해당 URL의 분석 결과 + 저장 시각
// ※ 주의: Service Worker가 절전 상태로 종료되면 이 데이터도 같이 사라집니다.
const analysisCache = new Map();
