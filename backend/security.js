const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { body, param, validationResult } = require('express-validator');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const JWT_EXPIRES_IN = '7d';
const GENERIC_500_MESSAGE = 'Something went wrong. Please try again later.';

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (secret) return secret;
  if (IS_PRODUCTION) {
    console.error('FATAL: JWT_SECRET must be set in production.');
    process.exit(1);
  }
  console.warn('⚠️  Using dev JWT_SECRET. Set JWT_SECRET in .env for production.');
  return 'nexmill-dev-jwt-secret-change-me';
}

const JWT_SECRET = getJwtSecret();

function buildCorsOptions() {
  const fromEnv = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  const allowed = new Set(fromEnv);
  allowed.add('http://localhost:5000');
  allowed.add('http://127.0.0.1:5000');
  allowed.add('http://localhost:3000');
  if (process.env.RENDER_EXTERNAL_URL) {
    allowed.add(process.env.RENDER_EXTERNAL_URL.replace(/\/+$/, ''));
  }

  return {
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      const normalized = origin.replace(/\/+$/, '');
      if (allowed.has(normalized) || allowed.has(origin)) {
        return callback(null, true);
      }
      if (!IS_PRODUCTION) return callback(null, true);
      return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-user-id', 'Accept']
  };
}

/**
 * Helmet security headers. CSP is set in frontend index.html meta tag (inline scripts + Tailwind CDN).
 * HSTS and other defaults apply automatically in production.
 */
const helmetMiddleware = helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
});

const rateLimitCommon = {
  windowMs: 15 * 60 * 1000,
  standardHeaders: true,
  legacyHeaders: false,
  skipFailedRequests: true
};

const authLimiter = rateLimit({
  ...rateLimitCommon,
  max: 5,
  message: { message: 'Too many login attempts. Try again in 15 minutes.' }
});

const apiLimiter = rateLimit({
  ...rateLimitCommon,
  max: 100,
  message: { message: 'Too many requests. Try again later.' },
  skip: (req) => {
    const p = req.path || '';
    return p === '/api/health' || p === '/health' || p.endsWith('/health');
  }
});

function isDangerousKey(key) {
  return typeof key === 'string' && (key.startsWith('$') || key.includes('.'));
}

function sanitizeKey(key) {
  return key.replace(/^\$+/g, '_').replace(/\./g, '_');
}

/** Strip MongoDB operator characters from plain strings. */
function stripMongoChars(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$/g, '').replace(/\./g, '');
}

function deepSanitize(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return stripMongoChars(value);
  if (Array.isArray(value)) {
    return value.map((item) => deepSanitize(item));
  }
  if (typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      const safeKey = isDangerousKey(key) ? sanitizeKey(key) : key;
      out[safeKey] = deepSanitize(child);
    }
    return out;
  }
  return value;
}

function assertNoMongoOperatorsInString(value) {
  if (value === undefined || value === null || value === '') return true;
  const s = String(value);
  if (s.includes('$') || s.includes('.')) {
    throw new Error('Invalid characters in input.');
  }
  return true;
}

const noMongoOperators = (field) =>
  body(field).custom(assertNoMongoOperatorsInString);

/**
 * Manual NoSQL injection prevention (Express 5 safe — never assign req.query).
 */
function sanitizeInput(req, res, next) {
  try {
    if (req.body && typeof req.body === 'object') {
      const rawPassword = req.body.password;
      req.body = deepSanitize(req.body);
      if (typeof rawPassword === 'string') req.body.password = rawPassword;
    }
    req.sanitizedQuery = deepSanitize({ ...req.query });
    req.sanitizedParams = deepSanitize({ ...req.params });
    next();
  } catch (err) {
    next(err);
  }
}

