require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors({ origin: true }));
app.use(express.json());

const MONGODB_URI = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb+srv://kushalsaini0007_db:kush5547x@cluster0.9fztkn9.mongodb.net/nexmill_arena?retryWrites=true&w=majority&appName=Cluster0';

// DEBUG LOGS TO CATCH THE ERROR
if (process.env.MONGO_URI) {
    console.log("🔍 DEBUG: Server is using 'process.env.MONGO_URI' from Render Dashboard!");
} else if (process.env.MONGODB_URI) {
    console.log("🔍 DEBUG: Server is using 'process.env.MONGODB_URI' from Render Dashboard!");
} else {
    console.log("🔍 DEBUG: Server is ignoring environment variables and using the HARDCODED fallback string!");
}

console.log("🔍 DEBUG: The current database user is:", MONGODB_URI.split('://')[1]?.split(':')[0]);

// ✅ FIXED: Added connection options for DNS resolution
mongoose.connect(MONGODB_URI, {
  serverSelectionTimeoutMS: 30000,
  socketTimeoutMS: 45000,
  family: 4 // Force IPv4
})
  .then(() => console.log('✅ MongoDB connected (Atlas)'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

// ==================== SCHEMAS & MODELS ====================

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
  roomID: { type: String, default: "" },
  roomPass: { type: String, default: "" },
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

const winnerSchema = new mongoose.Schema({
  tournament: { type: String, required: true },
  name: { type: String, required: true },
  uid: { type: String, required: true },
  prize: { type: String, required: true },
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

const User = mongoose.model('User', userSchema);
const Tournament = mongoose.model('Tournament', tournamentSchema);
const DepositRequest = mongoose.model('DepositRequest', depositRequestSchema);
const Winner = mongoose.model('Winner', winnerSchema);
const Wallet = mongoose.model('Wallet', walletSchema);
const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);
const Leaderboard = mongoose.model('Leaderboard', leaderboardSchema);

// ==================== HELPERS ====================

function getUserIdFromRequest(req) {
  return req.headers['x-user-id'] || req.body.userId || req.query.userId;
}

function sanitizeUser(user) {
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    isAdmin: user.isAdmin,
    gameUid: user.gameUid || ''
  };
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
    res.status(401).json({ message: 'Invalid user session. Please log in again.' });
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
  if (!entryFeeStr || entryFeeStr.toLowerCase().includes('free')) return 0;
  const match = entryFeeStr.match(/\d+/);
  return match ? parseInt(match[0], 10) : 0;
}

function calculateAdminProfit(entryFeeStr, totalSlots) {
  if (entryFeeStr.toLowerCase().includes('free')) return 0;
  const match = entryFeeStr.match(/\d+/);
  if (!match) return 0;
  const numericEntry = parseInt(match[0]);
  if (isNaN(numericEntry)) return 0;
  return Math.floor(numericEntry * totalSlots * 0.20);
}

async function creditWalletByGameUid(gameUid, amount) {
  const user = await User.findOne({ gameUid });
  if (!user) return null;
  const wallet = await getOrCreateWallet(user._id);
  wallet.balance += amount;
  await wallet.save();
  return wallet;
}

// ==================== AUTH ROUTES ====================

app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    const trimmedName = typeof name === 'string' ? name.trim() : '';
    const trimmedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const trimmedPassword = typeof password === 'string' ? password : '';

    if (!trimmedName || !trimmedEmail || !trimmedPassword) {
      return res.status(400).json({ message: 'Name, email, and password are required.' });
    }
    if (trimmedPassword.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters.' });
    }

    const existing = await User.findOne({ email: trimmedEmail });
    if (existing) {
      return res.status(409).json({ message: 'An account with this email already exists.' });
    }

    const isAdmin = trimmedEmail === 'admin@nexmillarena.com';
    const hashedPassword = await bcrypt.hash(trimmedPassword, 10);
    const user = await User.create({
      name: trimmedName,
      email: trimmedEmail,
      password: hashedPassword,
      isAdmin
    });

    await Wallet.create({ userId: user._id, balance: 0 });

    res.status(201).json({
      message: 'Account created successfully!',
      user: sanitizeUser(user)
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: 'An account with this email already exists.' });
    }
    console.error(err);
    res.status(500).json({ message: 'Signup failed.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const trimmedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const trimmedPassword = typeof password === 'string' ? password : '';

    if (!trimmedEmail || !trimmedPassword) {
      return res.status(400).json({ message: 'Email and password are required.' });
    }

    const user = await User.findOne({ email: trimmedEmail });
    if (!user) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }

    const isMatch = await bcrypt.compare(trimmedPassword, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }

    res.json({
      message: 'Login successful!',
      user: sanitizeUser(user)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Login failed.' });
  }
});

// ==================== TOURNAMENT ROUTES ====================

app.get('/api/tournaments', async (req, res) => {
  try {
    // ✅ SECURITY FIX: Room ID aur Password ko normal global list se bilkul chhipa diya hai
    const tournaments = await Tournament.find().select('-roomID -roomPass').sort({ createdAt: -1 });
    res.json(tournaments);
  } catch (err) {
    res.status(500).json({ message: 'Server error fetching tournaments' });
  }
});

app.post('/api/tournaments', async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const { matchTitle, mapName, entryFee, prizePool, totalSlots, rules } = req.body;
    if (!matchTitle || !mapName || !entryFee || !prizePool || !totalSlots) {
      return res.status(400).json({ message: 'Missing required fields' });
    }
    const adminProfit = calculateAdminProfit(entryFee, totalSlots);
    const newTournament = new Tournament({
      matchTitle, mapName, entryFee, prizePool, totalSlots, rules, adminProfit, participants: []
    });
    await newTournament.save();
    res.status(201).json(newTournament);
  } catch (err) {
    res.status(500).json({ message: 'Error creating tournament' });
  }
});

