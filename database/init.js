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
  console.log('PostgreSQL database initialized');
}

async function createTables() {
  const tables = [
    // Users table
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT DEFAULT 'user',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,

    // User settings
    `CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT PRIMARY KEY,
      theme TEXT DEFAULT 'light',
      currency TEXT DEFAULT 'INR',
      language TEXT DEFAULT 'en-IN',
      data_refresh_interval INTEGER DEFAULT 5,
      notifications_portfolio BOOLEAN DEFAULT TRUE,
      notifications_price_alerts BOOLEAN DEFAULT TRUE,
      notifications_risk_alerts BOOLEAN DEFAULT TRUE,
      notifications_email BOOLEAN DEFAULT FALSE,
      notifications_push BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id)
    )`,

    // Portfolio holdings
    `CREATE TABLE IF NOT EXISTS portfolio_holdings (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      quantity REAL NOT NULL,
      average_cost REAL NOT NULL,
      purchase_price REAL,
      current_price REAL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id)
    )`,

    // Market data
    `CREATE TABLE IF NOT EXISTS market_data (
      id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL UNIQUE,
      name TEXT,
      price REAL NOT NULL,
      change_percent REAL,
      change_amount REAL,
      volume BIGINT,
      market_cap BIGINT,
      sector TEXT,
      industry TEXT,
      currency TEXT DEFAULT 'INR',
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
      FOREIGN KEY (user_id) REFERENCES users (id)
    )`,

    // Risk metrics
    `CREATE TABLE IF NOT EXISTS risk_metrics (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      date DATE NOT NULL,
      var_95 REAL,
      var_99 REAL,
      cvar_95 REAL,
      cvar_99 REAL,
      volatility REAL,
      beta REAL,
      sharpe_ratio REAL,
      max_drawdown REAL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id)
    )`,

    // Optimization results
    `CREATE TABLE IF NOT EXISTS optimization_results (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      method TEXT NOT NULL,
      risk_tolerance REAL NOT NULL,
      current_allocation TEXT NOT NULL,
      optimized_allocation TEXT NOT NULL,
      expected_return REAL,
      expected_volatility REAL,
      sharpe_improvement REAL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id)
    )`,

    // Analytics events
    `CREATE TABLE IF NOT EXISTS analytics_events (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      event_type TEXT NOT NULL,
      event_data TEXT,
      ip_address TEXT,
      user_agent TEXT,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,

    // Notifications
    `CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      read BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id)
    )`,

    // Watchlist
    `CREATE TABLE IF NOT EXISTS watchlist (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id),
      UNIQUE(user_id, symbol)
    )`
  ];

  for (const table of tables) {
    await pool.query(table);
  }

  // Create indexes
  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_portfolio_user_id ON portfolio_holdings(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_market_data_symbol ON market_data(symbol)',
    'CREATE INDEX IF NOT EXISTS idx_performance_user_date ON portfolio_performance(user_id, date)',
    'CREATE INDEX IF NOT EXISTS idx_risk_user_date ON risk_metrics(user_id, date)',
    'CREATE INDEX IF NOT EXISTS idx_analytics_user_type ON analytics_events(user_id, event_type)',
    'CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read)'
  ];

  for (const index of indexes) {
    await pool.query(index);
  }

  console.log('Database tables created successfully');
}

async function runMigrations() {
  // Example migration: Add purchase_price column if not exists (Postgres syntax)
  try {
    await pool.query(
      `ALTER TABLE portfolio_holdings ADD COLUMN IF NOT EXISTS purchase_price REAL`
    );
    await pool.query(
      `UPDATE portfolio_holdings SET purchase_price = average_cost WHERE purchase_price IS NULL`
    );
    // Run custom migration for market_data fixes
    const fs = require('fs');
    const path = require('path');
    const migrationPath = path.join(__dirname, 'migrations', '2025-07-31-fix-market-data.sql');
    if (fs.existsSync(migrationPath)) {
      const migrationSQL = fs.readFileSync(migrationPath, 'utf8');
      for (const statement of migrationSQL.split(';')) {
        if (statement.trim()) {
          await pool.query(statement);
        }
      }
      console.log('Market data migration applied');
    }
    console.log('Migrations completed');
  } catch (error) {
    console.log('Migration error:', error.message);
  }
}

async function createTestUser() {
  // Check if test user exists
  const res = await pool.query('SELECT id FROM users WHERE email = $1', ['test@example.com']);
  if (res.rows.length === 0) {
    const testUserId = 'test-user-1';
    const passwordHash = await bcrypt.hash('test123', 12);
    await pool.query(
      'INSERT INTO users (id, email, password_hash, name, role) VALUES ($1, $2, $3, $4, $5)',
      [testUserId, 'test@example.com', passwordHash, 'Test User', 'user']
    );
    console.log('Test user created: email=test@example.com, password=test123');
  }
}

function getDatabase() {
  return pool;
}

module.exports = {
  initializeDatabase,
  getDatabase
};