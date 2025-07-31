const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const { getDatabase } = require('../database/init');
const { authenticateToken } = require('../middleware/auth');
const { logAnalyticsEvent } = require('../services/analyticsService');

const router = express.Router();

// Register
router.post('/register', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }),
  body('name').trim().isLength({ min: 1 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password, name } = req.body;
    const db = getDatabase();

    // Check if user exists
    const existingUserResult = await db.query('SELECT id FROM users WHERE email = $1', [email]);
    const existingUser = existingUserResult.rows[0];

    if (existingUser) {
      return res.status(400).json({ error: 'User already exists' });
    }

    // Hash password
    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // Create user
    const userId = uuidv4();
    await db.query(
      'INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, $3, $4)',
      [userId, email, passwordHash, name]
    );

    // Generate JWT
    const token = jwt.sign(
      { userId, email, name },
      process.env.JWT_SECRET || '2f8e7c1a-4b3d-4e9a-9c2a-8e7f1b2c3d4e5f6a7b8c9dee1f2a3b4c',
      { expiresIn: '7d' }
    );

    // Log analytics event
    await logAnalyticsEvent(userId, 'user_registered', { email }, req.ip, req.get('User-Agent'));

    res.status(201).json({
      token,
      user: { id: userId, email, name, role: 'user' }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').exists()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;
    const db = getDatabase();

    // Find user
    const userResult = await db.query(
      'SELECT id, email, password_hash, name, role FROM users WHERE email = $1',
      [email]
    );
    const user = userResult.rows[0];

    if (!user) {
      await logAnalyticsEvent(null, 'login_failed', { email, reason: 'user_not_found' }, req.ip, req.get('User-Agent'));
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      await logAnalyticsEvent(user.id, 'login_failed', { email, reason: 'invalid_password' }, req.ip, req.get('User-Agent'));
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Generate JWT
    const token = jwt.sign(
      { userId: user.id, email: user.email, name: user.name },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '7d' }
    );

    // Log analytics event
    await logAnalyticsEvent(user.id, 'user_login', { email }, req.ip, req.get('User-Agent'));

    res.json({
      token,
      user: { 
        id: user.id, 
        email: user.email, 
        name: user.name, 
        role: user.role 
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Get current user
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase();
    const user = await new Promise((resolve, reject) => {
      db.get(
        'SELECT id, email, name, role, created_at FROM users WHERE id = ?',
        [req.user.userId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(user);
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// Logout (client-side token removal, but log the event)
router.post('/logout', authenticateToken, async (req, res) => {
  try {
    await logAnalyticsEvent(req.user.userId, 'user_logout', {}, req.ip, req.get('User-Agent'));
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Logout failed' });
  }
});

// Update user profile
router.put('/profile', authenticateToken, [
  body('name').optional().trim().isLength({ min: 1 }),
  body('email').optional().isEmail().normalizeEmail()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, email } = req.body;
    const db = getDatabase();

    // Check if email is already taken by another user
    if (email) {
      const existingUser = await new Promise((resolve, reject) => {
        db.get('SELECT id FROM users WHERE email = ? AND id != ?', [email, req.user.userId], (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
      });

      if (existingUser) {
        return res.status(400).json({ error: 'Email already taken' });
      }
    }

    // Build update query
    const updates = [];
    const values = [];
    
    if (name !== undefined) {
      updates.push('name = ?');
      values.push(name);
    }
    
    if (email !== undefined) {
      updates.push('email = ?');
      values.push(email);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(req.user.userId);

    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE users SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        values,
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    // Get updated user data
    const updatedUser = await new Promise((resolve, reject) => {
      db.get(
        'SELECT id, email, name, role, created_at FROM users WHERE id = ?',
        [req.user.userId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    await logAnalyticsEvent(req.user.userId, 'profile_updated', { name, email }, req.ip, req.get('User-Agent'));

    res.json({
      user: updatedUser,
      message: 'Profile updated successfully'
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Get user settings
router.get('/settings', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase();
    const settings = await new Promise((resolve, reject) => {
      db.get(
        'SELECT * FROM user_settings WHERE user_id = ?',
        [req.user.userId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    // Default settings if none exist
    const defaultSettings = {
      theme: 'light',
      currency: 'INR',
      language: 'en-IN',
      data_refresh_interval: 5,
      notifications_portfolio: true,
      notifications_price_alerts: true,
      notifications_risk_alerts: true,
      notifications_email: false,
      notifications_push: true
    };

    res.json(settings || defaultSettings);
  } catch (error) {
    console.error('Get settings error:', error);
    res.status(500).json({ error: 'Failed to get settings' });
  }
});

// Update user settings
router.put('/settings', authenticateToken, async (req, res) => {
  try {
    const {
      theme,
      currency,
      language,
      dataRefreshInterval,
      notifications
    } = req.body;

    const db = getDatabase();

    // Check if settings exist
    const existingSettings = await new Promise((resolve, reject) => {
      db.get(
        'SELECT user_id FROM user_settings WHERE user_id = ?',
        [req.user.userId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    const settingsData = {
      user_id: req.user.userId,
      theme: theme || 'light',
      currency: currency || 'INR',
      language: language || 'en-IN',
      data_refresh_interval: dataRefreshInterval || 5,
      notifications_portfolio: notifications?.portfolio ?? true,
      notifications_price_alerts: notifications?.priceAlerts ?? true,
      notifications_risk_alerts: notifications?.riskAlerts ?? true,
      notifications_email: notifications?.email ?? false,
      notifications_push: notifications?.push ?? true
    };

    if (existingSettings) {
      // Update existing settings
      await new Promise((resolve, reject) => {
        db.run(
          `UPDATE user_settings SET 
           theme = ?, currency = ?, language = ?, data_refresh_interval = ?,
           notifications_portfolio = ?, notifications_price_alerts = ?, 
           notifications_risk_alerts = ?, notifications_email = ?, notifications_push = ?,
           updated_at = CURRENT_TIMESTAMP
           WHERE user_id = ?`,
          [
            settingsData.theme, settingsData.currency, settingsData.language,
            settingsData.data_refresh_interval, settingsData.notifications_portfolio,
            settingsData.notifications_price_alerts, settingsData.notifications_risk_alerts,
            settingsData.notifications_email, settingsData.notifications_push,
            req.user.userId
          ],
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });
    } else {
      // Insert new settings
      await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO user_settings (
            user_id, theme, currency, language, data_refresh_interval,
            notifications_portfolio, notifications_price_alerts, notifications_risk_alerts,
            notifications_email, notifications_push
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            settingsData.user_id, settingsData.theme, settingsData.currency,
            settingsData.language, settingsData.data_refresh_interval,
            settingsData.notifications_portfolio, settingsData.notifications_price_alerts,
            settingsData.notifications_risk_alerts, settingsData.notifications_email,
            settingsData.notifications_push
          ],
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });
    }

    await logAnalyticsEvent(req.user.userId, 'settings_updated', settingsData, req.ip, req.get('User-Agent'));

    res.json({
      settings: settingsData,
      message: 'Settings updated successfully'
    });
  } catch (error) {
    console.error('Update settings error:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

module.exports = router;