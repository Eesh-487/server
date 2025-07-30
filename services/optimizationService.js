const { getDatabase } = require('../database/init');

async function runOptimization(userId, options) {
  const { method, risk_tolerance, max_position_size, constraints } = options;
  
  // Get current portfolio
  const db = getDatabase();
  const holdings = await new Promise((resolve, reject) => {
    db.all(
      `SELECT h.*, m.price as current_price
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

  // Fetch historical price data for all holdings
  const { getHistoricalData } = require('./marketDataService');
  const priceHistories = {};
  for (const holding of holdings) {
    priceHistories[holding.symbol] = await getHistoricalData(holding.symbol, '1y', '1d');
  }

  // Calculate expected returns and volatility for each symbol
  const returns = [];
  const volatilities = [];
  const symbols = holdings.map(h => h.symbol);
  for (const symbol of symbols) {
    const history = priceHistories[symbol];
    if (history && history.length > 1) {
      let totalReturn = 0;
      let dailyReturns = [];
      for (let i = 1; i < history.length; i++) {
        const ret = (history[i].close - history[i-1].close) / history[i-1].close;
        totalReturn += ret;
        dailyReturns.push(ret);
      }
      const avgReturn = totalReturn / (history.length - 1);
      // Calculate volatility (standard deviation of daily returns)
      const mean = avgReturn;
      const variance = dailyReturns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / dailyReturns.length;
      const volatility = Math.sqrt(variance);
      returns.push(avgReturn);
      volatilities.push(volatility);
    } else {
      returns.push(0);
      volatilities.push(0.01); // small default volatility
    }
  }

  // Risk-adjusted return (Sharpe-like, no risk-free rate)
  let riskAdjustedReturns = returns.map((ret, i) => volatilities[i] > 0 ? ret / volatilities[i] : 0);
  // If all are zero, fallback to equal weights
  const sumRiskAdj = riskAdjustedReturns.reduce((sum, r) => sum + r, 0);
  let optimizedAllocation = {};
  if (sumRiskAdj > 0) {
    for (let i = 0; i < symbols.length; i++) {
      optimizedAllocation[symbols[i]] = (riskAdjustedReturns[i] / sumRiskAdj) * 100;
    }
  } else {
    for (let i = 0; i < symbols.length; i++) {
      optimizedAllocation[symbols[i]] = (1 / symbols.length) * 100;
    }
  }

  // Calculate current allocation
  const currentAllocation = calculateCurrentAllocation(holdings);

  // Calculate expected improvements (mocked)
  const improvements = calculateImprovements(currentAllocation, optimizedAllocation, method);

  return {
    method,
    risk_tolerance,
    current_allocation: currentAllocation,
    optimized_allocation: optimizedAllocation,
    expected_return: improvements.expected_return,
    expected_volatility: improvements.expected_volatility,
    sharpe_improvement: improvements.sharpe_improvement,
    implementation_plan: generateImplementationPlan(currentAllocation, optimizedAllocation)
  };
}

function calculateCurrentAllocation(holdings) {
  const totalValue = holdings.reduce((sum, holding) => {
    const price = holding.current_price || holding.average_cost;
    return sum + (holding.quantity * price);
  }, 0);

  // Group by category
  const categoryMap = new Map();
  holdings.forEach(holding => {
    const price = holding.current_price || holding.average_cost;
    const value = holding.quantity * price;
    
    if (categoryMap.has(holding.category)) {
      categoryMap.set(holding.category, categoryMap.get(holding.category) + value);
    } else {
      categoryMap.set(holding.category, value);
    }
  });

  return Array.from(categoryMap, ([name, value]) => ({
    name,
    value,
    percentage: totalValue > 0 ? (value / totalValue) * 100 : 0
  }));
}

function meanVarianceOptimization(currentAllocation, riskTolerance, maxPosition) {
  // Simplified mean-variance optimization
  // In production, this would use complex mathematical optimization
  
  const targetAllocations = {
    'Technology': Math.min(25 + (riskTolerance - 50) * 0.2, maxPosition),
    'Healthcare': Math.min(20 + (riskTolerance - 50) * 0.1, maxPosition),
    'Financials': Math.min(18 + (riskTolerance - 50) * 0.15, maxPosition),
    'Consumer Discretionary': Math.min(15 + (riskTolerance - 50) * 0.1, maxPosition),
    'Consumer Staples': Math.min(8 - (riskTolerance - 50) * 0.1, maxPosition),
    'Energy': Math.min(6 + (riskTolerance - 50) * 0.05, maxPosition),
    'Utilities': Math.min(4 - (riskTolerance - 50) * 0.05, maxPosition),
    'Fixed Income': Math.min(4 - (riskTolerance - 50) * 0.08, maxPosition)
  };

  return normalizeAllocation(targetAllocations, currentAllocation);
}

function blackLittermanOptimization(currentAllocation, riskTolerance, maxPosition) {
  // Simplified Black-Litterman model
  // Incorporates market equilibrium with investor views
  
  const marketEquilibrium = {
    'Technology': 28,
    'Healthcare': 22,
    'Financials': 16,
    'Consumer Discretionary': 14,
    'Consumer Staples': 8,
    'Energy': 5,
    'Utilities': 4,
    'Fixed Income': 3
  };

  // Adjust based on risk tolerance
  const targetAllocations = {};
  Object.keys(marketEquilibrium).forEach(sector => {
    const adjustment = (riskTolerance - 50) * 0.1;
    targetAllocations[sector] = Math.min(
      Math.max(marketEquilibrium[sector] + adjustment, 0),
      maxPosition
    );
  });

  return normalizeAllocation(targetAllocations, currentAllocation);
}

function riskParityOptimization(currentAllocation, maxPosition) {
  // Risk parity - equal risk contribution from all assets
  const sectors = ['Technology', 'Healthcare', 'Financials', 'Consumer Discretionary', 
                  'Consumer Staples', 'Energy', 'Utilities', 'Fixed Income'];
  
  const equalWeight = 100 / sectors.length;
  const targetAllocations = {};
  
  sectors.forEach(sector => {
    targetAllocations[sector] = Math.min(equalWeight, maxPosition);
  });

  return normalizeAllocation(targetAllocations, currentAllocation);
}

function minVolatilityOptimization(currentAllocation, maxPosition) {
  // Minimize portfolio volatility
  const lowVolatilitySectors = {
    'Utilities': 25,
    'Consumer Staples': 20,
    'Healthcare': 18,
    'Fixed Income': 15,
    'Financials': 12,
    'Technology': 8,
    'Energy': 2,
    'Consumer Discretionary': 0
  };

  const targetAllocations = {};
  Object.keys(lowVolatilitySectors).forEach(sector => {
    targetAllocations[sector] = Math.min(lowVolatilitySectors[sector], maxPosition);
  });

  return normalizeAllocation(targetAllocations, currentAllocation);
}

function maxSharpeOptimization(currentAllocation, riskTolerance, maxPosition) {
  // Maximize Sharpe ratio
  const highSharpeSectors = {
    'Technology': 30,
    'Healthcare': 25,
    'Consumer Discretionary': 20,
    'Financials': 15,
    'Energy': 5,
    'Consumer Staples': 3,
    'Utilities': 2,
    'Fixed Income': 0
  };

  const targetAllocations = {};
  Object.keys(highSharpeSectors).forEach(sector => {
    targetAllocations[sector] = Math.min(highSharpeSectors[sector], maxPosition);
  });

  return normalizeAllocation(targetAllocations, currentAllocation);
}

function normalizeAllocation(targetAllocations, currentAllocation) {
  // Ensure allocations sum to 100%
  const total = Object.values(targetAllocations).reduce((sum, val) => sum + val, 0);
  const scaleFactor = 100 / total;

  const optimized = [];
  
  Object.keys(targetAllocations).forEach(sector => {
    const targetPercentage = targetAllocations[sector] * scaleFactor;
    const currentItem = currentAllocation.find(item => item.name === sector);
    const currentPercentage = currentItem ? currentItem.percentage : 0;
    const change = targetPercentage - currentPercentage;

    optimized.push({
      name: sector,
      percentage: targetPercentage,
      change: change
    });
  });

  // Add any existing sectors not in target
  currentAllocation.forEach(item => {
    if (!targetAllocations[item.name]) {
      optimized.push({
        name: item.name,
        percentage: 0,
        change: -item.percentage
      });
    }
  });

  return optimized.sort((a, b) => b.percentage - a.percentage);
}

function calculateImprovements(currentAllocation, optimizedAllocation, method) {
  // Mock improvement calculations
  // In production, these would be based on historical data and complex models
  
  const improvements = {
    'mean-variance': { return: 1.8, volatility: -2.2, sharpe: 0.24 },
    'black-litterman': { return: 1.5, volatility: -1.8, sharpe: 0.19 },
    'risk-parity': { return: 0.8, volatility: -3.1, sharpe: 0.31 },
    'min-volatility': { return: -0.5, volatility: -4.2, sharpe: 0.18 },
    'max-sharpe': { return: 2.3, volatility: -1.2, sharpe: 0.35 }
  };

  const improvement = improvements[method] || improvements['mean-variance'];
  
  return {
    expected_return: improvement.return,
    expected_volatility: improvement.volatility,
    sharpe_improvement: improvement.sharpe
  };
}

function generateImplementationPlan(currentAllocation, optimizedAllocation) {
  const trades = [];
  
  optimizedAllocation.forEach(optimized => {
    if (Math.abs(optimized.change) > 1) { // Only include significant changes
      const action = optimized.change > 0 ? 'BUY' : 'SELL';
      const amount = Math.abs(optimized.change);
      
      trades.push({
        sector: optimized.name,
        action,
        change_percent: optimized.change,
        priority: Math.abs(optimized.change) > 5 ? 'HIGH' : 'MEDIUM'
      });
    }
  });

  return trades.sort((a, b) => Math.abs(b.change_percent) - Math.abs(a.change_percent));
}

async function getOptimizationHistory(userId, limit = 10) {
  const db = getDatabase();
  
  const history = await new Promise((resolve, reject) => {
    db.all(
      `SELECT id, method, risk_tolerance, expected_return, expected_volatility, 
              sharpe_improvement, created_at
       FROM optimization_results 
       WHERE user_id = ? 
       ORDER BY created_at DESC 
       LIMIT ?`,
      [userId, limit],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      }
    );
  });

  return history;
}

module.exports = {
  runOptimization,
  getOptimizationHistory
};