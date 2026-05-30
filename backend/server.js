require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const security = require('./security');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 5000;
function envReferralCoins() {
  const n = parseInt(process.env.REFERRAL_COINS || '100', 10);
  if (!Number.isFinite(n) || n < 1) {
    console.error('FATAL: REFERRAL_COINS must be a positive integer.');
    process.exit(1);
  }
  return n;
}
function envCoinRate() {
  const n = parseFloat(process.env.COIN_RATE || '0.2');
  if (!Number.isFinite(n) || n <= 0) {
    console.error('FATAL: COIN_RATE must be a positive number.');
    process.exit(1);
  }
  return n;
}
const DEFAULT_REFERRAL_COINS = envReferralCoins();
const DEFAULT_COIN_RATE = envCoinRate();
const FRONTEND_DIR = fs.existsSync(path.join(__dirname, '..', 'frontend'))
  ? path.join(__dirname, '..', 'frontend')
  : path.join(__dirname, 'frontend');

app.use(cors(security.buildCorsOptions()));
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(security.helmetMiddleware);
app.use(security.sanitizeInput);

app.get('/api/health', (req, res) => {
  const dbConnected = mongoose.connection.readyState === 1;
  const payload = { status: dbConnected ? 'ok' : 'degraded', db: dbConnected ? 'connected' : 'disconnected' };
  res.status(dbConnected ? 200 : 503).json(payload);
});

security.applyRateLimiters(app);

const MONGODB_URI = process.env.MONGO_URI;
if (!MONGODB_URI) {
  if (security.IS_PRODUCTION) {
    console.error('FATAL: MONGO_URI must be set in production.');
    process.exit(1);
  }
  console.warn('⚠️  MONGO_URI not set — using local fallback for development only.');
}
const mongoUri = MONGODB_URI || 'mongodb://127.0.0.1:27017/nexmill_arena_dev';

mongoose.connect(mongoUri, {
  maxPoolSize: 10,
  serverSelectionTimeoutMS: 30000,
  socketTimeoutMS: 45000,
  family: 4
})
.then(() => console.log('✅ MongoDB connected'))
.catch(err => console.error('❌ MongoDB error:', err));

// ==================== SCHEMAS ====================
const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, unique: true, sparse: true, lowercase: true, trim: true, default: null },
  password: { type: String, required: true },
  isAdmin: { type: Boolean, default: false },
  gameUid: { type: String, default: '' },
  phone: { type: String, unique: true, sparse: true, trim: true, default: null },
  referralCode: { type: String, unique: true, sparse: true, uppercase: true, trim: true },
  referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  coins: { type: Number, default: 0, min: 0 },
  referralCount: { type: Number, default: 0, min: 0 },
  createdAt: { type: Date, default: Date.now }
});

const participantSchema = new mongoose.Schema({
  ign: { type: String, required: true },
  uid: { type: String, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  paidWithCoins: { type: Boolean, default: false },
  registeredAt: { type: Date, default: Date.now }
});

const tournamentSchema = new mongoose.Schema({
  matchTitle: { type: String, required: true },
  mapName: { type: String, required: true },
  entryFee: { type: String, required: true },
  prizePool: { type: String, required: true },
  totalSlots: { type: Number, required: true, min: 1 },
  filledSlots: { type: Number, default: 0 },
  // Admin visibility control: if false, hidden from regular users until published by admin.
  isPublished: { type: Boolean, default: true },
  isFeatured: { type: Boolean, default: false },
  notice: { type: String, default: '' },
  rules: { type: String, default: 'Standard Rules Apply' },
  adminProfit: { type: Number, default: 0 },
  participants: [participantSchema],
  roomID: { type: String, default: '' },
  roomPass: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});
tournamentSchema.index({ createdAt: -1 });
tournamentSchema.index({ 'participants.uid': 1 });

const depositRequestSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  amount: { type: Number, required: true, min: 1 },
  uid: { type: String, required: true },
  utr: { type: String, required: true, unique: true },
  status: { type: String, default: 'pending', enum: ['pending', 'completed', 'failed'] },
  createdAt: { type: Date, default: Date.now }
});
depositRequestSchema.index({ userId: 1, createdAt: -1 });
depositRequestSchema.index({ createdAt: -1 });
depositRequestSchema.index({ status: 1, createdAt: -1 });

const walletSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  balance: { type: Number, default: 0 }
});
const withdrawalSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  uid: { type: String, required: true },
  upiId: { type: String, required: true },
  amount: { type: Number, required: true, min: 1 },
  status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
  createdAt: { type: Date, default: Date.now }
});
withdrawalSchema.index({ userId: 1, createdAt: -1 });
withdrawalSchema.index({ createdAt: -1 });
withdrawalSchema.index({ status: 1, createdAt: -1 });

