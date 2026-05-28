require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');

app.use(cors({ origin: true }));
app.use(express.json());
app.use(express.static(FRONTEND_DIR));

const MONGODB_URI = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb+srv://kushalsaini0007_db:kush5547x@cluster0.9fztkn9.mongodb.net/nexmill_arena?retryWrites=true&w=majority&appName=Cluster0';

mongoose.connect(MONGODB_URI, {
  serverSelectionTimeoutMS: 30000,
  socketTimeoutMS: 45000,
  family: 4
})
  .then(() => console.log('MongoDB connected (Atlas)'))
  .catch(err => console.error('MongoDB connection error:', err));

// ==================== SCHEMAS ====================
const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  isAdmin: { type: Boolean, default: false },
  gameUid: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});

const participantSchema = new mongoose.Schema({
  ign: { type: String, required: true },
  uid: { type: String, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  registeredAt: { type: Date, default: Date.now }
});

const tournamentSchema = new mongoose.Schema({
  matchTitle: { type: String, required: true },
  mapName: { type: String, required: true },
  entryFee: { type: String, required: true },
  prizePool: { type: String, required: true },
  totalSlots: { type: Number, required: true, min: 1 },
  filledSlots: { type: Number, default: 0 },
  rules: { type: String, default: 'Standard Rules Apply' },
  adminProfit: { type: Number, default: 0 },
  participants: [participantSchema],
  roomID: { type: String, default: '' },
  roomPass: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});

const depositRequestSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  amount: { type: Number, required: true, min: 1 },
  uid: { type: String, required: true },
  utr: { type: String, required: true, unique: true },
  status: { type: String, default: 'pending', enum: ['pending', 'completed', 'failed'] },
  createdAt: { type: Date, default: Date.now }
});

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

const User = mongoose.model('User', userSchema);
const Tournament = mongoose.model('Tournament', tournamentSchema);
const DepositRequest = mongoose.model('DepositRequest', depositRequestSchema);
const Wallet = mongoose.model('Wallet', walletSchema);
const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);
const Leaderboard = mongoose.model('Leaderboard', leaderboardSchema);
const Winner = mongoose.model('Winner', winnerSchema);

// ==================== HELPERS ====================
function getUserIdFromRequest(req) {
  return req.headers['x-user-id'] || req.body.userId || req.query.userId;
}

function sanitizeUser(user) {
  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    isAdmin: !!user.isAdmin,
    gameUid: user.gameUid || ''
  };
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

async function requireUser(req, res) {
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

// ==================== AUTH ====================
app.post('/api/auth/signup', async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    const email = (req.body.email || '').trim().toLowerCase();
    const password = req.body.password || '';
    if (!name || !email || !password) return res.status(400).json({ message: 'Name, email, and password are required.' });
    if (password.length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters.' });
    const existing = await User.findOne({ email });
    if (existing) return res.status(409).json({ message: 'An account with this email already exists.' });
    const isAdmin = email === 'adminkush@nexmillarena.com';
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await User.create({ name, email, password: hashedPassword, isAdmin });
    await Wallet.create({ userId: user._id, balance: 0 });
    res.status(201).json({ message: 'Account created successfully!', user: sanitizeUser(user) });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: 'An account with this email already exists.' });
    console.error(err);
    res.status(500).json({ message: 'Signup failed.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    const password = req.body.password || '';
    if (!email || !password) return res.status(400).json({ message: 'Email and password are required.' });
    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ message: 'Invalid email or password.' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ message: 'Invalid email or password.' });
    res.json({ message: 'Login successful!', user: sanitizeUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Login failed.' });
  }
});

// ==================== TOURNAMENTS ====================
app.get('/api/tournaments', async (req, res) => {
  try {
    const tournaments = await Tournament.find().select('-roomID -roomPass').sort({ createdAt: -1 });
    res.json(tournaments);
  } catch (err) {
    res.status(500).json({ message: 'Server error fetching tournaments' });
  }
});

// 🔐 SECURE ROOM CREDENTIALS ENDPOINT (only for joined participants or admin)
app.get('/api/tournaments/:id/room', async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const tournament = await Tournament.findById(req.params.id);
    if (!tournament) return res.status(404).json({ message: 'Tournament not found.' });

    const isJoined = isParticipant(tournament, user._id);
    const isAdmin = user.isAdmin === true;

    if (!isJoined && !isAdmin) {
      return res.status(403).json({ message: 'Access Denied: You must join this tournament to view Room Credentials.' });
    }

    res.json({
      roomID: tournament.roomID || '',
      roomPass: tournament.roomPass || ''
    });
  } catch (err) {
    console.error('Room info error:', err);
    res.status(500).json({ message: 'Server error while fetching room details.' });
  }
});

