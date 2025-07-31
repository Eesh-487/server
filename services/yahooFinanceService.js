const yahooFinance = require('yahoo-finance2').default;
const axios = require('axios');
const { getDatabase } = require('../database/init');

class YahooFinanceService {
  constructor() {
    this.cache = new Map();
    this.cacheTimeout = 60000; // 1 minute cache
  }

  // Get real-time quote data
  async getQuote(symbol) {
    try {
      const cacheKey = `quote_${symbol}`;
      const cached = this.cache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
        return cached.data;
      }

      const quote = await yahooFinance.quote(symbol);
      if (!quote || typeof quote !== 'object' || !quote.symbol) {
        console.error(`No valid quote returned for ${symbol}. Skipping.`);
        return null;
      }
      const result = {
        symbol: quote.symbol,
        name: quote.longName || quote.shortName || symbol,
        price: quote.regularMarketPrice || 0,
        change: quote.regularMarketChange || 0,
        changePercent: quote.regularMarketChangePercent || 0,
        volume: quote.regularMarketVolume || 0,
        marketCap: quote.marketCap || 0,
        sector: this.getSectorFromIndustry(quote.industry),
        industry: quote.industry || 'Unknown',
        currency: quote.currency || 'INR',
        exchange: quote.fullExchangeName || quote.exchange || 'Unknown',
        lastUpdated: new Date().toISOString()
      };
      this.cache.set(cacheKey, { data: result, timestamp: Date.now() });
      return result;
    } catch (error) {
      console.error(`Error fetching quote for ${symbol}:`, error);
      if (error && error.response) {
        // If error has a response (e.g., axios error)
        console.error('Yahoo response status:', error.response.status);
        console.error('Yahoo response data:', error.response.data);
      } else if (error && error.data) {
        // If error has a data property
        console.error('Yahoo error data:', error.data);
      } else if (error && error.message) {
        // Log error message
        console.error('Yahoo error message:', error.message);
      }
      if (error && error.stack) {
        console.error('Yahoo error stack:', error.stack);
      }
      throw new Error(`Failed to fetch quote for ${symbol}`);
    }
  }

  // Get historical data
  async getHistoricalData(symbol, period = '1y', interval = '1d') {
    try {
      const periodMap = {
        '1d': '1d',
        '5d': '5d',
        '1m': '1mo',
        '3m': '3mo',
        '6m': '6mo',
        '1y': '1y',
        '2y': '2y',
        '5y': '5y',
        '10y': '10y',
        'max': 'max'
      };

      const intervalMap = {
        '1m': '1m',
        '2m': '2m',
        '5m': '5m',
        '15m': '15m',
        '30m': '30m',
        '60m': '60m',
        '90m': '90m',
        '1h': '1h',
        '1d': '1d',
        '5d': '5d',
        '1wk': '1wk',
        '1mo': '1mo',
        '3mo': '3mo'
      };

      const queryOptions = {
        period1: this.getPeriodStartDate(period),
        period2: new Date(),
        interval: intervalMap[interval] || '1d'
      };

      const result = await yahooFinance.historical(symbol, queryOptions);
      
      return result.map(item => ({
        date: item.date.toISOString().split('T')[0],
        open: item.open,
        high: item.high,
        low: item.low,
        close: item.close,
        volume: item.volume,
        adjClose: item.adjClose
      }));
    } catch (error) {
      console.error(`Error fetching historical data for ${symbol}:`, error);
      throw new Error(`Failed to fetch historical data for ${symbol}`);
    }
  }

  // Search for symbols
  async searchSymbols(query, limit = 10) {
    try {
      const searchResults = await yahooFinance.search(query);
      
      return searchResults.quotes
        .filter(quote => quote.symbol && quote.longname)
        .slice(0, limit)
        .map(quote => ({
          symbol: quote.symbol,
          name: quote.longname || quote.shortname,
          exchange: quote.exchange,
          type: quote.quoteType,
          sector: this.getSectorFromIndustry(quote.industry)
        }));
    } catch (error) {
      console.error(`Error searching symbols for ${query}:`, error);
      return [];
    }
  }

  // Get market summary (indices)
  async getMarketSummary() {
    try {
      const indices = ['^GSPC', '^DJI', '^IXIC', '^RUT']; // S&P 500, Dow, NASDAQ, Russell 2000
      const summaryPromises = indices.map(symbol => this.getQuote(symbol));
      const results = await Promise.allSettled(summaryPromises);
      
      return results
        .filter(result => result.status === 'fulfilled')
        .map(result => result.value);
    } catch (error) {
      console.error('Error fetching market summary:', error);
      return [];
    }
  }

  // Get trending stocks
  async getTrendingStocks(region = 'US', count = 20) {
    try {
      const trending = await yahooFinance.trendingSymbols(region, { count });
      
      const quotesPromises = trending.quotes
        .slice(0, count)
        .map(quote => this.getQuote(quote.symbol));
      
      const results = await Promise.allSettled(quotesPromises);
      
      return results
        .filter(result => result.status === 'fulfilled')
        .map(result => result.value)
        .sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent));
    } catch (error) {
      console.error('Error fetching trending stocks:', error);
      return [];
    }
  }

  // Get sector performance
  async getSectorPerformance() {
    try {
      const sectorETFs = {
        'Technology': 'XLK',
        'Healthcare': 'XLV',
        'Financials': 'XLF',
        'Consumer Discretionary': 'XLY',
        'Consumer Staples': 'XLP',
        'Energy': 'XLE',
        'Utilities': 'XLU',
        'Industrials': 'XLI',
        'Materials': 'XLB',
        'Real Estate': 'XLRE',
        'Communication Services': 'XLC'
      };

      const sectorPromises = Object.entries(sectorETFs).map(async ([sector, etf]) => {
        try {
          const quote = await this.getQuote(etf);
          return {
            sector,
            changePercent: quote.changePercent,
            price: quote.price
          };
        } catch (error) {
          console.error(`Error fetching ${sector} performance:`, error);
          return {
            sector,
            changePercent: 0,
            price: 0
          };
        }
      });

      return await Promise.all(sectorPromises);
    } catch (error) {
      console.error('Error fetching sector performance:', error);
      return [];
    }
  }

  // Get company profile
  async getCompanyProfile(symbol) {
    try {
      const modules = ['summaryProfile', 'financialData', 'defaultKeyStatistics'];
      const result = await yahooFinance.quoteSummary(symbol, { modules });
      
      return {
        symbol,
        name: result.summaryProfile?.longBusinessSummary || '',
        sector: result.summaryProfile?.sector || 'Unknown',
        industry: result.summaryProfile?.industry || 'Unknown',
        employees: result.summaryProfile?.fullTimeEmployees || 0,
        website: result.summaryProfile?.website || '',
        description: result.summaryProfile?.longBusinessSummary || '',
        marketCap: result.defaultKeyStatistics?.marketCap || 0,
        peRatio: result.defaultKeyStatistics?.trailingPE || 0,
        pegRatio: result.defaultKeyStatistics?.pegRatio || 0,
        dividendYield: result.defaultKeyStatistics?.dividendYield || 0,
        beta: result.defaultKeyStatistics?.beta || 0,
        eps: result.defaultKeyStatistics?.trailingEps || 0,
        revenue: result.financialData?.totalRevenue || 0,
        profitMargin: result.financialData?.profitMargins || 0
      };
    } catch (error) {
      console.error(`Error fetching company profile for ${symbol}:`, error);
      throw new Error(`Failed to fetch company profile for ${symbol}`);
    }
  }

  // Get options data
  async getOptionsData(symbol, expirationDate = null) {
    try {
      const options = await yahooFinance.options(symbol, { date: expirationDate });
      
      return {
        symbol,
        expirationDates: options.expirationDates,
        strikes: options.strikes,
        calls: options.calls?.map(call => ({
          strike: call.strike,
          lastPrice: call.lastPrice,
          bid: call.bid,
          ask: call.ask,
          volume: call.volume,
          openInterest: call.openInterest,
          impliedVolatility: call.impliedVolatility
        })) || [],
        puts: options.puts?.map(put => ({
          strike: put.strike,
          lastPrice: put.lastPrice,
          bid: put.bid,
          ask: put.ask,
          volume: put.volume,
          openInterest: put.openInterest,
          impliedVolatility: put.impliedVolatility
        })) || []
      };
    } catch (error) {
      console.error(`Error fetching options data for ${symbol}:`, error);
      throw new Error(`Failed to fetch options data for ${symbol}`);
    }
  }

  // Helper methods
  getPeriodStartDate(period) {
    const now = new Date();
    switch (period) {
      case '1d': return new Date(now.getTime() - 24 * 60 * 60 * 1000);
      case '5d': return new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
      case '1m': return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      case '3m': return new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      case '6m': return new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
      case '1y': return new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
      case '2y': return new Date(now.getTime() - 2 * 365 * 24 * 60 * 60 * 1000);
      case '5y': return new Date(now.getTime() - 5 * 365 * 24 * 60 * 60 * 1000);
      case '10y': return new Date(now.getTime() - 10 * 365 * 24 * 60 * 60 * 1000);
      default: return new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
    }
  }

  getSectorFromIndustry(industry) {
    if (!industry) return 'Unknown';
    
    const sectorMap = {
      'Technology': ['Software', 'Hardware', 'Semiconductors', 'Internet', 'Computer', 'Electronic', 'Telecom'],
      'Healthcare': ['Pharmaceutical', 'Biotechnology', 'Medical', 'Health', 'Drug'],
      'Financials': ['Bank', 'Insurance', 'Financial', 'Investment', 'Credit', 'Mortgage'],
      'Consumer Discretionary': ['Retail', 'Automotive', 'Entertainment', 'Media', 'Restaurant', 'Hotel'],
      'Consumer Staples': ['Food', 'Beverage', 'Tobacco', 'Household', 'Personal'],
      'Energy': ['Oil', 'Gas', 'Energy', 'Petroleum', 'Coal'],
      'Utilities': ['Electric', 'Water', 'Gas Utilities', 'Power'],
      'Industrials': ['Aerospace', 'Defense', 'Construction', 'Machinery', 'Transportation'],
      'Materials': ['Chemical', 'Mining', 'Steel', 'Paper', 'Container'],
      'Real Estate': ['REIT', 'Real Estate'],
      'Communication Services': ['Telecommunications', 'Media', 'Entertainment']
    };

    for (const [sector, keywords] of Object.entries(sectorMap)) {
      if (keywords.some(keyword => industry.toLowerCase().includes(keyword.toLowerCase()))) {
        return sector;
      }
    }

    return 'Unknown';
  }

  // Update market data in database
  async updateMarketDataInDB(symbol) {
    try {
      const quote = await this.getQuote(symbol);
      const db = getDatabase();
      const { v4: uuidv4 } = require('uuid');

      await db.query(
        `INSERT INTO market_data 
           (id, symbol, price, change_percent, volume, market_cap, timestamp) 
           VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
         ON CONFLICT (symbol) DO UPDATE SET 
           price = EXCLUDED.price,
           change_percent = EXCLUDED.change_percent,
           volume = EXCLUDED.volume,
           market_cap = EXCLUDED.market_cap,
           timestamp = CURRENT_TIMESTAMP`,
        [uuidv4(), symbol, quote.price, quote.changePercent, quote.volume, quote.marketCap]
      );

      return quote;
    } catch (error) {
      console.error(`Error updating market data for ${symbol}:`, error);
      throw error;
    }
  }

  // Batch update multiple symbols
  async batchUpdateMarketData(symbols) {
    const results = [];
    const batchSize = 10; // Process in batches to avoid rate limiting
    
    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);
      const batchPromises = batch.map(symbol => 
        this.updateMarketDataInDB(symbol).catch(error => {
          console.error(`Failed to update ${symbol}:`, error);
          return null;
        })
      );
      
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults.filter(result => result !== null));
      
      // Add delay between batches to respect rate limits
      if (i + batchSize < symbols.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    return results;
  }
}

module.exports = new YahooFinanceService();