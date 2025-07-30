const { getDatabase } = require('../database/init');
const { getMarketData } = require('./marketDataService');

async function calculatePortfolioMetrics(userId) {
  const db = getDatabase();
  
  // Get portfolio holdings with current market data
  const holdings = await new Promise((resolve, reject) => {
    db.all(
      `SELECT h.*, m.price as current_price, m.change_percent
       FROM portfolio_holdings h 
       LEFT JOIN market_data m ON h.symbol = m.symbol 
       WHERE h.user_id = ?`,
      [userId],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      }
    );
  });

  if (holdings.length === 0) {
    return {
      total_value: 0,
      daily_pnl: 0,
      daily_pnl_percent: 0,
      total_cost: 0,
      unrealized_pnl: 0,
      unrealized_pnl_percent: 0,
      holdings_count: 0
    };
  }

  let totalValue = 0;
  let totalCost = 0;
  let dailyPnL = 0;

  holdings.forEach(holding => {
    const currentPrice = holding.current_price || holding.average_cost;
    const positionValue = holding.quantity * currentPrice;
    const positionCost = holding.quantity * holding.average_cost;
    
    totalValue += positionValue;
    totalCost += positionCost;
    
    // Calculate daily P&L based on price change
    if (holding.change_percent) {
      const dailyChange = positionValue * (holding.change_percent / 100);
      dailyPnL += dailyChange;
    }
  });

  const unrealizedPnL = totalValue - totalCost;
  const unrealizedPnLPercent = totalCost > 0 ? (unrealizedPnL / totalCost) * 100 : 0;
  const dailyPnLPercent = totalValue > 0 ? (dailyPnL / totalValue) * 100 : 0;

  return {
    total_value: totalValue,
    daily_pnl: dailyPnL,
    daily_pnl_percent: dailyPnLPercent,
    total_cost: totalCost,
    unrealized_pnl: unrealizedPnL,
    unrealized_pnl_percent: unrealizedPnLPercent,
    holdings_count: holdings.length
  };
}

async function calculateAllocation(userId) {
  const db = getDatabase();
  
  const allocation = await new Promise((resolve, reject) => {
    db.all(
      `SELECT 
         h.category,
         SUM(h.quantity * COALESCE(m.price, h.average_cost)) as value,
         COUNT(*) as holdings_count
       FROM portfolio_holdings h 
       LEFT JOIN market_data m ON h.symbol = m.symbol 
       WHERE h.user_id = ? 
       GROUP BY h.category
       ORDER BY value DESC`,
      [userId],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      }
    );
  });

  const totalValue = allocation.reduce((sum, cat) => sum + cat.value, 0);
  
  return allocation.map((cat, index) => ({
    category: cat.category,
    value: cat.value,
    percentage: totalValue > 0 ? (cat.value / totalValue) * 100 : 0,
    holdings_count: cat.holdings_count,
    color: getColorForIndex(index)
  }));
}

