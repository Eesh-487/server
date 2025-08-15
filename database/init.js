const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Required for Render
});

async function initializeDatabase() {
  // Create tables if they don't exist
  await createTables();
  // Run migrations
  await runMigrations();
  // Create test user if it doesn't exist
  await createTestUser();

  console.log('Database initialization completed');
  
  return pool;
}

async function createTables() {
  // Create tables and indexes
  const tableQueries = [
    // Users table
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT,
      role TEXT DEFAULT 'user',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    
    // Portfolio holdings
    `CREATE TABLE IF NOT EXISTS portfolio_holdings (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      symbol TEXT,
      company_name TEXT,
      quantity REAL NOT NULL,
      purchase_date DATE,
      average_cost REAL NOT NULL,
      purchase_price REAL,
      asset_type TEXT DEFAULT 'Stock',
      category TEXT,
      notes TEXT,
      target_allocation REAL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`,
    
    // Market data cache
    `CREATE TABLE IF NOT EXISTS market_data (
      symbol TEXT PRIMARY KEY,
      price REAL,
      change_percent REAL,
      volume REAL,
      pe_ratio REAL,
      dividend_yield REAL,
      market_cap REAL,
      exchange TEXT,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,

    // Portfolio performance history
    `CREATE TABLE IF NOT EXISTS portfolio_performance (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      date DATE NOT NULL,
      total_value REAL NOT NULL,
      daily_return REAL,
      cumulative_return REAL,
      benchmark_return REAL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`,
    
    // Risk metrics
    `CREATE TABLE IF NOT EXISTS risk_metrics (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      date DATE NOT NULL,
      volatility REAL,
      sharpe_ratio REAL,
      sortino_ratio REAL,
      max_drawdown REAL,
      beta REAL,
      alpha REAL,
      var_95 REAL,
      cvar_95 REAL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`,
    
    // User settings
    `CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT PRIMARY KEY,
      theme TEXT DEFAULT 'light',
      currency TEXT DEFAULT 'USD',
      language TEXT DEFAULT 'en',
      data_refresh_interval INTEGER DEFAULT 60000,
      notifications_portfolio BOOLEAN DEFAULT true,
      notifications_price_alerts BOOLEAN DEFAULT true,
      notifications_risk_alerts BOOLEAN DEFAULT true,
      notifications_email BOOLEAN DEFAULT true,
      notifications_push BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`,
    
    // Price alerts
    `CREATE TABLE IF NOT EXISTS price_alerts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      price_target REAL NOT NULL,
      alert_type TEXT NOT NULL,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      triggered_at TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`,
    
    // Transaction history
    `CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      transaction_type TEXT NOT NULL,
      quantity REAL NOT NULL,
      price REAL NOT NULL,
      fees REAL DEFAULT 0,
      date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`,
    
    // Optimization results
    `CREATE TABLE IF NOT EXISTS optimization_results (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      optimization_params TEXT,
      estimation_methods TEXT,
      portfolio_weights TEXT,
      expected_return REAL,
      expected_risk REAL,
      sharpe_ratio REAL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`,
    
    // Analytics events
    `CREATE TABLE IF NOT EXISTS analytics_events (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      event_type TEXT NOT NULL,
      event_data TEXT,
      ip_address TEXT,
      user_agent TEXT,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    )`,
    
    // Mutual funds data
    `CREATE TABLE IF NOT EXISTS mutual_funds (
      symbol TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      fund_family TEXT,
      category TEXT,
      risk_level TEXT,
      expense_ratio REAL,
      min_investment REAL,
      inception_date DATE,
      aum REAL,
      yield REAL,
      ytd_return REAL,
      one_year_return REAL,
      three_year_return REAL,
      five_year_return REAL,
      last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    
    // Watchlist
    `CREATE TABLE IF NOT EXISTS watchlist (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`
  ];

  // Execute all table creation queries
  for (const query of tableQueries) {
    await pool.query(query);
  }
  
  // Create indexes
  const indexQueries = [
    'CREATE INDEX IF NOT EXISTS idx_holdings_user ON portfolio_holdings(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_performance_user_date ON portfolio_performance(user_id, date)',
    'CREATE INDEX IF NOT EXISTS idx_risk_metrics_user ON risk_metrics(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_transactions_symbol ON transactions(symbol)',
    'CREATE INDEX IF NOT EXISTS idx_price_alerts_user ON price_alerts(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_price_alerts_symbol ON price_alerts(symbol)',
    'CREATE INDEX IF NOT EXISTS idx_analytics_user ON analytics_events(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_analytics_event_type ON analytics_events(event_type)',
    'CREATE INDEX IF NOT EXISTS idx_optimization_user ON optimization_results(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_watchlist_user ON watchlist(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_watchlist_symbol ON watchlist(symbol)'
  ];
  
  // Execute all index creation queries
  for (const query of indexQueries) {
    await pool.query(query);
  }
  
  console.log('Tables and indexes created or already exist');
}

// Run database migrations
async function runMigrations() {
  try {
    // Add purchase_price column if not exists
    await pool.query(
      `ALTER TABLE portfolio_holdings ADD COLUMN IF NOT EXISTS purchase_price REAL`
    );
    await pool.query(
      `UPDATE portfolio_holdings SET purchase_price = average_cost WHERE purchase_price IS NULL`
    );
    
    // Add asset_type column if not exists
    await pool.query(
      `ALTER TABLE portfolio_holdings ADD COLUMN IF NOT EXISTS asset_type TEXT`
    );
    await pool.query(
      `UPDATE portfolio_holdings SET asset_type = 'Stock' WHERE asset_type IS NULL`
    );
    
    // Add UNIQUE constraint to portfolio_performance if it doesn't exist
    try {
      // Check if the constraint already exists
      const constraintCheck = await pool.query(
        `SELECT constraint_name
         FROM information_schema.table_constraints
         WHERE table_name = 'portfolio_performance'
         AND constraint_type = 'UNIQUE'
         AND constraint_name = 'portfolio_performance_user_date_key'`
      );
      
      if (constraintCheck.rows.length === 0) {
        // Add the constraint if it doesn't exist
        await pool.query(
          `ALTER TABLE portfolio_performance ADD CONSTRAINT portfolio_performance_user_date_key UNIQUE (user_id, date)`
        );
        console.log('Added unique constraint to portfolio_performance table');
      }
    } catch (constraintError) {
      console.warn('Error adding unique constraint to portfolio_performance:', constraintError.message);
      // Not critical if this fails
    }
    
    // Add new optimization_results columns
    await pool.query(
      `ALTER TABLE optimization_results ADD COLUMN IF NOT EXISTS estimation_methods TEXT`
    );
    
    console.log('Database migrations completed successfully');
  } catch (error) {
    console.error('Error running migrations:', error);
  }
}

// Create a test user for development
async function createTestUser() {
  try {
    // Check if test user already exists
    const userExists = await pool.query('SELECT id FROM users WHERE email = $1', ['test@example.com']);
    
    if (userExists.rows.length === 0) {
      // Create test user
      const userId = uuidv4();
      const hashedPassword = await bcrypt.hash('password123', 10);
      
      await pool.query(
        'INSERT INTO users (id, email, password_hash, name, role) VALUES ($1, $2, $3, $4, $5)',
        [userId, 'test@example.com', hashedPassword, 'Test User', 'user']
      );
      
      // Create user settings
      await pool.query(
        'INSERT INTO user_settings (user_id) VALUES ($1)',
        [userId]
      );
      
      console.log('Test user created');
    }
  } catch (error) {
    console.error('Error creating test user:', error);
  }
}

function getDatabase() {
  return pool;
}

module.exports = {
  initializeDatabase,
  getDatabase
};
