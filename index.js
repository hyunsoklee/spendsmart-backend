// Import Express and PostgreSQL
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Connect to PostgreSQL
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: parseInt(process.env.DB_PORT, 10) || 5432,
});

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

// Route 2: Get budgets FROM DATABASE with stickers
app.get('/api/budgets', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM budgets');
    
    // Add sticker tiers (mock data for now)
    const budgetsWithStickers = result.rows.map(budget => {
      const percentage = (budget.spent / budget.budget) * 100;
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
    res.status(500).json({ error: 'Database error' });
  }
});

// Route 3: Get spending summary FROM DATABASE with household sticker
app.get('/api/summary', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        SUM(budget) as total_budget,
        SUM(spent) as total_spent
      FROM budgets
    `);
    
    const totalBudget = parseInt(result.rows[0].total_budget);
    const totalSpent = parseInt(result.rows[0].total_spent);
    const percentageUsed = Math.round((totalSpent / totalBudget) * 100);
    
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