app.delete('/api/tournaments/:id', async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    await Tournament.findByIdAndDelete(req.params.id);
    res.json({ message: 'Tournament deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Error deleting tournament' });
  }
});

app.post('/api/tournaments/:id/join', async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const { ign, uid } = req.body;
    const trimmedIgn = typeof ign === 'string' ? ign.trim() : '';
    const trimmedUid = typeof uid === 'string' ? uid.trim() : '';

    if (!trimmedIgn || !trimmedUid) {
      return res.status(400).json({ message: 'IGN and UID are required.' });
    }

    const tournament = await Tournament.findById(req.params.id);
    if (!tournament) return res.status(404).json({ message: 'Match not found.' });
    if (tournament.filledSlots >= tournament.totalSlots) {
      return res.status(400).json({ message: 'Match is already full!' });
    }
    if (tournament.participants.some(p => p.uid === trimmedUid)) {
      return res.status(400).json({ message: 'This UID is already registered in this match!' });
    }

    const entryFee = parseEntryFee(tournament.entryFee);
    const wallet = await getOrCreateWallet(user._id);

    if (wallet.balance < entryFee) {
      return res.status(400).json({
        message: `Insufficient balance! Entry fee is ₹${entryFee}, but your wallet balance is ₹${wallet.balance}. Please add money first.`
      });
    }

    wallet.balance -= entryFee;
    await wallet.save();

    if (!user.gameUid) {
      user.gameUid = trimmedUid;
      await user.save();
    }

    tournament.participants.push({
      ign: trimmedIgn,
      uid: trimmedUid,
      userId: user._id,
      registeredAt: new Date()
    });
    tournament.filledSlots += 1;
    await tournament.save();

    res.json({
      message: 'Successfully registered!',
      tournament,
      newBalance: wallet.balance,
      entryFeeDeducted: entryFee
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Internal server error during join.' });
  }
});

// ==================== WINNERS ROUTES ====================

app.get('/api/winners', async (req, res) => {
  try {
    const winners = await Winner.find().sort({ createdAt: -1 }).limit(10);
    res.json(winners);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching winners' });
  }
});

app.post('/api/winners', async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const newWinner = new Winner(req.body);
    await newWinner.save();
    res.status(201).json(newWinner);
  } catch (err) {
    res.status(500).json({ message: 'Error announcing winner' });
  }
});

// ==================== WALLET ROUTES ====================

app.get('/api/wallet', async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const wallet = await getOrCreateWallet(user._id);
    res.json(wallet);
  } catch (err) {
    res.status(500).json({ message: 'Wallet error' });
  }
});

