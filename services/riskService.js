const { getDatabase } = require('../database/init');
const { calculatePortfolioMetrics } = require('./portfolioService');

async function calculateRiskMetrics(userId, confidenceLevel = 95, timeHorizon = 1) {
  const db = getDatabase();
  
  // Get portfolio holdings
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
      var: 0,
      cvar: 0,
      volatility: 0,
      beta: 1,
      sharpe_ratio: 0,
      max_drawdown: 0
    };
  }

  // Calculate portfolio value
  const totalValue = holdings.reduce((sum, holding) => {
    const price = holding.current_price || holding.average_cost;
    return sum + (holding.quantity * price);
  }, 0);

  // Calculate VaR using historical simulation method (simplified)
  const var95 = calculateVaR(holdings, totalValue, 95, timeHorizon);
  const var99 = calculateVaR(holdings, totalValue, 99, timeHorizon);
  
  // Calculate CVaR (Expected Shortfall)
  const cvar95 = var95 * 1.5; // Simplified calculation
  const cvar99 = var99 * 1.5;

  // Calculate portfolio volatility
  const volatility = calculateVolatility(holdings);

  // Calculate beta (simplified - using sector betas)
  const beta = calculateBeta(holdings);

  // Calculate Sharpe ratio (simplified)
  const riskFreeRate = 0.02; // 2% risk-free rate
  const expectedReturn = 0.08; // 8% expected return
  const sharpeRatio = (expectedReturn - riskFreeRate) / (volatility / 100);

  // Calculate max drawdown (mock calculation)
  const maxDrawdown = -8.3; // Would be calculated from historical performance

  const riskMetrics = {
    var_95: var95,
    var_99: var99,
    cvar_95: cvar95,
    cvar_99: cvar99,
    volatility,
    beta,
    sharpe_ratio: sharpeRatio,
    max_drawdown: maxDrawdown,
    confidence_level: confidenceLevel,
    time_horizon: timeHorizon
  };

  // Save to database
  await saveRiskMetrics(userId, riskMetrics);

  return riskMetrics;
}

function calculateVaR(holdings, totalValue, confidenceLevel, timeHorizon) {
  // Simplified VaR calculation using parametric method
  // In production, this would use historical returns or Monte Carlo simulation
  
  const portfolioVolatility = calculateVolatility(holdings);
  const zScore = confidenceLevel === 95 ? 1.645 : 2.326; // Z-scores for 95% and 99%
  
  const dailyVaR = totalValue * (portfolioVolatility / 100) * zScore / Math.sqrt(252); // 252 trading days
  const adjustedVaR = dailyVaR * Math.sqrt(timeHorizon);
  
  return adjustedVaR;
}

function calculateVolatility(holdings) {
  // Simplified volatility calculation based on sector volatilities
  const sectorVolatilities = {
    'Technology': 25,
    'Healthcare': 18,
    'Financials': 22,
    'Consumer Discretionary': 20,
    'Consumer Staples': 12,
    'Energy': 30,
    'Utilities': 15,
    'Telecommunications': 16,
    'Materials': 24,
    'Industrials': 19
  };

  let weightedVolatility = 0;
  let totalValue = 0;

  holdings.forEach(holding => {
    const value = holding.quantity * (holding.current_price || holding.average_cost);
    const volatility = sectorVolatilities[holding.category] || 20;
    
    weightedVolatility += value * volatility;
    totalValue += value;
  });

  return totalValue > 0 ? weightedVolatility / totalValue : 20;
}

function calculateBeta(holdings) {
  // Simplified beta calculation based on sector betas
  const sectorBetas = {
    'Technology': 1.2,
    'Healthcare': 0.9,
    'Financials': 1.1,
    'Consumer Discretionary': 1.0,
    'Consumer Staples': 0.7,
    'Energy': 1.3,
    'Utilities': 0.6,
    'Telecommunications': 0.8,
    'Materials': 1.1,
    'Industrials': 1.0
  };

  let weightedBeta = 0;
  let totalValue = 0;

  holdings.forEach(holding => {
    const value = holding.quantity * (holding.current_price || holding.average_cost);
    const beta = sectorBetas[holding.category] || 1.0;
    
    weightedBeta += value * beta;
    totalValue += value;
  });

  return totalValue > 0 ? weightedBeta / totalValue : 1.0;
}

