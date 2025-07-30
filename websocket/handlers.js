function setupWebSocketHandlers(io) {
  io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);

    // Handle user authentication
    socket.on('authenticate', (data) => {
      const { userId, token } = data;
      
      // In production, verify the JWT token here
      if (userId && token) {
        socket.userId = userId;
        socket.join(`user_${userId}`);
        console.log(`User ${userId} authenticated and joined room`);
        
        socket.emit('authenticated', { success: true });
      } else {
        socket.emit('authenticated', { success: false, error: 'Invalid credentials' });
      }
    });

    // Handle portfolio subscription
    socket.on('subscribe_portfolio', (data) => {
      if (socket.userId) {
        socket.join(`portfolio_${socket.userId}`);
        console.log(`User ${socket.userId} subscribed to portfolio updates`);
      }
    });

    // Handle market data subscription
    socket.on('subscribe_market_data', (data) => {
      const { symbols } = data;
      if (Array.isArray(symbols)) {
        symbols.forEach(symbol => {
          socket.join(`market_${symbol.toUpperCase()}`);
        });
        console.log(`Client subscribed to market data for: ${symbols.join(', ')}`);
      }
    });

    // Handle unsubscribe from market data
    socket.on('unsubscribe_market_data', (data) => {
      const { symbols } = data;
      if (Array.isArray(symbols)) {
        symbols.forEach(symbol => {
          socket.leave(`market_${symbol.toUpperCase()}`);
        });
        console.log(`Client unsubscribed from market data for: ${symbols.join(', ')}`);
      }
    });

    // Handle real-time analytics subscription
    socket.on('subscribe_analytics', () => {
      if (socket.userId) {
        socket.join(`analytics_${socket.userId}`);
        console.log(`User ${socket.userId} subscribed to analytics updates`);
      }
    });

    // Handle chat/support messages
    socket.on('support_message', (data) => {
      if (socket.userId) {
        const { message, type } = data;
        
        // Log support request
        console.log(`Support request from user ${socket.userId}: ${message}`);
        
        // Echo back acknowledgment
        socket.emit('support_response', {
          message: 'Thank you for your message. Our support team will get back to you shortly.',
          timestamp: new Date().toISOString()
        });

        // Notify admin users (in production, this would be more sophisticated)
        socket.broadcast.to('admin').emit('support_request', {
          userId: socket.userId,
          message,
          type,
          timestamp: new Date().toISOString()
        });
      }
    });

    // Handle ping/pong for connection health
    socket.on('ping', () => {
      socket.emit('pong', { timestamp: new Date().toISOString() });
    });

    // Handle custom events
    socket.on('custom_event', (data) => {
      console.log('Custom event received:', data);
      // Process custom events as needed
    });

    // Handle disconnection
    socket.on('disconnect', (reason) => {
      console.log(`Client disconnected: ${socket.id}, reason: ${reason}`);
      
      if (socket.userId) {
        // Clean up user-specific subscriptions
        socket.leave(`user_${socket.userId}`);
        socket.leave(`portfolio_${socket.userId}`);
        socket.leave(`analytics_${socket.userId}`);
      }
    });

    // Handle connection errors
    socket.on('error', (error) => {
      console.error(`Socket error for ${socket.id}:`, error);
    });
  });

  // Middleware for authentication (optional)
  io.use((socket, next) => {
    // You can add authentication middleware here
    // For now, we'll allow all connections
    next();
  });

  console.log('WebSocket handlers configured');
}

// Helper function to broadcast to specific user
function broadcastToUser(io, userId, event, data) {
  io.to(`user_${userId}`).emit(event, data);
}

// Helper function to broadcast to all users
function broadcastToAll(io, event, data) {
  io.emit(event, data);
}

// Helper function to broadcast market data updates
function broadcastMarketData(io, symbol, data) {
  io.to(`market_${symbol.toUpperCase()}`).emit('market_update', {
    symbol,
    ...data,
    timestamp: new Date().toISOString()
  });
}

module.exports = {
  setupWebSocketHandlers,
  broadcastToUser,
  broadcastToAll,
  broadcastMarketData
};