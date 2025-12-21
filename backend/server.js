const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const winston = require('winston');
const expressWinston = require('express-winston');
const { createClient } = require('@supabase/supabase-js');
const { body, validationResult } = require('express-validator');
const csurf = require('csurf');
require('dotenv').config();

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error('Missing required Supabase environment variables');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey || supabaseAnonKey);

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3001;

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      fontSrc: ["'self'", "data:"],
      connectSrc: ["'self'", supabaseUrl],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// CORS configuration
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5500',
  credentials: true
}));

// Logging
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
  ],
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.simple(),
  }));
}

app.use(expressWinston.logger({
  winstonInstance: logger,
  meta: true,
  msg: "HTTP {{req.method}} {{req.url}}",
  expressFormat: true,
  colorize: false,
}));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-super-secure-session-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    sameSite: 'strict'
  }
}));

// CSRF protection
const csrfProtection = csurf({
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'strict'
  }
});

// Middleware to check authentication
const requireAuth = async (req, res, next) => {
  try {
    const token = req.cookies.supabase_auth_token || req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({ error: 'No authentication token provided' });
    }

    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid authentication token' });
    }

    req.user = user;
    next();
  } catch (error) {
    logger.error('Auth middleware error:', error);
    res.status(500).json({ error: 'Authentication error' });
  }
};

// Routes

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Get CSRF token
app.get('/csrf-token', csrfProtection, (req, res) => {
  res.json({ csrfToken: req.csrfToken() });
});

