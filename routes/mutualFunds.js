const express = require('express');
const router = express.Router();
const mutualFundService = require('../services/mutualFundService');
const { authenticateToken } = require('../middleware/auth');

// Get mutual fund NAV and details by AMFI code
router.get('/:symbol', authenticateToken, async (req, res) => {
  try {
    const { symbol } = req.params;
    const mutualFundData = await mutualFundService.getMutualFundData(symbol);
    
    if (!mutualFundData) {
      return res.status(404).json({ error: 'Mutual fund not found' });
    }
    
    res.json(mutualFundData);
  } catch (error) {
    console.error('Error fetching mutual fund data:', error);
    res.status(500).json({ error: 'Failed to fetch mutual fund data' });
  }
});

// Search mutual funds by name, symbol or AMC
router.get('/search', authenticateToken, async (req, res) => {
  try {
    const { q: query, category } = req.query;
    
    if (!query || query.trim().length === 0) {
      return res.json([]);
    }
    
    const results = await mutualFundService.searchMutualFunds(query, category);
    res.json(results);
  } catch (error) {
    console.error('Error searching mutual funds:', error);
    res.status(500).json({ error: 'Failed to search mutual funds' });
  }
});

module.exports = router;
