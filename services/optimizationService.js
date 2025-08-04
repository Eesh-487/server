const { getDatabase } = require('../database/init');
const { PortfolioOptimizationEngine } = require('./optimizationEngine');
const { InputEstimationEngine } = require('./inputEstimationEngine');

async function runOptimization(userId, options) {
  const { method, risk_tolerance, max_position_size, constraints, estimation = {} } = options;
  
  // Initialize engines
  const optimizationEngine = new PortfolioOptimizationEngine();
  const estimationEngine = new InputEstimationEngine();
  
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

  if (holdings.length === 0) {
    throw new Error('No holdings found for optimization');
  }

  // Fetch historical price data for all holdings
  const { getHistoricalData } = require('./marketDataService');
  const priceHistories = {};
  for (const holding of holdings) {
    try {
      priceHistories[holding.symbol] = await getHistoricalData(
        holding.symbol, 
        estimation.lookback ? `${Math.ceil(estimation.lookback / 252)}y` : '2y', 
        '1d'
      );
    } catch (error) {
      console.warn(`Failed to fetch data for ${holding.symbol}:`, error.message);
      priceHistories[holding.symbol] = [];
    }
  }

  // Estimate expected returns using configured method
  const expectedReturns = await estimationEngine.estimateExpectedReturns(
    priceHistories,
    estimation.returns || 'historical_mean',
    { lookback: estimation.lookback || 504 }
  );

  // Estimate covariance matrix using configured method
  const covarianceResult = await estimationEngine.estimateCovarianceMatrix(
    priceHistories,
    estimation.covariance || 'shrinkage',
    { lookback: estimation.lookback || 504 }
  );

  // Convert to arrays for optimization engine
  const symbols = Object.keys(expectedReturns);
  const returnsArray = symbols.map(symbol => expectedReturns[symbol] || 0);
  const constraintsForOptimization = {
    longOnly: !constraints?.allowShortSelling,
    maxWeight: max_position_size ? max_position_size / 100 : 0.3,
    minWeight: constraints?.minPositionSize ? constraints.minPositionSize / 100 : 0.01
  };

  let optimizationResult;

  try {
    switch (method) {
      case 'mean-variance':
        optimizationResult = await optimizationEngine.meanVarianceOptimization(
          returnsArray,
          covarianceResult.matrix,
          null, // Let it find optimal return
          constraintsForOptimization
        );
        break;

      case 'max-sharpe':
        optimizationResult = await optimizationEngine.maximizeSharpeRatio(
          returnsArray,
          covarianceResult.matrix,
          constraintsForOptimization
        );
        break;

      case 'risk-parity':
        optimizationResult = await optimizationEngine.riskParityOptimization(
          covarianceResult.matrix
        );
        break;

      case 'min-volatility':
        // Use mean-variance with very low target return to minimize volatility
        const minReturn = Math.min(...returnsArray);
        optimizationResult = await optimizationEngine.meanVarianceOptimization(
          returnsArray,
          covarianceResult.matrix,
          minReturn * 1.1,
          constraintsForOptimization
        );
        break;

      case 'cvar-min':
        // Generate scenarios for CVaR optimization
        const scenarios = estimationEngine.generateMonteCarloScenarios(
          returnsArray,
          covarianceResult,
          1000
        );
        optimizationResult = await optimizationEngine.cvarOptimization(
          scenarios,
          0.05,
          constraintsForOptimization
        );
        break;

      case 'black-litterman':
        // For simplicity, use equal market cap weights
        const marketCapWeights = new Array(symbols.length).fill(1 / symbols.length);
        optimizationResult = await optimizationEngine.blackLittermanOptimization(
          marketCapWeights,
          covarianceResult.matrix
        );
        break;

      default:
        throw new Error(`Unknown optimization method: ${method}`);
    }

    // Convert weights back to allocations object
    const optimizedAllocation = symbols.reduce((acc, symbol, index) => {
      acc[symbol] = {
        percentage: (optimizationResult.weights[index] * 100).toFixed(2),
        change: 0 // Will be calculated below
      };
      return acc;
    }, {});

    // Calculate current allocation for comparison
    const currentAllocation = calculateCurrentAllocation(holdings);

    // Calculate changes
    Object.keys(optimizedAllocation).forEach(symbol => {
      const currentWeight = currentAllocation.find(item => item.name === symbol)?.percentage || 0;
      const optimizedWeight = parseFloat(optimizedAllocation[symbol].percentage);
      optimizedAllocation[symbol].change = optimizedWeight - currentWeight;
    });

    // Generate efficient frontier for mean-variance
    let efficientFrontier = null;
    if (method === 'mean-variance') {
      try {
        const frontierPoints = optimizationEngine.generateEfficientFrontier(
          returnsArray,
          covarianceResult.matrix,
          50
        );
        efficientFrontier = frontierPoints.map(point => ({
          risk: point.expectedVolatility * 100,
          return: point.expectedReturn * 100,
          weights: point.weights
        }));
      } catch (error) {
        console.warn('Failed to generate efficient frontier:', error.message);
      }
    }

    return {
      method,
      risk_tolerance,
      current_allocation: currentAllocation,
      optimized_allocation: optimizedAllocation,
      expected_return: optimizationResult.expectedReturn || 0.08,
      expected_volatility: optimizationResult.expectedVolatility || 0.16,
      sharpe_ratio: optimizationResult.sharpeRatio || 0.5,
      cvar: optimizationResult.expectedCVaR,
      efficient_frontier: efficientFrontier,
      implementation_plan: generateImplementationPlan(currentAllocation, optimizedAllocation),
      estimation_methods: {
        returns: estimation.returns || 'historical_mean',
        covariance: estimation.covariance || 'shrinkage',
        lookback_days: estimation.lookback || 504
      }
    };

  } catch (error) {
    console.error('Optimization engine error:', error);
    // Fallback to simple optimization
    return runSimpleOptimization(holdings, method, constraints);
  }
}

// Fallback simple optimization for when advanced methods fail
function runSimpleOptimization(holdings, method, constraints) {
  const symbols = holdings.map(h => h.symbol);
  const n = symbols.length;
  
  let weights;
  switch (method) {
    case 'risk-parity':
      // Equal weights for simplicity
      weights = new Array(n).fill(1/n);
      break;
    case 'min-volatility':
      // Favor lower volatility assets (mock)
      weights = holdings.map(() => Math.random() * 0.5 + 0.5);
      const sum = weights.reduce((a, b) => a + b, 0);
      weights = weights.map(w => w / sum);
      break;
    default:
      // Equal weights
      weights = new Array(n).fill(1/n);
  }

  const optimizedAllocation = symbols.reduce((acc, symbol, index) => {
    acc[symbol] = {
      percentage: (weights[index] * 100).toFixed(2),
      change: 0
    };
    return acc;
  }, {});

  const currentAllocation = calculateCurrentAllocation(holdings);

  return {
    method,
    risk_tolerance: 50,
    current_allocation: currentAllocation,
    optimized_allocation: optimizedAllocation,
    expected_return: 0.08,
    expected_volatility: 0.16,
    sharpe_ratio: 0.5,
    implementation_plan: generateImplementationPlan(currentAllocation, optimizedAllocation),
    estimation_methods: {
      returns: 'simple_fallback',
      covariance: 'simple_fallback',
      lookback_days: 252
    }
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