async function calculateStressTests(userId) {
  const db = getDatabase();
  
  // Get portfolio holdings
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
  
    const totalValue = holdings.reduce((sum, holding) => {
      const price = holding.current_price || holding.average_cost;
      return sum + (holding.quantity * price);
    }, 0);
  
    const { getHistoricalData } = require('./marketDataService');
    const scenarios = [
      { name: 'Market Drop (10%)', type: 'fixed', market_shock: -10, sector_shocks: {} },
      { name: 'Tech Correction (15%)', type: 'fixed', market_shock: -5, sector_shocks: { 'Technology': -15 } },
      { name: 'Interest Rate +1%', type: 'fixed', market_shock: -3, sector_shocks: { 'Financials': 5, 'Utilities': -8 } },
      { name: 'Oil Price Spike (30%)', type: 'fixed', market_shock: -2, sector_shocks: { 'Energy': 15, 'Transportation': -10 } },
      { name: 'INR Weakness (10%)', type: 'fixed', market_shock: -2, sector_shocks: {} },
      { name: '2008 Crisis', type: 'historical', start: '2007-10-01', end: '2009-03-01' },
      { name: 'COVID-19 Crash', type: 'historical', start: '2020-02-15', end: '2020-04-15' },
      { name: 'Inflation Spike (5%)', type: 'fixed', market_shock: -8, sector_shocks: { 'Consumer Staples': -5, 'Energy': 20 } }
    ];
  
    const results = [];
    for (const scenario of scenarios) {
      let stressedValue = 0;
      if (scenario.type === 'fixed') {
        holdings.forEach(holding => {
          const currentPrice = holding.current_price || holding.average_cost;
          let stressedPrice = currentPrice * (1 + scenario.market_shock / 100);
          if (scenario.sector_shocks[holding.category]) {
            stressedPrice *= (1 + scenario.sector_shocks[holding.category] / 100);
          }
          stressedValue += holding.quantity * stressedPrice;
        });
      } else if (scenario.type === 'historical') {
        for (const holding of holdings) {
          const history = await getHistoricalData(holding.symbol, 'max', '1d');
          const startDay = history.find(h => h.date === scenario.start);
          const endDay = history.find(h => h.date === scenario.end);
          if (startDay && endDay) {
            const priceDrop = (endDay.close - startDay.close) / startDay.close;
            const stressedPrice = (holding.current_price || holding.average_cost) * (1 + priceDrop);
            stressedValue += holding.quantity * stressedPrice;
          } else {
            stressedValue += holding.quantity * (holding.current_price || holding.average_cost);
          }
        }
      }
      const impactPercent = totalValue > 0 ? ((stressedValue - totalValue) / totalValue) * 100 : 0;
      const impactAmount = stressedValue - totalValue;
      results.push({
        scenario: scenario.name,
        impact_percent: impactPercent,
        impact_amount: impactAmount,
        stressed_value: stressedValue
      });
    }
  
    return results;
  }


async function saveRiskMetrics(userId, metrics) {
  const db = getDatabase();
  const metricsId = require('uuid').v4();
  
  await new Promise((resolve, reject) => {
    db.run(
      `INSERT OR REPLACE INTO risk_metrics 
       (id, user_id, date, var_95, var_99, cvar_95, cvar_99, volatility, beta, sharpe_ratio, max_drawdown) 
       VALUES (?, ?, date('now'), ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        metricsId, userId, metrics.var_95, metrics.var_99, 
        metrics.cvar_95, metrics.cvar_99, metrics.volatility, 
        metrics.beta, metrics.sharpe_ratio, metrics.max_drawdown
      ],
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

async function getRiskHistory(userId, days = 90) {
  const db = getDatabase();
  
  const history = await new Promise((resolve, reject) => {
    db.all(
      `SELECT date, var_95, var_99, volatility, beta, sharpe_ratio
       FROM risk_metrics 
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

module.exports = {
  calculateRiskMetrics,
  calculateStressTests,
  getRiskHistory,
  calculateVaR
};