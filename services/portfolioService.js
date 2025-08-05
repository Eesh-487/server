const { getDatabase } = require('../database/init');
const { getMarketData } = require('./marketDataService');

async function calculatePortfolioMetrics(userId) {
  const db = getDatabase();
  
  module.exports = {
  calculatePortfolioMetrics,
  calculateAllocation,
  updatePortfolioPerformance,
  getPortfolioHistory,
  getTopHoldings,
  populatePortfolioPerformanceFromHistory
};
  const holdingsResult = await db.query(
    `SELECT h.*, m.price as current_price, m.change_percent
       FROM portfolio_holdings h 
       LEFT JOIN market_data m ON h.symbol = m.symbol 
       WHERE h.user_id = $1`,
    [userId]
  );
  const holdings = holdingsResult.rows;

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
  
  const allocationResult = await db.query(
    `SELECT 
         h.category,
         SUM(h.quantity * COALESCE(m.price, h.average_cost)) as value,
         COUNT(*) as holdings_count
       FROM portfolio_holdings h 
       LEFT JOIN market_data m ON h.symbol = m.symbol 
       WHERE h.user_id = $1 
       GROUP BY h.category
       ORDER BY value DESC`,
    [userId]
  );
  const allocation = allocationResult.rows;

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
  try {
    const metrics = await calculatePortfolioMetrics(userId);
    const db = getDatabase();
    
    // Get yesterday's performance for comparison
    const yesterdayResult = await db.query(
      `SELECT total_value, cumulative_return 
         FROM portfolio_performance 
         WHERE user_id = $1 AND date = CURRENT_DATE - INTERVAL '1 day'
         ORDER BY date DESC
         LIMIT 1`,
      [userId]
    );
    const yesterday = yesterdayResult.rows[0];
    
    const dailyReturn = yesterday && yesterday.total_value > 0 ? 
      ((metrics.total_value - yesterday.total_value) / yesterday.total_value) * 100 : 0;
    
    const cumulativeReturn = metrics.total_cost > 0 ? 
      ((metrics.total_value - metrics.total_cost) / metrics.total_cost) * 100 : 0;

    // Get current date in YYYY-MM-DD format
    const today = new Date();
    const dateString = today.toISOString().split('T')[0];

    // Mock benchmark return (S&P 500)
    const benchmarkReturn = (Math.random() - 0.5) * 2; // ±1% daily

    const performanceId = require('uuid').v4();
    
    // Check if we already have an entry for today
    const todayResult = await db.query(
      `SELECT id FROM portfolio_performance 
       WHERE user_id = $1 AND date = CURRENT_DATE`,
      [userId]
    );
    
    if (todayResult.rows.length > 0) {
      // Update existing record
      await db.query(
        `UPDATE portfolio_performance 
         SET total_value = $1, daily_return = $2, cumulative_return = $3, benchmark_return = $4
         WHERE id = $5`,
        [metrics.total_value, dailyReturn, cumulativeReturn, benchmarkReturn, todayResult.rows[0].id]
      );
    } else {
      // Insert new record
      await db.query(
        `INSERT INTO portfolio_performance 
         (id, user_id, date, total_value, daily_return, cumulative_return, benchmark_return) 
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [performanceId, userId, dateString, metrics.total_value, dailyReturn, cumulativeReturn, benchmarkReturn]
      );
    }

    console.log(`Updated performance data for user ${userId}: value=${metrics.total_value}, dailyReturn=${dailyReturn}, cumulativeReturn=${cumulativeReturn}`);

    // Also check if we need to populate historical data
    const historyCount = await db.query(
      `SELECT COUNT(*) as count FROM portfolio_performance WHERE user_id = $1`,
      [userId]
    );
    
    if (historyCount.rows[0].count <= 1) {
      // We only have today's record, populate historical data
      try {
        await populatePortfolioPerformanceFromHistory(userId, '3m', '1d');
      } catch (populateError) {
        console.error('Error populating performance history:', populateError);
      }
    }

    return {
      ...metrics,
      daily_return: dailyReturn,
      cumulative_return: cumulativeReturn,
      benchmark_return: benchmarkReturn
    };
  } catch (error) {
    console.error('Error updating portfolio performance:', error);
    // Return the metrics even if we couldn't save to the database
    return metrics;
  }
}

// Populate portfolio performance history using Yahoo Finance historical data for all holdings
async function populatePortfolioPerformanceFromHistory(userId, period = '1y', interval = '1d') {
  try {
    const db = getDatabase();
    
    // Get all holdings for the user
    const holdingsResult = await db.query(
      `SELECT symbol, quantity, average_cost FROM portfolio_holdings WHERE user_id = $1`,
      [userId]
    );
    const holdings = holdingsResult.rows;
    
    if (!holdings.length) {
      console.log(`No holdings found for user ${userId}, skipping performance history population`);
      return;
    }

    console.log(`Populating performance history for user ${userId} with ${holdings.length} holdings`);

    // For each holding, fetch historical prices
    const historyBySymbol = {};
    for (const holding of holdings) {
      if (holding.symbol) {
        const history = await getHistoricalData(holding.symbol, period, interval);
        historyBySymbol[holding.symbol] = history;
      }
    }

    // Build daily portfolio value history
    // Collect all unique dates
    const dateSet = new Set();
    Object.values(historyBySymbol).forEach(histArr => {
      if (Array.isArray(histArr)) {
        histArr.forEach(h => dateSet.add(h.date));
      }
    });
    
    const dates = Array.from(dateSet).sort();
    if (dates.length === 0) {
      console.log(`No historical data available for holdings, skipping performance history population`);
      return;
    }

    console.log(`Processing ${dates.length} days of historical data`);

    let prevValue = null;
    let initialValue = null;
    
    // Process each date
    for (let i = 0; i < dates.length; i++) {
      const date = dates[i];
      let totalValue = 0;
      
      // Calculate total portfolio value for this date
      for (const holding of holdings) {
        if (holding.symbol && historyBySymbol[holding.symbol]) {
          const histArr = historyBySymbol[holding.symbol];
          const day = histArr.find(h => h.date === date);
          const price = day ? day.close : holding.average_cost;
          totalValue += holding.quantity * price;
        } else {
          // For holdings without symbols or historical data
          totalValue += holding.quantity * holding.average_cost;
        }
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
      
      // Insert performance record with PostgreSQL syntax
      await db.query(
        `INSERT INTO portfolio_performance 
         (id, user_id, date, total_value, daily_return, cumulative_return, benchmark_return) 
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_id, date) 
         DO UPDATE SET 
           total_value = $4, 
           daily_return = $5, 
           cumulative_return = $6, 
           benchmark_return = $7`,
        [performanceId, userId, date, totalValue, dailyReturn, cumulativeReturn, benchmarkReturn]
      );
      
      prevValue = totalValue;
    }
    
    console.log(`Successfully populated performance history for user ${userId}`);
  } catch (error) {
    console.error(`Error populating portfolio performance history:`, error);
  }
}

async function getPortfolioHistory(userId, days = 90) {
  try {
    const db = getDatabase();
    
    const historyResult = await db.query(
      `SELECT date, total_value, daily_return, cumulative_return, benchmark_return
       FROM portfolio_performance 
       WHERE user_id = $1 
       AND date >= CURRENT_DATE - INTERVAL '$2 days'
       ORDER BY date ASC`,
      [userId, days]
    );
    
    return historyResult.rows;
  } catch (error) {
    console.error(`Error getting portfolio history:`, error);
    return [];
  }
}

function getColorForIndex(index) {
  const colors = [
    '#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', 
    '#EC4899', '#06B6D4', '#84CC16', '#F97316'
  ];
  return colors[index % colors.length];
}

async function getTopHoldings(userId, limit = 10) {
  try {
    const db = getDatabase();
    
    const topHoldingsResult = await db.query(
      `SELECT h.*, m.price as current_price, m.change_percent,
              (h.quantity * COALESCE(m.price, h.average_cost)) as value
       FROM portfolio_holdings h 
       LEFT JOIN market_data m ON h.symbol = m.symbol 
       WHERE h.user_id = $1
       ORDER BY value DESC
       LIMIT $2`,
      [userId, limit]
    );
    
    return topHoldingsResult.rows;
  } catch (error) {
    console.error(`Error getting top holdings:`, error);
    return [];
  }
}