const leaderboardSchema = new mongoose.Schema({
  tournamentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tournament' },
  matchTitle: { type: String, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  uid: { type: String, required: true },
  ign: { type: String, required: true },
  rank: { type: Number, required: true },
  prizeAmount: { type: Number, required: true },
  createdAt: { type: Date, default: Date.now }
});

const winnerSchema = new mongoose.Schema({
  tournament: { type: String, required: true },
  name: { type: String, required: true },
  uid: { type: String, required: true },
  prize: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

const liveStreamSettingsSchema = new mongoose.Schema({
  singletonKey: { type: String, default: 'default', unique: true },
  show: { type: Boolean, default: false },
  youtubeUrl: { type: String, default: '' },
  title: { type: String, default: '' },
  schedule: { type: String, default: '' },
  description: { type: String, default: '' },
  channelLogo: { type: String, default: '' },
  updatedAt: { type: Date, default: Date.now }
});

const referralSettingsSchema = new mongoose.Schema({
  singletonKey: { type: String, default: 'default', unique: true },
  referralCoins: { type: Number, default: DEFAULT_REFERRAL_COINS, min: 1 },
  coinRate: { type: Number, default: DEFAULT_COIN_RATE, min: 0.01 },
  updatedAt: { type: Date, default: Date.now }
});

const adminNotificationSchema = new mongoose.Schema({
  type: { type: String, enum: ['deposit', 'withdrawal'], required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  userName: { type: String, default: '' },
  userUid: { type: String, default: '' },
  amount: { type: Number, required: true },
  newBalance: { type: Number, required: true },
  status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
  read: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  resolvedAt: { type: Date, default: null }
});
adminNotificationSchema.index({ createdAt: -1 });
adminNotificationSchema.index({ read: 1, createdAt: -1 });

const User = mongoose.model('User', userSchema);
const Tournament = mongoose.model('Tournament', tournamentSchema);
const DepositRequest = mongoose.model('DepositRequest', depositRequestSchema);
const Wallet = mongoose.model('Wallet', walletSchema);
const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);
const Leaderboard = mongoose.model('Leaderboard', leaderboardSchema);
const Winner = mongoose.model('Winner', winnerSchema);
const LiveStreamSettings = mongoose.model('LiveStreamSettings', liveStreamSettingsSchema);
const ReferralSettings = mongoose.model('ReferralSettings', referralSettingsSchema);
const AdminNotification = mongoose.model('AdminNotification', adminNotificationSchema);

// ==================== HELPERS ====================
function getAdminSeedEmail() {
  return (process.env.ADMIN_SEED_EMAIL || 'adminkush@nexmillarena.com').toLowerCase().trim();
}

function getUserIdFromRequest(req) {
  if (!req || typeof req !== 'object') return null;
  try {
    const token = security.getBearerToken(req);
    if (token) {
      try {
        const payload = security.verifyToken(token);
        return payload?.sub ? String(payload.sub) : null;
      } catch (_) {
        return null;
      }
    }
    const headers = req.headers || {};
    const headerId = headers['x-user-id'];
    if (headerId && security.isValidObjectId(String(headerId))) return String(headerId);
    const body = req.body && typeof req.body === 'object' ? req.body : null;
    if (body?.userId && security.isValidObjectId(String(body.userId))) return String(body.userId);
    const query = req.sanitizedQuery || req.query || {};
    const queryId = query.userId;
    if (queryId && security.isValidObjectId(String(queryId))) return String(queryId);
    return null;
  } catch (_) {
    return null;
  }
}

function sanitizeUser(user) {
  return {
    id: String(user._id),
    name: user.name,
    email: user.email && !String(user.email).endsWith('@phone.nexmill.local') ? user.email : '',
    phone: user.phone || '',
    isAdmin: !!user.isAdmin,
    gameUid: user.gameUid || '',
    coins: Math.max(0, Number(user.coins) || 0),
    referralCode: user.referralCode || ''
  };
}

function cleanPhoneForStorage(phone) {
  const cleaned = security.sanitizePhoneInput(phone, 25);
  if (!cleaned || cleaned.length < 10) return null;
  return cleaned;
}

/** Legacy lookup for accounts created before exact phone storage. */
function legacyPhoneCandidates(phoneInput) {
  const raw = security.sanitizePhoneInput(phoneInput, 25);
  if (!raw) return [];
  const out = new Set([raw]);
  const digits = raw.replace(/\D/g, '');
  if (digits.length >= 10) {
    out.add(`+${digits}`);
    if (digits.length === 10) out.add(`+91${digits}`);
    if (digits.length === 12 && digits.startsWith('91')) out.add(`+${digits}`);
    out.add(digits);
    if (digits.length > 10) out.add(digits.slice(-10));
    if (digits.length >= 10) out.add(`+91${digits.slice(-10)}`);
  }
  return [...out];
}

async function findUserByPhone(phoneInput) {
  const exact = cleanPhoneForStorage(phoneInput);
  if (!exact) return null;

  let user = await User.findOne({ phone: exact });
  if (user) return user;

  for (const candidate of legacyPhoneCandidates(phoneInput)) {
    if (candidate === exact) continue;
    user = await User.findOne({ phone: candidate });
    if (user) return user;
  }
  return null;
}

async function finishAuthLogin(user, res) {
  await ensureReferralCode(user);
  const fresh = await User.findById(user._id);
  const token = security.signToken(fresh);
  res.json({ message: 'Login successful!', user: sanitizeUser(fresh), token });
}

async function getCoinConfig() {
  let doc = await ReferralSettings.findOne({ singletonKey: 'default' });
  if (!doc) {
    doc = await ReferralSettings.create({
      singletonKey: 'default',
      referralCoins: DEFAULT_REFERRAL_COINS,
      coinRate: DEFAULT_COIN_RATE
    });
  }
  return {
    referralCoins: Math.max(1, Math.floor(Number(doc.referralCoins) || DEFAULT_REFERRAL_COINS)),
    coinRate: Math.max(0.01, Number(doc.coinRate) || DEFAULT_COIN_RATE)
  };
}

function rupeesToRequiredCoins(rupees, coinRate) {
  if (!rupees || rupees <= 0) return 0;
  return Math.ceil(rupees / coinRate);
}

function buildReferralLink(req, referralCode) {
  const origin = req.headers.origin || process.env.RENDER_EXTERNAL_URL || '';
  const base = (origin || '').replace(/\/+$/, '');
  return base ? `${base}/?ref=${referralCode}` : `/?ref=${referralCode}`;
}

async function buildReferralInfoPayload(req, user) {
  await ensureReferralCode(user);
  const fresh = await User.findById(user._id);
  const config = await getCoinConfig();
  const referredUsers = await User.find({ referredBy: fresh._id })
    .select('name email createdAt')
    .sort({ createdAt: -1 })
    .limit(200);
  const coins = Math.max(0, Number(fresh.coins) || 0);
  return {
    coins,
    coinsBalance: coins,
    referralCode: fresh.referralCode,
    referralLink: buildReferralLink(req, fresh.referralCode),
    referralCount: Math.max(0, Number(fresh.referralCount) || 0),
    referralCoinsReward: config.referralCoins,
    coinRate: config.coinRate,
    coinsValueInRupees: (coins * config.coinRate).toFixed(2),
    coinsEarnedValueInRupees: (coins * config.coinRate).toFixed(2),
    coinsNote: 'Coins can only be used for tournament entry fees, not withdrawn.',
    referredUsers: referredUsers.map((u) => ({
      name: u.name,
      email: u.email,
      joinedAt: u.createdAt
    }))
  };
}

function mapReferralLeaderboardRow(u, index) {
  return {
    rank: index + 1,
    name: u.name,
    referralCode: u.referralCode,
    referralCount: u.referralCount,
    coins: u.coins,
    coinsEarned: u.coins
  };
}

async function generateUniqueReferralCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 25; attempt++) {
    let code = '';
    for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
    const exists = await User.findOne({ referralCode: code });
    if (!exists) return code;
  }
  return `NX${Date.now().toString(36).toUpperCase().slice(-6)}`;
}

async function ensureReferralCode(user) {
  if (user.referralCode) return user.referralCode;
  user.referralCode = await generateUniqueReferralCode();
  await user.save();
  return user.referralCode;
}

async function creditReferrer(referrer, newUserId) {
  if (!referrer || String(referrer._id) === String(newUserId)) return;
  const config = await getCoinConfig();
  referrer.coins = Math.max(0, Number(referrer.coins) || 0) + config.referralCoins;
  referrer.referralCount = Math.max(0, Number(referrer.referralCount) || 0) + 1;
  await referrer.save();
}

function parseReferralRef(req) {
  const raw = req.query.ref || req.body.ref || req.body.referralCode || '';
  return security.sanitizePlainString(String(raw), 16).toUpperCase();
}

function isParticipant(tournament, userId) {
  if (!tournament || !tournament.participants || !userId) return false;
  const uidStr = String(userId);
  return tournament.participants.some(p => p.userId && String(p.userId) === uidStr);
}

async function getOrCreateWallet(userId) {
  let wallet = await Wallet.findOne({ userId });
  if (!wallet) {
    wallet = new Wallet({ userId, balance: 0 });
    await wallet.save();
  }
  return wallet;
}

function formatAdminNotification(doc) {
  return {
    id: String(doc._id),
    type: doc.type,
    userId: String(doc.userId),
    userName: doc.userName || '',
    userUid: doc.userUid || '',
    amount: doc.amount,
    newBalance: doc.newBalance,
    status: doc.status,
    read: !!doc.read,
    createdAt: doc.createdAt,
    resolvedAt: doc.resolvedAt || null
  };
}

async function createAdminNotification(payload) {
  const doc = await AdminNotification.create({
    type: payload.type,
    userId: payload.userId,
    userName: payload.userName || '',
    userUid: payload.userUid || '',
    amount: payload.amount,
    newBalance: payload.newBalance,
    status: payload.status || 'pending',
    read: false,
    resolvedAt: payload.resolvedAt || null
  });
  console.log('[AdminNotification]', doc.type, doc.status, {
    userId: String(doc.userId),
    userName: doc.userName,
    userUid: doc.userUid,
    amount: doc.amount,
    newBalance: doc.newBalance
  });
  return doc;
}

async function resolvePendingWithdrawalNotification(withdrawal) {
  const pending = await AdminNotification.findOne({
    type: 'withdrawal',
    userId: withdrawal.userId,
    amount: parseFloat(withdrawal.amount),
    status: 'pending'
  }).sort({ createdAt: -1 });
  if (pending) {
    pending.resolvedAt = new Date();
    await pending.save();
  }
  return pending;
}

async function requireUser(req, res) {
  const token = security.getBearerToken(req);
  if (token) {
    try {
      const payload = security.verifyToken(token);
      const user = await User.findById(payload.sub);
      if (!user) {
        res.status(401).json({ message: 'Invalid session. Please log in again.' });
        return null;
      }
      return user;
    } catch (_) {
      res.status(401).json({ message: 'Invalid or expired session. Please log in again.' });
      return null;
    }
  }
  const userId = getUserIdFromRequest(req);
  if (!userId) {
    res.status(401).json({ message: 'Authentication required. Please log in.' });
    return null;
  }
  const user = await User.findById(userId);
  if (!user) {
    res.status(401).json({ message: 'Invalid session. Please log in again.' });
    return null;
  }
  return user;
}

async function requireAdmin(req, res) {
  const user = await requireUser(req, res);
  if (!user) return null;
  if (!user.isAdmin) {
    res.status(403).json({ message: 'Admin access denied.' });
    return null;
  }
  return user;
}

function parseEntryFee(entryFeeStr) {
  if (!entryFeeStr || entryFeeStr.toLowerCase().indexOf('free') !== -1) return 0;
  const match = entryFeeStr.match(/\d+/);
  return match ? parseInt(match[0], 10) : 0;
}

function calculateAdminProfit(entryFeeStr, totalSlots) {
  if (entryFeeStr.toLowerCase().indexOf('free') !== -1) return 0;
  const match = entryFeeStr.match(/\d+/);
  if (!match) return 0;
  return Math.floor(parseInt(match[0], 10) * totalSlots * 0.2);
}

function extractYoutubeVideoId(input) {
  const raw = (input || '').trim();
  if (!raw) return '';
  if (/^[a-zA-Z0-9_-]{11}$/.test(raw)) return raw;
  try {
    const url = new URL(raw);
    if (url.hostname.includes('youtu.be')) {
      return url.pathname.replace(/^\//, '').split('/')[0] || '';
    }
    if (url.searchParams.get('v')) return url.searchParams.get('v');
    const pathPatterns = [
      /\/embed\/([a-zA-Z0-9_-]{11})/,
      /\/live\/([a-zA-Z0-9_-]{11})/,
      /\/shorts\/([a-zA-Z0-9_-]{11})/
    ];
    for (const pattern of pathPatterns) {
      const match = url.pathname.match(pattern);
      if (match) return match[1];
    }
  } catch (_) {}
  const generic = raw.match(/(?:v=|\/embed\/|youtu\.be\/|\/shorts\/|\/live\/)([a-zA-Z0-9_-]{11})/);
  return generic ? generic[1] : '';
}

function normalizeLiveStreamDoc(doc) {
  if (!doc) {
    return {
      show: false,
      youtubeUrl: '',
      title: '',
      schedule: '',
      description: '',
      channelLogo: ''
    };
  }
  const obj = doc.toObject ? doc.toObject() : doc;
  const youtubeUrl = obj.youtubeUrl || obj.videoId || '';
  return {
    show: obj.show === true || obj.isActive === true,
    youtubeUrl: typeof youtubeUrl === 'string' && youtubeUrl.length === 11 && !youtubeUrl.includes('/')
      ? `https://www.youtube.com/watch?v=${youtubeUrl}`
      : (youtubeUrl || ''),
    title: obj.title || '',
    schedule: obj.schedule || obj.scheduleText || '',
    description: obj.description || '',
    channelLogo: obj.channelLogo || obj.channelLogoUrl || '',
    updatedAt: obj.updatedAt || null
  };
}

function toPublicLiveStreamPayload(settings) {
  const normalized = normalizeLiveStreamDoc(settings);
  if (!normalized.show) return { show: false };
  const videoId = extractYoutubeVideoId(normalized.youtubeUrl);
  if (!videoId) return { show: false };
  return {
    show: true,
    videoId,
    youtubeUrl: normalized.youtubeUrl,
    title: normalized.title,
    schedule: normalized.schedule,
    description: normalized.description,
    channelLogo: normalized.channelLogo
  };
}


// ==================== AUTH ====================
app.post('/api/auth/signup', ...security.validateSignup, async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const name = security.sanitizePlainString(body.name, 80);
    const emailInput = security.sanitizePlainString(body.email, 120).toLowerCase();
    const phone = cleanPhoneForStorage(body.phone);
    const password = typeof body.password === 'string' ? body.password : '';

    console.log('[SIGNUP] phone raw:', body.phone, '→ stored:', phone || 'none');

    if (!name || !password) {
      return res.status(400).json({ message: 'Name and password are required.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters.' });
    }
    if (!emailInput && !phone) {
      return res.status(400).json({ message: 'Provide an email or phone number.' });
    }

    let email = emailInput || null;
    if (phone) {
      const phoneTaken = await User.findOne({ phone });
      if (phoneTaken) return res.status(409).json({ message: 'This phone number is already registered.' });
    }
    if (email) {
      const emailTaken = await User.findOne({ email });
      if (emailTaken) return res.status(409).json({ message: 'An account with this email already exists.' });
    } else if (phone) {
      email = `phone_${phone.replace(/\D/g, '')}@phone.nexmill.local`;
      const syntheticTaken = await User.findOne({ email });
      if (syntheticTaken) return res.status(409).json({ message: 'This phone number is already registered.' });
    }

    const isAdmin = email === getAdminSeedEmail();
    const hashedPassword = await bcrypt.hash(password, 10);
    const referralCode = await generateUniqueReferralCode();
    let referredBy = null;
    const config = await getCoinConfig();
    const refInput = parseReferralRef(req);
    if (refInput) {
      const referrer = await User.findOne({ referralCode: refInput });
      if (!referrer) {
        return res.status(400).json({ message: 'Invalid referral code.' });
      }
      if ((referrer.email && referrer.email === email) || (referrer.phone && referrer.phone === phone)) {
        return res.status(400).json({ message: 'You cannot refer yourself.' });
      }
      referredBy = referrer._id;
    }
    const user = await User.create({
      name,
      email,
      phone: phone || null,
      password: hashedPassword,
      isAdmin,
      referralCode,
      referredBy,
      coins: 0,
      referralCount: 0
    });
    console.log('[SIGNUP] user created id:', user._id, 'phone:', user.phone || 'none');
    await Wallet.create({ userId: user._id, balance: 0 });
    if (referredBy) {
      const referrer = await User.findById(referredBy);
      if (referrer) await creditReferrer(referrer, user._id);
    }
    const token = security.signToken(user);
    const fresh = await User.findById(user._id);
    res.status(201).json({
      message: referredBy
        ? `Account created! Your referrer earned ${config.referralCoins} coins.`
        : 'Account created successfully!',
      user: sanitizeUser(fresh),
      token
    });
  } catch (err) {
    console.error('[SIGNUP ERROR]', err);
    if (err.code === 11000) {
      return res.status(409).json({ message: 'Email or phone already registered.' });
    }
    security.sendSafeError(res, 500, 'Signup failed.', err);
  }
});