// Authentication routes
app.post('/auth/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;

    logger.info(`Login attempt for email: ${email}`);

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password
    });

    if (error) {
      logger.warn(`Login failed for ${email}: ${error.message}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Set httpOnly cookie with session token
    res.cookie('supabase_auth_token', data.session.access_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000 // 24 hours
    });

    logger.info(`Login successful for user: ${data.user.id}`);
    res.json({
      user: {
        id: data.user.id,
        email: data.user.email,
        username: data.user.user_metadata?.username
      }
    });
  } catch (error) {
    logger.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/auth/register', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }),
  body('username').trim().isLength({ min: 2, max: 50 }).matches(/^[a-zA-Z0-9_]+$/),
  body('country').optional().isIn(['kz']),
  body('city').optional().isIn(['almaty', 'astana', 'shymkent', 'other'])
], csrfProtection, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password, username, country, city } = req.body;

    logger.info(`Registration attempt for email: ${email}, username: ${username}`);

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          username,
          country: country || 'kz',
          city: city || 'almaty'
        }
      }
    });

    if (error) {
      logger.warn(`Registration failed for ${email}: ${error.message}`);
      return res.status(400).json({ error: error.message });
    }

    logger.info(`Registration successful for user: ${data.user.id}`);
    res.json({
      message: 'Registration successful. Please check your email for verification.',
      user: {
        id: data.user.id,
        email: data.user.email,
        username: data.user.user_metadata?.username
      }
    });
  } catch (error) {
    logger.error('Registration error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/auth/logout', requireAuth, async (req, res) => {
  try {
    const { error } = await supabase.auth.signOut();

    if (error) {
      logger.warn(`Logout error for user ${req.user.id}: ${error.message}`);
    }

    // Clear the auth cookie
    res.clearCookie('supabase_auth_token');

    logger.info(`Logout successful for user: ${req.user.id}`);
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    logger.error('Logout error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Protected routes
app.get('/auth/me', requireAuth, (req, res) => {
  res.json({
    user: {
      id: req.user.id,
      email: req.user.email,
      username: req.user.user_metadata?.username,
      country: req.user.user_metadata?.country,
      city: req.user.user_metadata?.city
    }
  });
});

// Materials API
app.get('/api/materials', requireAuth, async (req, res) => {
  try {
    const { subject, type } = req.query;

    let query = supabase
      .from('materials')
      .select('*')
      .eq('user_id', req.user.id);

    if (subject && subject !== 'all') {
      query = query.eq('subject', subject);
    }

    if (type && type !== 'all') {
      query = query.eq('type', type);
    }

    const { data, error } = await query.order('created_at', { ascending: false });

    if (error) {
      logger.error('Error fetching materials:', error);
      return res.status(500).json({ error: 'Failed to fetch materials' });
    }

    res.json({ materials: data });
  } catch (error) {
    logger.error('Materials fetch error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/materials', [
  requireAuth,
  body('title').trim().isLength({ min: 1, max: 200 }),
  body('content').trim().isLength({ min: 1 }),
  body('subject').isIn(['history_kz', 'math_lit', 'reading', 'math', 'physics', 'chemistry', 'biology', 'geography', 'world_history', 'english', 'informatics', 'other']),
  body('type').isIn(['material', 'test']),
  body('is_public').isBoolean()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { title, content, subject, type, is_public } = req.body;

    const { data, error } = await supabase
      .from('materials')
      .insert([{
        user_id: req.user.id,
        title,
        content,
        subject,
        type,
        is_public
      }])
      .select()
      .single();

    if (error) {
      logger.error('Error creating material:', error);
      return res.status(500).json({ error: 'Failed to create material' });
    }

    logger.info(`Material created by user ${req.user.id}: ${data.id}`);
    res.status(201).json({ material: data });
  } catch (error) {
    logger.error('Material creation error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Favorites API
app.get('/api/favorites', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('favorites')
      .select(`
        *,
        materials (*)
      `)
      .eq('user_id', req.user.id);

    if (error) {
      logger.error('Error fetching favorites:', error);
      return res.status(500).json({ error: 'Failed to fetch favorites' });
    }

    res.json({ favorites: data });
  } catch (error) {
    logger.error('Favorites fetch error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Profile API
app.get('/api/profile', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('user_id', req.user.id)
      .single();

    if (error && error.code !== 'PGRST116') { // PGRST116 = no rows returned
      logger.error('Error fetching profile:', error);
      return res.status(500).json({ error: 'Failed to fetch profile' });
    }

    res.json({ profile: data });
  } catch (error) {
    logger.error('Profile fetch error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/profile', [
  requireAuth,
  body('username').optional().trim().isLength({ min: 2, max: 50 }).matches(/^[a-zA-Z0-9_]+$/),
  body('country').optional().isIn(['kz']),
  body('city').optional().isIn(['almaty', 'astana', 'shymkent', 'other']),
  body('school').optional().trim().isLength({ min: 2, max: 100 }),
  body('class_number').optional().isInt({ min: 1, max: 12 }),
  body('class_letter').optional().isIn(['А', 'Ә', 'Б', 'В', 'Г', 'Ғ', 'Д', 'Е', 'Ж', 'З', 'И', 'К', 'Л', 'М', 'Н', 'О', 'Ө', 'П', 'Р', 'С', 'Т', 'У', 'Ұ', 'Ү', 'Ф', 'Х', 'Ц', 'Ч', 'Ш', 'Щ', 'Ъ', 'Ы', 'І', 'Ь', 'Э', 'Ю', 'Я']),
  body('subject1').optional().isIn(['math', 'physics', 'chemistry', 'biology', 'geography', 'world_history', 'english', 'informatics']),
  body('subject2').optional().isIn(['math', 'physics', 'chemistry', 'biology', 'geography', 'world_history', 'english', 'informatics'])
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const updateData = {};
    const allowedFields = ['username', 'country', 'city', 'school', 'class_number', 'class_letter', 'subject1', 'subject2'];

    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) {
        updateData[field] = req.body[field];
      }
    });

    const { data, error } = await supabase
      .from('profiles')
      .upsert({
        user_id: req.user.id,
        ...updateData,
        updated_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) {
      logger.error('Error updating profile:', error);
      return res.status(500).json({ error: 'Failed to update profile' });
    }

    logger.info(`Profile updated for user ${req.user.id}`);
    res.json({ profile: data });
  } catch (error) {
    logger.error('Profile update error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  if (err.code === 'EBADCSRFTOKEN') {
    logger.warn(`CSRF token validation failed for ${req.ip}`);
    return res.status(403).json({ error: 'Invalid CSRF token' });
  }

  logger.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Start server
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT} in ${process.env.NODE_ENV} mode`);
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});

module.exports = app;
