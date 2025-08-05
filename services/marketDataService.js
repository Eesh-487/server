const { v4: uuidv4 } = require('uuid');
const { getDatabase } = require('../database/init');
const yahooFinanceService = require('./yahooFinanceService');

let marketDataUpdateInterval;
let connectedSymbols = new Set();

async function startMarketDataService(io) {
  console.log('Starting real-time market data service...');
  
  // Initialize with popular symbols
  const popularSymbols = [
    'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'TSLA', 'NVDA', 'AMD',
    'JPM', 'BAC', 'JNJ', 'PFE', 'XOM', 'CVX', 'KO', 'PG',
    '^GSPC', '^DJI', '^IXIC', '^RUT' // Major indices
  ];
  
  // Initial data load
  await initializeMarketData(popularSymbols);
  
  // Start real-time updates every 30 seconds during market hours
  marketDataUpdateInterval = setInterval(async () => {
    if (isMarketHours()) {
      await updateMarketData(io);
    }
  }, 30000);

  // Update every 5 minutes during off-hours
  setInterval(async () => {
    if (!isMarketHours()) {
      await updateMarketData(io);
    }
  }, 5 * 60 * 1000);

  console.log('Market data service started with real Yahoo Finance data');
}

async function initializeMarketData(symbols) {
  console.log('Initializing market data for', symbols.length, 'symbols...');
  
  try {
    await yahooFinanceService.batchUpdateMarketData(symbols);
    console.log('Market data initialized successfully');
  } catch (error) {
    console.error('Error initializing market data:', error);
  }
}

async function updateMarketData(io) {
  try {
    const db = getDatabase();
    
    // Get all symbols that need updating (from portfolio holdings and watchlists)
    const result = await db.query(
      `SELECT DISTINCT symbol FROM (
        SELECT symbol FROM portfolio_holdings
        UNION
        SELECT symbol FROM watchlist
        UNION
        SELECT symbol FROM market_data WHERE timestamp > NOW() - INTERVAL '1 hour'
      )`
    );
    const symbols = result.rows.map(row => row.symbol);

    if (symbols.length === 0) return;

    // Update market data in batches
    const updates = await yahooFinanceService.batchUpdateMarketData(symbols);
    
    // Broadcast updates via WebSocket
    if (io && updates.length > 0) {
      // Emit the entire array of updates at once (for bulk updates)
      io.emit('market_data_update', updates);
      
      // Also emit individual updates to symbol-specific rooms
      updates.forEach(update => {
        if (update) {
          io.to(`market_${update.symbol}`).emit('market_update', update);
        }
      });
    }

    console.log(`Updated market data for ${updates.length} symbols`);
  } catch (error) {
    console.error('Error updating market data:', error);
  }
}

async function getMarketData(symbol) {
  try {
    const db = getDatabase();
    
    // First try to get from database
    const result = await db.query(
      "SELECT * FROM market_data WHERE symbol = $1 AND timestamp > NOW() - INTERVAL '5 minutes'",
      [symbol.toUpperCase()]
    );
    const cachedData = result.rows[0];

    if (cachedData) {
      return {
        symbol: cachedData.symbol,
        name: cachedData.name || 'Unknown',
        price: cachedData.price,
        change: cachedData.change || 0,
        changePercent: cachedData.change_percent || 0,
        volume: cachedData.volume,
        marketCap: cachedData.market_cap,
        sector: cachedData.sector || 'Unknown',
        lastUpdated: cachedData.timestamp
      };
    }

    // If not in cache or stale, fetch from Yahoo Finance
    const realTimeData = await yahooFinanceService.getQuote(symbol);
    
    // Check if data was retrieved successfully
    if (!realTimeData) {
      console.error(`No data returned from Yahoo Finance for ${symbol}`);
      return null;
    }
    
    // Update database
    await yahooFinanceService.updateMarketDataInDB(symbol);
    
    return realTimeData;
  } catch (error) {
    console.error(`Error getting market data for ${symbol}:`, error);
    return null;
  }
}

async function searchSymbols(query, limit = 10) {
  try {
    return await yahooFinanceService.searchSymbols(query, limit);
  } catch (error) {
    console.error(`Error searching symbols for ${query}:`, error);
    return [];
  }
}