app.post('/api/auth/login', ...security.validateLogin, async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const password = typeof body.password === 'string' ? body.password : '';
    const phone = cleanPhoneForStorage(body.phone);
    const email = security.sanitizePlainString(body.email, 120).toLowerCase();

    if (!password) return res.status(400).json({ message: 'Password is required.' });
    if (!email && !phone) {
      return res.status(400).json({ message: 'Email or phone is required.' });
    }

    if (phone) {
      console.log('Login attempt with phone:', phone);
      const user = await findUserByPhone(phone);
      console.log('Found user:', user ? user.phone : 'none');
      if (!user) {
        return res.status(401).json({ message: 'Invalid phone or password.' });
      }
      const match = await bcrypt.compare(password, user.password);
      console.log('Password match result:', match);
      if (!match) {
        return res.status(401).json({ message: 'Invalid phone or password.' });
      }
      await finishAuthLogin(user, res);
      return;
    }

    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ message: 'Invalid email or password.' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ message: 'Invalid email or password.' });
    await finishAuthLogin(user, res);
  } catch (err) {
    console.error('[LOGIN ERROR]', err);
    security.sendSafeError(res, 500, 'Login failed.', err);
  }
});

if (process.env.ENABLE_DEBUG_ROUTES === 'true') {
  app.get('/api/debug/users', async (req, res) => {
    try {
      if (!(await requireAdmin(req, res))) return;
      const users = await User.find()
        .select('name email phone isAdmin createdAt')
        .sort({ createdAt: -1 })
        .lean();
      const summary = users.map((u) => ({
        id: String(u._id),
        name: u.name,
        email: u.email,
        phone: u.phone || null,
        isAdmin: !!u.isAdmin,
        createdAt: u.createdAt
      }));
      res.json({ count: summary.length, users: summary });
    } catch (err) {
      security.sendSafeError(res, 500, 'Debug list failed.', err);
    }
  });
}