app.post('/api/wallet/deposit', async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const { amount, uid, utr } = req.body;
    const parsedAmount = parseFloat(amount);
    const trimmedUid = typeof uid === 'string' ? uid.trim() : '';
    const trimmedUtr = typeof utr === 'string' ? utr.trim() : '';

    if (!parsedAmount || isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ message: 'Invalid deposit amount. Must be a positive number.' });
    }
    if (!trimmedUid) {
      return res.status(400).json({ message: 'Game UID is required.' });
    }
    if (!/^\d{12}$/.test(trimmedUtr)) {
      return res.status(400).json({ message: 'Invalid UTR. Please provide a valid 12-digit transaction ID.' });
    }

    const existingUtr = await DepositRequest.findOne({ utr: trimmedUtr });
    if (existingUtr) {
      return res.status(409).json({ message: 'This UTR has already been submitted. Duplicate transactions are not allowed.' });
    }

    if (!user.gameUid) {
      user.gameUid = trimmedUid;
      await user.save();
    }

    const newRequest = new DepositRequest({
      userId: user._id,
      amount: parsedAmount,
      uid: trimmedUid,
      utr: trimmedUtr,
      status: 'pending'
    });
    await newRequest.save();

    res.status(201).json({
      message: 'Deposit request submitted successfully. Pending admin approval.',
      request: newRequest
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: 'This UTR has already been submitted. Duplicate transactions are not allowed.' });
    }
    console.error(err);
    res.status(500).json({ message: 'Deposit system error' });
  }
});

app.post('/api/wallet/withdraw', async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const { uid, upiId, amount } = req.body;
    const trimmedUid = typeof uid === 'string' ? uid.trim() : '';
    const trimmedUpi = typeof upiId === 'string' ? upiId.trim() : '';
    const parsedAmount = parseFloat(amount);

    if (!trimmedUid) return res.status(400).json({ message: 'Game UID is required.' });
    if (!trimmedUpi) return res.status(400).json({ message: 'UPI ID / PhonePe number is required.' });
    if (!parsedAmount || isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ message: 'Invalid withdrawal amount. Must be a positive number.' });
    }

    const wallet = await getOrCreateWallet(user._id);
    if (wallet.balance < parsedAmount) {
      return res.status(400).json({
        message: `Insufficient balance! Your wallet has ₹${wallet.balance}, but you requested ₹${parsedAmount}.`
      });
    }

    wallet.balance -= parsedAmount;
    await wallet.save();

    const withdrawal = new Withdrawal({
      userId: user._id,
      uid: trimmedUid,
      upiId: trimmedUpi,
      amount: parsedAmount,
      status: 'pending'
    });
    await withdrawal.save();

    res.status(201).json({
      message: 'Withdrawal request submitted successfully.',
      withdrawal,
      newBalance: wallet.balance
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Withdrawal system error' });
  }
});

// ==================== ADMIN ROUTES ====================

app.get('/api/admin/participants', async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const tournaments = await Tournament.find().sort({ createdAt: -1 });
    const participants = [];
    tournaments.forEach(tournament => {
      if (tournament.participants?.length) {
        tournament.participants.forEach(player => {
          participants.push({
            matchTitle: tournament.matchTitle,
            ign: player.ign,
            uid: player.uid,
            registeredAt: player.registeredAt
          });
        });
      }
    });
    res.json(participants);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error fetching participants' });
  }
});

app.get('/api/admin/deposits', async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const deposits = await DepositRequest.find().sort({ createdAt: -1 });
    res.json(deposits);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error fetching admin deposits' });
  }
});

app.post('/api/admin/deposits/action', async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const { requestId, action } = req.body;
    if (!requestId || !action) {
      return res.status(400).json({ message: 'Missing requestId or action' });
    }

    const depositReq = await DepositRequest.findById(requestId);
    if (!depositReq) return res.status(404).json({ message: 'Deposit request not found' });
    if (depositReq.status !== 'pending') {
      return res.status(400).json({ message: 'This request has already been processed!' });
    }

    if (action === 'completed') {
      depositReq.status = 'completed';
      await depositReq.save();
      const wallet = await getOrCreateWallet(depositReq.userId);
      wallet.balance += parseFloat(depositReq.amount);
      await wallet.save();
      return res.json({
        message: 'Deposit approved and balance added successfully!',
        status: 'completed',
        balance: wallet.balance
      });
    }

    if (action === 'failed') {
      depositReq.status = 'failed';
      await depositReq.save();
      return res.json({ message: 'Deposit request rejected successfully!', status: 'failed' });
    }

    res.status(400).json({ message: 'Invalid action type' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Internal Server Error during admin action' });
  }
});

