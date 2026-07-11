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

// Firebase(Firestore) 설정은 options.html에서 저장합니다. 둘 다 있어야 사용합니다.
const FIREBASE_PROJECT_ID_STORAGE_KEY = "firebaseProjectId";
const FIREBASE_API_KEY_STORAGE_KEY = "firebaseApiKey";
const FIRESTORE_COLLECTION = "analysisResults";

// Firestore는 여러 사용자가 함께 쓰는 공유 캐시라서 로컬 캐시(6시간)보다 오래 유지합니다.
const FIRESTORE_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7일

const AI_ACTIVE_CREDENTIAL_INDEX_STORAGE_KEY = "aiActiveCredentialIndex";

const LEARNED_NEWS_PATTERNS_STORAGE_KEY = "learnedNewsUrlPrefixes";

const NEWS_SITE_OBSERVATIONS_STORAGE_KEY = "newsSiteObservations";

const NEWS_SITE_LEARNING_THRESHOLD = 2;

// 분석 결과를 임시로 보관하는 메모리 저장소 (Map = 키-값 쌍을 저장하는 자료구조)
// 키: URL 문자열, 값: 해당 URL의 분석 결과 + 저장 시각
// ※ 주의: Service Worker가 절전 상태로 종료되면 이 데이터도 같이 사라집니다.
const analysisCache = new Map();