async function getHistoricalData(symbol, period = '1y', interval = '1d') {
  try {
    return await yahooFinanceService.getHistoricalData(symbol, period, interval);
  } catch (error) {
    console.error(`Error getting historical data for ${symbol}:`, error);
    return [];
  }
}

async function getMarketOverview() {
  try {
    // Get major indices
    const indices = await yahooFinanceService.getMarketSummary();
    
    // Get trending stocks
    const trending = await yahooFinanceService.getTrendingStocks('US', 20);
    
    // Separate gainers and losers
    const gainers = trending
      .filter(stock => stock.changePercent > 0)
      .sort((a, b) => b.changePercent - a.changePercent)
      .slice(0, 10);
      
    const losers = trending
      .filter(stock => stock.changePercent < 0)
      .sort((a, b) => a.changePercent - b.changePercent)
      .slice(0, 10);
    
    // Get sector performance
    const sectorPerformance = await yahooFinanceService.getSectorPerformance();
    
    return {
      indices: indices.map(index => ({
        symbol: index.symbol,
        name: index.name,
        price: index.price,
        change: index.change,
        changePercent: index.changePercent
      })),
      topGainers: gainers,
      topLosers: losers,
      sectorPerformance,
      marketStatus: getMarketStatus(),
      lastUpdated: new Date().toISOString()
    };
  } catch (error) {
    console.error('Error getting market overview:', error);
    return {
      indices: [],
      topGainers: [],
      topLosers: [],
      sectorPerformance: [],
      marketStatus: 'UNKNOWN',
      lastUpdated: new Date().toISOString()
    };
  }
}

async function getCompanyProfile(symbol) {
  try {
    return await yahooFinanceService.getCompanyProfile(symbol);
  } catch (error) {
    console.error(`Error getting company profile for ${symbol}:`, error);
    throw error;
  }
}

async function getOptionsData(symbol, expirationDate = null) {
  try {
    return await yahooFinanceService.getOptionsData(symbol, expirationDate);
  } catch (error) {
    console.error(`Error getting options data for ${symbol}:`, error);
    throw error;
  }
}

function isMarketHours() {
  const now = new Date();
  const easternTime = new Date(now.toLocaleString("en-US", {timeZone: "America/New_York"}));
  const day = easternTime.getDay(); // 0 = Sunday, 6 = Saturday
  const hour = easternTime.getHours();
  const minute = easternTime.getMinutes();
  
  // Market is open Monday-Friday, 9:30 AM - 4:00 PM ET
  if (day === 0 || day === 6) return false; // Weekend
  
  const currentTime = hour * 60 + minute;
  const marketOpen = 9 * 60 + 30; // 9:30 AM
  const marketClose = 16 * 60; // 4:00 PM
  
  return currentTime >= marketOpen && currentTime < marketClose;
}

function getMarketStatus() {
  const now = new Date();
  const easternTime = new Date(now.toLocaleString("en-US", {timeZone: "America/New_York"}));
  const day = easternTime.getDay();
  const hour = easternTime.getHours();
  const minute = easternTime.getMinutes();
  
  if (day === 0 || day === 6) return 'CLOSED'; // Weekend
  
  const currentTime = hour * 60 + minute;
  const preMarket = 4 * 60; // 4:00 AM
  const marketOpen = 9 * 60 + 30; // 9:30 AM
  const marketClose = 16 * 60; // 4:00 PM
  const afterHours = 20 * 60; // 8:00 PM
  
  if (currentTime >= preMarket && currentTime < marketOpen) return 'PRE_MARKET';
  if (currentTime >= marketOpen && currentTime < marketClose) return 'OPEN';
  if (currentTime >= marketClose && currentTime < afterHours) return 'AFTER_HOURS';
  
  return 'CLOSED';
}

function addSymbolToTracking(symbol) {
  connectedSymbols.add(symbol.toUpperCase());
}

function removeSymbolFromTracking(symbol) {
  connectedSymbols.delete(symbol.toUpperCase());
}

function stopMarketDataService() {
  if (marketDataUpdateInterval) {
    clearInterval(marketDataUpdateInterval);
    console.log('Market data service stopped');
  }
}

module.exports = {
  startMarketDataService,
  stopMarketDataService,
  getMarketData,
  searchSymbols,
  getHistoricalData,
  getMarketOverview,
  getCompanyProfile,
  getOptionsData,
  addSymbolToTracking,
  removeSymbolFromTracking,
  isMarketHours,
  getMarketStatus
};