// ==================== TOURNAMENTS ====================
app.get('/api/tournaments', async (req, res) => {
  try {
    const wantFeatured = String(req.query.featured || '').toLowerCase() === 'true';
    if (wantFeatured) {
      const featured = await Tournament.findOne({ isFeatured: true, isPublished: true })
        .select('-roomID -roomPass')
        .sort({ updatedAt: -1, createdAt: -1 });
      return res.json(featured ? [featured] : []);
    }

    const includeUnpublished = String(req.query.includeUnpublished || '') === '1' || String(req.query.includeUnpublished || '') === 'true';
    if (includeUnpublished) {
      if (!(await requireAdmin(req, res))) return;
    }
    const filter = includeUnpublished ? {} : { isPublished: true };
    const tournaments = await Tournament.find(filter).select('-roomID -roomPass').sort({ createdAt: -1 });
    res.json(tournaments);
  } catch (err) {
    security.sendSafeError(res, 500, security.GENERIC_500_MESSAGE, err);
  }
});

app.get('/api/tournaments/:id/room', ...security.validateObjectIdParam('id'), async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const tournament = await Tournament.findById(req.params.id);
    if (!tournament) return res.status(404).json({ message: 'Tournament not found.' });
    if (!tournament.isPublished && !user.isAdmin) {
      return res.status(403).json({ message: 'This match is not published yet.' });
    }
    const isJoined = isParticipant(tournament, user._id);
    const isAdmin = user.isAdmin === true;
    if (!isJoined && !isAdmin) {
      return res.status(403).json({ message: 'Access Denied: You must join this tournament to view Room Credentials.' });
    }
    res.json({ roomID: tournament.roomID || '', roomPass: tournament.roomPass || '' });
  } catch (err) {
    security.sendSafeError(res, 500, security.GENERIC_500_MESSAGE, err);
  }
});

app.post('/api/tournaments', ...security.validateTournamentCreate, async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const matchTitle = security.sanitizePlainString(req.body.matchTitle, 120);
    const mapName = security.sanitizePlainString(req.body.mapName, 40);
    const entryFee = security.sanitizePlainString(req.body.entryFee, 40);
    const prizePool = security.sanitizePlainString(req.body.prizePool, 40);
    const totalSlots = Number(req.body.totalSlots);
    const rules = security.sanitizePlainString(req.body.rules || 'Standard Rules Apply', 2000);
    const notice = security.sanitizePlainString(req.body.notice, 300);
    const isPublished = req.body.isPublished === undefined ? true : !!req.body.isPublished;
    if (!matchTitle || !mapName || !entryFee || !prizePool || totalSlots === undefined) {
      return res.status(400).json({ message: 'Missing required fields.' });
    }
    const adminProfit = calculateAdminProfit(entryFee, totalSlots);
    const tournament = new Tournament({
      matchTitle, mapName, entryFee, prizePool, totalSlots, rules,
      notice,
      adminProfit, participants: [], isPublished
    });
    await tournament.save();
    res.status(201).json(tournament);
  } catch (err) {
    security.sendSafeError(res, 500, security.GENERIC_500_MESSAGE, err);
  }
});