app.post('/api/tournaments', async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const { matchTitle, mapName, entryFee, prizePool, totalSlots, rules } = req.body;
    if (!matchTitle || !mapName || !entryFee || !prizePool || totalSlots === undefined) {
      return res.status(400).json({ message: 'Missing required fields.' });
    }
    const adminProfit = calculateAdminProfit(entryFee, totalSlots);
    const tournament = new Tournament({ matchTitle, mapName, entryFee, prizePool, totalSlots, rules, adminProfit, participants: [] });
    await tournament.save();
    res.status(201).json(tournament);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error creating tournament.' });
  }
});

app.delete('/api/tournaments/:id', async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    await Tournament.findByIdAndDelete(req.params.id);
    res.json({ message: 'Tournament deleted successfully.' });
  } catch (err) {
    res.status(500).json({ message: 'Error deleting tournament.' });
  }
});

app.post('/api/tournaments/:id/join', async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const ign = (req.body.ign || '').trim();
    const uid = (req.body.uid || '').trim();
    if (!ign || !uid) return res.status(400).json({ message: 'IGN and UID are required.' });
    const tournament = await Tournament.findById(req.params.id);
    if (!tournament) return res.status(404).json({ message: 'Match not found.' });
    if (tournament.filledSlots >= tournament.totalSlots) return res.status(400).json({ message: 'Match is already full!' });
    if (tournament.participants.some(p => p.uid === uid)) return res.status(400).json({ message: 'This UID is already registered in this match!' });
    const entryFee = parseEntryFee(tournament.entryFee);
    const wallet = await getOrCreateWallet(user._id);
    if (wallet.balance < entryFee) return res.status(400).json({ message: `Insufficient balance! Entry fee is Rs ${entryFee}, wallet has Rs ${wallet.balance}.` });
    wallet.balance -= entryFee;
    await wallet.save();
    if (!user.gameUid) {
      user.gameUid = uid;
      await user.save();
    }
    tournament.participants.push({ ign, uid, userId: user._id, registeredAt: new Date() });
    tournament.filledSlots += 1;
    await tournament.save();
    res.json({ message: 'Successfully registered!', newBalance: wallet.balance, entryFeeDeducted: entryFee });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Internal server error during join.' });
  }
});

// ✅ ADMIN UPDATE ROOM CREDENTIALS ENDPOINT
app.put('/api/tournaments/:id/room-info', async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const updated = await Tournament.findByIdAndUpdate(
      req.params.id,
      { roomID: req.body.roomID || '', roomPass: req.body.roomPass || '' },
      { new: true }
    );
    if (!updated) return res.status(404).json({ message: 'Tournament not found.' });
    res.json({ message: 'Room ID and password updated successfully!', updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error while updating room info.' });
  }
});

// ==================== WINNERS / LEADERBOARD ====================
app.get('/api/winners', async (req, res) => {
  try {
    const winners = await Winner.find().sort({ createdAt: -1 }).limit(10);
    res.json(winners);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching winners.' });
  }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const entries = await Leaderboard.find().sort({ createdAt: -1 });
    res.json(entries);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching leaderboard.' });
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
    res.status(500).json({ message: 'Wallet error.' });
  }
});

app.post('/api/wallet/deposit', async (req, res) => {
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
    console.error(err);
    res.status(500).json({ message: 'Deposit system error.' });
  }
});

app.post('/api/wallet/withdraw', async (req, res) => {
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
    res.status(201).json({ message: 'Withdrawal request submitted successfully.', newBalance: wallet.balance });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Withdrawal system error.' });
  }
});

// ==================== ADMIN ====================
app.get('/api/admin/participants', async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const tournaments = await Tournament.find().sort({ createdAt: -1 });
    const list = [];
    tournaments.forEach(tournament => {
      if (tournament.participants && tournament.participants.length) {
        tournament.participants.forEach(player => {
          list.push({ matchTitle: tournament.matchTitle, ign: player.ign, uid: player.uid, registeredAt: player.registeredAt });
        });
      }
    });
    res.json(list);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error fetching participants.' });
  }
});

app.get('/api/admin/deposits', async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const deposits = await DepositRequest.find().sort({ createdAt: -1 });
    res.json(deposits);
  } catch (err) {
    res.status(500).json({ message: 'Server error fetching deposits.' });
  }
});

