// Import Express and PostgreSQL
const express = require('express');
const { Pool } = require('pg');

const app = express();
const PORT = 3000;

// Middleware
app.use(express.json());

// Connect to PostgreSQL
const pool = new Pool({
  user: process.env.USER || 'Hwayeon',
  host: 'localhost',
  database: 'spendsmart',
  port: 5432,
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

// Route 2: Get budgets FROM DATABASE
app.get('/api/budgets', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM budgets');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Route 3: Get spending summary FROM DATABASE
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
    
    res.json({
      totalBudget,
      totalSpent,
      spendFree: totalBudget - totalSpent,
      percentageUsed: Math.round((totalSpent / totalBudget) * 100)
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

// Start server
app.listen(PORT, () => {
  console.log(`SpendSmart API running at http://localhost:${PORT}`);
});