// ✅ UPDATE TOURNAMENT (only admin)
app.put('/api/tournaments/:id', ...security.validateObjectIdParam('id'), ...security.validateTournamentUpdate, async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const tournament = await Tournament.findById(req.params.id);
    if (!tournament) return res.status(404).json({ message: 'Tournament not found.' });

    const matchTitle = req.body.matchTitle !== undefined ? String(req.body.matchTitle).trim() : tournament.matchTitle;
    const mapName = req.body.mapName !== undefined ? String(req.body.mapName).trim() : tournament.mapName;
    const entryFee = req.body.entryFee !== undefined ? String(req.body.entryFee).trim() : tournament.entryFee;
    const prizePool = req.body.prizePool !== undefined ? String(req.body.prizePool).trim() : tournament.prizePool;
    const totalSlots = req.body.totalSlots !== undefined ? Number(req.body.totalSlots) : tournament.totalSlots;
    const rules = req.body.rules !== undefined ? String(req.body.rules).trim() : tournament.rules;
    const notice = req.body.notice !== undefined ? String(req.body.notice).trim() : tournament.notice;
    const isPublished = req.body.isPublished !== undefined ? !!req.body.isPublished : tournament.isPublished;

    if (!matchTitle || !mapName || !entryFee || !prizePool || !totalSlots || totalSlots < 1) {
      return res.status(400).json({ message: 'Missing or invalid required fields.' });
    }
    if (totalSlots < tournament.filledSlots) {
      return res.status(400).json({
        message: `Total slots cannot be less than current registrations (${tournament.filledSlots}).`
      });
    }

    tournament.matchTitle = matchTitle;
    tournament.mapName = mapName;
    tournament.entryFee = entryFee;
    tournament.prizePool = prizePool;
    tournament.totalSlots = totalSlots;
    tournament.rules = rules || 'Standard Rules Apply';
    tournament.notice = notice;
    tournament.isPublished = isPublished;
    tournament.adminProfit = calculateAdminProfit(entryFee, totalSlots);
    await tournament.save();

    const safe = tournament.toObject();
    delete safe.roomID;
    delete safe.roomPass;
    res.json({ message: 'Tournament updated successfully.', tournament: safe });
  } catch (err) {
    security.sendSafeError(res, 500, security.GENERIC_500_MESSAGE, err);
  }
});

// ✅ DELETE TOURNAMENT ROUTE (only admin)
app.delete('/api/tournaments/:id', ...security.validateObjectIdParam('id'), async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const tournament = await Tournament.findByIdAndDelete(req.params.id);
    if (!tournament) return res.status(404).json({ message: 'Tournament not found.' });
    res.json({ message: 'Tournament deleted successfully.' });
  } catch (err) {
    security.sendSafeError(res, 500, security.GENERIC_500_MESSAGE, err);
  }
});

app.post('/api/tournaments/:id/join', ...security.validateObjectIdParam('id'), ...security.validateJoin, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const ign = security.sanitizePlainString(req.body.ign, 32);
    const uid = security.sanitizePlainString(req.body.uid, 12);
    if (!ign || !uid) return res.status(400).json({ message: 'IGN and UID are required.' });
    const tournament = await Tournament.findById(req.params.id);
    if (!tournament) return res.status(404).json({ message: 'Match not found.' });
    if (!tournament.isPublished && !user.isAdmin) return res.status(403).json({ message: 'This match is not published yet.' });
    if (tournament.filledSlots >= tournament.totalSlots) return res.status(400).json({ message: 'Match is already full!' });
    if (tournament.participants.some(p => p.uid === uid)) return res.status(400).json({ message: 'This UID is already registered in this match!' });
    const entryFeeRupees = parseEntryFee(tournament.entryFee);
    const payWithCoins = req.body.payWithCoins === true || req.body.payWithCoins === 'true';
    const coinConfig = await getCoinConfig();
    let paidWithCoins = false;
    let coinsDeducted = 0;
    let newBalance = null;

    if (entryFeeRupees > 0) {
      if (payWithCoins) {
        const requiredCoins = rupeesToRequiredCoins(entryFeeRupees, coinConfig.coinRate);
        const payer = await User.findById(user._id);
        const userCoins = Math.max(0, Number(payer.coins) || 0);
        if (userCoins < requiredCoins) {
          return res.status(400).json({
            message: `Not enough coins. Need ${requiredCoins} coins (₹${entryFeeRupees} entry), you have ${userCoins}.`
          });
        }
        payer.coins = userCoins - requiredCoins;
        await payer.save();
        paidWithCoins = true;
        coinsDeducted = requiredCoins;
      } else {
        const wallet = await getOrCreateWallet(user._id);
        if (wallet.balance < entryFeeRupees) {
          return res.status(400).json({
            message: `Insufficient wallet balance. Entry is ₹${entryFeeRupees}, wallet has ₹${wallet.balance}.`
          });
        }
        wallet.balance -= entryFeeRupees;
        await wallet.save();
        newBalance = wallet.balance;
      }
    }

    if (!user.gameUid) {
      user.gameUid = uid;
      await user.save();
    }
    tournament.participants.push({
      ign, uid, userId: user._id, paidWithCoins, registeredAt: new Date()
    });
    tournament.filledSlots += 1;
    await tournament.save();

    const updatedUser = await User.findById(user._id);
    res.json({
      message: paidWithCoins
        ? `Registered! ${coinsDeducted} coins used for entry.`
        : 'Successfully registered!',
      newBalance,
      entryFeeDeducted: payWithCoins ? 0 : entryFeeRupees,
      coinsDeducted,
      coinsBalance: Math.max(0, Number(updatedUser.coins) || 0),
      paidWithCoins
    });
  } catch (err) {
    security.sendSafeError(res, 500, security.GENERIC_500_MESSAGE, err);
  }
});

// ✅ Set / remove featured tournament (only admin)
app.put('/api/tournaments/:id/feature', ...security.validateObjectIdParam('id'), async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const tournament = await Tournament.findById(req.params.id);
    if (!tournament) return res.status(404).json({ message: 'Tournament not found.' });
    await Tournament.updateMany({ _id: { $ne: tournament._id } }, { $set: { isFeatured: false } });
    tournament.isFeatured = true;
    await tournament.save();
    const safe = tournament.toObject();
    delete safe.roomID;
    delete safe.roomPass;
    res.json({ message: 'Tournament set as featured.', tournament: safe });
  } catch (err) {
    security.sendSafeError(res, 500, security.GENERIC_500_MESSAGE, err);
  }
});

app.delete('/api/tournaments/:id/feature', ...security.validateObjectIdParam('id'), async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const tournament = await Tournament.findById(req.params.id);
    if (!tournament) return res.status(404).json({ message: 'Tournament not found.' });
    if (!tournament.isFeatured) {
      return res.status(400).json({ message: 'This tournament is not featured.' });
    }
    tournament.isFeatured = false;
    await tournament.save();
    res.json({ message: 'Featured tournament removed.' });
  } catch (err) {
    security.sendSafeError(res, 500, security.GENERIC_500_MESSAGE, err);
  }
});

// ✅ Publish / Unpublish tournament (only admin)
app.put('/api/tournaments/:id/publish', ...security.validateObjectIdParam('id'), async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const isPublished = !!req.body.isPublished;
    const updated = await Tournament.findByIdAndUpdate(req.params.id, { isPublished }, { returnDocument: 'after' });
    if (!updated) return res.status(404).json({ message: 'Tournament not found.' });
    res.json({ message: `Tournament ${isPublished ? 'published' : 'unpublished'} successfully.`, tournament: updated });
  } catch (err) {
    security.sendSafeError(res, 500, security.GENERIC_500_MESSAGE, err);
  }
});

app.put('/api/tournaments/:id/notice', ...security.validateObjectIdParam('id'), ...security.validateNotice, async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const notice = security.sanitizePlainString(req.body.notice, 300);
    const updated = await Tournament.findByIdAndUpdate(
      req.params.id,
      { notice },
      { returnDocument: 'after' }
    ).select('-roomID -roomPass');
    if (!updated) return res.status(404).json({ message: 'Tournament not found.' });
    res.json({ message: 'Tournament notice updated.', tournament: updated });
  } catch (err) {
    security.sendSafeError(res, 500, security.GENERIC_500_MESSAGE, err);
  }
});