app.post('/api/admin/deposits/action', async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const { requestId, action } = req.body;
    const depositReq = await DepositRequest.findById(requestId);
    if (!depositReq) return res.status(404).json({ message: 'Deposit request not found.' });
    if (depositReq.status !== 'pending') return res.status(400).json({ message: 'This request has already been processed.' });
    if (action === 'completed') {
      depositReq.status = 'completed';
      await depositReq.save();
      const wallet = await getOrCreateWallet(depositReq.userId);
      wallet.balance += parseFloat(depositReq.amount);
      await wallet.save();
      return res.json({ message: 'Deposit approved.', status: 'completed', balance: wallet.balance });
    } else if (action === 'failed') {
      depositReq.status = 'failed';
      await depositReq.save();
      return res.json({ message: 'Deposit rejected.', status: 'failed' });
    } else {
      return res.status(400).json({ message: 'Invalid action type.' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Internal server error during admin action.' });
  }
});

app.get('/api/admin/withdrawals', async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const withdrawals = await Withdrawal.find().sort({ createdAt: -1 });
    res.json(withdrawals);
  } catch (err) {
    res.status(500).json({ message: 'Server error fetching withdrawals.' });
  }
});

app.post('/api/admin/withdrawals/action', async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const withdrawal = await Withdrawal.findById(req.body.requestId);
    if (!withdrawal) return res.status(404).json({ message: 'Withdrawal request not found.' });
    if (withdrawal.status !== 'pending') return res.status(400).json({ message: 'This withdrawal has already been processed.' });
    if (req.body.action === 'completed') {
      withdrawal.status = 'completed';
      await withdrawal.save();
      return res.json({ message: 'Withdrawal marked completed.', status: 'completed' });
    } else if (req.body.action === 'failed') {
      withdrawal.status = 'failed';
      await withdrawal.save();
      const wallet = await getOrCreateWallet(withdrawal.userId);
      wallet.balance += parseFloat(withdrawal.amount);
      await wallet.save();
      return res.json({ message: 'Withdrawal rejected and refunded.', status: 'failed', balance: wallet.balance });
    } else {
      return res.status(400).json({ message: 'Invalid action type.' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Internal server error during withdrawal action.' });
  }
});

app.post('/api/admin/distribute-prizes', async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const { tournamentId, winners } = req.body;
    if (!tournamentId || !winners || !winners.length) return res.status(400).json({ message: 'tournamentId and winners array required.' });
    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) return res.status(404).json({ message: 'Tournament not found.' });
    let totalDistributed = 0;
    for (const w of winners) {
      const trimmedUid = (w.uid || '').trim();
      const trimmedIgn = (w.ign || '').trim();
      const rank = parseInt(w.rank, 10);
      const prizeAmount = parseFloat(w.prizeAmount);
      if (!trimmedUid || !trimmedIgn || !rank || isNaN(prizeAmount) || prizeAmount <= 0) {
        return res.status(400).json({ message: 'Each winner needs uid, ign, rank, and prizeAmount.' });
      }
      let targetUserId = null;
      for (const p of tournament.participants) {
        if (p.uid === trimmedUid && p.userId) {
          targetUserId = p.userId;
          break;
        }
      }
      if (!targetUserId) {
        const linkedUser = await User.findOne({ gameUid: trimmedUid });
        if (linkedUser) targetUserId = linkedUser._id;
      }
      if (targetUserId) {
        const wlt = await getOrCreateWallet(targetUserId);
        wlt.balance += prizeAmount;
        await wlt.save();
      }
      totalDistributed += prizeAmount;
      await Leaderboard.create({ tournamentId: tournament._id, matchTitle: tournament.matchTitle, userId: targetUserId, uid: trimmedUid, ign: trimmedIgn, rank, prizeAmount });
      await Winner.create({ tournament: tournament.matchTitle, name: trimmedIgn, uid: trimmedUid, prize: 'Rs ' + prizeAmount });
    }
    res.json({ message: 'Prizes distributed for ' + tournament.matchTitle + '.', totalDistributed });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error distributing prizes.' });
  }
});

// ==================== SEED ====================
async function seedAdminUser() {
  const adminEmail = 'adminkush@nexmillarena.com';
  let admin = await User.findOne({ email: adminEmail });
  if (!admin) {
    const hashedPassword = await bcrypt.hash('admin123kush', 10);
    admin = await User.create({ name: 'NexmilL Admin', email: adminEmail, password: hashedPassword, isAdmin: true });
    await Wallet.create({ userId: admin._id, balance: 0 });
    console.log('Admin user seeded: adminkush@nexmillarena.com / admin123kush');
  } else {
    admin.isAdmin = true;
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

// SPA fallback
app.use((req, res, next) => {
  if (req.path.indexOf('/api') === 0) {
    return res.status(404).json({ message: 'API route not found.' });
  }
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

app.listen(PORT, async () => {
  console.log(`Server running on http://localhost:${PORT}`);
  await seedInitialTournaments();
  await seedAdminUser();
});