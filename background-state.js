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

const AI_ACTIVE_CREDENTIAL_INDEX_STORAGE_KEY = "aiActiveCredentialIndex";

const LEARNED_NEWS_PATTERNS_STORAGE_KEY = "learnedNewsUrlPrefixes";

const NEWS_SITE_OBSERVATIONS_STORAGE_KEY = "newsSiteObservations";

const NEWS_SITE_LEARNING_THRESHOLD = 2;

// Firebase(Firestore)는 이제 "같은 사건을 다룬 기사끼리 묶기"(주제 클러스터링)
// 용도로만 씁니다. options.html에서 저장한 값이 없으면 아래 기본값을 씁니다.
const FIREBASE_PROJECT_ID_STORAGE_KEY = "firebaseProjectId";
const FIREBASE_API_KEY_STORAGE_KEY = "firebaseApiKey";
const FIREBASE_DEFAULT_PROJECT_ID = "intone-analysis";
const FIREBASE_DEFAULT_API_KEY = "AIzaSyBQT-UNNgB5Ujlkw_RFsPNsfKfj0jIXQnY";

// 사건/이슈 하나당 문서 하나. 대표 topic 라벨 + 키워드 배열 + 소속 기사 URL 목록을 가짐.
// keywords 배열에 Firestore의 array-contains-any 쿼리를 걸어 후보를 찾는다.
const TOPICS_COLLECTION = "topics";

// 기사 하나당 문서 하나(문서 ID = URL의 SHA-256 해시). topicId로 topics 문서를
// 참조하며, 이 기사의 신뢰도·어그로도·요약까지 담아서 "같은 주제의 기사들을
// 분석 내용까지" 바로 조회할 수 있게 한다.
const ARTICLES_COLLECTION = "articles";

// 로컬 키워드 추출: 제목 쪽 단어에 더 높은 가중치를 준다(본문 단어보다 주제를 잘 대표하므로).
const LOCAL_KEYWORD_TITLE_WEIGHT = 3;
// 이 가중치 합계 이상인 단어만(또는 제목에 등장한 단어는 무조건) 키워드 후보로 남긴다.
const LOCAL_KEYWORD_MIN_SCORE = 2;
// 기사 하나에서 뽑아 쓰는 키워드 최대 개수.
const LOCAL_KEYWORD_MAX_COUNT = 6;

// 두 기사가 "같은 사건"으로 묶이려면 최소 이만큼 키워드가 겹쳐야 한다.
const TOPIC_MATCH_MIN_OVERLAP = 2;
// 그리고 자카드 유사도(교집합/합집합)가 이 값 이상이어야 한다.
const TOPIC_MATCH_MIN_JACCARD = 0.3;
// 색인을 시도하기 위한 이 기사 자체의 최소 키워드 개수(너무 적으면 아예 건너뜀).
const TOPIC_MATCH_MIN_KEYWORDS = 2;
// 후보 주제를 몇 개까지 가져와서 비교할지.
const TOPIC_QUERY_LIMIT = 20;
// 주제 문서에 쌓아두는 키워드 목록의 최대 길이(계속 늘어나지 않도록 상한을 둠).
const TOPIC_KEYWORD_CAP = 24;

// 분석 결과를 임시로 보관하는 메모리 저장소 (Map = 키-값 쌍을 저장하는 자료구조)
// 키: URL 문자열, 값: 해당 URL의 분석 결과 + 저장 시각
// ※ 주의: Service Worker가 절전 상태로 종료되면 이 데이터도 같이 사라집니다.
const analysisCache = new Map();