app.put('/api/tournaments/:id/room-info', ...security.validateObjectIdParam('id'), async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const updated = await Tournament.findByIdAndUpdate(req.params.id, { roomID: req.body.roomID || '', roomPass: req.body.roomPass || '' }, { returnDocument: 'after' });
    if (!updated) return res.status(404).json({ message: 'Tournament not found.' });
    res.json({ message: 'Room ID and password updated successfully!', updated });
  } catch (err) {
    security.sendSafeError(res, 500, security.GENERIC_500_MESSAGE, err);
  }
});

// ==================== LIVE STREAM ====================
app.get('/api/live-stream', async (req, res) => {
  try {
    const settings = await LiveStreamSettings.findOne({ singletonKey: 'default' });
    let adminUser = null;
    const token = security.getBearerToken(req);
    if (token) {
      try {
        const payload = security.verifyToken(token);
        adminUser = await User.findById(payload.sub);
      } catch (_) { /* public view */ }
    } else {
      const userId = getUserIdFromRequest(req);
      if (userId) adminUser = await User.findById(userId);
    }
    if (adminUser && adminUser.isAdmin) {
      return res.json(normalizeLiveStreamDoc(settings));
    }
    res.json(toPublicLiveStreamPayload(settings));
  } catch (err) {
    security.sendSafeError(res, 500, security.GENERIC_500_MESSAGE, err);
  }
});

app.put('/api/admin/live-stream', async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const youtubeUrl = (req.body.youtubeUrl || req.body.videoUrl || req.body.videoId || '').trim();
    const show = req.body.show === undefined
      ? (req.body.isActive !== undefined ? !!req.body.isActive : false)
      : !!req.body.show;
    const title = (req.body.title || '').trim();
    const schedule = (req.body.schedule || req.body.scheduleText || '').trim();
    const description = (req.body.description || '').trim();
    let channelLogo = req.body.channelLogo || req.body.channelLogoUrl || '';
    if (typeof channelLogo === 'string') channelLogo = channelLogo.trim();

    if (show && youtubeUrl && !extractYoutubeVideoId(youtubeUrl)) {
      return res.status(400).json({ message: 'Invalid YouTube URL. Supported: watch, youtu.be, live, shorts, embed.' });
    }

    const settings = await LiveStreamSettings.findOneAndUpdate(
      { singletonKey: 'default' },
      {
        singletonKey: 'default',
        show,
        youtubeUrl,
        title,
        schedule,
        description,
        channelLogo,
        updatedAt: new Date()
      },
      { returnDocument: 'after', upsert: true }
    );
    res.json({
      message: 'Live stream settings saved.',
      settings: normalizeLiveStreamDoc(settings)
    });
  } catch (err) {
    security.sendSafeError(res, 500, security.GENERIC_500_MESSAGE, err);
  }
});

app.delete('/api/admin/live-stream', async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const result = await LiveStreamSettings.deleteOne({ singletonKey: 'default' });
    if (result.deletedCount === 0) {
      return res.json({ message: 'No live stream settings to delete.' });
    }
    res.json({ message: 'Live stream deleted.' });
  } catch (err) {
    security.sendSafeError(res, 500, security.GENERIC_500_MESSAGE, err);
  }
});

// ==================== WINNERS / LEADERBOARD ====================
app.get('/api/winners', async (req, res) => {
  try {
    const winners = await Winner.find().sort({ createdAt: -1 }).limit(10);
    res.json(winners);
  } catch (err) {
    security.sendSafeError(res, 500, security.GENERIC_500_MESSAGE, err);
  }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const entries = await Leaderboard.find().sort({ createdAt: -1 });
    res.json(entries);
  } catch (err) {
    security.sendSafeError(res, 500, security.GENERIC_500_MESSAGE, err);
  }
});

// ==================== WALLET ====================
app.get('/api/wallet', async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const wallet = await getOrCreateWallet(user._id);
    res.json(wallet);
  } catch (err) {
    security.sendSafeError(res, 500, security.GENERIC_500_MESSAGE, err);
  }
});

app.post('/api/wallet/deposit', ...security.validateDeposit, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    let amount = parseFloat(req.body.amount);
    const uid = (req.body.uid || '').trim();
    const utr = (req.body.utr || '').trim();
    if (!amount || isNaN(amount) || amount <= 0) return res.status(400).json({ message: 'Invalid deposit amount.' });
    if (!uid) return res.status(400).json({ message: 'Game UID is required.' });
    if (!/^\d{12}$/.test(utr)) return res.status(400).json({ message: 'Invalid UTR. Must be 12 digits.' });
    const existingUtr = await DepositRequest.findOne({ utr });
    if (existingUtr) return res.status(409).json({ message: 'This UTR has already been submitted.' });
    if (!user.gameUid) {
      user.gameUid = uid;
      await user.save();
    }
    const deposit = new DepositRequest({ userId: user._id, amount, uid, utr, status: 'pending' });
    await deposit.save();
    res.status(201).json({ message: 'Deposit request submitted. Pending admin approval.' });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: 'This UTR has already been submitted.' });
    security.sendSafeError(res, 500, security.GENERIC_500_MESSAGE, err);
  }
});

app.post('/api/wallet/withdraw', ...security.validateWithdraw, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const uid = (req.body.uid || '').trim();
    const upiId = (req.body.upiId || '').trim();
    let amount = parseFloat(req.body.amount);
    if (!uid) return res.status(400).json({ message: 'Game UID is required.' });
    if (!upiId) return res.status(400).json({ message: 'UPI ID is required.' });
    if (!amount || isNaN(amount) || amount <= 0) return res.status(400).json({ message: 'Invalid withdrawal amount.' });
    const wallet = await getOrCreateWallet(user._id);
    if (wallet.balance < amount) return res.status(400).json({ message: 'Insufficient balance.' });
    wallet.balance -= amount;
    await wallet.save();
    const withdrawal = new Withdrawal({ userId: user._id, uid, upiId, amount, status: 'pending' });
    await withdrawal.save();
    await createAdminNotification({
      type: 'withdrawal',
      userId: user._id,
      userName: user.name,
      userUid: uid,
      amount,
      newBalance: wallet.balance,
      status: 'pending'
    });
    res.status(201).json({ message: 'Withdrawal request submitted successfully.', newBalance: wallet.balance });
  } catch (err) {
    security.sendSafeError(res, 500, security.GENERIC_500_MESSAGE, err);
  }
});

// ==================== ADMIN ====================
app.get('/api/admin/participants', async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const tournaments = await Tournament.find().sort({ createdAt: -1 });
    const list = [];
    tournaments.forEach(t => {
      if (t.participants && t.participants.length) {
        t.participants.forEach(p => {
          list.push({ matchTitle: t.matchTitle, ign: p.ign, uid: p.uid, registeredAt: p.registeredAt });
        });
      }
    });
    res.json(list);
  } catch (err) {
    security.sendSafeError(res, 500, security.GENERIC_500_MESSAGE, err);
  }
});