async function updatePortfolioPerformance(userId) {
  const metrics = await calculatePortfolioMetrics(userId);
  const db = getDatabase();
  
  // Get yesterday's performance for comparison
  const yesterday = await new Promise((resolve, reject) => {
    db.get(
      `SELECT total_value, cumulative_return 
       FROM portfolio_performance 
       WHERE user_id = ? AND date = date('now', '-1 day')`,
      [userId],
      (err, row) => {
        if (err) reject(err);
        else resolve(row);
      }
    );
  });
  
// Populate portfolio performance history using Yahoo Finance historical data for all holdings
const { getHistoricalData } = require('./marketDataService');

async function populatePortfolioPerformanceFromHistory(userId, period = '1y', interval = '1d') {
  const db = getDatabase();
  // Get all holdings for the user
  const holdings = await new Promise((resolve, reject) => {
    db.all(
      `SELECT symbol, quantity, average_cost FROM portfolio_holdings WHERE user_id = ?`,
      [userId],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      }
    );
  });
  if (!holdings.length) return;

  // For each holding, fetch historical prices
  const historyBySymbol = {};
  for (const holding of holdings) {
    const history = await getHistoricalData(holding.symbol, period, interval);
    historyBySymbol[holding.symbol] = history;
  }

  // Build daily portfolio value history
  // Assume all holdings held throughout the period
  const dateSet = new Set();
  Object.values(historyBySymbol).forEach(histArr => histArr.forEach(h => dateSet.add(h.date)));
  const dates = Array.from(dateSet).sort();

  let prevValue = null;
  let initialValue = null;
  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    let totalValue = 0;
    for (const holding of holdings) {
      const histArr = historyBySymbol[holding.symbol];
      const day = histArr.find(h => h.date === date);
      const price = day ? day.close : holding.average_cost;
      totalValue += holding.quantity * price;
    }
    if (i === 0) initialValue = totalValue;
    // Calculate daily return
    let dailyReturn = 0;
    if (prevValue !== null && prevValue > 0) {
      dailyReturn = ((totalValue - prevValue) / prevValue) * 100;
    }
    // Calculate cumulative return
    let cumulativeReturn = 0;
    if (initialValue && initialValue > 0) {
      cumulativeReturn = ((totalValue - initialValue) / initialValue) * 100;
    }
    // Mock benchmark return (can be improved)
    const benchmarkReturn = (Math.random() - 0.5) * 2;
    const performanceId = require('uuid').v4();
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT OR REPLACE INTO portfolio_performance 
         (id, user_id, date, total_value, daily_return, cumulative_return, benchmark_return) 
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [performanceId, userId, date, totalValue, dailyReturn, cumulativeReturn, benchmarkReturn],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
    prevValue = totalValue;
  }
}

  const dailyReturn = yesterday ? 
    ((metrics.total_value - yesterday.total_value) / yesterday.total_value) * 100 : 0;
  
  const cumulativeReturn = metrics.total_cost > 0 ? 
    ((metrics.total_value - metrics.total_cost) / metrics.total_cost) * 100 : 0;

  // Mock benchmark return (S&P 500)
  const benchmarkReturn = (Math.random() - 0.5) * 2; // ±1% daily

  const performanceId = require('uuid').v4();
  
  await new Promise((resolve, reject) => {
    db.run(
      `INSERT OR REPLACE INTO portfolio_performance 
       (id, user_id, date, total_value, daily_return, cumulative_return, benchmark_return) 
       VALUES (?, ?, date('now'), ?, ?, ?, ?)`,
      [performanceId, userId, metrics.total_value, dailyReturn, cumulativeReturn, benchmarkReturn],
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });

  return {
    ...metrics,
    daily_return: dailyReturn,
    cumulative_return: cumulativeReturn,
    benchmark_return: benchmarkReturn
  };
}

async function getPortfolioHistory(userId, days = 90) {
  const db = getDatabase();
  
  const history = await new Promise((resolve, reject) => {
    db.all(
      `SELECT date, total_value, daily_return, cumulative_return, benchmark_return
       FROM portfolio_performance 
       WHERE user_id = ? 
       AND date >= date('now', '-' || ? || ' days')
       ORDER BY date ASC`,
      [userId, days],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      }
    );
  });

  return history;
}

async function getTopHoldings(userId, limit = 10) {
  const db = getDatabase();
  
  const topHoldings = await new Promise((resolve, reject) => {
    db.all(
      `SELECT h.*, m.price as current_price, m.change_percent,
              (h.quantity * COALESCE(m.price, h.average_cost)) as value
       FROM portfolio_holdings h 
       LEFT JOIN market_data m ON h.symbol = m.symbol 
       WHERE h.user_id = ?
       ORDER BY value DESC
       LIMIT ?`,
      [userId, limit],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      }
    );
  });

  return topHoldings;
}

function getColorForIndex(index) {
  const colors = [
    '#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', 
    '#EC4899', '#06B6D4', '#84CC16', '#F97316'
  ];
  return colors[index % colors.length];
}

module.exports = {
  calculatePortfolioMetrics,
  calculateAllocation,
  updatePortfolioPerformance,
  getPortfolioHistory,
  getTopHoldings
};