const express = require('express');
const { getDatabase } = require('../database/init');
const { authenticateToken } = require('../middleware/auth');
const { logAnalyticsEvent } = require('../services/analyticsService');
const { calculateRiskMetrics, calculateVaR, calculateStressTests } = require('../services/riskService');

const router = express.Router();

// Get current risk metrics
router.get('/metrics', authenticateToken, async (req, res) => {
  try {
    const { confidence_level = 95, time_horizon = 1 } = req.query;
    
    const riskMetrics = await calculateRiskMetrics(
      req.user.userId, 
      parseFloat(confidence_level), 
      parseInt(time_horizon)
    );

    await logAnalyticsEvent(req.user.userId, 'risk_metrics_viewed', { confidence_level, time_horizon });

    res.json(riskMetrics);
  } catch (error) {
    console.error('Get risk metrics error:', error);
    res.status(500).json({ error: 'Failed to get risk metrics' });
  }
});

// Get VaR history
router.get('/var-history', authenticateToken, async (req, res) => {
  try {
    const { days = 90, confidence_level = 95 } = req.query;
    const db = getDatabase();

    const varHistory = await new Promise((resolve, reject) => {
      db.all(
        `SELECT date, 
                CASE WHEN ? = 95 THEN var_95 ELSE var_99 END as var_value
         FROM risk_metrics 
         WHERE user_id = ? 
         AND date >= date('now', '-' || ? || ' days')
         ORDER BY date ASC`,
        [confidence_level, req.user.userId, days],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });

    // If no historical data, generate sample data
    if (varHistory.length === 0) {
      const sampleData = generateSampleVarHistory(parseInt(days), parseFloat(confidence_level));
      res.json(sampleData);
      return;
    }

    const formattedData = varHistory.map(row => ({
      date: row.date,
      value: row.var_value
    }));

    await logAnalyticsEvent(req.user.userId, 'var_history_viewed', { days, confidence_level });

    res.json(formattedData);
  } catch (error) {
    console.error('Get VaR history error:', error);
    res.status(500).json({ error: 'Failed to get VaR history' });
  }
});

// Get stress test results
router.get('/stress-tests', authenticateToken, async (req, res) => {
  try {
    const stressTests = await calculateStressTests(req.user.userId);
    
    await logAnalyticsEvent(req.user.userId, 'stress_tests_viewed');

    res.json(stressTests);
  } catch (error) {
    console.error('Get stress tests error:', error);
    res.status(500).json({ error: 'Failed to get stress test results' });
  }
});

// Run custom stress test
router.post('/stress-test', authenticateToken, async (req, res) => {
  try {
    const { scenario_name, market_shock, sector_shocks = {} } = req.body;

    if (!scenario_name || typeof market_shock !== 'number') {
      return res.status(400).json({ error: 'Invalid stress test parameters' });
    }

    // Get portfolio holdings
    const db = getDatabase();
    const holdings = await new Promise((resolve, reject) => {
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

    // Calculate stress test impact
    let totalCurrentValue = 0;
    let totalStressedValue = 0;

    holdings.forEach(holding => {
      const currentPrice = holding.current_price || holding.average_cost;
      const currentValue = holding.quantity * currentPrice;
      totalCurrentValue += currentValue;

      // Apply market shock
      let stressedPrice = currentPrice * (1 + market_shock / 100);
      
      // Apply sector-specific shock if provided
      if (sector_shocks[holding.category]) {
        stressedPrice *= (1 + sector_shocks[holding.category] / 100);
      }

      const stressedValue = holding.quantity * stressedPrice;
      totalStressedValue += stressedValue;
    });

    const impactPercent = totalCurrentValue > 0 ? 
      ((totalStressedValue - totalCurrentValue) / totalCurrentValue) * 100 : 0;

    const result = {
      scenario_name,
      current_value: totalCurrentValue,
      stressed_value: totalStressedValue,
      impact_percent: impactPercent,
      impact_amount: totalStressedValue - totalCurrentValue
    };

    await logAnalyticsEvent(req.user.userId, 'custom_stress_test_run', { 
      scenario_name, 
      market_shock, 
      impact_percent 
    });

    res.json(result);
  } catch (error) {
    console.error('Run stress test error:', error);
    res.status(500).json({ error: 'Failed to run stress test' });
  }
});

// Get risk factor breakdown
router.get('/factors', authenticateToken, async (req, res) => {
  try {
    // This would typically involve complex factor analysis
    // For now, return sample risk factor breakdown
    const riskFactors = [
      { factor: 'Market Risk', contribution: 65, description: 'Systematic market movements' },
      { factor: 'Sector Concentration', contribution: 45, description: 'Concentration in specific sectors' },
      { factor: 'Interest Rate Risk', contribution: 30, description: 'Sensitivity to interest rate changes' },
      { factor: 'Currency Risk', contribution: 15, description: 'Foreign exchange exposure' },
      { factor: 'Liquidity Risk', contribution: 10, description: 'Difficulty in trading positions' }
    ];

    await logAnalyticsEvent(req.user.userId, 'risk_factors_viewed');

    res.json(riskFactors);
  } catch (error) {
    console.error('Get risk factors error:', error);
    res.status(500).json({ error: 'Failed to get risk factors' });
  }
});

// Generate sample VaR history for demo purposes
function generateSampleVarHistory(days, confidenceLevel) {
  const data = [];
  const baseVaR = confidenceLevel === 95 ? 4.2 : 6.1;
  
  for (let i = days; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    
    const volatilityFactor = Math.sin(i / 10) * 0.5;
    const randomNoise = (Math.random() - 0.5) * 0.3;
    const value = baseVaR + volatilityFactor + randomNoise;
    
    data.push({
      date: date.toISOString().split('T')[0],
      value: Math.max(0, value)
    });
  }
  
  return data;
}

module.exports = router;