app.get('/api/admin/withdrawals', async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const withdrawals = await Withdrawal.find().sort({ createdAt: -1 });
    res.json(withdrawals);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error fetching withdrawals' });
  }
});

app.post('/api/admin/withdrawals/action', async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const { requestId, action } = req.body;
    if (!requestId || !action) {
      return res.status(400).json({ message: 'Missing requestId or action' });
    }

    const withdrawal = await Withdrawal.findById(requestId);
    if (!withdrawal) return res.status(404).json({ message: 'Withdrawal request not found' });
    if (withdrawal.status !== 'pending') {
      return res.status(400).json({ message: 'This withdrawal has already been processed!' });
    }

    if (action === 'completed') {
      withdrawal.status = 'completed';
      await withdrawal.save();
      return res.json({ message: 'Withdrawal marked as completed.', status: 'completed' });
    }

    if (action === 'failed') {
      withdrawal.status = 'failed';
      await withdrawal.save();
      const wallet = await getOrCreateWallet(withdrawal.userId);
      wallet.balance += parseFloat(withdrawal.amount);
      await wallet.save();
      return res.json({
        message: 'Withdrawal rejected and amount refunded to wallet.',
        status: 'failed',
        balance: wallet.balance
      });
    }

    res.status(400).json({ message: 'Invalid action type' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Internal Server Error during withdrawal action' });
  }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const entries = await Leaderboard.find().sort({ createdAt: -1 });
    res.json(entries);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error fetching leaderboard' });
  }
});

app.post('/api/admin/distribute-prizes', async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const { tournamentId, winners } = req.body;

    if (!tournamentId || !Array.isArray(winners) || winners.length === 0) {
      return res.status(400).json({ message: 'tournamentId and a non-empty winners array are required.' });
    }

    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) return res.status(404).json({ message: 'Tournament not found.' });

    const leaderboardEntries = [];
    let totalDistributed = 0;

    for (const winner of winners) {
      const trimmedUid = typeof winner.uid === 'string' ? winner.uid.trim() : '';
      const trimmedIgn = typeof winner.ign === 'string' ? winner.ign.trim() : '';
      const rank = parseInt(winner.rank, 10);
      const prizeAmount = parseFloat(winner.prizeAmount);

      if (!trimmedUid || !trimmedIgn || !rank || isNaN(prizeAmount) || prizeAmount <= 0) {
        return res.status(400).json({ message: 'Each winner must have valid uid, ign, rank, and prizeAmount.' });
      }

      const participant = tournament.participants.find(p => p.uid === trimmedUid);
      let targetUserId = winner.userId || participant?.userId;

      if (!targetUserId) {
        const linkedUser = await User.findOne({ gameUid: trimmedUid });
        if (linkedUser) targetUserId = linkedUser._id;
      }

      if (targetUserId) {
        const wallet = await getOrCreateWallet(targetUserId);
        wallet.balance += prizeAmount;
        await wallet.save();
      }

      totalDistributed += prizeAmount;

      const entry = await Leaderboard.create({
        tournamentId: tournament._id,
        matchTitle: tournament.matchTitle,
        userId: targetUserId || undefined,
        uid: trimmedUid,
        ign: trimmedIgn,
        rank,
        prizeAmount
      });
      leaderboardEntries.push(entry);

      await Winner.create({
        tournament: tournament.matchTitle,
        name: trimmedIgn,
        uid: trimmedUid,
        prize: `₹${prizeAmount}`
      });
    }

    res.json({
      message: `Prizes distributed successfully for ${tournament.matchTitle}!`,
      totalDistributed,
      leaderboardEntries
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error distributing prizes' });
  }
});

// ==================== SECURE ROOM ID & PASSWORD SYSTEM (WITH CCTV LOGS) ====================

