// Load test configuration
import {
  BACKEND_DEFAULT_BASE_URL,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX_REQUESTS,
} from './gateway-defaults.js';

export const config = {
  // Base URL for API
  // Port is sourced from gateway-defaults.js (mirrors backend/src/config/env.ts).
  // Override with BASE_URL env var if needed.
  baseUrl: __ENV.BASE_URL || BACKEND_DEFAULT_BASE_URL,
  
  // Test data
  testData: {
    creators: [
      'GCREATOR1ABC123',
      'GCREATOR2DEF456',
      'GCREATOR3GHI789',
    ],
    searchQueries: [
      'token',
      'stellar',
      'test',
      'crypto',
      'coin',
    ],
  },
  
  // Thresholds for different test types
  thresholds: {
    normal: {
      http_req_duration: ['p(95)<500', 'p(99)<1000'],
      http_req_failed: ['rate<0.01'],
      http_reqs: ['rate>10'],
    },
    peak: {
      http_req_duration: ['p(95)<1000', 'p(99)<2000'],
      http_req_failed: ['rate<0.05'],
      http_reqs: ['rate>50'],
    },
    stress: {
      http_req_duration: ['p(95)<2000', 'p(99)<5000'],
      http_req_failed: ['rate<0.10'],
    },
    integration: {
      dashboard_load: ['p(95)<1500', 'p(99)<2500'],
      token_search: ['p(95)<400', 'p(99)<800'],
      campaign_refresh: ['p(95)<800', 'p(99)<1500'],
      monitoring_volume: ['rate<10'], // requests per minute per VU
    },
  },
  
  // Rate limiting — mirrors the gateway's default tier
  // (backend/src/middleware/rateLimiter.ts): 100 requests per 15 minutes.
  rateLimit: {
    windowMs: RATE_LIMIT_WINDOW_MS,
    maxRequests: RATE_LIMIT_MAX_REQUESTS,
    burstSize: 20,
  },
};

export default config;
