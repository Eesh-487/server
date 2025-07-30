const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');

// Load environment variables based on NODE_ENV
require('dotenv').config({
  path: path.resolve(__dirname, `.env.${process.env.NODE_ENV || 'development'}`)
});

const authRoutes = require('./routes/auth');
const portfolioRoutes = require('./routes/portfolio');
const riskRoutes = require('./routes/risk');
const performanceRoutes = require('./routes/performance');
const optimizationRoutes = require('./routes/optimization');
const analyticsRoutes = require('./routes/analytics');
const marketDataRoutes = require('./routes/marketData');

const { initializeDatabase } = require('./database/init');
const { startMarketDataService } = require('./services/marketDataService');
const { startAnalyticsEngine } = require('./services/analyticsEngine');
const { setupWebSocketHandlers } = require('./websocket/handlers');

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: [
      'http://localhost:5173',
      'http://192.168.1.9:5173'
    ],
    methods: ["GET", "POST", "PUT", "DELETE"]
  }
});

// Security middleware
app.use(helmet());
app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://192.168.1.9:5173'
  ],
  credentials: true
}));

// Rate limiting - Generous limits for development
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10000 // limit each IP to 10,000 requests per windowMs (much higher for development)
});
app.use(limiter);

// General middleware
app.use(compression());
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/portfolio', portfolioRoutes);
app.use('/api/risk', riskRoutes);
app.use('/api/performance', performanceRoutes);
app.use('/api/optimization', optimizationRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/market-data', marketDataRoutes);

// Health check with component status
app.get('/api/health', async (req, res) => {
  try {
    // Check database connection
    const dbStatus = await new Promise((resolve) => {
      try {
        const { getDatabase } = require('../database/init');
        const db = getDatabase();
        db.get('SELECT 1', (err) => {
          resolve(err ? 'error' : 'connected');
        });
      } catch (error) {
        resolve('error');
      }
    });

    // System information
    const health = {
      status: dbStatus === 'connected' ? 'OK' : 'degraded',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: process.env.npm_package_version || '1.0.0',
      components: {
        database: { status: dbStatus },
        server: { status: 'running' }
      },
      environment: process.env.NODE_ENV
    };

    // Set appropriate status code
    const statusCode = health.status === 'OK' ? 200 : 500;
    res.status(statusCode).json(health);
  } catch (error) {
    res.status(500).json({ 
      status: 'error', 
      timestamp: new Date().toISOString(),
      error: error.message 
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ 
    error: 'Something went wrong!',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
  });
});

// Serve static files in production
if (process.env.NODE_ENV === 'production') {
  // Serve static files from the React build folder
  app.use(express.static(path.join(__dirname, '../dist')));
  
  // For any route that doesn't match an API route, serve the React app
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../dist/index.html'));
  });
  console.log('Static file serving configured for production');
} else {
  // 404 handler for development
  app.use('*', (req, res) => {
    res.status(404).json({ error: 'Route not found' });
  });
}

const PORT = 3001;

// ...existing code...

async function startServer() {
  try {
    // Initialize database
    await initializeDatabase();
    console.log('Database initialized successfully');

    // Register routes AFTER DB is ready
    app.use('/api/auth', authRoutes);
    app.use('/api/portfolio', portfolioRoutes);
    app.use('/api/risk', riskRoutes);
    app.use('/api/performance', performanceRoutes);
    app.use('/api/optimization', optimizationRoutes);
    app.use('/api/analytics', analyticsRoutes);
    app.use('/api/market-data', marketDataRoutes);

    // Setup WebSocket handlers
    setupWebSocketHandlers(io);
    console.log('WebSocket handlers configured');

    // Start market data service
    await startMarketDataService(io);
    console.log('Market data service started');

    // Start analytics engine
    await startAnalyticsEngine(io);
    console.log('Analytics engine started');

    // Start server
        // Start server
        server.listen(PORT, '0.0.0.0', () => {
          console.log(`Server running on http://0.0.0.0:${PORT} [${process.env.NODE_ENV}]`);
        });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

// ...existing code...

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Process terminated');
  });
});

module.exports = { app, io };