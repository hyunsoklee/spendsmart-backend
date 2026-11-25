// Import Express and PostgreSQL
require('dotenv').config();
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Only callers that send the shared key are answered (see apiKey.js).
app.use('/api', require('./apiKey'));

// Connect to PostgreSQL
const pool = require('./db');
const { getBudgetsWithSpent, getCategoryTransactions } = require('./spending');
const { retagTransaction } = require('./retag');
const { setTransactionSplit, listUsers } = require('./split');
const { getSetup, saveSetup } = require('./setup');

// The link page and its routes (this Mac only).
app.use(require('./linkRoutes'));

// Test database connection
pool.connect((err) => {
  if (err) {
    console.error('Database connection error:', err);
  } else {
    console.log('✅ Connected to PostgreSQL database!');
  }
});

// Route 1: Home
app.get('/', (req, res) => {
  res.send('SpendSmart API is running! 🚀');
});

// Route 2: Get budgets, with spent calculated from this month's transactions
app.get('/api/budgets', async (req, res) => {
  try {
    const budgets = await getBudgetsWithSpent();

    // Add sticker tiers (mock data for now)
    const budgetsWithStickers = budgets.map((budget) => {
      const percentage = budget.budget > 0 ? (budget.spent / budget.budget) * 100 : 0;
      let sticker = null;

      // Sticker logic: 80-105% = on track gets a sticker
      if (percentage >= 80 && percentage <= 105) {
        // Mock different achievement levels
        if (budget.category === 'dining') sticker = '💍'; // 9 months - Ruby
        else if (budget.category === 'shopping') sticker = '💎'; // 6 months - Diamond
        else if (budget.category === 'entertainment') sticker = '👑'; // 12 months - Crown
        else if (budget.category === 'groceries') sticker = '🌟'; // 2 months - Silver
        else if (budget.category === 'travel') sticker = '💫'; // 3 months - Gold
        else sticker = '⭐️'; // 1 month - Bronze
      }

      return { ...budget, sticker };
    });

    res.json(budgetsWithStickers);
  } catch (error) {
    console.error('GET /api/budgets failed:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Route 3: Get spending summary, from the same numbers as Route 2
app.get('/api/summary', async (req, res) => {
  try {
    const budgets = await getBudgetsWithSpent();

    const totalBudget = budgets.reduce((sum, b) => sum + b.budget, 0);
    const totalSpentCents = budgets.reduce((sum, b) => sum + b.spent_cents, 0);
    const totalSpent = Math.round(totalSpentCents / 100);
    const percentageUsed = totalBudget > 0 ? Math.round((totalSpent / totalBudget) * 100) : 0;

    // Household sticker logic (80-105% = on track)
    let householdSticker = null;
    if (percentageUsed >= 80 && percentageUsed <= 105) {
      householdSticker = '💫'; // Gold - 3 months household streak
    }

    res.json({
      totalBudget,
      totalSpent,
      spendFree: totalBudget - totalSpent,
      percentageUsed,
      householdSticker,
    });
  } catch (error) {
    console.error('GET /api/summary failed:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Route 3b: This month's charges for one budget category, newest first
app.get('/api/budgets/:id/transactions', async (req, res) => {
  const budgetId = parseInt(req.params.id, 10);
  if (Number.isNaN(budgetId)) {
    return res.status(400).json({ error: 'Invalid budget id' });
  }

  try {
    const transactions = await getCategoryTransactions(budgetId);
    res.json(transactions);
  } catch (error) {
    console.error('GET /api/budgets/:id/transactions failed:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Route 3c: Move a charge to another category and remember the merchant
app.post('/api/transactions/:id/category', async (req, res) => {
  const txnId = parseInt(req.params.id, 10);
  const budgetId = parseInt(req.body.budgetId, 10);
  if (Number.isNaN(txnId) || Number.isNaN(budgetId)) {
    return res.status(400).json({ error: 'Invalid transaction or budget id' });
  }

  const remember = req.body.remember !== false; // default: remember the merchant
  const restore = parseInt(req.body.restoreRuleBudgetId, 10);

  try {
    const result = await retagTransaction(txnId, budgetId, {
      remember,
      restoreRuleBudgetId: Number.isNaN(restore) ? null : restore,
    });
    res.json(result);
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('POST /api/transactions/:id/category failed:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Route 3d: Set who a charge belongs to (a person's id, or null for Shared)
app.post('/api/transactions/:id/split', async (req, res) => {
  const txnId = parseInt(req.params.id, 10);
  if (Number.isNaN(txnId) || !('splitUserId' in req.body)) {
    return res.status(400).json({ error: 'Invalid transaction id or missing splitUserId' });
  }

  const raw = req.body.splitUserId;
  const splitUserId = raw === null ? null : parseInt(raw, 10);
  if (splitUserId !== null && Number.isNaN(splitUserId)) {
    return res.status(400).json({ error: 'Invalid splitUserId' });
  }

  try {
    const result = await setTransactionSplit(txnId, splitUserId);
    res.json(result);
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('POST /api/transactions/:id/split failed:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Route 3e: Household members, for the split control
app.get('/api/users', async (req, res) => {
  try {
    res.json(await listUsers());
  } catch (error) {
    console.error('GET /api/users failed:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Route 3f: Everything the setup screens need
app.get('/api/setup', async (req, res) => {
  try {
    res.json(await getSetup());
  } catch (error) {
    console.error('GET /api/setup failed:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Route 3g: Save planned savings and all budgets together, or nothing
app.post('/api/setup', async (req, res) => {
  try {
    res.json(await saveSetup(req.body));
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('POST /api/setup failed:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Route 4: Update budget IN DATABASE
app.post('/api/budgets/update', async (req, res) => {
  const id = Number((req.body || {}).id);
  const newBudget = Math.round(Number((req.body || {}).newBudget));

  if (!Number.isInteger(id) || !Number.isFinite(newBudget) || newBudget < 0) {
    return res.status(400).json({ error: 'id and newBudget are required' });
  }

  try {
    const result = await pool.query(
      'UPDATE budgets SET budget = $1 WHERE id = $2',
      [newBudget, id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'No such category' });
    }
    res.json({ success: true, id, newBudget });
  } catch (error) {
    console.error('POST /api/budgets/update failed:', error.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// Route 5: Get credit cards
app.get('/api/cards', async (req, res) => {
  try {
    // Mock data for now (will connect to Plaid later)
    const cards = [
      {
        id: 1,
        name: 'Chase Sapphire',
        points: 45200,
        type: 'points'
      },
      {
        id: 2,
        name: 'Amex Gold',
        points: 38500,
        type: 'points'
      }
    ];
    
    res.json(cards);
  } catch (error) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Fetch new charges from the banks, unless they were fetched recently.
const { refreshFromBanks } = require('./syncAll');

app.post('/api/sync', async (req, res) => {
  try {
    const minutes = Number((req.body || {}).ifOlderThanMinutes);
    res.json(await refreshFromBanks(Number.isFinite(minutes) ? minutes : 60));
  } catch (err) {
    console.error('Sync route error:', err.message);
    res.status(500).json({ error: 'Could not fetch from the banks' });
  }
});

// The kinds of charge a new category could be built from
const { listKinds } = require('./kinds');
app.get('/api/kinds', async (req, res) => {
  try {
    const name = typeof req.query.name === 'string' ? req.query.name.slice(0, 60) : '';
    const include = typeof req.query.include === 'string' ? [req.query.include.slice(0, 80)] : [];
    res.json(await listKinds(undefined, { name, include, suggestIncluded: true }));
  } catch (err) {
    console.error('GET /api/kinds failed:', err.message);
    res.status(500).json({ error: 'Could not list kinds' });
  }
});

// Categories of your own
const {
  createCategory,
  suggestForKinds,
  updateCategory,
  removeCategory,
  previewRemoveCategory,
  saveCategoryOrder,
  listCategoryKinds,
  setCategoryKinds,  
} = require('./categories');

app.post('/api/categories/suggest', async (req, res) => {
  try {
    res.json(await suggestForKinds((req.body || {}).kinds));
  } catch (err) {
    if (!err.status) console.error('POST /api/categories/suggest failed:', err.message);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not work that out' });
  }
});

app.post('/api/categories', async (req, res) => {
  try {
    res.json(await createCategory(req.body));
  } catch (err) {
    if (!err.status) console.error('POST /api/categories failed:', err.message);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not add the category' });
  }
});

app.post('/api/categories/:id', async (req, res) => {
  try {
    res.json(await updateCategory(Number(req.params.id), req.body));
  } catch (err) {
    if (!err.status) console.error('POST /api/categories/:id failed:', err.message);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not save the category' });
  }
});

app.post('/api/categories/:id/remove', async (req, res) => {
  try {
    res.json(await removeCategory(Number(req.params.id), req.body));
  } catch (err) {
    if (!err.status) console.error('POST /api/categories/:id/remove failed:', err.message);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not remove the category' });
  }
});

app.get('/api/categories/:id/removal', async (req, res) => {
  try {
    res.json(await previewRemoveCategory(Number(req.params.id)));
  } catch (err) {
    if (!err.status) console.error('GET /api/categories/:id/removal failed:', err.message);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not work that out' });
  }
});

app.post('/api/category-order', async (req, res) => {
  try {
    res.json(await saveCategoryOrder((req.body || {}).ids));
  } catch (err) {
    if (!err.status) console.error('POST /api/category-order failed:', err.message);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not save the order' });
  }
});

app.get('/api/categories/:id/kinds', async (req, res) => {
  try {
    res.json(await listCategoryKinds(Number(req.params.id)));
  } catch (err) {
    if (!err.status) console.error('GET /api/categories/:id/kinds failed:', err.message);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not list kinds' });
  }
});

app.post('/api/categories/:id/kinds', async (req, res) => {
  try {
    res.json(await setCategoryKinds(Number(req.params.id), req.body));
  } catch (err) {
    if (!err.status) console.error('POST /api/categories/:id/kinds failed:', err.message);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not save' });
  }
});

// Savings targets
const savings = require('./savings');

function savingsRoute(label, work) {
  return async (req, res) => {
    try {
      res.json(await work(req));
    } catch (err) {
      if (!err.status) console.error(`${label} failed:`, err);
      res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not save that' });
    }
  };
}

const targetId = (req) => Number(req.params.id);

app.get('/api/savings/targets',
  savingsRoute('GET /api/savings/targets', () => savings.listTargets()));

app.post('/api/savings/targets',
  savingsRoute('POST /api/savings/targets', (req) => savings.createTarget(req.body || {})));

app.post('/api/savings/targets/:id',
  savingsRoute('POST /api/savings/targets/:id', (req) => savings.updateTarget(targetId(req), req.body || {})));

app.post('/api/savings/targets/:id/amount',
  savingsRoute('POST /api/savings/targets/:id/amount', (req) => savings.setAmount(targetId(req), req.body || {})));

app.post('/api/savings/targets/:id/remove',
  savingsRoute('POST /api/savings/targets/:id/remove', (req) => savings.removeTarget(targetId(req), req.body || {})));

// Health check with uptime
const startTime = Date.now();

app.get('/api/health', (req, res) => {
  const uptime = Math.floor((Date.now() - startTime) / 1000);
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = uptime % 60;
  
  res.json({
    status: 'healthy',
    uptime: `${hours}h ${minutes}m ${seconds}s`,
    database: 'connected',
    timestamp: new Date().toISOString()
  });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`SpendSmart API running at http://localhost:${PORT}`);
});