function signToken(user) {
  return jwt.sign(
    { sub: String(user._id), isAdmin: !!user.isAdmin },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function getBearerToken(req) {
  if (!req?.headers) return null;
  const auth = req.headers.authorization;
  if (auth && typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice(7).trim();
  }
  return null;
}

const validatePasswordMin6 = body('password').custom((value) => {
  if (typeof value !== 'string' || value.length < 6) {
    throw new Error('Password must be at least 6 characters.');
  }
  return true;
});

function sanitizePlainString(value, maxLen = 500) {
  if (value === null || value === undefined) return '';
  return stripMongoChars(String(value)).trim().slice(0, maxLen);
}

/** Phone: trim and remove spaces only — keep + prefix and digits as entered. */
function sanitizePhoneInput(phone, maxLen = 25) {
  if (phone === null || phone === undefined) return '';
  return String(phone).trim().replace(/\s+/g, '').slice(0, maxLen);
}

function isValidObjectId(id) {
  return typeof id === 'string' && mongoose.Types.ObjectId.isValid(id);
}

function handleValidationErrors(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ message: errors.array()[0].msg });
  }
  next();
}

const phoneSanitizer = body('phone').optional({ values: 'falsy' }).customSanitizer((v) => sanitizePhoneInput(v, 25));

const validatePhoneField = body('phone').optional({ values: 'falsy' }).custom((v) => {
  if (!v) return true;
  const cleaned = sanitizePhoneInput(v, 25);
  if (cleaned.length < 10) throw new Error('Enter a valid phone number (include country code).');
  return true;
});

const validateSignup = [
  noMongoOperators('name'),
  body('name').trim().isLength({ min: 2, max: 80 }).withMessage('Name must be 2–80 characters.'),
  body('email').optional({ values: 'null' }).trim().isEmail().withMessage('Enter a valid email.').normalizeEmail(),
  phoneSanitizer,
  validatePhoneField,
  validatePasswordMin6,
  body('referralCode').optional().trim().matches(/^[A-Z0-9]{4,16}$/i).withMessage('Invalid referral code format.'),
  body('ref').optional().trim().matches(/^[A-Z0-9]{4,16}$/i).withMessage('Invalid referral code format.'),
  handleValidationErrors
];

const validateLogin = [
  body('email').optional({ values: 'falsy' }).trim().isEmail().withMessage('Enter a valid email.').normalizeEmail(),
  phoneSanitizer,
  validatePhoneField,
  validatePasswordMin6,
  body().custom((_, { req }) => {
    const email = (req.body?.email || '').trim();
    const phone = (req.body?.phone || '').trim();
    if (!email && !phone) throw new Error('Email or phone is required.');
    return true;
  }),
  handleValidationErrors
];

const validateObjectIdParam = (paramName = 'id') => [
  param(paramName).custom((value) => {
    if (!isValidObjectId(value)) throw new Error('Invalid ID.');
    return true;
  }),
  handleValidationErrors
];

const validateJoin = [
  noMongoOperators('ign'),
  body('ign').trim().matches(/^[a-zA-Z0-9_\s-]{1,32}$/).withMessage('IGN must be 1–32 alphanumeric characters.'),
  body('uid').trim().matches(/^\d{6,12}$/).withMessage('UID must be 6–12 digits.'),
  body('payWithCoins').optional().isBoolean().withMessage('Invalid payment option.'),
  handleValidationErrors
];

const validateDeposit = [
  body('amount').isFloat({ min: 1, max: 1000000 }).withMessage('Amount must be a positive number.'),
  body('uid').trim().matches(/^\d{6,12}$/).withMessage('UID must be 6–12 digits.'),
  body('utr').trim().matches(/^\d{12}$/).withMessage('Transaction ID must be exactly 12 digits.'),
  handleValidationErrors
];

const validateWithdraw = [
  body('amount').isFloat({ min: 1, max: 1000000 }).withMessage('Amount must be a positive number.'),
  body('uid').trim().matches(/^\d{6,12}$/).withMessage('UID must be 6–12 digits.'),
  body('upiId').trim().isLength({ min: 3, max: 64 }).withMessage('Valid UPI ID required.'),
  handleValidationErrors
];

const ALLOWED_MAPS = ['Bermuda', 'Kalahari', 'Purgatory', 'Alpine'];

