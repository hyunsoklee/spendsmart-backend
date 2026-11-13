// Import Express and PostgreSQL
require('dotenv').config();
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Connect to PostgreSQL
const pool = require('./db');
const { getBudgetsWithSpent, getCategoryTransactions } = require('./spending');
const { retagTransaction } = require('./retag');

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

// Route 4: Update budget IN DATABASE
app.post('/api/budgets/update', async (req, res) => {
  const { category, newBudget } = req.body;
  
  try {
    await pool.query(
      'UPDATE budgets SET budget = $1 WHERE category = $2',
      [newBudget, category]
    );
    
    res.json({
      success: true,
      message: `Budget for ${category} updated to $${newBudget}`,
      category,
      newBudget
    });
  } catch (error) {
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