app.get('/api/admin/deposits', async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const deposits = await DepositRequest.find().sort({ createdAt: -1 });
    res.json(deposits);
  } catch (err) {
    security.sendSafeError(res, 500, security.GENERIC_500_MESSAGE, err);
  }
});

app.post('/api/admin/deposits/action', ...security.validateAdminAction, async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const { requestId, action } = req.body;
    const deposit = await DepositRequest.findById(requestId);
    if (!deposit) return res.status(404).json({ message: 'Deposit request not found.' });
    if (deposit.status !== 'pending') return res.status(400).json({ message: 'This request has already been processed.' });
    if (action === 'completed') {
      deposit.status = 'completed';
      await deposit.save();
      const wallet = await getOrCreateWallet(deposit.userId);
      wallet.balance += parseFloat(deposit.amount);
      await wallet.save();
      const depositUser = await User.findById(deposit.userId);
      await createAdminNotification({
        type: 'deposit',
        userId: deposit.userId,
        userName: depositUser?.name || '',
        userUid: deposit.uid || depositUser?.gameUid || '',
        amount: parseFloat(deposit.amount),
        newBalance: wallet.balance,
        status: 'completed'
      });
      return res.json({ message: 'Deposit approved.', status: 'completed', balance: wallet.balance });
    } else if (action === 'failed') {
      deposit.status = 'failed';
      await deposit.save();
      return res.json({ message: 'Deposit rejected.', status: 'failed' });
    } else {
      return res.status(400).json({ message: 'Invalid action type.' });
    }
  } catch (err) {
    security.sendSafeError(res, 500, security.GENERIC_500_MESSAGE, err);
  }
});

app.get('/api/admin/withdrawals', async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const withdrawals = await Withdrawal.find().sort({ createdAt: -1 });
    res.json(withdrawals);
  } catch (err) {
    security.sendSafeError(res, 500, security.GENERIC_500_MESSAGE, err);
  }
});

app.post('/api/admin/withdrawals/action', ...security.validateAdminAction, async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const withdrawal = await Withdrawal.findById(req.body.requestId);
    if (!withdrawal) return res.status(404).json({ message: 'Withdrawal request not found.' });
    if (withdrawal.status !== 'pending') return res.status(400).json({ message: 'This withdrawal has already been processed.' });
    if (req.body.action === 'completed') {
      withdrawal.status = 'completed';
      await withdrawal.save();
      await resolvePendingWithdrawalNotification(withdrawal);
      const wdUser = await User.findById(withdrawal.userId);
      const wallet = await Wallet.findOne({ userId: withdrawal.userId });
      await createAdminNotification({
        type: 'withdrawal',
        userId: withdrawal.userId,
        userName: wdUser?.name || '',
        userUid: withdrawal.uid || wdUser?.gameUid || '',
        amount: parseFloat(withdrawal.amount),
        newBalance: wallet?.balance ?? 0,
        status: 'completed',
        resolvedAt: new Date()
      });
      return res.json({ message: 'Withdrawal marked completed.', status: 'completed' });
    } else if (req.body.action === 'failed') {
      withdrawal.status = 'failed';
      await withdrawal.save();
      const wallet = await getOrCreateWallet(withdrawal.userId);
      wallet.balance += parseFloat(withdrawal.amount);
      await wallet.save();
      await resolvePendingWithdrawalNotification(withdrawal);
      const wdUser = await User.findById(withdrawal.userId);
      await createAdminNotification({
        type: 'withdrawal',
        userId: withdrawal.userId,
        userName: wdUser?.name || '',
        userUid: withdrawal.uid || wdUser?.gameUid || '',
        amount: parseFloat(withdrawal.amount),
        newBalance: wallet.balance,
        status: 'failed',
        resolvedAt: new Date()
      });
      return res.json({ message: 'Withdrawal rejected and refunded.', status: 'failed', balance: wallet.balance });
    } else {
      return res.status(400).json({ message: 'Invalid action type.' });
    }
  } catch (err) {
    security.sendSafeError(res, 500, security.GENERIC_500_MESSAGE, err);
  }
});

app.get('/api/admin/notifications', async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const unreadOnly = String(req.query.unread || '').toLowerCase() === 'true';
    const filter = unreadOnly ? { read: false } : {};
    const notifications = await AdminNotification.find(filter)
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    res.json(notifications.map(formatAdminNotification));
  } catch (err) {
    security.sendSafeError(res, 500, security.GENERIC_500_MESSAGE, err);
  }
});

app.put('/api/admin/notifications/:id/read', ...security.validateObjectIdParam('id'), async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const doc = await AdminNotification.findByIdAndUpdate(
      req.params.id,
      { read: true },
      { returnDocument: 'after' }
    );
    if (!doc) return res.status(404).json({ message: 'Notification not found.' });
    res.json({ message: 'Marked as read.', notification: formatAdminNotification(doc) });
  } catch (err) {
    security.sendSafeError(res, 500, security.GENERIC_500_MESSAGE, err);
  }
});

app.delete('/api/admin/notifications', async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const result = await AdminNotification.deleteMany({});
    res.json({ message: 'All notifications cleared.', deleted: result.deletedCount });
  } catch (err) {
    security.sendSafeError(res, 500, security.GENERIC_500_MESSAGE, err);
  }
});

app.post('/api/admin/distribute-prizes', ...security.validateDistributePrizes, async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const { tournamentId, winners } = req.body;
    if (!tournamentId || !winners || !winners.length) return res.status(400).json({ message: 'tournamentId and winners array required.' });
    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) return res.status(404).json({ message: 'Tournament not found.' });
    let totalDistributed = 0;
    for (const w of winners) {
      const uid = (w.uid || '').trim();
      const ign = (w.ign || '').trim();
      const rank = parseInt(w.rank, 10);
      const prizeAmount = parseFloat(w.prizeAmount);
      if (!uid || !ign || !rank || isNaN(prizeAmount) || prizeAmount <= 0) {
        return res.status(400).json({ message: 'Each winner needs uid, ign, rank, and prizeAmount.' });
      }
      let targetUserId = null;
      for (const p of tournament.participants) {
        if (p.uid === uid && p.userId) {
          targetUserId = p.userId;
          break;
        }
      }
      if (!targetUserId) {
        const linkedUser = await User.findOne({ gameUid: uid });
        if (linkedUser) targetUserId = linkedUser._id;
      }
      if (targetUserId) {
        const wlt = await getOrCreateWallet(targetUserId);
        wlt.balance += prizeAmount;
        await wlt.save();
      }
      totalDistributed += prizeAmount;
      await Leaderboard.create({ tournamentId: tournament._id, matchTitle: tournament.matchTitle, userId: targetUserId, uid, ign, rank, prizeAmount });
      await Winner.create({ tournament: tournament.matchTitle, name: ign, uid, prize: 'Rs ' + prizeAmount });
    }
    res.json({ message: 'Prizes distributed for ' + tournament.matchTitle + '.', totalDistributed });
  } catch (err) {
    security.sendSafeError(res, 500, security.GENERIC_500_MESSAGE, err);
  }
});