const validateTournamentCreate = [
  noMongoOperators('matchTitle'),
  noMongoOperators('rules'),
  noMongoOperators('notice'),
  body('matchTitle').trim().notEmpty().withMessage('Title is required.').isLength({ max: 120 }),
  body('mapName').trim().isIn(ALLOWED_MAPS).withMessage('Invalid map.'),
  body('entryFee').trim().notEmpty().isLength({ max: 40 }),
  body('prizePool').trim().notEmpty().isLength({ max: 40 }),
  body('totalSlots').isInt({ min: 1, max: 10000 }),
  body('rules').optional().trim().isLength({ max: 2000 }),
  body('notice').optional().trim().isLength({ max: 300 }),
  body('isPublished').optional().isBoolean(),
  handleValidationErrors
];

const validateTournamentUpdate = [
  noMongoOperators('matchTitle'),
  noMongoOperators('rules'),
  noMongoOperators('notice'),
  body('matchTitle').optional().trim().notEmpty().isLength({ max: 120 }),
  body('mapName').optional().trim().isIn(ALLOWED_MAPS),
  body('entryFee').optional().trim().isLength({ min: 1, max: 40 }),
  body('prizePool').optional().trim().isLength({ min: 1, max: 40 }),
  body('totalSlots').optional().isInt({ min: 1, max: 10000 }),
  body('rules').optional().trim().isLength({ max: 2000 }),
  body('notice').optional().trim().isLength({ max: 300 }),
  body('isPublished').optional().isBoolean(),
  handleValidationErrors
];

const validateNotice = [
  noMongoOperators('notice'),
  body('notice').trim().isLength({ max: 300 }),
  handleValidationErrors
];

const validateDistributePrizes = [
  body('tournamentId').custom((v) => {
    if (!isValidObjectId(v)) throw new Error('Invalid tournament ID.');
    return true;
  }),
  body('winners').isArray({ min: 1, max: 20 }).withMessage('Winners array required (max 20).'),
  body('winners.*.rank').isInt({ min: 1, max: 100 }),
  body('winners.*.ign').trim().matches(/^[a-zA-Z0-9_\s-]{1,32}$/),
  body('winners.*.uid').trim().matches(/^\d{6,12}$/),
  body('winners.*.prizeAmount').isFloat({ min: 0.01, max: 1000000 }),
  handleValidationErrors
];

const validateAdminAction = [
  body('requestId').custom((v) => {
    if (!isValidObjectId(v)) throw new Error('Invalid request ID.');
    return true;
  }),
  body('action').isIn(['completed', 'failed']).withMessage('Action must be completed or failed.'),
  handleValidationErrors
];

function applyRateLimiters(app) {
  app.use('/api/auth/login', authLimiter);
  app.use('/api/auth/signup', authLimiter);
  app.use('/api/admin', rateLimit({ ...rateLimitCommon, max: 60, message: { message: 'Too many admin requests. Try again later.' } }));
  app.use('/api', apiLimiter);
}

function sendSafeError(res, status, publicMessage, err) {
  if (err) console.error('[API ERROR]', err.stack || err.message || err);
  const message = status >= 500 ? GENERIC_500_MESSAGE : publicMessage;
  res.status(status).json({ message });
}

function globalErrorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (err && err.message === 'Not allowed by CORS') {
    return res.status(403).json({ message: 'Origin not allowed.' });
  }
  console.error('[UNHANDLED]', err?.stack || err);
  res.status(500).json({ message: GENERIC_500_MESSAGE });
}

function notFoundHandler(req, res) {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ message: 'Resource not found.' });
  }
  res.status(404).json({ message: 'Not found.' });
}

module.exports = {
  buildCorsOptions,
  helmetMiddleware,
  sanitizeInput,
  applyRateLimiters,
  signToken,
  verifyToken,
  getBearerToken,
  isValidObjectId,
  sanitizePlainString,
  sanitizePhoneInput,
  validateSignup,
  validateLogin,
  validateObjectIdParam,
  validateJoin,
  validateDeposit,
  validateWithdraw,
  validateTournamentCreate,
  validateTournamentUpdate,
  validateNotice,
  validateDistributePrizes,
  validateAdminAction,
  sendSafeError,
  globalErrorHandler,
  notFoundHandler,
  GENERIC_500_MESSAGE,
  IS_PRODUCTION,
  JWT_SECRET
};