// 🅰️ ADMIN ROUTE: Isse admin custom room ki details save karega
app.post('/api/admin/tournaments/:id/room', async (req, res) => {
  console.log(`\n🚨 [CCTV LOG - ADMIN] Room update request received for Match ID: ${req.params.id}`);
  try {
    const adminUser = await requireAdmin(req, res);
    if (!adminUser) {
      console.log("❌ [CCTV LOG - ADMIN] Blocked: Request is NOT from an Admin.");
      return; 
    }
    console.log(`✅ [CCTV LOG - ADMIN] Access Granted for Admin: ${adminUser.email}`);

    const { roomID, roomPass } = req.body;
    console.log(`🔍 [CCTV LOG - ADMIN] Data received -> ID: ${roomID || 'EMPTY'}, Pass: ${roomPass || 'EMPTY'}`);

    if (!roomID || !roomPass) {
      console.log("❌ [CCTV LOG - ADMIN] Failed: Missing Room ID or Password input.");
      return res.status(400).json({ message: 'Both Room ID and Password are required.' });
    }

    const updated = await Tournament.findByIdAndUpdate(
      req.params.id,
      { roomID, roomPass },
      { new: true }
    );

    if (!updated) {
      console.log("❌ [CCTV LOG - ADMIN] Error: Tournament match not found in Database.");
      return res.status(404).json({ message: 'Tournament not found.' });
    }

    console.log("✅ [CCTV LOG - ADMIN] Success: Room Details successfully pushed to Database!");
    res.json({ message: 'Room ID & Password updated successfully!', updated });

  } catch (err) {
    console.error("💥 [CCTV LOG - ADMIN] CRITICAL SERVER ERROR:", err);
    res.status(500).json({ message: 'Server error while updating room info', error: err.message });
  }
});

// 🅱️ USER ROUTE: Sirf joined players ko ID/PASS dikhane ke liye secure gate
app.get('/api/tournaments/:id/room', async (req, res) => {
  console.log(`\n🔒 [CCTV LOG - USER] Security check triggered for Match ID: ${req.params.id}`);
  try {
    const user = await requireUser(req, res);
    if (!user) {
      console.log("❌ [CCTV LOG - USER] Blocked: Visitor is not logged in.");
      return; 
    }
    console.log(`👋 [CCTV LOG - USER] Identity Verified: ${user.name} (ID: ${user._id})`);

    const tournament = await Tournament.findById(req.params.id);
    if (!tournament) {
      console.log("❌ [CCTV LOG - USER] Error: Tournament match not found.");
      return res.status(404).json({ message: 'Tournament not found.' });
    }

    const hasJoined = tournament.participants.some(p => p.userId && p.userId.toString() === user._id.toString());
    console.log(`🔍 [CCTV LOG - USER] Scan Report -> Joined Status: ${hasJoined} | Admin Status: ${user.isAdmin}`);

    if (!hasJoined && !user.isAdmin) {
      console.log(`❌ [CCTV LOG - USER] ALERT: ${user.name} tried to view Room Codes without registering! ACCESS DENIED.`);
      return res.status(403).json({ message: 'Access Denied! You have not registered for this tournament.' });
    }

    console.log(`✅ [CCTV LOG - USER] Access Granted! Sending room data securely to ${user.name}.`);
    res.json({
      roomID: tournament.roomID || "Not Assigned Yet",
      roomPass: tournament.roomPass || "Not Assigned Yet"
    });

  } catch (err) {
    console.error("💥 [CCTV LOG - USER] CRITICAL SERVER ERROR:", err);
    res.status(500).json({ message: 'Server error while fetching room details', error: err.message });
  }
});

// ==================== SEEDING ====================

async function seedInitialTournaments() {
  const count = await Tournament.countDocuments();
  if (count === 0) {
    await Tournament.insertMany([
      { matchTitle: 'Bermuda Blitz', mapName: 'Bermuda', entryFee: 'Free', prizePool: '₹500', totalSlots: 100, filledSlots: 0, rules: 'Rank 1: ₹250, Rank 2: ₹150, Rank 3: ₹100', adminProfit: 0, participants: [] },
      { matchTitle: 'Kalahari Showdown', mapName: 'Kalahari', entryFee: '₹20', prizePool: '₹1,000', totalSlots: 64, filledSlots: 0, rules: 'Rank 1: ₹500, Rank 2: ₹300, Rank 3: ₹200', adminProfit: 256, participants: [] }
    ]);
    console.log('✅ Default tournaments seeded');
  }
}

async function seedAdminUser() {
  const adminEmail = 'admin@nexmillarena.com';
  let admin = await User.findOne({ email: adminEmail });
  if (!admin) {
    const hashedPassword = await bcrypt.hash('admin123', 10);
    admin = await User.create({
      name: 'NexmilL Admin',
      email: adminEmail,
      password: hashedPassword,
      isAdmin: true
    });
    await Wallet.create({ userId: admin._id, balance: 0 });
    console.log('✅ Admin user seeded (admin@nexmillarena.com / admin123)');
  }
}

app.listen(PORT, async () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  await seedInitialTournaments();
  await seedAdminUser();
});