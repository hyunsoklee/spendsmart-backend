const { Pool } = require('pg');

const pool = new Pool({
  user: process.env.USER || 'Hwayeon',
  host: 'localhost',
  database: 'spendsmart',
  port: 5432,
});

async function updateDatabase() {
  try {
    await pool.query("UPDATE budgets SET budget = 300 WHERE category = 'entertainment'");
    console.log('✅ Updated Entertainment budget to $300');
    
    await pool.query("UPDATE budgets SET budget = 200 WHERE category = 'transportation'");
    console.log('✅ Updated Transportation budget to $200');
    
    await pool.query("UPDATE budgets SET spent = 145 WHERE category = 'transportation'");
    console.log('✅ Updated Transportation spent to $145');
    
    const result = await pool.query('SELECT * FROM budgets ORDER BY id');
    console.log('\n📊 Current budgets:');
    console.table(result.rows);
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

updateDatabase();