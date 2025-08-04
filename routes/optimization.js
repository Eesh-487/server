const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const { getDatabase } = require('../database/init');
const { authenticateToken } = require('../middleware/auth');
const { logAnalyticsEvent } = require('../services/analyticsService');
const { runOptimization, getOptimizationHistory } = require('../services/optimizationService');
const { getHistoricalData } = require('../services/marketDataService');

const router = express.Router();

// Run portfolio optimization
router.post('/optimize', authenticateToken, [
  body('method').isIn(['mean-variance', 'black-litterman', 'risk-parity', 'min-volatility', 'max-sharpe', 'cvar-min']),
  body('risk_tolerance').isFloat({ min: 0, max: 100 }),
  body('max_position_size').optional().isFloat({ min: 1, max: 100 }),
  body('constraints').optional().isObject(),
  body('estimation').optional().isObject()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { method, risk_tolerance, max_position_size = 30, constraints = {}, estimation = {} } = req.body;
    
    const optimizationResult = await runOptimization(req.user.userId, {
      method,
      risk_tolerance,
      max_position_size,
      constraints,
      estimation
    });

    // Save optimization result
    const db = getDatabase();
    const resultId = uuidv4();
    
    await db.query(
      `INSERT INTO optimization_results 
         (id, user_id, method, risk_tolerance, current_allocation, optimized_allocation, 
          expected_return, expected_volatility, sharpe_improvement, estimation_methods, sharpe_ratio) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        resultId,
        req.user.userId,
        method,
        risk_tolerance,
        JSON.stringify(optimizationResult.current_allocation),
        JSON.stringify(optimizationResult.optimized_allocation),
        optimizationResult.expected_return,
        optimizationResult.expected_volatility,
        optimizationResult.sharpe_improvement,
        JSON.stringify(optimizationResult.estimation_methods),
        optimizationResult.sharpe_ratio
      ]
    );

    await logAnalyticsEvent(req.user.userId, 'optimization_run', { 
      method, 
      risk_tolerance,
      expected_return: optimizationResult.expected_return
    });

    res.json({
      id: resultId,
      ...optimizationResult
    });
  } catch (error) {
    console.error('Run optimization error:', error);
    res.status(500).json({ error: 'Failed to run optimization' });
  }
});

// Get optimization history
router.get('/history', authenticateToken, async (req, res) => {
  try {
    const { limit = 10 } = req.query;
    
    const history = await getOptimizationHistory(req.user.userId, parseInt(limit));
    
    await logAnalyticsEvent(req.user.userId, 'optimization_history_viewed');

    res.json(history);
  } catch (error) {
    console.error('Get optimization history error:', error);
    res.status(500).json({ error: 'Failed to get optimization history' });
  }
});

// Get specific optimization result
router.get('/result/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const db = getDatabase();

    const resultQuery = await db.query(
      `SELECT * FROM optimization_results 
         WHERE id = $1 AND user_id = $2`,
      [id, req.user.userId]
    );
    const result = resultQuery.rows[0];

    if (!result) {
      return res.status(404).json({ error: 'Optimization result not found' });
    }

    // Parse JSON fields
    const formattedResult = {
      ...result,
      current_allocation: JSON.parse(result.current_allocation),
      optimized_allocation: JSON.parse(result.optimized_allocation)
    };

    res.json(formattedResult);
  } catch (error) {
    console.error('Get optimization result error:', error);
    res.status(500).json({ error: 'Failed to get optimization result' });
  }
});

// Apply optimization (rebalance portfolio)
router.post('/apply/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const db = getDatabase();

    // Get optimization result
    const resultQuery = await db.query(
      `SELECT optimized_allocation FROM optimization_results 
         WHERE id = $1 AND user_id = $2`,
      [id, req.user.userId]
    );
    const result = resultQuery.rows[0];

    if (!result) {
      return res.status(404).json({ error: 'Optimization result not found' });
    }

    const optimizedAllocation = JSON.parse(result.optimized_allocation);

    // Get current portfolio value
    const currentHoldingsQuery = await db.query(
      `SELECT h.*, m.price as current_price 
         FROM portfolio_holdings h 
         LEFT JOIN market_data m ON h.symbol = m.symbol 
         WHERE h.user_id = $1`,
      [req.user.userId]
    );
    const currentHoldings = currentHoldingsQuery.rows;

    const totalValue = currentHoldings.reduce((sum, holding) => {
      const price = holding.current_price || holding.average_cost;
      return sum + (holding.quantity * price);
    }, 0);

    // Calculate trades needed
    const trades = [];
    
    optimizedAllocation.forEach(allocation => {
      const targetValue = totalValue * (allocation.percentage / 100);
      const currentHolding = currentHoldings.find(h => h.category === allocation.category);
      
      if (currentHolding) {
        const currentValue = currentHolding.quantity * (currentHolding.current_price || currentHolding.average_cost);
        const difference = targetValue - currentValue;
        
        if (Math.abs(difference) > totalValue * 0.01) { // Only trade if difference > 1%
          trades.push({
            category: allocation.category,
            action: difference > 0 ? 'BUY' : 'SELL',
            amount: Math.abs(difference),
            current_value: currentValue,
            target_value: targetValue
          });
        }
      } else if (targetValue > totalValue * 0.01) {
        trades.push({
          category: allocation.category,
          action: 'BUY',
          amount: targetValue,
          current_value: 0,
          target_value: targetValue
        });
      }
    });

    await logAnalyticsEvent(req.user.userId, 'optimization_applied', { 
      optimization_id: id,
      trades_count: trades.length,
      total_value: totalValue
    });

    res.json({
      message: 'Optimization applied successfully',
      trades,
      total_value: totalValue
    });
  } catch (error) {
    console.error('Apply optimization error:', error);
    res.status(500).json({ error: 'Failed to apply optimization' });
  }
});

// Get optimization methods
router.get('/methods', authenticateToken, async (req, res) => {
  try {
    const methods = [
      {
        id: 'mean-variance',
        name: 'Mean-Variance Optimization',
        description: 'Classic Markowitz optimization balancing expected return and risk',
        suitable_for: 'Balanced portfolios with clear return expectations'
      },
      {
        id: 'black-litterman',
        name: 'Black-Litterman Model',
        description: 'Incorporates market equilibrium and investor views',
        suitable_for: 'Portfolios with specific market outlook'
      },
      {
        id: 'risk-parity',
        name: 'Risk Parity',
        description: 'Equal risk contribution from all assets',
        suitable_for: 'Diversified portfolios focusing on risk balance'
      },
      {
        id: 'min-volatility',
        name: 'Minimum Volatility',
        description: 'Minimizes portfolio volatility while maintaining diversification',
        suitable_for: 'Conservative investors prioritizing stability'
      },
      {
        id: 'max-sharpe',
        name: 'Maximum Sharpe Ratio',
        description: 'Maximizes risk-adjusted returns',
        suitable_for: 'Investors seeking optimal risk-return balance'
      }
    ];

    res.json(methods);
  } catch (error) {
    console.error('Get optimization methods error:', error);
    res.status(500).json({ error: 'Failed to get optimization methods' });
  }
});

// Export optimization report
router.get('/export/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { format = 'json' } = req.query;
    const db = getDatabase();

    const resultQuery = await db.query(
      `SELECT * FROM optimization_results 
         WHERE id = $1 AND user_id = $2`,
      [id, req.user.userId]
    );
    const result = resultQuery.rows[0];

    if (!result) {
      return res.status(404).json({ error: 'Optimization result not found' });
    }

    const reportData = {
      ...result,
      current_allocation: JSON.parse(result.current_allocation),
      optimized_allocation: JSON.parse(result.optimized_allocation),
      generated_at: new Date().toISOString()
    };

    await logAnalyticsEvent(req.user.userId, 'optimization_report_exported', { 
      optimization_id: id, 
      format 
    });

    if (format === 'csv') {
      const csv = convertOptimizationToCSV(reportData);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=optimization_${id}.csv`);
      res.send(csv);
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename=optimization_${id}.json`);
      res.json(reportData);
    }
  } catch (error) {
    console.error('Export optimization error:', error);
    res.status(500).json({ error: 'Failed to export optimization' });
  }
});

function convertOptimizationToCSV(data) {
  const lines = [];
  lines.push('Optimization Report');
  lines.push(`Method,${data.method}`);
  lines.push(`Risk Tolerance,${data.risk_tolerance}%`);
  lines.push(`Expected Return,${data.expected_return}%`);
  lines.push(`Expected Volatility,${data.expected_volatility}%`);
  lines.push(`Sharpe Improvement,${data.sharpe_improvement}`);
  lines.push('');
  lines.push('Current Allocation');
  lines.push('Category,Percentage');
  
  data.current_allocation.forEach(item => {
    lines.push(`${item.name},${item.percentage}%`);
  });
  
  lines.push('');
  lines.push('Optimized Allocation');
  lines.push('Category,Percentage,Change');
  
  data.optimized_allocation.forEach(item => {
    lines.push(`${item.name},${item.percentage}%,${item.change > 0 ? '+' : ''}${item.change}%`);
  });
  
  return lines.join('\n');
}

// Enhanced optimization endpoints

// Endpoint to generate efficient frontier
router.post('/efficient-frontier', authenticateToken, async (req, res) => {
  try {
    const { symbols, estimation = {}, points = 50 } = req.body;
    
    if (!symbols || !Array.isArray(symbols) || symbols.length === 0) {
      return res.status(400).json({ error: 'Valid symbols array is required' });
    }

    try {
      // Fetch historical data for all symbols
      const priceHistories = {};
      for (const symbol of symbols) {
        try {
          priceHistories[symbol] = await getHistoricalData(
            symbol, 
            estimation.lookback ? `${Math.ceil(estimation.lookback / 252)}y` : '2y', 
            '1d'
          );
        } catch (error) {
          console.warn(`Failed to fetch data for ${symbol}:`, error.message);
          priceHistories[symbol] = [];
        }
      }

      // Create estimation engines
      const { InputEstimationEngine } = require('../services/inputEstimationEngine');
      const { PortfolioOptimizationEngine } = require('../services/optimizationEngine');
      
      const estimationEngine = new InputEstimationEngine();
      const optimizationEngine = new PortfolioOptimizationEngine();

      // Estimate returns and covariance
      const expectedReturns = await estimationEngine.estimateExpectedReturns(
        priceHistories,
        estimation.returns || 'historical_mean',
        { lookback: estimation.lookback || 504 }
      );

      const covarianceResult = await estimationEngine.estimateCovarianceMatrix(
        priceHistories,
        estimation.covariance || 'shrinkage',
        { lookback: estimation.lookback || 504 }
      );

      // Convert to arrays
      const returnsArray = symbols.map(symbol => expectedReturns[symbol] || 0);
      
      // Generate efficient frontier
      const frontierPoints = await optimizationEngine.generateEfficientFrontier(
        returnsArray,
        covarianceResult.matrix,
        points
      );

      // Format response
      const efficientFrontier = frontierPoints.map(point => ({
        risk: point.expectedVolatility * 100,
        return: point.expectedReturn * 100,
        weights: symbols.reduce((acc, symbol, index) => {
          acc[symbol] = point.weights[index];
          return acc;
        }, {})
      }));

      res.json({
        symbols,
        points: efficientFrontier,
        estimation_methods: {
          returns: estimation.returns || 'historical_mean',
          covariance: estimation.covariance || 'shrinkage',
          lookback_days: estimation.lookback || 504
        }
      });
    } catch (error) {
      console.error('Efficient frontier calculation failed:', error);
      // Return empty frontier if calculation fails
      res.json({
        symbols,
        points: [],
        estimation_methods: {
          returns: estimation.returns || 'historical_mean',
          covariance: estimation.covariance || 'shrinkage',
          lookback_days: estimation.lookback || 504
        },
        error: 'Calculation failed, using fallback'
      });
    }
  } catch (error) {
    console.error('Efficient frontier error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to get random portfolio suggestions
router.post('/random-portfolios', authenticateToken, async (req, res) => {
  try {
    const { symbols, count = 1000, estimation = {} } = req.body;
    
    if (!symbols || !Array.isArray(symbols) || symbols.length === 0) {
      return res.status(400).json({ error: 'Valid symbols array is required' });
    }

    try {
      // Fetch historical data
      const priceHistories = {};
      for (const symbol of symbols) {
        try {
          priceHistories[symbol] = await getHistoricalData(
            symbol, 
            estimation.lookback ? `${Math.ceil(estimation.lookback / 252)}y` : '2y', 
            '1d'
          );
        } catch (error) {
          console.warn(`Failed to fetch data for ${symbol}:`, error.message);
          priceHistories[symbol] = [];
        }
      }

      // Create estimation engine
      const { InputEstimationEngine } = require('../services/inputEstimationEngine');
      const estimationEngine = new InputEstimationEngine();

      // Estimate returns and covariance
      const expectedReturns = await estimationEngine.estimateExpectedReturns(
        priceHistories,
        estimation.returns || 'historical_mean',
        { lookback: estimation.lookback || 504 }
      );

      const covarianceResult = await estimationEngine.estimateCovarianceMatrix(
        priceHistories,
        estimation.covariance || 'shrinkage',
        { lookback: estimation.lookback || 504 }
      );

      // Generate random portfolios
      const returnsArray = symbols.map(symbol => expectedReturns[symbol] || 0);
      const randomPortfolios = [];
      
      for (let i = 0; i < count; i++) {
        // Generate random weights that sum to 1
        const rawWeights = symbols.map(() => Math.random());
        const sum = rawWeights.reduce((a, b) => a + b, 0);
        const weights = rawWeights.map(w => w / sum);
        
        // Calculate portfolio metrics
        const portfolioReturn = weights.reduce((sum, weight, j) => sum + weight * returnsArray[j], 0);
        
        let portfolioVariance = 0;
        for (let j = 0; j < weights.length; j++) {
          for (let k = 0; k < weights.length; k++) {
            portfolioVariance += weights[j] * weights[k] * covarianceResult.matrix[j][k];
          }
        }
        const portfolioVolatility = Math.sqrt(portfolioVariance);
        
        randomPortfolios.push({
          risk: portfolioVolatility * 100,
          return: portfolioReturn * 100,
          weights
        });
      }

      res.json({
        portfolios: randomPortfolios,
        symbols,
        estimation_methods: {
          returns: estimation.returns || 'historical_mean',
          covariance: estimation.covariance || 'shrinkage',
          lookback_days: estimation.lookback || 504
        }
      });
    } catch (error) {
      console.error('Random portfolios calculation failed:', error);
      // Generate simple random portfolios as fallback
      const randomPortfolios = [];
      for (let i = 0; i < Math.min(count, 100); i++) {
        const rawWeights = symbols.map(() => Math.random());
        const sum = rawWeights.reduce((a, b) => a + b, 0);
        const weights = rawWeights.map(w => w / sum);
        
        randomPortfolios.push({
          risk: Math.random() * 20 + 5, // 5-25% volatility
          return: Math.random() * 20 - 5, // -5% to 15% return
          weights
        });
      }

      res.json({
        portfolios: randomPortfolios,
        symbols,
        estimation_methods: {
          returns: 'fallback',
          covariance: 'fallback',
          lookback_days: 252
        },
        error: 'Calculation failed, using fallback'
      });
    }
  } catch (error) {
    console.error('Random portfolios error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;