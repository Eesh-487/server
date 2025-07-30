const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const { getDatabase } = require('../database/init');
const { authenticateToken } = require('../middleware/auth');
const { logAnalyticsEvent } = require('../services/analyticsService');
const { runOptimization, getOptimizationHistory } = require('../services/optimizationService');

const router = express.Router();

// Run portfolio optimization
router.post('/optimize', authenticateToken, [
  body('method').isIn(['mean-variance', 'black-litterman', 'risk-parity', 'min-volatility', 'max-sharpe']),
  body('risk_tolerance').isFloat({ min: 0, max: 100 }),
  body('max_position_size').optional().isFloat({ min: 1, max: 100 }),
  body('constraints').optional().isObject()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { method, risk_tolerance, max_position_size = 30, constraints = {} } = req.body;
    
    const optimizationResult = await runOptimization(req.user.userId, {
      method,
      risk_tolerance,
      max_position_size,
      constraints
    });

    // Save optimization result
    const db = getDatabase();
    const resultId = uuidv4();
    
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO optimization_results 
         (id, user_id, method, risk_tolerance, current_allocation, optimized_allocation, 
          expected_return, expected_volatility, sharpe_improvement) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          resultId,
          req.user.userId,
          method,
          risk_tolerance,
          JSON.stringify(optimizationResult.current_allocation),
          JSON.stringify(optimizationResult.optimized_allocation),
          optimizationResult.expected_return,
          optimizationResult.expected_volatility,
          optimizationResult.sharpe_improvement
        ],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

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

    const result = await new Promise((resolve, reject) => {
      db.get(
        `SELECT * FROM optimization_results 
         WHERE id = ? AND user_id = ?`,
        [id, req.user.userId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

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
    const result = await new Promise((resolve, reject) => {
      db.get(
        `SELECT optimized_allocation FROM optimization_results 
         WHERE id = ? AND user_id = ?`,
        [id, req.user.userId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    if (!result) {
      return res.status(404).json({ error: 'Optimization result not found' });
    }

    const optimizedAllocation = JSON.parse(result.optimized_allocation);

    // Get current portfolio value
    const currentHoldings = await new Promise((resolve, reject) => {
      db.all(
        `SELECT h.*, m.price as current_price 
         FROM portfolio_holdings h 
         LEFT JOIN market_data m ON h.symbol = m.symbol 
         WHERE h.user_id = ?`,
        [req.user.userId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });

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

    const result = await new Promise((resolve, reject) => {
      db.get(
        `SELECT * FROM optimization_results 
         WHERE id = ? AND user_id = ?`,
        [id, req.user.userId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

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

module.exports = router;