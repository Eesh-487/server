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
// Ensure logs directory exists for error logging
const fs = require('fs');
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir);
  console.log('Created logs directory for error logging');
}
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: [
      'https://stocks-frontend-wheat.vercel.app', // Vercel frontend
      'http://localhost:5173',
      'http://192.168.1.9:5173',
      'https://stocks-frontend-git-master-eesh-487s-projects.vercel.app'
    ],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true
  }
});

// Security middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// Configure CORS before other middleware
app.use(cors({
  origin: [
    'https://stocks-frontend-wheat.vercel.app', // Vercel frontend
    'http://localhost:5173',
    'http://192.168.1.9:5173',
    'https://stocks-frontend-git-master-eesh-487s-projects.vercel.app'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// Add fallback CORS headers for preflight requests
app.options('*', (req, res) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.status(200).send();
});

// Rate limiting - Generous limits for development
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10000 // limit each IP to 10,000 requests per windowMs (much higher for development)
});
app.use(limiter);

// Ensure CORS headers are set on all responses
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && [
    'https://stocks-frontend-wheat.vercel.app',
    'http://localhost:5173',
    'http://192.168.1.9:5173',
    'https://stocks-frontend-git-master-eesh-487s-projects.vercel.app'
  ].includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  next();
});

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
// Always return 404 for non-API routes (API-only backend)
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

const PORT = process.env.PORT || 3001;

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