// ==================== REFERRAL & COINS ====================
app.get('/api/referral/config', async (req, res) => {
  try {
    const config = await getCoinConfig();
    res.json({
      referralCoins: config.referralCoins,
      coinRate: config.coinRate,
      coinValueInRupees: config.coinRate,
      example: `${config.referralCoins} coins = ₹${(config.referralCoins * config.coinRate).toFixed(0)}`
    });
  } catch (err) {
    security.sendSafeError(res, 500, security.GENERIC_500_MESSAGE, err);
  }
});

async function handleReferralLeaderboard(req, res, defaultLimit) {
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || defaultLimit));
  const rows = await User.find({ referralCount: { $gt: 0 } })
    .sort({ referralCount: -1, coins: -1 })
    .limit(limit)
    .select('name referralCode referralCount coins');
  res.json(rows.map(mapReferralLeaderboardRow));
}

app.get('/api/referral-leaderboard', async (req, res) => {
  try {
    await handleReferralLeaderboard(req, res, 10);
  } catch (err) {
    security.sendSafeError(res, 500, security.GENERIC_500_MESSAGE, err);
  }
});

app.get('/api/referral/leaderboard', async (req, res) => {
  try {
    await handleReferralLeaderboard(req, res, 10);
  } catch (err) {
    security.sendSafeError(res, 500, security.GENERIC_500_MESSAGE, err);
  }
});

app.get('/api/user/referral-info', async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    res.json(await buildReferralInfoPayload(req, user));
  } catch (err) {
    security.sendSafeError(res, 500, security.GENERIC_500_MESSAGE, err);
  }
});

app.get('/api/referral/me', async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    res.json(await buildReferralInfoPayload(req, user));
  } catch (err) {
    security.sendSafeError(res, 500, security.GENERIC_500_MESSAGE, err);
  }
});

async function handleAdminReferralStats(req, res) {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const rows = await User.find({ referralCount: { $gt: 0 } })
    .sort({ referralCount: -1, coins: -1 })
    .limit(limit)
    .select('name email referralCode referralCount coins createdAt');
  res.json(rows.map((u, i) => ({
    rank: i + 1,
    name: u.name,
    email: u.email,
    referralCode: u.referralCode,
    referralCount: u.referralCount,
    coins: u.coins,
    coinsEarned: u.coins,
    joinedAt: u.createdAt
  })));
}

app.get('/api/admin/referral-stats', async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    await handleAdminReferralStats(req, res);
  } catch (err) {
    security.sendSafeError(res, 500, security.GENERIC_500_MESSAGE, err);
  }
});

app.get('/api/admin/referral/leaderboard', async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    await handleAdminReferralStats(req, res);
  } catch (err) {
    security.sendSafeError(res, 500, security.GENERIC_500_MESSAGE, err);
  }
});

app.get('/api/admin/referral-settings', async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const config = await getCoinConfig();
    res.json(config);
  } catch (err) {
    security.sendSafeError(res, 500, security.GENERIC_500_MESSAGE, err);
  }
});

app.put('/api/admin/referral-settings', async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const referralCoins = parseInt(req.body.referralCoins, 10);
    const coinRate = parseFloat(req.body.coinRate);
    if (!Number.isFinite(referralCoins) || referralCoins < 1) {
      return res.status(400).json({ message: 'referralCoins must be a positive integer.' });
    }
    if (!Number.isFinite(coinRate) || coinRate <= 0) {
      return res.status(400).json({ message: 'coinRate must be a positive number.' });
    }
    const settings = await ReferralSettings.findOneAndUpdate(
      { singletonKey: 'default' },
      { referralCoins, coinRate, updatedAt: new Date() },
      { upsert: true, returnDocument: 'after' }
    );
    res.json({
      message: 'Referral settings updated.',
      referralCoins: settings.referralCoins,
      coinRate: settings.coinRate
    });
  } catch (err) {
    security.sendSafeError(res, 500, security.GENERIC_500_MESSAGE, err);
  }
});

// ==================== SEED ====================
async function seedAdminUser() {
  const adminEmail = getAdminSeedEmail();
  const adminPassword = process.env.ADMIN_SEED_PASSWORD;
  let admin = await User.findOne({ email: adminEmail });
  if (security.IS_PRODUCTION && !adminPassword) {
    if (admin) {
      admin.isAdmin = true;
      await ensureReferralCode(admin);
      await admin.save();
    } else {
      console.warn('⚠️  Set ADMIN_SEED_PASSWORD in production to create the initial admin account.');
    }
    return;
  }
  const passwordToUse = adminPassword || 'admin123kush';
  if (!admin) {
    const hashedPassword = await bcrypt.hash(passwordToUse, 10);
    admin = await User.create({
      name: 'NexmilL Admin', email: adminEmail, password: hashedPassword, isAdmin: true,
      referralCode: await generateUniqueReferralCode(), coins: 0, referralCount: 0
    });
    await Wallet.create({ userId: admin._id, balance: 0 });
    console.log('Admin user seeded:', adminEmail);
  } else {
    admin.isAdmin = true;
    await ensureReferralCode(admin);
    await admin.save();
  }
}

async function seedInitialTournaments() {
  const count = await Tournament.countDocuments();
  if (count === 0) {
    await Tournament.insertMany([
      { matchTitle: 'Bermuda Blitz', mapName: 'Bermuda', entryFee: 'Free', prizePool: 'Rs 500', totalSlots: 100, filledSlots: 0, rules: 'Rank 1: Rs 250', adminProfit: 0, participants: [] },
      { matchTitle: 'Kalahari Showdown', mapName: 'Kalahari', entryFee: 'Rs 20', prizePool: 'Rs 1000', totalSlots: 64, filledSlots: 0, rules: 'Rank 1: Rs 500', adminProfit: 256, participants: [] }
    ]);
    console.log('Default tournaments seeded');
  }
}

// Static frontend (after API routes so /api/* is never shadowed)
const staticOptions = security.IS_PRODUCTION
  ? { index: false, maxAge: '1d', etag: true, lastModified: true }
  : { index: false };
app.use(express.static(FRONTEND_DIR, staticOptions));

// SPA fallback — HTML routes only (never serve index.html for missing .png/.css/etc.)
app.use(function (req, res, next) {
  if (req.method !== 'GET') return next();
  if (req.path.indexOf('/api') === 0) return next();
  if (/\.[a-zA-Z0-9]{2,8}$/i.test(req.path)) {
    return res.status(404).json({ message: 'Not found.' });
  }
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'), function (err) {
    if (err) return next(err);
  });
});

app.use(security.notFoundHandler);
app.use(security.globalErrorHandler);

const server = app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT} (${security.IS_PRODUCTION ? 'production' : 'development'})`);
  await seedInitialTournaments();
  await seedAdminUser();
  await getCoinConfig();
});

function gracefulShutdown(signal) {
  console.log(`${signal} received — closing server`);
  server.close(() => {
    mongoose.connection.close(false).then(() => process.exit(0)).catch(() => process.exit(1));
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
