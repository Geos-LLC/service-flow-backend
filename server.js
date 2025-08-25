const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const validator = require('validator');
const nodemailer = require('nodemailer');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cron = require('node-cron');
const https = require('https');
const crypto = require('crypto');
require('dotenv').config();

// Email configuration with fallback
let transporter;

function createTransporter() {
  return nodemailer.createTransport({
    service: process.env.EMAIL_SERVICE || 'gmail',
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: process.env.EMAIL_PORT || 587,
    secure: false, // use TLS with STARTTLS
    auth: {
      user: process.env.EMAIL_USER || 'wevbest@gmail.com',
      pass: process.env.EMAIL_PASSWORD || 'qqsf nruc uosc twwc'
    },
    tls: {
      rejectUnauthorized: false
    },
    connectionTimeout: 60000, // 60 seconds
    greetingTimeout: 30000, // 30 seconds
    socketTimeout: 60000 // 60 seconds
  });
}

transporter = createTransporter();



// Test email configuration
async function testEmailConnection() {
  try {
    console.log('Testing email connection...');
    console.log('Email config:', {
      service: process.env.EMAIL_SERVICE || 'gmail',
      host: process.env.EMAIL_HOST || 'smtp.gmail.com',
      port: process.env.EMAIL_PORT || 587,
      user: process.env.EMAIL_USER || 'wevbest@gmail.com',
      hasPassword: !!process.env.EMAIL_PASSWORD
    });
    
    await transporter.verify();
    console.log('Email connection verified successfully');
    return true;
  } catch (error) {
    console.error('Email connection test failed:', error);
    console.error('Error details:', {
      message: error.message,
      code: error.code,
      command: error.command,
      responseCode: error.responseCode
    });
    return false;
  }
}

// Test email connection on startup
testEmailConnection();

// Cron job for recurring billing
cron.schedule('0 9 * * *', async () => {
  console.log('Running recurring billing check...');
  try {
    const connection = await pool.getConnection();
    const [recurringJobs] = await connection.query(`
      SELECT j.*, c.email, c.first_name, c.last_name, s.name as service_name, s.price
      FROM jobs j
      JOIN customers c ON j.customer_id = c.id
      JOIN services s ON j.service_id = s.id
      WHERE j.is_recurring = 1 
      AND j.next_billing_date <= CURDATE()
      AND j.status = 'completed'
    `);
    
    for (const job of recurringJobs) {
      // Create new job for recurring service
      await connection.query(`
        INSERT INTO jobs (user_id, customer_id, service_id, scheduled_date, notes, status, is_recurring, recurring_frequency)
        VALUES (?, ?, ?, DATE_ADD(CURDATE(), INTERVAL ? DAY), ?, 'pending', 1, ?)
      `, [job.user_id, job.customer_id, job.service_id, job.recurring_frequency, job.notes, job.recurring_frequency]);
      
      // Update next billing date
      await connection.query(`
        UPDATE jobs SET next_billing_date = DATE_ADD(next_billing_date, INTERVAL ? DAY)
        WHERE id = ?
      `, [job.recurring_frequency, job.id]);
      
      // Send email notification
      await sendEmail({
        to: job.email,
        subject: 'Recurring Service Scheduled',
        html: `
          <h2>Your recurring service has been scheduled</h2>
          <p>Hello ${job.first_name},</p>
          <p>Your recurring ${job.service_name} service has been scheduled for ${new Date().toLocaleDateString()}.</p>
          <p>Service: ${job.service_name}</p>
          <p>Price: $${job.price}</p>
          <p>Thank you for choosing our services!</p>
        `
      });
    }
    
    connection.release();
  } catch (error) {
    console.error('Recurring billing error:', error);
  }
});

// Email sending function
async function sendEmail({ to, subject, html, text }) {
  try {
    console.log('Attempting to send email to:', to);
    console.log('Email configuration:', {
      service: process.env.EMAIL_SERVICE || 'gmail',
      user: process.env.EMAIL_USER || 'wevbest@gmail.com',
      from: process.env.EMAIL_USER || 'wevbest@gmail.com'
    });
    
    const mailOptions = {
      from: process.env.EMAIL_USER || 'wevbest@gmail.com',
      to,
      subject,
      html,
      text
    };
    
    console.log('Mail options:', { to, subject, from: mailOptions.from });
    
    const info = await transporter.sendMail(mailOptions);
    console.log('Email sent successfully:', info.messageId);
    return info;
  } catch (error) {
    console.error('Email sending error:', error);
    console.error('Email error details:', {
      message: error.message,
      code: error.code,
      command: error.command,
      responseCode: error.responseCode,
      response: error.response
    });
    throw error;
  }
}

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';

// Security middleware
app.use(helmet());

// Rate limiting
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // limit each IP to 10 requests per windowMs
  message: 'Too many authentication attempts, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  skipFailedRequests: false,
});

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200, // limit each IP to 200 requests per windowMs
  message: 'Too many requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
  skipFailedRequests: false,
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500, // limit each IP to 500 requests per windowMs for API endpoints
  message: 'Too many API requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
  skipFailedRequests: false,
});

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// File upload configuration
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'profile-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  },
  fileFilter: function (req, file, cb) {
    // Accept only image files
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'), false);
    }
  }
});

// CORS configuration - Allow all origins
const corsOptions = {
  origin: true, // Allow all origins
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin', 'Cache-Control'],
  exposedHeaders: ['Content-Length', 'X-Requested-With'],
  preflightContinue: false,
  optionsSuccessStatus: 204
};

// Middleware
app.use(cors(corsOptions));

// Handle preflight requests
app.options('*', cors(corsOptions));

// Add CORS headers to all responses - Allow all origins
app.use((req, res, next) => {
  // Set CORS headers for all responses
  const origin = req.headers.origin;
  
  // Allow all origins
  if (origin) {
    res.header('Access-Control-Allow-Origin', origin);
  } else {
    // If no origin header, allow all (for non-browser requests)
    res.header('Access-Control-Allow-Origin', '*');
  }
  
  // Set standard CORS headers
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin, Cache-Control');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Max-Age', '86400'); // Cache preflight for 24 hours
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    console.log('🔄 Handling OPTIONS preflight request for:', req.path);
    res.status(204).send();
    return;
  }
  
  // Log all requests for debugging
  console.log('📡 Request received:', req.method, req.path, req.query);
  
  next();
});

// Define public routes that don't require authentication
const publicRoutes = [
  '/api/health',
  '/api/test-cors',
  '/api/auth/signup',
  '/api/auth/signin',
  '/api/public/services',
  '/api/public/availability',
  '/api/public/bookings',
  '/api/public/business-info',
  '/api/services',
  '/api/services/:id',
  '/api/team',
  '/api/estimates',
  '/api/estimates/:id',
  '/api/territories',
  '/api/territories/:id',
  '/api/territories/detect',
  '/api/territories/:id/team-members',
  '/api/territories/:id/business-hours',
  '/api/territories/:id/pricing',
  '/api/invoices',
  '/api/invoices/:id',
  '/api/analytics/overview',
  '/api/analytics/revenue',
  '/api/analytics/team-performance',
  '/api/analytics/customer-insights',
  '/api/analytics/service-performance',
  '/api/territories/:id/analytics',
  '/api/user/service-areas',
  '/api/service-templates',
  '/api/services/:serviceId/availability',
  '/api/job-templates',
  '/api/team-members',
  '/api/team-members/:id',
  '/api/customers',
  '/api/customers/:customerId/notifications',
  '/api/customers/:customerId/notifications/history',
  '/api/user/profile',
  '/api/user/password',
  '/api/user/email',
  '/api/user/profile-picture',
  '/api/user/billing',
  '/api/user/payment-settings',
  '/api/user/payment-methods',
  '/api/user/payment-methods/:id',
  '/api/user/payment-processor/setup',
  '/api/user/availability',
  '/api/user/service-areas',
  '/api/jobs',
  '/api/jobs/:id',
  '/api/jobs/:jobId/assign',
  '/api/jobs/:jobId/assign/:teamMemberId',
  '/api/jobs/:jobId/assignments',
  '/api/jobs/:jobId/assign-multiple',
  '/api/team-members/:id/availability',
  '/api/team-members/login',
  '/api/team-members/register',
  '/api/team-members/logout',
  '/api/team-members/:id/resend-invite',
  '/api/team-members/dashboard/:teamMemberId',
  '/api/team-members/jobs/:jobId/status',
  '/api/team-analytics',
  '/api/team-members/:id/performance',
  '/api/team-members/:id/settings'
];

// Add OPTIONS handlers for all public routes
publicRoutes.forEach(route => {
  app.options(route, (req, res) => {
    res.status(204).send();
  });
});

// Add specific OPTIONS handlers for key endpoints that might be missing them
app.options('/api/team', (req, res) => res.status(204).send());
app.options('/api/estimates', (req, res) => res.status(204).send());
app.options('/api/estimates/:id', (req, res) => res.status(204).send());
app.options('/api/territories', (req, res) => res.status(204).send());
app.options('/api/territories/:id', (req, res) => res.status(204).send());
app.options('/api/invoices', (req, res) => res.status(204).send());
app.options('/api/invoices/:id', (req, res) => res.status(204).send());
app.options('/api/analytics/overview', (req, res) => res.status(204).send());
app.options('/api/analytics/revenue', (req, res) => res.status(204).send());
app.options('/api/team-members', (req, res) => res.status(204).send());
app.options('/api/team-members/:id', (req, res) => res.status(204).send());
app.options('/api/customers', (req, res) => res.status(204).send());
app.options('/api/service-templates', (req, res) => res.status(204).send());
app.options('/api/job-templates', (req, res) => res.status(204).send());
app.options('/api/user/profile', (req, res) => res.status(204).send());
app.options('/api/user/password', (req, res) => res.status(204).send());
app.options('/api/user/email', (req, res) => res.status(204).send());
app.options('/api/user/profile-picture', (req, res) => res.status(204).send());
app.options('/api/user/billing', (req, res) => res.status(204).send());
app.options('/api/user/payment-settings', (req, res) => res.status(204).send());
app.options('/api/user/payment-methods', (req, res) => res.status(204).send());
app.options('/api/user/payment-methods/:id', (req, res) => res.status(204).send());
app.options('/api/user/payment-processor/setup', (req, res) => res.status(204).send());
app.options('/api/user/availability', (req, res) => res.status(204).send());
app.options('/api/user/service-areas', (req, res) => res.status(204).send());

// Add OPTIONS handlers for jobs endpoints
app.options('/api/jobs', (req, res) => res.status(204).send());
app.options('/api/jobs/:id', (req, res) => res.status(204).send());
app.options('/api/jobs/:jobId/assign', (req, res) => res.status(204).send());
app.options('/api/jobs/:jobId/assign/:teamMemberId', (req, res) => res.status(204).send());
app.options('/api/jobs/:jobId/assignments', (req, res) => res.status(204).send());
app.options('/api/jobs/:jobId/assign-multiple', (req, res) => res.status(204).send());

// Add OPTIONS handlers for additional team member endpoints
app.options('/api/team-members/:id/availability', (req, res) => res.status(204).send());
app.options('/api/team-members/login', (req, res) => res.status(204).send());
app.options('/api/team-members/register', (req, res) => res.status(204).send());
app.options('/api/team-members/logout', (req, res) => res.status(204).send());
app.options('/api/team-members/:id/resend-invite', (req, res) => res.status(204).send());
app.options('/api/team-members/dashboard/:teamMemberId', (req, res) => res.status(204).send());
app.options('/api/team-members/jobs/:jobId/status', (req, res) => res.status(204).send());
app.options('/api/team-analytics', (req, res) => res.status(204).send());
app.options('/api/team-members/:id/performance', (req, res) => res.status(204).send());
app.options('/api/team-members/:id/settings', (req, res) => res.status(204).send());

// Add a more specific OPTIONS handler for team-members endpoint
app.options('/api/team-members', (req, res) => {
  console.log('🔄 Handling OPTIONS request for /api/team-members');
  res.status(204).send();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Apply rate limiting
app.use('/api/auth', authLimiter);
app.use('/api/jobs', apiLimiter); // Higher limit for jobs API
app.use('/api', generalLimiter);

// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Database connection pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'nowcodeo_Justweb1',
  password: process.env.DB_PASSWORD || 'Just web08107370125',
  database: process.env.DB_NAME || 'nowcodeo_zenbooker'
});

// Test database connection
pool.getConnection()
  .then(connection => {
    console.log('Database connected successfully');
    console.log('Database config:', {
      host: process.env.DB_HOST || '127.0.0.1',
      database: process.env.DB_NAME || 'nowcodeo_zenbooker',
      port: process.env.DB_PORT || 3306
    });
    connection.release();
  })
  .catch(err => {
    console.error('Database connection failed:', err);
    console.error('Database connection error details:', {
      message: err.message,
      code: err.code,
      errno: err.errno
    });
  });

// Authentication middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  console.log('Auth check - Header:', authHeader ? 'Present' : 'Missing');
  console.log('Auth check - Token:', token ? 'Present' : 'Missing');
  console.log('Auth check - Origin:', req.headers.origin);
  console.log('Auth check - User-Agent:', req.headers['user-agent']);

  if (!token) {
    console.log('Auth failed - No token provided');
    return res.status(401).json({ 
      error: 'Access token required',
      message: 'Please log in to access this resource'
    });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      console.log('Auth failed - Token verification error:', err.message);
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ 
          error: 'Token expired',
          message: 'Your session has expired. Please log in again.'
        });
      } else if (err.name === 'JsonWebTokenError') {
        return res.status(403).json({ 
          error: 'Invalid token',
          message: 'Invalid authentication token. Please log in again.'
        });
      } else {
        return res.status(403).json({ 
          error: 'Token verification failed',
          message: 'Authentication failed. Please log in again.'
        });
      }
    }
    console.log('Auth successful - User ID:', user.userId);
    req.user = user;
    next();
  });
};

// Input validation helpers
const validateEmail = (email) => {
  return validator.isEmail(email) && email.length <= 255;
};

const validatePassword = (password) => {
  return password && password.length >= 8 && password.length <= 128;
};

const validateName = (name) => {
  return name && name.trim().length >= 2 && name.trim().length <= 50;
};

const sanitizeInput = (input) => {
  if (typeof input !== 'string') return input;
  return validator.escape(input.trim());
};

// Calculate distance between two points using Haversine formula
const calculateDistance = (lat1, lon1, lat2, lon2) => {
  const R = 3959 // Earth's radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon/2) * Math.sin(dLon/2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
  return R * c
}

// Health check endpoint
app.get('/api/health', async (req, res) => {
  try {
    // Test database connection
    const connection = await pool.getConnection();
    connection.release();
    
    res.json({ status: 'OK', message: 'Server is healthy' });
  } catch (error) {
    console.error('Health check error:', error);
    res.status(500).json({ status: 'ERROR', message: 'Server is not healthy' });
  }
});

// User authentication endpoints
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password, firstName, lastName, businessName } = req.body;
    
    // Input validation
    if (!validateEmail(email)) {
      return res.status(400).json({ error: 'Please provide a valid email address' });
    }
    
    if (!validatePassword(password)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long' });
    }
    
    if (!validateName(firstName) || !validateName(lastName)) {
      return res.status(400).json({ error: 'First and last names must be between 2 and 50 characters' });
    }
    
    if (!businessName || businessName.trim().length < 2 || businessName.trim().length > 100) {
      return res.status(400).json({ error: 'Business name must be between 2 and 100 characters' });
    }
    
    // Sanitize inputs
    const sanitizedEmail = email.toLowerCase().trim();
    const sanitizedFirstName = sanitizeInput(firstName);
    const sanitizedLastName = sanitizeInput(lastName);
    const sanitizedBusinessName = sanitizeInput(businessName);
    
    const connection = await pool.getConnection();
    
    try {
      // Check if user already exists
      const [existingUsers] = await connection.query(
        'SELECT id FROM users WHERE email = ?',
        [sanitizedEmail]
      );
      
      if (existingUsers.length > 0) {
        return res.status(400).json({ error: 'An account with this email already exists' });
      }
      
      // Hash password
      const saltRounds = 12;
      const hashedPassword = await bcrypt.hash(password, saltRounds);
      
      // Create new user
      const [result] = await connection.query(
        'INSERT INTO users (email, password, first_name, last_name, business_name, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
        [sanitizedEmail, hashedPassword, sanitizedFirstName, sanitizedLastName, sanitizedBusinessName]
      );
      
      // Generate JWT token
      const token = jwt.sign(
        { 
          userId: result.insertId, 
          email: sanitizedEmail,
          firstName: sanitizedFirstName,
          lastName: sanitizedLastName,
          businessName: sanitizedBusinessName
        },
        JWT_SECRET,
        { expiresIn: '1d' }
      );
      
      res.status(201).json({ 
        message: 'Account created successfully',
        token,
        user: {
          id: result.insertId,
          email: sanitizedEmail,
          firstName: sanitizedFirstName,
          lastName: sanitizedLastName,
          businessName: sanitizedBusinessName
        }
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ error: 'Failed to create account. Please try again.' });
  }
});

app.post('/api/auth/signin', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    // Input validation
    if (!validateEmail(email)) {
      return res.status(400).json({ error: 'Please provide a valid email address' });
    }
    
    if (!password || password.length < 1) {
      return res.status(400).json({ error: 'Password is required' });
    }
    
    // Sanitize email
    const sanitizedEmail = email.toLowerCase().trim();
    
    const connection = await pool.getConnection();
    
    try {
      // Get user with hashed password
      const [users] = await connection.query(
        'SELECT id, email, password, first_name, last_name, business_name FROM users WHERE email = ?',
        [sanitizedEmail]
      );
      
      if (users.length === 0) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }
      
      const user = users[0];
      
      // Verify password
      const isPasswordValid = await bcrypt.compare(password, user.password);
      
      if (!isPasswordValid) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }
      
      // Generate JWT token
      const token = jwt.sign(
        { 
          userId: user.id, 
          email: user.email,
          firstName: user.first_name,
          lastName: user.last_name,
          businessName: user.business_name
        },
        JWT_SECRET,
        { expiresIn: '1d' }
      );
      
      res.json({ 
        message: 'Login successful',
        token,
        user: {
          id: user.id,
          email: user.email,
          firstName: user.first_name,
          lastName: user.last_name,
          businessName: user.business_name,
          business_name: user.business_name // Add both for compatibility
        }
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Signin error:', error);
    console.error('Error details:', {
      message: error.message,
      stack: error.stack,
      code: error.code,
      errno: error.errno
    });
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// Token refresh endpoint
app.post('/api/auth/refresh', authenticateToken, async (req, res) => {
  try {
    const connection = await pool.getConnection();
    
    try {
      // Get updated user data
      const [users] = await connection.query(
        'SELECT id, email, first_name, last_name, business_name FROM users WHERE id = ?',
        [req.user.userId]
      );
      
      if (users.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }
      
      const user = users[0];
      
      // Generate new token
      const token = jwt.sign(
        { 
          userId: user.id, 
          email: user.email,
          firstName: user.first_name,
          lastName: user.last_name,
          businessName: user.business_name
        },
        JWT_SECRET,
        { expiresIn: '1d' }
      );
      
      res.json({ 
        message: 'Token refreshed successfully',
        token,
        user: {
          id: user.id,
          email: user.email,
          firstName: user.first_name,
          lastName: user.last_name,
          businessName: user.business_name
        }
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Token refresh error:', error);
    res.status(500).json({ error: 'Failed to refresh token' });
  }
});

// Logout endpoint (client-side token removal)
app.post('/api/auth/logout', authenticateToken, async (req, res) => {
  try {
    // In a more advanced setup, you might want to blacklist the token
    // For now, we'll just return success and let the client remove the token
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Logout failed' });
  }
});

// Verify token endpoint
app.get('/api/auth/verify', authenticateToken, async (req, res) => {
  try {
    const connection = await pool.getConnection();
    
    try {
      const [users] = await connection.query(
        'SELECT id, email, first_name, last_name, business_name FROM users WHERE id = ?',
        [req.user.userId]
      );
      
      if (users.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }
      
      const user = users[0];
      
      res.json({ 
        message: 'Token is valid',
        user: {
          id: user.id,
          email: user.email,
          firstName: user.first_name,
          lastName: user.last_name,
          businessName: user.business_name
        }
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Token verification error:', error);
    res.status(500).json({ error: 'Token verification failed' });
  }
});

// Services endpoints
app.get('/api/services', async (req, res) => {
  try {
    const { userId, search, page = 1, limit = 20, sortBy = 'name', sortOrder = 'ASC' } = req.query;
    
    console.log('🔄 Backend: Services request received');
    console.log('🔄 Backend: User ID:', userId);
    console.log('🔄 Backend: All query params:', req.query);
    
    const connection = await pool.getConnection();
    
    try {
      let query = `
        SELECT 
          id,
          user_id,
          name,
          description,
          price,
          duration,
          category,
          category_id,
          modifiers,
          intake_questions,
          require_payment_method,
          image,
          created_at,
          updated_at
        FROM services
        WHERE user_id = ?
      `;
      let params = [userId];
      
      if (search) {
        query += ' AND (name LIKE ? OR description LIKE ?)';
        const searchTerm = `%${search}%`;
        params.push(searchTerm, searchTerm);
      }
      
      // Add sorting
      query += ` ORDER BY ${sortBy} ${sortOrder}`;
      
      // Add pagination
      const offset = (page - 1) * limit;
      query += ` LIMIT ? OFFSET ?`;
      params.push(parseInt(limit), offset);
      
      const [services] = await connection.query(query, params);
      
      // Get total count for pagination
      let countQuery = `
        SELECT COUNT(*) as total
        FROM services
        WHERE user_id = ?
      `;
      let countParams = [userId];
      
      if (search) {
        countQuery += ' AND (name LIKE ? OR description LIKE ?)';
        const searchTerm = `%${search}%`;
        countParams.push(searchTerm, searchTerm);
      }
      
      const [countResult] = await connection.query(countQuery, countParams);
      const total = countResult[0].total;
      
      res.json({
        services,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / limit)
        }
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Get services error:', error);
    res.status(500).json({ error: 'Failed to get services' });
  }
});

// Individual service endpoints
app.get('/api/services/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    
    const connection = await pool.getConnection();
    
    try {
      const [services] = await connection.query(
        'SELECT * FROM services WHERE id = ? AND user_id = ?',
        [id, userId]
      );
      
      if (services.length === 0) {
        return res.status(404).json({ error: 'Service not found' });
      }
      
      const service = services[0];
      
      // Debug logging for modifiers
      console.log('🔍 Service endpoint - Raw service data:', {
        id: service.id,
        name: service.name,
        modifiers: service.modifiers,
        modifiersType: typeof service.modifiers,
        modifiersLength: service.modifiers ? service.modifiers.length : 'null/undefined'
      });
      
      // Special debug for service ID 38
      if (service.id == 38) {
        console.log('🔍 Service 38 - Special debug:');
        console.log('🔍 Service 38 - All fields:', Object.keys(service));
        console.log('🔍 Service 38 - Modifiers field:', service.modifiers);
        console.log('🔍 Service 38 - Modifiers field type:', typeof service.modifiers);
        console.log('🔍 Service 38 - Modifiers field value:', JSON.stringify(service.modifiers));
        
        // Try to query the database directly for this service
        try {
          const [directQuery] = await connection.query(
            'SELECT id, name, modifiers FROM services WHERE id = 38'
          );
          console.log('🔍 Service 38 - Direct database query result:', directQuery);
        } catch (error) {
          console.log('🔍 Service 38 - Direct query error:', error.message);
        }
      }
      
      if (service.modifiers) {
        try {
          const parsedModifiers = JSON.parse(service.modifiers);
          console.log('🔍 Service endpoint - Parsed modifiers:', parsedModifiers);
          console.log('🔍 Service endpoint - Is array?', Array.isArray(parsedModifiers));
          console.log('🔍 Service endpoint - Parsed modifiers length:', Array.isArray(parsedModifiers) ? parsedModifiers.length : 'not an array');
        } catch (error) {
          console.log('🔍 Service endpoint - Error parsing modifiers:', error.message);
          console.log('🔍 Service endpoint - Raw modifiers string:', service.modifiers);
        }
      } else {
        console.log('🔍 Service endpoint - No modifiers field or modifiers is null/undefined');
      }
      
      res.json(service);
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Get service error:', error);
    res.status(500).json({ error: 'Failed to fetch service' });
  }
});

app.post('/api/services', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { name, description, price, duration, category, modifiers, intake_questions, require_payment_method, image } = req.body;
    
    // Input validation
    if (!name || name.trim().length < 1) {
      return res.status(400).json({ error: 'Service name is required' });
    }
    
    if (price && (isNaN(price) || price < 0)) {
      return res.status(400).json({ error: 'Price must be a positive number' });
    }
    
    if (duration && (isNaN(duration) || duration < 1)) {
      return res.status(400).json({ error: 'Duration must be a positive number' });
    }
    
    // Sanitize inputs
    const sanitizedName = sanitizeInput(name);
    const sanitizedDescription = description ? sanitizeInput(description) : null;
    const sanitizedCategory = category ? sanitizeInput(category) : null;
    
    const connection = await pool.getConnection();
    
    try {
      // Create new service
      const [result] = await connection.query(
        'INSERT INTO services (user_id, name, description, price, duration, category, modifiers, intake_questions, require_payment_method, image, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())',
        [userId, sanitizedName, sanitizedDescription, price || 0, duration || 60, sanitizedCategory, modifiers ? JSON.stringify(modifiers) : null, intake_questions ? JSON.stringify(intake_questions) : null, require_payment_method || false, image]
      );
      
      // Get the created service
      const [services] = await connection.query(
        'SELECT * FROM services WHERE id = ?',
        [result.insertId]
      );
      
      res.status(201).json({
        message: 'Service created successfully',
        service: services[0]
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Create service error:', error);
    res.status(500).json({ error: 'Failed to create service' });
  }
});

app.put('/api/services/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    const { name, description, price, duration, category, modifiers, intake_questions, require_payment_method, image } = req.body;
    
    // Input validation
    if (!name || name.trim().length < 1) {
      return res.status(400).json({ error: 'Service name is required' });
    }
    
    if (price && (isNaN(price) || price < 0)) {
      return res.status(400).json({ error: 'Price must be a positive number' });
    }
    
    if (duration && (isNaN(duration) || duration < 1)) {
      return res.status(400).json({ error: 'Duration must be a positive number' });
    }
    
    // Sanitize inputs
    const sanitizedName = sanitizeInput(name);
    const sanitizedDescription = description ? sanitizeInput(description) : null;
    const sanitizedCategory = category ? sanitizeInput(category) : null;
    
    const connection = await pool.getConnection();
    
    try {
      // Check if service exists and belongs to user
      const [existingServices] = await connection.query(
        'SELECT id FROM services WHERE id = ? AND user_id = ?',
        [id, userId]
      );
      
      if (existingServices.length === 0) {
        return res.status(404).json({ error: 'Service not found' });
      }
      
      // Update service
      await connection.query(
        'UPDATE services SET name = ?, description = ?, price = ?, duration = ?, category = ?, modifiers = ?, intake_questions = ?, require_payment_method = ?, image = ?, updated_at = NOW() WHERE id = ? AND user_id = ?',
        [sanitizedName, sanitizedDescription, price || 0, duration || 60, sanitizedCategory, modifiers ? JSON.stringify(modifiers) : null, intake_questions ? JSON.stringify(intake_questions) : null, require_payment_method || false, image, id, userId]
      );
      
      // Get the updated service
      const [services] = await connection.query(
        'SELECT * FROM services WHERE id = ?',
        [id]
      );
      
      res.json({
        message: 'Service updated successfully',
        service: services[0]
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Update service error:', error);
    res.status(500).json({ error: 'Failed to update service' });
  }
});

app.delete('/api/services/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    
    const connection = await pool.getConnection();
    
    try {
      // Check if service exists and belongs to user
      const [existingServices] = await connection.query(
        'SELECT id FROM services WHERE id = ? AND user_id = ?',
        [id, userId]
      );
      
      if (existingServices.length === 0) {
        return res.status(404).json({ error: 'Service not found' });
      }
      
      // Check if service is being used in any jobs
      const [jobsUsingService] = await connection.query(
        'SELECT COUNT(*) as count FROM jobs WHERE service_id = ?',
        [id]
      );
      
      if (jobsUsingService[0].count > 0) {
        return res.status(400).json({ error: 'Cannot delete service that is being used in jobs' });
      }
      
      // Delete service
      await connection.query(
        'DELETE FROM services WHERE id = ? AND user_id = ?',
        [id, userId]
      );
      
      res.json({ message: 'Service deleted successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Delete service error:', error);
    res.status(500).json({ error: 'Failed to delete service' });
  }
});

// Jobs endpoints
app.get('/api/jobs', authenticateToken, async (req, res) => {
  // Set CORS headers explicitly
  const origin = req.headers.origin;
  if (origin) {
    res.header('Access-Control-Allow-Origin', origin);
  } else {
    res.header('Access-Control-Allow-Origin', '*');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin, Cache-Control');
  res.header('Access-Control-Allow-Credentials', 'true');
  
  try {
    const { userId, status, search, page = 1, limit = 20, dateRange, dateFilter, sortBy = 'scheduled_date', sortOrder = 'ASC', teamMember, invoiceStatus, customerId, territoryId } = req.query;
    
    console.log('🔄 Backend: Jobs request received');
    console.log('🔄 Backend: User ID:', userId);
    console.log('🔄 Backend: Status filter:', status);
    console.log('🔄 Backend: Date filter:', dateFilter);
    console.log('🔄 Backend: All query params:', req.query);
    const connection = await pool.getConnection();
    
    try {
      let query = `
        SELECT 
          j.id,
          j.user_id,
          j.customer_id,
          j.service_id,
          j.team_member_id,
          j.territory_id,
          j.notes,
          j.status,
          j.invoice_status,
          j.invoice_id,
          j.invoice_amount,
          j.invoice_date,
          j.payment_date,
          j.created_at,
          j.updated_at,
          j.is_recurring,
          j.recurring_frequency,
          j.next_billing_date,
          j.stripe_payment_intent_id,
          DATE_FORMAT(j.scheduled_date, '%Y-%m-%d %H:%i:%s') as scheduled_date,
          c.first_name as customer_first_name,
          c.last_name as customer_last_name,
          c.email as customer_email,
          c.phone as customer_phone,
          c.address as customer_address,
          c.city as customer_city,
          c.state as customer_state,
          c.zip_code as customer_zip_code,
          COALESCE(s.name, 'Service Not Available') as service_name,
          COALESCE(s.price, 0.00) as service_price,
          COALESCE(s.duration, 60) as service_duration,
          tm.first_name as team_member_first_name,
          tm.last_name as team_member_last_name,
          tm.email as team_member_email
        FROM jobs j
        LEFT JOIN customers c ON j.customer_id = c.id
        LEFT JOIN services s ON j.service_id = s.id
        LEFT JOIN team_members tm ON j.team_member_id = tm.id
        WHERE j.user_id = ?
      `;
      let params = [userId];
      
      if (status) {
        const statusArray = status.split(',');
        const placeholders = statusArray.map(() => '?').join(',');
        query += ` AND j.status IN (${placeholders})`;
        params.push(...statusArray);
      }
      
      if (search) {
        query += ' AND (c.first_name LIKE ? OR c.last_name LIKE ? OR COALESCE(s.name, j.service_name) LIKE ?)';
        const searchTerm = `%${search}%`;
        params.push(searchTerm, searchTerm, searchTerm);
      }
      
      // Handle customer filtering
      if (customerId) {
        query += ' AND j.customer_id = ?';
        params.push(customerId);
      }
      // Handle territory filtering
      if (territoryId) {
        query += ' AND j.territory_id = ?';
        params.push(territoryId);
      }
      
      // Handle team member assignment filtering
      if (teamMember) {
        switch (teamMember) {
          case 'assigned':
            query += ' AND j.team_member_id IS NOT NULL';
            break;
          case 'unassigned':
            query += ' AND j.team_member_id IS NULL';
            break;
          case 'web':
            // Jobs created through web booking (you can customize this logic)
            query += ' AND j.team_member_id IS NULL';
            break;
        }
      }
      
      // Handle invoice status filtering
      if (invoiceStatus) {
        switch (invoiceStatus) {
          case 'invoiced':
            query += ' AND j.invoice_status IN ("invoiced", "paid", "unpaid")';
            break;
          case 'not_invoiced':
            query += ' AND j.invoice_status = "not_invoiced"';
            break;
          case 'paid':
            query += ' AND j.invoice_status = "paid"';
            break;
          case 'unpaid':
            query += ' AND j.invoice_status = "unpaid"';
            break;
        }
      }
      
      // Handle date filtering
      if (dateFilter === 'future') {
        query += ' AND DATE(j.scheduled_date) >= CURDATE()';
      } else if (dateFilter === 'past') {
        query += ' AND DATE(j.scheduled_date) < CURDATE()';
      } else if (dateRange) {
        const [startDate, endDate] = dateRange.split(':');
        if (startDate && endDate) {
          query += ' AND DATE(j.scheduled_date) BETWEEN ? AND ?';
          params.push(startDate, endDate);
        }
      }
      
      // Handle sorting
      const allowedSortFields = ['scheduled_date', 'customer_first_name', 'service_price', 'created_at'];
      const allowedSortOrders = ['ASC', 'DESC'];
      
      if (allowedSortFields.includes(sortBy) && allowedSortOrders.includes(sortOrder.toUpperCase())) {
        query += ` ORDER BY ${sortBy} ${sortOrder.toUpperCase()}`;
      } else {
        query += ' ORDER BY j.scheduled_date ASC';
      }
      
      // Add pagination
      const offset = (page - 1) * limit;
      query += ' LIMIT ? OFFSET ?';
      params.push(parseInt(limit), offset);
      
      console.log('🔄 Backend: Final SQL Query:', query);
      console.log('🔄 Backend: Query Parameters:', params);
      
      const [jobs] = await connection.query(query, params);
      
      console.log('🔄 Backend: Jobs query executed');
      console.log('🔄 Backend: Jobs found:', jobs.length);
      console.log('🔄 Backend: First job:', jobs[0]);
      
      // Fetch team assignments for all jobs
      for (let job of jobs) {
        try {
          // First try to get team assignments from job_team_assignments table
          const [teamAssignments] = await connection.query(`
            SELECT 
              jta.team_member_id,
              jta.is_primary,
              tm.first_name,
              tm.last_name,
              tm.email
            FROM job_team_assignments jta
            LEFT JOIN team_members tm ON jta.team_member_id = tm.id
            WHERE jta.job_id = ?
            ORDER BY jta.is_primary DESC, jta.assigned_at ASC
          `, [job.id]);
          
          job.team_assignments = teamAssignments;
          
          // For backward compatibility, set the primary team member
          const primaryAssignment = teamAssignments.find(ta => ta.is_primary);
          if (primaryAssignment) {
            job.team_member_first_name = primaryAssignment.first_name;
            job.team_member_last_name = primaryAssignment.last_name;
            job.team_member_email = primaryAssignment.email;
          }
        } catch (error) {
          console.log('Could not fetch team assignments for job:', job.id, error.message);
          
          // Fallback: create team assignment from the single team_member_id if it exists
          if (job.team_member_id && job.team_member_first_name) {
            job.team_assignments = [{
              team_member_id: job.team_member_id,
              is_primary: true,
              first_name: job.team_member_first_name,
              last_name: job.team_member_last_name,
              email: job.team_member_email
            }];
          } else {
          job.team_assignments = [];
          }
        }
      }
      
      // Get total count for pagination
      let countQuery = `
        SELECT COUNT(*) as total 
        FROM jobs j
        LEFT JOIN customers c ON j.customer_id = c.id
        LEFT JOIN services s ON j.service_id = s.id
        WHERE j.user_id = ?
      `;
      let countParams = [userId];
      
      if (status) {
        const statusArray = status.split(',');
        const placeholders = statusArray.map(() => '?').join(',');
        countQuery += ` AND j.status IN (${placeholders})`;
        countParams.push(...statusArray);
      }
      
      if (search) {
        countQuery += ' AND (c.first_name LIKE ? OR c.last_name LIKE ? OR COALESCE(s.name, j.service_name) LIKE ?)';
        const searchTerm = `%${search}%`;
        countParams.push(searchTerm, searchTerm, searchTerm);
      }
      
      // Handle customer filtering for count query
      if (customerId) {
        countQuery += ' AND j.customer_id = ?';
        countParams.push(customerId);
      }
      // Handle territory filtering for count query
      if (territoryId) {
        countQuery += ' AND j.territory_id = ?';
        countParams.push(territoryId);
      }
      
      // Handle team member assignment filtering for count query
      if (teamMember) {
        switch (teamMember) {
          case 'assigned':
            countQuery += ' AND j.team_member_id IS NOT NULL';
            break;
          case 'unassigned':
            countQuery += ' AND j.team_member_id IS NULL';
            break;
          case 'web':
            countQuery += ' AND j.team_member_id IS NULL';
            break;
        }
      }
      
      // Handle invoice status filtering for count query
      if (invoiceStatus) {
        switch (invoiceStatus) {
          case 'invoiced':
            countQuery += ' AND j.invoice_status IN ("invoiced", "paid", "unpaid")';
            break;
          case 'not_invoiced':
            countQuery += ' AND j.invoice_status = "not_invoiced"';
            break;
          case 'paid':
            countQuery += ' AND j.invoice_status = "paid"';
            break;
          case 'unpaid':
            countQuery += ' AND j.invoice_status = "unpaid"';
            break;
        }
      }
      
      // Handle date filtering for count query
      if (dateFilter === 'future') {
        countQuery += ' AND DATE(j.scheduled_date) >= CURDATE()';
      } else if (dateFilter === 'past') {
        countQuery += ' AND DATE(j.scheduled_date) < CURDATE()';
      } else if (dateRange) {
        const [startDate, endDate] = dateRange.split(':');
        if (startDate && endDate) {
          countQuery += ' AND DATE(j.scheduled_date) BETWEEN ? AND ?';
          countParams.push(startDate, endDate);
        }
      }
      
      const [countResult] = await connection.query(countQuery, countParams);
      const total = countResult[0].total;
      
      const response = {
        jobs,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / limit)
        }
      };
      
      console.log('🔄 Backend: Sending response with', jobs.length, 'jobs');
      console.log('🔄 Backend: Response structure:', response);
      
      res.json(response);
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Get jobs error:', error);
    res.status(500).json({ error: 'Failed to fetch jobs' });
  }
});

app.get('/api/jobs/:id', authenticateToken, async (req, res) => {
  // Set CORS headers explicitly
  const origin = req.headers.origin;
  if (origin) {
    res.header('Access-Control-Allow-Origin', origin);
  } else {
    res.header('Access-Control-Allow-Origin', '*');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin, Cache-Control');
  res.header('Access-Control-Allow-Credentials', 'true');
  
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    
    const connection = await pool.getConnection();
    
    try {
      const [jobs] = await connection.query(
        `SELECT 
          j.id,
          j.user_id,
          j.customer_id,
          j.service_id,
          j.team_member_id,
          j.territory_id,
          j.notes,
          j.status,
          j.invoice_status,
          j.invoice_id,
          j.invoice_amount,
          j.invoice_date,
          j.payment_date,
          j.created_at,
          j.updated_at,
          j.is_recurring,
          j.recurring_frequency,
          j.next_billing_date,
          j.stripe_payment_intent_id,
          DATE_FORMAT(j.scheduled_date, '%Y-%m-%d %H:%i:%s') as scheduled_date,
          c.first_name as customer_first_name,
          c.last_name as customer_last_name,
          c.email as customer_email,
          c.phone as customer_phone,
          c.address as customer_address,
          c.city as customer_city,
          c.state as customer_state,
          c.zip_code as customer_zip_code,
          s.name as service_name,
          s.price as service_price,
          s.duration as service_duration,
          tm.first_name as team_member_first_name,
          tm.last_name as team_member_last_name
        FROM jobs j
        LEFT JOIN customers c ON j.customer_id = c.id
        LEFT JOIN services s ON j.service_id = s.id
        LEFT JOIN team_members tm ON j.team_member_id = tm.id
        WHERE j.id = ? AND j.user_id = ?`,
        [id, userId]
      );
      
      if (jobs.length === 0) {
        return res.status(404).json({ error: 'Job not found' });
      }
      
      // Get intake answers from job_answers table
      const [intakeAnswers] = await connection.query(
        `SELECT 
          question_id,
          question_text,
          question_type,
          answer
        FROM job_answers 
        WHERE job_id = ?
        ORDER BY created_at ASC`,
        [id]
      );

      // Parse JSON answers
      const parsedIntakeAnswers = intakeAnswers.map(answer => ({
        ...answer,
        answer: answer.answer ? (answer.answer.startsWith('[') || answer.answer.startsWith('{') ? JSON.parse(answer.answer) : answer.answer) : null
      }));

      // Get intake questions and answers from job_answers table
      // The job_answers table contains both the question details and the answers
      const intakeQuestionsAndAnswers = parsedIntakeAnswers.map(answer => ({
        id: answer.question_id,
        question: answer.question_text,
        questionType: answer.question_type,
        answer: answer.answer
      }));

      // Get team assignments for this job
      let teamAssignments = [];
      try {
        const [assignmentsResult] = await connection.query(`
          SELECT 
            jta.team_member_id,
            jta.is_primary,
            tm.first_name,
            tm.last_name,
            tm.email,
            tm.phone,
            tm.role
          FROM job_team_assignments jta
          LEFT JOIN team_members tm ON jta.team_member_id = tm.id
          WHERE jta.job_id = ?
          ORDER BY jta.is_primary DESC, jta.assigned_at ASC
        `, [id]);
        
        teamAssignments = assignmentsResult;
        
        // For backward compatibility, set the primary team member
        const primaryAssignment = teamAssignments.find(ta => ta.is_primary);
        if (primaryAssignment) {
          jobs[0].team_member_first_name = primaryAssignment.first_name;
          jobs[0].team_member_last_name = primaryAssignment.last_name;
        }
      } catch (assignmentError) {
        console.log('Could not fetch team assignments for job:', id, assignmentError.message);
        
        // Fallback: create team assignment from the single team_member_id if it exists
        if (jobs[0].team_member_id && jobs[0].team_member_first_name) {
          teamAssignments = [{
            team_member_id: jobs[0].team_member_id,
            is_primary: true,
            first_name: jobs[0].team_member_first_name,
            last_name: jobs[0].team_member_last_name,
            email: null,
            phone: null,
            role: null
          }];
        }
      }

      const jobData = {
        ...jobs[0],
        team_assignments: teamAssignments,
        intake_answers: parsedIntakeAnswers,
        service_intake_questions: intakeQuestionsAndAnswers // Use the questions from job_answers table
      };
      
      res.json(jobData);
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Get job error:', error);
    res.status(500).json({ error: 'Failed to fetch job' });
  }
});

// Create job endpoint
app.post('/api/jobs', authenticateToken, async (req, res) => {
  // Set CORS headers explicitly
  const origin = req.headers.origin;
  if (origin) {
    res.header('Access-Control-Allow-Origin', origin);
  } else {
    res.header('Access-Control-Allow-Origin', '*');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin, Cache-Control');
  res.header('Access-Control-Allow-Credentials', 'true');
  
  try {
    const userId = req.user.userId;
    const {
      customerId,
      serviceId,
      teamMemberId,
      scheduledDate,
      scheduledTime,
      notes,
      status = 'pending',
      duration,
      workers,
      skillsRequired,
      price,
      discount = 0,
      additionalFees = 0,
      taxes = 0,
      total,
      paymentMethod,
      territory,
      recurringJob = false,
      scheduleType = 'one-time',
      letCustomerSchedule = false,
      offerToProviders = false,
      internalNotes,
      serviceAddress,
      contactInfo,
      serviceName,
      invoiceStatus = 'draft',
      paymentStatus = 'pending',
      priority = 'normal',
      estimatedDuration,
      skills,
      specialInstructions,
      customerNotes,
      tags,
      attachments,
      recurringFrequency = 'weekly',
      recurringEndDate,
      autoInvoice = true,
      autoReminders = true,
      customerSignature = false,
      photosRequired = false,
      qualityCheck = true,
      serviceModifiers,
      serviceIntakeQuestions,
      intakeQuestionIdMapping
    } = req.body;

    console.log('🔄 Creating job for user:', userId);
    console.log('🔄 Job data:', req.body);
    console.log('🔄 DEBUG: serviceIntakeQuestions in req.body:', req.body.serviceIntakeQuestions);
    console.log('🔄 DEBUG: intakeQuestionAnswers in req.body:', req.body.intakeQuestionAnswers);
    console.log('🔄 DEBUG: originalIntakeQuestionIds in req.body:', req.body.originalIntakeQuestionIds);

    const connection = await pool.getConnection();
    
    try {
      // Combine scheduled date and time - save exactly as user chose
      let fullScheduledDate;
      if (scheduledDate && scheduledTime) {
        // Simply combine date and time as-is, no timezone conversion
        fullScheduledDate = `${scheduledDate} ${scheduledTime}:00`;
        console.log(`🕐 Saving time as chosen: ${scheduledDate} ${scheduledTime}`);
      } else {
        fullScheduledDate = scheduledDate;
      }

      // Process modifiers and intake questions to calculate final price and duration
      let finalPrice = parseFloat(price) || 0;
      let finalDuration = parseFloat(duration) || 0;
      let processedModifiers = [];
      let processedIntakeQuestions = [];

      // Process selected modifiers to calculate price and duration
      if (serviceModifiers && Array.isArray(serviceModifiers)) {
        processedModifiers = serviceModifiers.map(modifier => {
          const selectedOptions = req.body.selectedModifiers?.[modifier.id] || [];
          let modifierPrice = 0;
          let modifierDuration = 0;
          let selectedOptionsData = [];

          if (modifier.selectionType === 'quantity') {
            // Handle quantity selection
            Object.entries(selectedOptions).forEach(([optionId, quantity]) => {
              const option = modifier.options?.find(o => o.id == optionId);
              if (option && quantity > 0) {
                const optionPrice = parseFloat(option.price) || 0;
                const optionDuration = parseFloat(option.duration) || 0;
                modifierPrice += optionPrice * quantity;
                modifierDuration += optionDuration * quantity;
                selectedOptionsData.push({
                  ...option,
                  selectedQuantity: quantity,
                  totalPrice: optionPrice * quantity,
                  totalDuration: optionDuration * quantity
                });
              }
            });
          } else {
            // Handle single/multi selection
            const selectedOptionIds = Array.isArray(selectedOptions) ? selectedOptions : [selectedOptions];
            selectedOptionIds.forEach(optionId => {
              const option = modifier.options?.find(o => o.id == optionId);
              if (option) {
                const optionPrice = parseFloat(option.price) || 0;
                const optionDuration = parseFloat(option.duration) || 0;
                modifierPrice += optionPrice;
                modifierDuration += optionDuration;
                selectedOptionsData.push({
                  ...option,
                  selected: true,
                  totalPrice: optionPrice,
                  totalDuration: optionDuration
                });
              }
            });
          }

          finalPrice += modifierPrice;
          finalDuration += modifierDuration;

          return {
            ...modifier,
            selectedOptions: selectedOptionsData,
            totalModifierPrice: modifierPrice,
            totalModifierDuration: modifierDuration
          };
        });
      }

      // Process intake questions with answers
      console.log('🔄 DEBUG: serviceIntakeQuestions type:', typeof serviceIntakeQuestions);
      console.log('🔄 DEBUG: serviceIntakeQuestions value:', serviceIntakeQuestions);
      console.log('🔄 DEBUG: Array.isArray(serviceIntakeQuestions):', Array.isArray(serviceIntakeQuestions));
      
      // If serviceIntakeQuestions is not provided, try to get it from the service
      if (!serviceIntakeQuestions && serviceId) {
        try {
          const [serviceData] = await connection.query(
            'SELECT intake_questions FROM services WHERE id = ?',
            [serviceId]
          );
          
          if (serviceData.length > 0 && serviceData[0].intake_questions) {
            try {
              if (typeof serviceData[0].intake_questions === 'string') {
                serviceIntakeQuestions = JSON.parse(serviceData[0].intake_questions);
              } else if (Array.isArray(serviceData[0].intake_questions)) {
                serviceIntakeQuestions = serviceData[0].intake_questions;
              }
              console.log('🔄 DEBUG: Retrieved serviceIntakeQuestions from service:', serviceIntakeQuestions);
            } catch (parseError) {
              console.error('Error parsing service intake questions:', parseError);
              serviceIntakeQuestions = [];
            }
          }
        } catch (serviceError) {
          console.error('Error fetching service intake questions:', serviceError);
          serviceIntakeQuestions = [];
        }
      }
      
        const intakeAnswers = req.body.intakeQuestionAnswers || {};
        const originalQuestionIds = req.body.originalIntakeQuestionIds || [];
      
      if (serviceIntakeQuestions && Array.isArray(serviceIntakeQuestions)) {
        console.log('🔄 Processing intake questions with answers:');
        console.log('🔄 Service intake questions:', serviceIntakeQuestions);
        console.log('🔄 Intake answers from frontend:', intakeAnswers);
        console.log('🔄 Original question IDs:', originalQuestionIds);
        
        processedIntakeQuestions = serviceIntakeQuestions.map((question, index) => {
          // The frontend sends answers using the normalized question IDs (1, 2, 3)
          // So we should use the question.id directly, not the originalQuestionIds
          const answer = intakeAnswers[question.id];
          
          console.log(`🔄 Question ${question.id} (${question.question}):`, {
            questionId: question.id,
            questionIdType: typeof question.id,
            availableAnswerIds: Object.keys(intakeAnswers),
            answer: answer,
            answerType: typeof answer,
            isArray: Array.isArray(answer)
          });
          
          return {
            ...question,
            answer: answer || null
          };
        });
      }

      console.log('🔄 Processed modifiers:', processedModifiers);
      console.log('🔄 Processed intake questions:', processedIntakeQuestions);
      console.log('🔄 Final price:', finalPrice);
      console.log('🔄 Final duration:', finalDuration);

      // Handle empty team member ID
      const teamMemberIdValue = teamMemberId && teamMemberId !== '' ? teamMemberId : null;
      
      // Also handle team member IDs array for multiple assignments
      const teamMemberIds = req.body.teamMemberIds || [];
      
      // Handle empty recurring end date
      const recurringEndDateValue = recurringEndDate && recurringEndDate !== '' ? recurringEndDate : null;

      // Create the job
      const [result] = await connection.query(`
        INSERT INTO jobs (
          user_id, customer_id, service_id, team_member_id, scheduled_date, notes, status,
          duration, workers_needed, skills_required, price, discount, additional_fees, taxes, total,
          payment_method, territory, is_recurring, schedule_type, let_customer_schedule,
          offer_to_providers, internal_notes, service_address_street, service_address_city,
          service_address_state, service_address_zip, service_name, invoice_status, payment_status,
          priority, estimated_duration, skills, special_instructions, customer_notes, tags,
          recurring_end_date, auto_invoice, auto_reminders, customer_signature,
          photos_required, quality_check, service_modifiers, service_intake_questions,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
      `, [
        userId, customerId, serviceId, teamMemberIdValue, fullScheduledDate, notes, status,
        finalDuration, workers, skillsRequired, finalPrice, discount, additionalFees, taxes, finalPrice,
        paymentMethod, territory, recurringJob, scheduleType, letCustomerSchedule,
        offerToProviders, internalNotes, 
        serviceAddress?.street, serviceAddress?.city, serviceAddress?.state, serviceAddress?.zipCode,
        serviceName, invoiceStatus, paymentStatus, priority, finalDuration,
        skills ? JSON.stringify(skills) : null, specialInstructions, customerNotes,
        tags ? JSON.stringify(tags) : null, recurringEndDateValue,
        autoInvoice, autoReminders, customerSignature, photosRequired, qualityCheck,
        processedModifiers.length > 0 ? JSON.stringify(processedModifiers) : null,
        null // Don't save intake questions to jobs table anymore - use job_answers table instead
      ]);

      // Create team member assignments in job_team_assignments table
      if (teamMemberIdValue || teamMemberIds.length > 0) {
        try {
          // If we have a single team member ID, add it as primary
          if (teamMemberIdValue) {
            await connection.query(`
              INSERT INTO job_team_assignments (job_id, team_member_id, is_primary, assigned_by)
              VALUES (?, ?, 1, ?)
            `, [result.insertId, teamMemberIdValue, userId]);
            console.log('🔄 DEBUG: Created primary team assignment for job:', result.insertId);
          }
          
          // Add additional team members from the array
          for (const memberId of teamMemberIds) {
            if (memberId && memberId !== teamMemberIdValue) {
              await connection.query(`
                INSERT INTO job_team_assignments (job_id, team_member_id, is_primary, assigned_by)
                VALUES (?, ?, 0, ?)
              `, [result.insertId, memberId, userId]);
              console.log('🔄 DEBUG: Created additional team assignment for job:', result.insertId);
            }
          }
        } catch (assignmentError) {
          console.error('Error creating team assignments:', assignmentError);
          // Don't fail the job creation if team assignment fails
        }
      }

      // Save intake question answers to job_answers table if provided
      console.log('🔄 DEBUG: processedIntakeQuestions length:', processedIntakeQuestions ? processedIntakeQuestions.length : 0);
      console.log('🔄 DEBUG: processedIntakeQuestions:', processedIntakeQuestions);
      
      if (processedIntakeQuestions && processedIntakeQuestions.length > 0) {
        console.log('🔄 DEBUG: Attempting to save intake questions to job_answers table');
        try {
          for (let index = 0; index < processedIntakeQuestions.length; index++) {
            const question = processedIntakeQuestions[index];
            console.log('🔄 DEBUG: Processing question:', question);
            if (question.answer !== undefined && question.answer !== null && question.answer !== '') {
              const answerToSave = (Array.isArray(question.answer) || typeof question.answer === 'object') ? JSON.stringify(question.answer) : question.answer;
              console.log('🔄 DEBUG: Saving answer:', answerToSave);
              try {
                // Use the original question ID for consistency in the database
                const originalQuestionId = originalQuestionIds[index] || question.id;
                await connection.query(`
                  INSERT INTO job_answers (
                    job_id, question_id, question_text, question_type, answer, created_at
                  ) VALUES (?, ?, ?, ?, ?, NOW())
                `, [result.insertId, originalQuestionId, question.question, question.questionType, answerToSave]);
                console.log('🔄 DEBUG: Successfully saved job answer for question:', question.id, 'with original ID:', originalQuestionId);
              } catch (insertError) {
                console.error('Error inserting job answer:', insertError);
                // Continue processing other answers even if one fails
              }
            } else {
              console.log('🔄 DEBUG: Skipping question with no answer:', question.id);
            }
          }
        } catch (error) {
          console.error('Error processing intake questions for job_answers:', error);
          // Don't fail the entire operation if intake questions processing fails
        }
      } else {
        console.log('🔄 DEBUG: No processedIntakeQuestions to save');
      }

      // Get the created job
      const [jobs] = await connection.query(
        `SELECT 
          j.*,
          c.first_name as customer_first_name,
          c.last_name as customer_last_name,
          c.email as customer_email,
          c.phone as customer_phone,
          COALESCE(s.name, j.service_name) as service_name,
          COALESCE(s.price, j.service_price) as service_price,
          COALESCE(s.duration, j.duration) as service_duration
        FROM jobs j
        LEFT JOIN customers c ON j.customer_id = c.id
        LEFT JOIN services s ON j.service_id = s.id
        WHERE j.id = ?`,
        [result.insertId]
      );

      console.log('🔄 Job created successfully:', result.insertId);
      
      res.status(201).json({
        message: 'Job created successfully',
        job: jobs[0]
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Create job error:', error);
    res.status(500).json({ error: 'Failed to create job' });
  }
});

// Update job endpoint
app.put('/api/jobs/:id', authenticateToken, async (req, res) => {
  // Set CORS headers explicitly
  const origin = req.headers.origin;
  if (origin) {
    res.header('Access-Control-Allow-Origin', origin);
  } else {
    res.header('Access-Control-Allow-Origin', '*');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin, Cache-Control');
  res.header('Access-Control-Allow-Credentials', 'true');
  
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    const updateData = req.body;

    console.log('🔄 Updating job:', id);
    console.log('🔄 Update data:', updateData);

    const connection = await pool.getConnection();
    
    try {
      // Check if job exists and belongs to user
      const [existingJobs] = await connection.query(
        'SELECT id FROM jobs WHERE id = ? AND user_id = ?',
        [id, userId]
      );

      if (existingJobs.length === 0) {
        return res.status(404).json({ error: 'Job not found' });
      }

      // Build update query dynamically
      const updateFields = [];
      const updateValues = [];

      // Map frontend fields to database fields
      const fieldMappings = {
        customerId: 'customer_id',
        serviceId: 'service_id',
        teamMemberId: 'team_member_id',
        scheduledDate: 'scheduled_date',
        notes: 'notes',
        status: 'status',
        duration: 'duration',
        workers: 'workers_needed',
        skillsRequired: 'skills_required',
        price: 'price',
        discount: 'discount',
        additionalFees: 'additional_fees',
        taxes: 'taxes',
        total: 'total',
        paymentMethod: 'payment_method',
        territory: 'territory',
        recurringJob: 'recurring_job',
        scheduleType: 'schedule_type',
        letCustomerSchedule: 'let_customer_schedule',
        offerToProviders: 'offer_to_providers',
        internalNotes: 'internal_notes',
        serviceName: 'service_name',
        invoiceStatus: 'invoice_status',
        paymentStatus: 'payment_status',
        priority: 'priority',
        estimatedDuration: 'estimated_duration',
        skills: 'skills',
        specialInstructions: 'special_instructions',
        customerNotes: 'customer_notes',
        tags: 'tags',
        recurringFrequency: 'recurring_frequency',
        recurringEndDate: 'recurring_end_date',
        autoInvoice: 'auto_invoice',
        autoReminders: 'auto_reminders',
        customerSignature: 'customer_signature',
        photosRequired: 'photos_required',
        qualityCheck: 'quality_check',
        serviceModifiers: 'service_modifiers',
        serviceIntakeQuestions: 'service_intake_questions'
      };

      Object.keys(updateData).forEach(key => {
        if (fieldMappings[key] && updateData[key] !== undefined) {
          updateFields.push(`${fieldMappings[key]} = ?`);
          
          // Handle special cases
          if (key === 'scheduledDate' && updateData.scheduledTime) {
            // Simply combine date and time as-is, no timezone conversion
            updateValues.push(`${updateData[key]} ${updateData.scheduledTime}:00`);
            console.log(`🕐 Update saving time as chosen: ${updateData[key]} ${updateData.scheduledTime}`);
          } else if (['skills', 'tags', 'serviceModifiers', 'serviceIntakeQuestions'].includes(key)) {
            updateValues.push(JSON.stringify(updateData[key]));
          } else if (key === 'serviceAddress') {
            // Handle nested service address
            if (updateData[key]) {
              updateFields.push('service_address_street = ?');
              updateFields.push('service_address_city = ?');
              updateFields.push('service_address_state = ?');
              updateFields.push('service_address_zip = ?');
              updateValues.push(updateData[key].street || null);
              updateValues.push(updateData[key].city || null);
              updateValues.push(updateData[key].state || null);
              updateValues.push(updateData[key].zipCode || null);
            }
          } else {
            updateValues.push(updateData[key]);
          }
        }
      });

      if (updateFields.length === 0) {
        return res.status(400).json({ error: 'No valid fields to update' });
      }

      // Handle team member assignments update
      if (updateData.teamMemberId !== undefined || updateData.teamMemberIds !== undefined) {
        try {
          // Remove existing assignments
          await connection.query('DELETE FROM job_team_assignments WHERE job_id = ?', [id]);
          
          // Add new assignments
          const teamMemberId = updateData.teamMemberId;
          const teamMemberIds = updateData.teamMemberIds || [];
          
          // If we have a single team member ID, add it as primary
          if (teamMemberId && teamMemberId !== '') {
            await connection.query(`
              INSERT INTO job_team_assignments (job_id, team_member_id, is_primary, assigned_by)
              VALUES (?, ?, 1, ?)
            `, [id, teamMemberId, userId]);
          }
          
          // Add additional team members from the array
          for (const memberId of teamMemberIds) {
            if (memberId && memberId !== teamMemberId) {
              await connection.query(`
                INSERT INTO job_team_assignments (job_id, team_member_id, is_primary, assigned_by)
                VALUES (?, ?, 0, ?)
              `, [id, memberId, userId]);
            }
          }
          
          console.log('🔄 Updated team assignments for job:', id);
        } catch (assignmentError) {
          console.error('Error updating team assignments:', assignmentError);
          // Don't fail the job update if team assignment fails
        }
      }

      updateFields.push('updated_at = NOW()');
      updateValues.push(id, userId);

      const query = `UPDATE jobs SET ${updateFields.join(', ')} WHERE id = ? AND user_id = ?`;
      
      console.log('🔄 Update query:', query);
      console.log('🔄 Update values:', updateValues);

      await connection.query(query, updateValues);

      // Get updated job
      const [jobs] = await connection.query(
        `SELECT 
          j.*,
          c.first_name as customer_first_name,
          c.last_name as customer_last_name,
          c.email as customer_email,
          c.phone as customer_phone,
          COALESCE(s.name, j.service_name) as service_name,
          COALESCE(s.price, j.service_price) as service_price,
          COALESCE(s.duration, j.duration) as service_duration
        FROM jobs j
        LEFT JOIN customers c ON j.customer_id = c.id
        LEFT JOIN services s ON j.service_id = s.id
        WHERE j.id = ?`,
        [id]
      );

      console.log('🔄 Job updated successfully');
      
      res.json({
        message: 'Job updated successfully',
        job: jobs[0]
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Update job error:', error);
    res.status(500).json({ error: 'Failed to update job' });
  }
});

// Delete job endpoint
app.delete('/api/jobs/:id', authenticateToken, async (req, res) => {
  // Set CORS headers explicitly
  const origin = req.headers.origin;
  if (origin) {
    res.header('Access-Control-Allow-Origin', origin);
  } else {
    res.header('Access-Control-Allow-Origin', '*');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin, Cache-Control');
  res.header('Access-Control-Allow-Credentials', 'true');
  
  try {
    const userId = req.user.userId;
    const { id } = req.params;

    console.log('🔄 Deleting job:', id);

    const connection = await pool.getConnection();
    
    try {
      // Check if job exists and belongs to user
      const [existingJobs] = await connection.query(
        'SELECT id FROM jobs WHERE id = ? AND user_id = ?',
        [id, userId]
      );

      if (existingJobs.length === 0) {
        return res.status(404).json({ error: 'Job not found' });
      }

      // Delete the job
      await connection.query('DELETE FROM jobs WHERE id = ? AND user_id = ?', [id, userId]);

      console.log('🔄 Job deleted successfully');
      
      res.json({ message: 'Job deleted successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Delete job error:', error);
    res.status(500).json({ error: 'Failed to delete job' });
  }
});

// Customers endpoints
app.get('/api/customers', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { search, page = 1, limit = 20, sortBy = 'created_at', sortOrder = 'DESC', status } = req.query;
    
    console.log('🔄 Backend: Customers request received');
    console.log('🔄 Backend: User ID:', userId);
    console.log('🔄 Backend: All query params:', req.query);
    
    const connection = await pool.getConnection();
    
    try {
      let query = `
        SELECT 
          id,
          user_id,
          first_name,
          last_name,
          email,
          phone,
          address,
          suite,
          city,
          state,
          zip_code,
          notes,
          status,
          created_at,
          updated_at
        FROM customers
        WHERE user_id = ?
      `;
      let params = [userId];
      
      if (status && status !== 'all') {
        query += ' AND status = ?';
        params.push(status);
      }
      
      if (search) {
        query += ' AND (first_name LIKE ? OR last_name LIKE ? OR email LIKE ? OR phone LIKE ?)';
        const searchTerm = `%${search}%`;
        params.push(searchTerm, searchTerm, searchTerm, searchTerm);
      }
      
      // Add sorting
      const allowedSortFields = ['first_name', 'last_name', 'email', 'created_at', 'updated_at'];
      const allowedSortOrders = ['ASC', 'DESC'];
      
      if (allowedSortFields.includes(sortBy) && allowedSortOrders.includes(sortOrder.toUpperCase())) {
        query += ` ORDER BY ${sortBy} ${sortOrder.toUpperCase()}`;
      } else {
        query += ' ORDER BY created_at DESC';
      }
      
      // Add pagination
      const offset = (page - 1) * limit;
      query += ' LIMIT ? OFFSET ?';
      params.push(parseInt(limit), offset);
      
      console.log('🔄 Backend: Final SQL Query:', query);
      console.log('🔄 Backend: Query Parameters:', params);
      
      const [customers] = await connection.query(query, params);
      
      console.log('🔄 Backend: Customers query executed');
      console.log('🔄 Backend: Customers found:', customers.length);
      
      // Get total count for pagination
      let countQuery = `
        SELECT COUNT(*) as total
        FROM customers
        WHERE user_id = ?
      `;
      let countParams = [userId];
      
      if (status && status !== 'all') {
        countQuery += ' AND status = ?';
        countParams.push(status);
      }
      
      if (search) {
        countQuery += ' AND (first_name LIKE ? OR last_name LIKE ? OR email LIKE ? OR phone LIKE ?)';
        const searchTerm = `%${search}%`;
        countParams.push(searchTerm, searchTerm, searchTerm, searchTerm);
      }
      
      const [countResult] = await connection.query(countQuery, countParams);
      const total = countResult[0].total;
      
      res.json({
        customers,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / limit)
        }
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Get customers error:', error);
    res.status(500).json({ error: 'Failed to get customers' });
  }
});

app.post('/api/customers', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { firstName, lastName, email, phone, address, suite, notes, city, state, zipCode } = req.body;
    
    // Input validation
    if (!validateName(firstName)) {
      return res.status(400).json({ error: 'First name must be between 2 and 50 characters' });
    }
    
    if (!validateName(lastName)) {
      return res.status(400).json({ error: 'Last name must be between 2 and 50 characters' });
    }
    
    if (email && !validateEmail(email)) {
      return res.status(400).json({ error: 'Please provide a valid email address' });
    }
    
    if (phone && phone.trim().length < 10) {
      return res.status(400).json({ error: 'Please provide a valid phone number (at least 10 digits)' });
    }
    
    // Sanitize inputs
    const sanitizedFirstName = sanitizeInput(firstName);
    const sanitizedLastName = sanitizeInput(lastName);
    const sanitizedEmail = email ? email.toLowerCase().trim() : null;
    const sanitizedPhone = phone ? phone.trim() : null;
    const sanitizedAddress = address ? sanitizeInput(address) : null;
    const sanitizedSuite = suite ? sanitizeInput(suite) : null;
    const sanitizedNotes = notes ? sanitizeInput(notes) : null;
    const sanitizedCity = city ? sanitizeInput(city) : null;
    const sanitizedState = state ? sanitizeInput(state) : null;
    const sanitizedZipCode = zipCode ? sanitizeInput(zipCode) : null;
    
    const connection = await pool.getConnection();
    
    try {
      // Note: Multiple customers can have the same email address
      // No email uniqueness check needed
      
      // Create new customer
      const [result] = await connection.query(
        'INSERT INTO customers (user_id, first_name, last_name, email, phone, address, suite, notes, city, state, zip_code, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, "active", NOW())',
        [userId, sanitizedFirstName, sanitizedLastName, sanitizedEmail, sanitizedPhone, sanitizedAddress, sanitizedSuite, sanitizedNotes, sanitizedCity, sanitizedState, sanitizedZipCode]
      );
      
      // Get the created customer
      const [customers] = await connection.query(
        'SELECT * FROM customers WHERE id = ?',
        [result.insertId]
      );
      
      res.status(201).json({
        message: 'Customer created successfully',
        customer: customers[0]
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Create customer error:', error);
    res.status(500).json({ error: 'Failed to create customer' });
  }
});

app.get('/api/customers/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    
    const connection = await pool.getConnection();
    
    try {
      const [customers] = await connection.query(
        'SELECT * FROM customers WHERE id = ? AND user_id = ?',
        [id, userId]
      );
      
      if (customers.length === 0) {
        return res.status(404).json({ error: 'Customer not found' });
      }
      
      res.json(customers[0]);
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Get customer error:', error);
    res.status(500).json({ error: 'Failed to fetch customer' });
  }
});

app.put('/api/customers/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    const { firstName, lastName, email, phone, address, suite, notes, status, city, state, zipCode } = req.body;
    
    // Input validation
    if (!validateName(firstName)) {
      return res.status(400).json({ error: 'First name must be between 2 and 50 characters' });
    }
    
    // if (!validateName(lastName)) {
    //   return res.status(400).json({ error: 'Last name must be between 2 and 50 characters' });
    // }
    
    if (email && !validateEmail(email)) {
      return res.status(400).json({ error: 'Please provide a valid email address' });
    }
    
    if (phone && phone.trim().length < 10) {
      return res.status(400).json({ error: 'Please provide a valid phone number (at least 10 digits)' });
    }
    
    // Sanitize inputs
    const sanitizedFirstName = sanitizeInput(firstName);
    const sanitizedLastName = sanitizeInput(lastName);
    const sanitizedEmail = email ? email.toLowerCase().trim() : null;
    const sanitizedPhone = phone ? phone.trim() : null;
    const sanitizedAddress = address ? sanitizeInput(address) : null;
    const sanitizedSuite = suite ? sanitizeInput(suite) : null;
    const sanitizedNotes = notes ? sanitizeInput(notes) : null;
    const sanitizedCity = city ? sanitizeInput(city) : null;
    const sanitizedState = state ? sanitizeInput(state) : null;
    const sanitizedZipCode = zipCode ? sanitizeInput(zipCode) : null;
    
    const connection = await pool.getConnection();
    
    try {
      // Check if customer exists and belongs to user
      const [existingCustomers] = await connection.query(
        'SELECT id, email FROM customers WHERE id = ? AND user_id = ?',
        [id, userId]
      );
      
      if (existingCustomers.length === 0) {
        return res.status(404).json({ error: 'Customer not found' });
      }
      
      const currentCustomer = existingCustomers[0];
      
      // Note: Multiple customers can have the same email address
      // No email uniqueness check needed when updating
      
      await connection.query(
        'UPDATE customers SET first_name = ?, last_name = ?, email = ?, phone = ?, address = ?, suite = ?, notes = ?, status = ?, city = ?, state = ?, zip_code = ?, updated_at = NOW() WHERE id = ? AND user_id = ?',
        [sanitizedFirstName, sanitizedLastName, sanitizedEmail, sanitizedPhone, sanitizedAddress, sanitizedSuite, sanitizedNotes, status, sanitizedCity, sanitizedState, sanitizedZipCode, id, userId]
      );
      
      // Get updated customer
      const [customers] = await connection.query(
        'SELECT * FROM customers WHERE id = ?',
        [id]
      );
      
      res.json({ 
        message: 'Customer updated successfully',
        customer: customers[0]
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Update customer error:', error);
    res.status(500).json({ error: 'Failed to update customer' });
  }
});

app.delete('/api/customers/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    
    const connection = await pool.getConnection();
    
    try {
      // Check if customer exists and belongs to user
      const [existingCustomers] = await connection.query(
        'SELECT id FROM customers WHERE id = ? AND user_id = ?',
        [id, userId]
      );
      
      if (existingCustomers.length === 0) {
        return res.status(404).json({ error: 'Customer not found' });
      }
      
      // Check if customer has associated jobs or estimates
      const [jobs] = await connection.query(
        'SELECT COUNT(*) as count FROM jobs WHERE customer_id = ?',
        [id]
      );
      
      const [estimates] = await connection.query(
        'SELECT COUNT(*) as count FROM estimates WHERE customer_id = ?',
        [id]
      );
      
      if (jobs[0].count > 0 || estimates[0].count > 0) {
        return res.status(400).json({ 
          error: 'Cannot delete customer with associated jobs or estimates. Please delete the associated records first.' 
        });
      }
      
      // Soft delete by setting status to 'archived' instead of hard delete
      await connection.query(
        'UPDATE customers SET status = "archived", updated_at = NOW() WHERE id = ? AND user_id = ?',
        [id, userId]
      );
      
      res.json({ message: 'Customer deleted successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Delete customer error:', error);
    res.status(500).json({ error: 'Failed to delete customer' });
  }
});

// Customer import/export endpoints
app.post('/api/customers/import', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { customers } = req.body;
    
    if (!Array.isArray(customers) || customers.length === 0) {
      return res.status(400).json({ error: 'Please provide a valid array of customers' });
    }
    
    if (customers.length > 1000) {
      return res.status(400).json({ error: 'Cannot import more than 1000 customers at once' });
    }
    
    const connection = await pool.getConnection();
    
    try {
      const importedCustomers = [];
      const errors = [];
      
      for (let i = 0; i < customers.length; i++) {
        const customer = customers[i];
        
        try {
          // Validate required fields
          if (!customer.firstName || !customer.lastName) {
            errors.push(`Row ${i + 1}: First name and last name are required`);
            continue;
          }
          
          // Validate email if provided
          if (customer.email && !validateEmail(customer.email)) {
            errors.push(`Row ${i + 1}: Invalid email format`);
            continue;
          }
          
          // Validate phone if provided
          if (customer.phone && customer.phone.trim().length < 10) {
            errors.push(`Row ${i + 1}: Invalid phone format (at least 10 digits)`);
            continue;
          }
          
          // Sanitize inputs
          const sanitizedFirstName = sanitizeInput(customer.firstName);
          const sanitizedLastName = sanitizeInput(customer.lastName);
          const sanitizedEmail = customer.email ? customer.email.toLowerCase().trim() : null;
          const sanitizedPhone = customer.phone ? customer.phone.trim() : null;
          const sanitizedAddress = customer.address ? sanitizeInput(customer.address) : null;
          const sanitizedNotes = customer.notes ? sanitizeInput(customer.notes) : null;
          
          // Note: Multiple customers can have the same email address
          // No email uniqueness check needed during import
          
          // Insert customer
          const [result] = await connection.query(
            'INSERT INTO customers (user_id, first_name, last_name, email, phone, address, notes, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())',
            [userId, sanitizedFirstName, sanitizedLastName, sanitizedEmail, sanitizedPhone, sanitizedAddress, sanitizedNotes, customer.status || 'active']
          );
          
          // Get created customer
          const [newCustomers] = await connection.query(
            'SELECT * FROM customers WHERE id = ?',
            [result.insertId]
          );
          
          importedCustomers.push(newCustomers[0]);
        } catch (error) {
          errors.push(`Row ${i + 1}: ${error.message}`);
        }
      }
      
      res.json({
        message: `Successfully imported ${importedCustomers.length} customers`,
        imported: importedCustomers.length,
        errors: errors.length > 0 ? errors : null,
        customers: importedCustomers
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Import customers error:', error);
    res.status(500).json({ error: 'Failed to import customers' });
  }
});

app.get('/api/customers/export', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { format = 'json' } = req.query;
    
    const connection = await pool.getConnection();
    
    try {
      const [customers] = await connection.query(
        'SELECT * FROM customers WHERE user_id = ? ORDER BY created_at DESC',
        [userId]
      );
      
      if (format === 'csv') {
        // Generate CSV
        const csvHeader = 'First Name,Last Name,Email,Phone,Address,Notes,Status,Created At\n';
        const csvRows = customers.map(customer => 
          `"${customer.first_name || ''}","${customer.last_name || ''}","${customer.email || ''}","${customer.phone || ''}","${customer.address || ''}","${customer.notes || ''}","${customer.status || ''}","${customer.created_at || ''}"`
        ).join('\n');
        
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="customers.csv"');
        res.send(csvHeader + csvRows);
      } else {
        // Return JSON
        res.json({
          customers,
          total: customers.length,
          exportedAt: new Date().toISOString()
        });
      }
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Export customers error:', error);
    res.status(500).json({ error: 'Failed to export customers' });
  }
});

// Team members endpoints
app.get('/api/team', async (req, res) => {
  try {
    const { userId } = req.query;
    const connection = await pool.getConnection();
    
    try {
      const [teamMembers] = await connection.query(
        'SELECT * FROM team_members WHERE user_id = ? ORDER BY created_at DESC',
        [userId]
      );
      
      res.json(teamMembers);
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Get team members error:', error);
    res.status(500).json({ error: 'Failed to fetch team members' });
  }
});

app.post('/api/team', async (req, res) => {
  try {
    const { userId, firstName, lastName, email, phone, role } = req.body;
    const connection = await pool.getConnection();
    
    try {
      const [result] = await connection.query(
        'INSERT INTO team_members (user_id, first_name, last_name, email, phone, role, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW())',
        [userId, firstName, lastName, email, phone, role]
      );
      
      res.status(201).json({ 
        message: 'Team member created successfully',
        teamMemberId: result.insertId 
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Create team member error:', error);
    res.status(500).json({ error: 'Failed to create team member' });
  }
});

// Estimates API endpoints
app.get('/api/estimates', async (req, res) => {
  try {
    const { userId, status, customerId, page = 1, limit = 20, sortBy = 'created_at', sortOrder = 'DESC' } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }
    
    console.log('Fetching estimates for user:', userId, 'with filters:', { status, customerId, page, limit, sortBy, sortOrder });
    
    const connection = await pool.getConnection();
    
    try {
      let query = `
        SELECT 
          e.*,
          c.first_name as customer_first_name,
          c.last_name as customer_last_name,
          c.email as customer_email,
          c.phone as customer_phone
        FROM estimates e
        LEFT JOIN customers c ON e.customer_id = c.id
        WHERE e.user_id = ?
      `;
      let params = [userId];
      
      if (status) {
        query += ' AND e.status = ?';
        params.push(status);
      }
      
      if (customerId) {
        query += ' AND e.customer_id = ?';
        params.push(customerId);
      }
      
      // Handle sorting
      const allowedSortFields = ['created_at', 'total_amount', 'status', 'valid_until'];
      const allowedSortOrders = ['ASC', 'DESC'];
      
      if (allowedSortFields.includes(sortBy) && allowedSortOrders.includes(sortOrder.toUpperCase())) {
        query += ` ORDER BY e.${sortBy} ${sortOrder.toUpperCase()}`;
      } else {
        query += ' ORDER BY e.created_at DESC';
      }
      
      // Add pagination
      const offset = (page - 1) * limit;
      query += ' LIMIT ? OFFSET ?';
      params.push(parseInt(limit), offset);
      
      console.log('Executing query:', query);
      console.log('With params:', params);
      
      const [estimates] = await connection.query(query, params);
      
      console.log('Found estimates:', estimates.length);
      
      // Get total count for pagination
      let countQuery = `
        SELECT COUNT(*) as total 
        FROM estimates e
        WHERE e.user_id = ?
      `;
      let countParams = [userId];
      
      if (status) {
        countQuery += ' AND e.status = ?';
        countParams.push(status);
      }
      
      if (customerId) {
        countQuery += ' AND e.customer_id = ?';
        countParams.push(customerId);
      }
      
      const [countResult] = await connection.query(countQuery, countParams);
      const total = countResult[0].total;
      
      const response = {
        estimates,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / limit)
        }
      };
      
      console.log('Sending response with', estimates.length, 'estimates');
      res.json(response);
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Get estimates error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch estimates',
      details: error.message,
      code: error.code
    });
  }
});

app.get('/api/estimates/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const connection = await pool.getConnection();
    
    try {
      const [estimates] = await connection.query(`
        SELECT 
          e.*,
          c.first_name as customer_first_name,
          c.last_name as customer_last_name,
          c.email as customer_email,
          c.phone as customer_phone,
          c.address as customer_address
        FROM estimates e
        LEFT JOIN customers c ON e.customer_id = c.id
        WHERE e.id = ?
      `, [id]);
      
      if (estimates.length === 0) {
        return res.status(404).json({ error: 'Estimate not found' });
      }
      
      const estimate = estimates[0];
      
      // Parse services JSON and get service details
      if (estimate.services) {
        const servicesData = JSON.parse(estimate.services);
        const serviceIds = servicesData.map(service => service.serviceId);
        
        if (serviceIds.length > 0) {
          const [services] = await connection.query(`
            SELECT id, name, description, price, duration
            FROM services 
            WHERE id IN (${serviceIds.map(() => '?').join(',')})
          `, serviceIds);
          
          // Map service details to the estimate services
          estimate.services = servicesData.map(service => {
            const serviceDetails = services.find(s => s.id === service.serviceId);
            return {
              ...service,
              serviceDetails
            };
          });
        }
      }
      
      res.json(estimate);
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Get estimate error:', error);
    res.status(500).json({ error: 'Failed to fetch estimate' });
  }
});

app.post('/api/estimates', async (req, res) => {
  try {
    const { 
      userId, 
      customerId, 
      services, 
      totalAmount, 
      validUntil,
      notes 
    } = req.body;
    
    if (!userId || !customerId || !services || !totalAmount) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Validate services structure
    if (!Array.isArray(services) || services.length === 0) {
      return res.status(400).json({ error: 'Services must be a non-empty array' });
    }
    
    const connection = await pool.getConnection();
    
    try {
      // Validate customer exists
      const [customers] = await connection.query(
        'SELECT id FROM customers WHERE id = ? AND user_id = ?',
        [customerId, userId]
      );
      
      if (customers.length === 0) {
        return res.status(400).json({ error: 'Customer not found' });
      }
      
      // Validate services exist
      const serviceIds = services.map(service => service.serviceId);
      const [existingServices] = await connection.query(
        `SELECT id FROM services WHERE id IN (${serviceIds.map(() => '?').join(',')}) AND user_id = ?`,
        [...serviceIds, userId]
      );
      
      if (existingServices.length !== serviceIds.length) {
        return res.status(400).json({ error: 'One or more services not found' });
      }
      
      // Calculate valid until date (default to 30 days from now)
      const validUntilDate = validUntil || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      
      const [result] = await connection.query(
        `INSERT INTO estimates (
          user_id, customer_id, services, total_amount, 
          valid_until, notes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, NOW())`,
        [
          userId, 
          customerId, 
          JSON.stringify(services), 
          totalAmount,
          validUntilDate,
          notes || null
        ]
      );
      
      // Get the created estimate with customer details
      const [estimates] = await connection.query(`
        SELECT 
          e.*,
          c.first_name as customer_first_name,
          c.last_name as customer_last_name,
          c.email as customer_email,
          c.phone as customer_phone
        FROM estimates e
        LEFT JOIN customers c ON e.customer_id = c.id
        WHERE e.id = ?
      `, [result.insertId]);
      
      res.status(201).json({
        message: 'Estimate created successfully',
        estimate: estimates[0]
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Create estimate error:', error);
    res.status(500).json({ error: 'Failed to create estimate' });
  }
});

app.put('/api/estimates/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      customerId, 
      services, 
      totalAmount, 
      status,
      validUntil,
      notes 
    } = req.body;
    
    const connection = await pool.getConnection();
    
    try {
      const updateFields = [];
      const updateValues = [];
      
      if (customerId) {
        updateFields.push('customer_id = ?');
        updateValues.push(customerId);
      }
      
      if (services) {
        updateFields.push('services = ?');
        updateValues.push(JSON.stringify(services));
      }
      
      if (totalAmount !== undefined) {
        updateFields.push('total_amount = ?');
        updateValues.push(totalAmount);
      }
      
      if (status) {
        updateFields.push('status = ?');
        updateValues.push(status);
      }
      
      if (validUntil !== undefined) {
        updateFields.push('valid_until = ?');
        updateValues.push(validUntil);
      }
      
      if (notes !== undefined) {
        updateFields.push('notes = ?');
        updateValues.push(notes);
      }
      
      updateFields.push('updated_at = NOW()');
      updateValues.push(id);
      
      const query = `UPDATE estimates SET ${updateFields.join(', ')} WHERE id = ?`;
      
      await connection.query(query, updateValues);
      
      res.json({ message: 'Estimate updated successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Update estimate error:', error);
    res.status(500).json({ error: 'Failed to update estimate' });
  }
});

app.delete('/api/estimates/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const connection = await pool.getConnection();
    
    try {
      // Check if estimate has been converted to invoice
      const [invoices] = await connection.query(
        'SELECT COUNT(*) as count FROM invoices WHERE estimate_id = ?',
        [id]
      );
      
      if (invoices[0].count > 0) {
        return res.status(400).json({ 
          error: 'Cannot delete estimate that has been converted to invoice' 
        });
      }
      
      await connection.query('DELETE FROM estimates WHERE id = ?', [id]);
      
      res.json({ message: 'Estimate deleted successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Delete estimate error:', error);
    res.status(500).json({ error: 'Failed to delete estimate' });
  }
});

// Send estimate to customer
app.post('/api/estimates/:id/send', async (req, res) => {
  try {
    const { id } = req.params;
    const connection = await pool.getConnection();
    
    try {
      // Get estimate details with customer and user information
      const [estimates] = await connection.query(`
        SELECT 
          e.*,
          c.first_name as customer_first_name,
          c.last_name as customer_last_name,
          c.email as customer_email,
          c.phone as customer_phone,
          u.first_name as user_first_name,
          u.last_name as user_last_name,
          u.business_name
        FROM estimates e
        LEFT JOIN customers c ON e.customer_id = c.id
        LEFT JOIN users u ON e.user_id = u.id
        WHERE e.id = ?
      `, [id]);
      
      if (estimates.length === 0) {
        return res.status(404).json({ error: 'Estimate not found' });
      }
      
      const estimate = estimates[0];
      
      // Update estimate status to 'sent'
      await connection.query(
        'UPDATE estimates SET status = "sent", updated_at = NOW() WHERE id = ?',
        [id]
      );
      
      let emailSent = false;
      let emailError = null;
      
              // Send email to customer if email is available and email is configured
        if (estimate.customer_email && process.env.EMAIL_USER && process.env.EMAIL_PASSWORD) {
        try {
          const services = JSON.parse(estimate.services || '[]');
          const servicesList = services.map(service => 
            `• ${service.name} - $${service.price} x ${service.quantity}`
          ).join('\n');
          
          const emailHtml = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <div style="background-color: #f8f9fa; padding: 20px; text-align: center;">
                <h1 style="color: #333; margin: 0;">Your Estimate is Ready!</h1>
              </div>
              
              <div style="padding: 20px;">
                <p style="color: #333; font-size: 16px;">Hi ${estimate.customer_first_name},</p>
                
                <p style="color: #666; line-height: 1.6;">
                  Great news! We've prepared your estimate and it's ready for your review.
                </p>
                
                <div style="background-color: #f8f9fa; padding: 15px; border-radius: 8px; margin: 20px 0;">
                  <h3 style="color: #333; margin-top: 0;">Estimate Details:</h3>
                  <p style="color: #666; margin: 5px 0;"><strong>Estimate ID:</strong> #${estimate.id}</p>
                  <p style="color: #666; margin: 5px 0;"><strong>Date:</strong> ${new Date(estimate.created_at).toLocaleDateString()}</p>
                  <p style="color: #666; margin: 5px 0;"><strong>Valid Until:</strong> ${new Date(estimate.valid_until).toLocaleDateString()}</p>
                </div>
                
                <div style="background-color: #fff; border: 1px solid #ddd; padding: 15px; border-radius: 8px; margin: 20px 0;">
                  <h3 style="color: #333; margin-top: 0;">Services:</h3>
                  <div style="color: #666; line-height: 1.6;">
                    ${servicesList}
                  </div>
                  <hr style="border: none; border-top: 1px solid #ddd; margin: 15px 0;">
                  <p style="color: #333; font-size: 18px; font-weight: bold; margin: 0;">
                    <strong>Total Amount: $${estimate.total_amount}</strong>
                  </p>
                </div>
                
                ${estimate.notes ? `
                <div style="background-color: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; border-radius: 8px; margin: 20px 0;">
                  <h3 style="color: #856404; margin-top: 0;">Notes:</h3>
                  <p style="color: #856404; margin: 0;">${estimate.notes}</p>
                </div>
                ` : ''}
                
                <p style="color: #666; line-height: 1.6;">
                  This estimate is valid for 30 days. If you have any questions or need modifications, 
                  please don't hesitate to contact us.
                </p>
                
                <p style="color: #666; line-height: 1.6;">
                  Thank you for considering ${estimate.business_name || 'our services'}!
                </p>
                
                <p style="color: #666; line-height: 1.6;">
                  Best regards,<br>
                  ${estimate.user_first_name} ${estimate.user_last_name}<br>
                  ${estimate.business_name || 'ZenBooker'}
                </p>
              </div>
            </div>
          `;
          
          await sendEmail({
            to: estimate.customer_email,
            subject: `Your Estimate #${estimate.id} is Ready - ${estimate.business_name || 'ZenBooker'}`,
            html: emailHtml,
            text: `
              Your Estimate is Ready!
              
              Hi ${estimate.customer_first_name},
              
              Great news! We've prepared your estimate and it's ready for your review.
              
              Estimate Details:
              - Estimate ID: #${estimate.id}
              - Date: ${new Date(estimate.created_at).toLocaleDateString()}
              - Valid Until: ${new Date(estimate.valid_until).toLocaleDateString()}
              
              Services:
              ${servicesList}
              
              Total Amount: $${estimate.total_amount}
              
              ${estimate.notes ? `Notes: ${estimate.notes}` : ''}
              
              This estimate is valid for 30 days. If you have any questions or need modifications, 
              please don't hesitate to contact us.
              
              Thank you for considering ${estimate.business_name || 'our services'}!
              
              Best regards,
              ${estimate.user_first_name} ${estimate.user_last_name}
              ${estimate.business_name || 'ZenBooker'}
            `
          });
          
          emailSent = true;
          console.log(`✅ Estimate email sent to ${estimate.customer_email}`);
        } catch (emailError) {
          console.error('Email sending failed:', emailError);
          emailError = emailError.message;
        }
      } else if (estimate.customer_email) {
        console.log('⚠️ Email not configured - estimate status updated but no email sent');
      } else {
        console.log('⚠️ No customer email available - estimate status updated but no email sent');
      }
      
      res.json({ 
        message: 'Estimate sent successfully',
        emailSent,
        customerEmail: estimate.customer_email,
        emailError: emailError
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Send estimate error:', error);
    res.status(500).json({ error: 'Failed to send estimate' });
  }
});

// Convert estimate to invoice
app.post('/api/estimates/:id/convert-to-invoice', async (req, res) => {
  try {
    const { id } = req.params;
    const { dueDate } = req.body;
    const connection = await pool.getConnection();
    
    try {
      // Get estimate details
      const [estimates] = await connection.query(`
        SELECT * FROM estimates WHERE id = ?
      `, [id]);
      
      if (estimates.length === 0) {
        return res.status(404).json({ error: 'Estimate not found' });
      }
      
      const estimate = estimates[0];
      
      // Calculate due date (default to 15 days from now)
      const calculatedDueDate = dueDate || new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      
      // Create invoice
      const [result] = await connection.query(
        `INSERT INTO invoices (
          user_id, customer_id, estimate_id, amount, 
          total_amount, due_date, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, NOW())`,
        [
          estimate.user_id,
          estimate.customer_id,
          estimate.id,
          estimate.total_amount,
          estimate.total_amount, // No tax for now
          calculatedDueDate
        ]
      );
      
      // Update estimate status to 'accepted'
      await connection.query(
        'UPDATE estimates SET status = "accepted", updated_at = NOW() WHERE id = ?',
        [id]
      );
      
      res.status(201).json({
        message: 'Estimate converted to invoice successfully',
        invoiceId: result.insertId
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Convert estimate to invoice error:', error);
    res.status(500).json({ error: 'Failed to convert estimate to invoice' });
  }
});

// Online Booking API endpoints
app.get('/api/public/services', async (req, res) => {
  try {
    const { userId = 1 } = req.query; // Default to user ID 1 for public booking
    const connection = await pool.getConnection();
    
    try {
      const [services] = await connection.query(`
        SELECT id, name, description, price, duration, category
        FROM services 
        WHERE user_id = ?
        ORDER BY name
      `, [userId]);
      
      res.json(services);
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Get public services error:', error);
    res.status(500).json({ error: 'Failed to fetch services' });
  }
});

app.get('/api/public/availability', async (req, res) => {
  try {
    const { userId = 1, date } = req.query;
    const connection = await pool.getConnection();
    
    try {
      // Get business hours and availability settings
      const [availabilitySettings] = await connection.query(`
        SELECT business_hours, timeslot_templates
        FROM user_availability 
        WHERE user_id = ?
      `, [userId]);
      
      // Get existing bookings for the date
      const [existingBookings] = await connection.query(`
        SELECT scheduled_date
        FROM jobs 
        WHERE user_id = ? AND DATE(scheduled_date) = ?
      `, [userId, date]);
      
      // Generate available time slots (9 AM to 5 PM, 30-minute intervals)
      const availableSlots = [];
      const startHour = 9;
      const endHour = 17;
      
      for (let hour = startHour; hour < endHour; hour++) {
        for (let minute = 0; minute < 60; minute += 30) {
          const time = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
          const slotDateTime = `${date} ${time}:00`;
          
          // Check if slot is available (not booked)
          const isBooked = existingBookings.some(booking => 
            booking.scheduled_date === slotDateTime
          );
          
          if (!isBooked) {
            availableSlots.push(time);
          }
        }
      }
      
      res.json({ availableSlots });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Get availability error:', error);
    res.status(500).json({ error: 'Failed to fetch availability' });
  }
});

app.post('/api/public/bookings', async (req, res) => {
  try {
    const { 
      userId = 1,
      customerData,
      services,
      scheduledDate,
      scheduledTime,
      totalAmount,
      notes,
      intakeAnswers = {} // New field for intake question answers
    } = req.body;
    
    if (!customerData || !services || !scheduledDate || !scheduledTime || !totalAmount) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const connection = await pool.getConnection();
    
    try {
      // First, create or find customer
      let customerId;
      const [existingCustomers] = await connection.query(`
        SELECT id FROM customers 
        WHERE user_id = ? AND email = ?
      `, [userId, customerData.email]);
      
      if (existingCustomers.length > 0) {
        customerId = existingCustomers[0].id;
        // Update customer information
        await connection.query(`
          UPDATE customers 
          SET first_name = ?, last_name = ?, phone = ?, address = ?, updated_at = NOW()
          WHERE id = ?
        `, [customerData.firstName, customerData.lastName, customerData.phone, customerData.address, customerId]);
      } else {
        // Create new customer
        const [customerResult] = await connection.query(`
          INSERT INTO customers (user_id, first_name, last_name, email, phone, address, created_at)
          VALUES (?, ?, ?, ?, ?, ?, NOW())
        `, [userId, customerData.firstName, customerData.lastName, customerData.email, customerData.phone, customerData.address]);
        customerId = customerResult.insertId;
      }
      
      // Create booking (job) for each service
      const bookingIds = [];
      for (const service of services) {
        const fullScheduledDate = `${scheduledDate} ${scheduledTime}:00`;
        
        const [bookingResult] = await connection.query(`
          INSERT INTO jobs (
            user_id, customer_id, service_id, scheduled_date, notes, status, created_at
          ) VALUES (?, ?, ?, ?, ?, 'pending', NOW())
        `, [userId, customerId, service.id, fullScheduledDate, notes]);
        
        const jobId = bookingResult.insertId;
        bookingIds.push(jobId);
        
        // Save intake question answers for this job
        if (intakeAnswers && Object.keys(intakeAnswers).length > 0) {
          // Get service intake questions to match with answers
          const [serviceData] = await connection.query(`
            SELECT intake_questions FROM services WHERE id = ?
          `, [service.id]);
          
          if (serviceData.length > 0 && serviceData[0].intake_questions) {
            try {
              // Handle both string and object formats with better validation
              let intakeQuestions;
              if (typeof serviceData[0].intake_questions === 'string') {
                try {
                  intakeQuestions = JSON.parse(serviceData[0].intake_questions);
                } catch (parseError) {
                  console.error('Error parsing intake_questions JSON string:', parseError);
                  intakeQuestions = [];
                }
              } else if (Array.isArray(serviceData[0].intake_questions)) {
                intakeQuestions = serviceData[0].intake_questions;
              } else {
                console.warn('Invalid intake_questions format, treating as empty array');
                intakeQuestions = [];
              }
              
              // Validate that intakeQuestions is an array
              if (!Array.isArray(intakeQuestions)) {
                console.warn('intakeQuestions is not an array, treating as empty array');
                intakeQuestions = [];
              }
              
              // Save each answer
              for (const question of intakeQuestions) {
                // Validate question structure
                if (!question || typeof question !== 'object' || !question.id || !question.question || !question.questionType) {
                  console.warn('Invalid question structure, skipping:', question);
                  continue;
                }
                
                const answer = intakeAnswers[question.id];
                if (answer !== undefined && answer !== null && answer !== '') {
                  const answerToSave = (Array.isArray(answer) || typeof answer === 'object') ? JSON.stringify(answer) : answer;
                  try {
                    await connection.query(`
                      INSERT INTO job_answers (
                        job_id, question_id, question_text, question_type, answer, created_at
                      ) VALUES (?, ?, ?, ?, ?, NOW())
                    `, [jobId, question.id, question.question, question.questionType, answerToSave]);
                  } catch (insertError) {
                    console.error('Error inserting job answer:', insertError);
                    // Continue processing other answers even if one fails
                  }
                }
              }
            } catch (error) {
              console.error('Error processing intake questions:', error);
              // Don't fail the entire operation if intake questions processing fails
            }
          }
        }
      }
      
      // Create invoice for the booking
      const [invoiceResult] = await connection.query(`
        INSERT INTO invoices (
          user_id, customer_id, amount, total_amount, status, due_date, created_at
        ) VALUES (?, ?, ?, ?, 'draft', DATE_ADD(NOW(), INTERVAL 15 DAY), NOW())
      `, [userId, customerId, totalAmount, totalAmount]);
      
      res.status(201).json({
        message: 'Booking created successfully',
        bookingIds,
        invoiceId: invoiceResult.insertId,
        customerId
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Create booking error:', error);
    res.status(500).json({ error: 'Failed to create booking' });
  }
});

app.get('/api/public/business-info', async (req, res) => {
  try {
    const { userId = 1 } = req.query;
    const connection = await pool.getConnection();
    
    try {
      const [users] = await connection.query(`
        SELECT business_name, email, phone
        FROM users 
        WHERE id = ?
      `, [userId]);
      
      if (users.length === 0) {
        return res.status(404).json({ error: 'Business not found' });
      }
      
      res.json(users[0]);
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Get business info error:', error);
    res.status(500).json({ error: 'Failed to fetch business information' });
  }
});

// User profile endpoints
app.get('/api/user/profile', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const connection = await pool.getConnection();
    
    try {
      // First try with the new columns
      try {
        const [users] = await connection.query(
          'SELECT id, email, first_name, last_name, business_name, phone, email_notifications, sms_notifications, profile_picture FROM users WHERE id = ?',
          [userId]
        );
        
        if (users.length === 0) {
          return res.status(404).json({ error: 'User not found' });
        }
        
        const user = users[0];
        res.json({
          id: user.id,
          email: user.email,
          firstName: user.first_name,
          lastName: user.last_name,
          businessName: user.business_name,
          phone: user.phone || '',
          emailNotifications: user.email_notifications === 1,
          smsNotifications: user.sms_notifications === 1,
          profilePicture: user.profile_picture
        });
      } catch (columnError) {
        // If new columns don't exist, fall back to basic columns
        if (columnError.code === 'ER_BAD_FIELD_ERROR') {
          const [users] = await connection.query(
            'SELECT id, email, first_name, last_name, business_name FROM users WHERE id = ?',
            [userId]
          );
          
          if (users.length === 0) {
            return res.status(404).json({ error: 'User not found' });
          }
          
          const user = users[0];
          res.json({
            id: user.id,
            email: user.email,
            firstName: user.first_name,
            lastName: user.last_name,
            businessName: user.business_name,
            phone: '',
            emailNotifications: true,
            smsNotifications: false,
            profilePicture: null
          });
        } else {
          throw columnError;
        }
      }
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Get user profile error:', error);
    res.status(500).json({ error: 'Failed to fetch user profile' });
  }
});

app.put('/api/user/profile', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { firstName, lastName, phone, emailNotifications, smsNotifications } = req.body;
    const connection = await pool.getConnection();
    
    try {
      await connection.query(
        'UPDATE users SET first_name = ?, last_name = ?, phone = ?, email_notifications = ?, sms_notifications = ?, updated_at = NOW() WHERE id = ?',
        [firstName, lastName, phone, emailNotifications ? 1 : 0, smsNotifications ? 1 : 0, userId]
      );
      
      res.json({ message: 'Profile updated successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Update user profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

app.put('/api/user/password', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { currentPassword, newPassword } = req.body;
    
    // Input validation
    if (!validatePassword(newPassword)) {
      return res.status(400).json({ error: 'New password must be at least 8 characters long' });
    }
    
    const connection = await pool.getConnection();
    
    try {
      // First verify current password
      const [users] = await connection.query(
        'SELECT password FROM users WHERE id = ?',
        [userId]
      );
      
      if (users.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }
      
      // Verify current password using bcrypt
      const isCurrentPasswordValid = await bcrypt.compare(currentPassword, users[0].password);
      
      if (!isCurrentPasswordValid) {
        return res.status(400).json({ error: 'Current password is incorrect' });
      }
      
      // Hash new password
      const saltRounds = 12;
      const hashedNewPassword = await bcrypt.hash(newPassword, saltRounds);
      
      // Update password
      await connection.query(
        'UPDATE users SET password = ?, updated_at = NOW() WHERE id = ?',
        [hashedNewPassword, userId]
      );
      
      res.json({ message: 'Password updated successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Update password error:', error);
    res.status(500).json({ error: 'Failed to update password' });
  }
});

app.put('/api/user/email', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { newEmail, password } = req.body;
    
    // Input validation
    if (!validateEmail(newEmail)) {
      return res.status(400).json({ error: 'Please provide a valid email address' });
    }
    
    if (!password || password.length < 1) {
      return res.status(400).json({ error: 'Password is required' });
    }
    
    // Sanitize email
    const sanitizedNewEmail = newEmail.toLowerCase().trim();
    
    const connection = await pool.getConnection();
    
    try {
      // Verify password first
      const [users] = await connection.query(
        'SELECT password FROM users WHERE id = ?',
        [userId]
      );
      
      if (users.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }
      
      // Verify password using bcrypt
      const isPasswordValid = await bcrypt.compare(password, users[0].password);
      
      if (!isPasswordValid) {
        return res.status(400).json({ error: 'Password is incorrect' });
      }
      
      // Check if new email already exists
      const [existingUsers] = await connection.query(
        'SELECT id FROM users WHERE email = ? AND id != ?',
        [sanitizedNewEmail, userId]
      );
      
      if (existingUsers.length > 0) {
        return res.status(400).json({ error: 'Email already exists' });
      }
      
      // Update email
      await connection.query(
        'UPDATE users SET email = ?, updated_at = NOW() WHERE id = ?',
        [sanitizedNewEmail, userId]
      );
      
      res.json({ message: 'Email updated successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Update email error:', error);
    res.status(500).json({ error: 'Failed to update email' });
  }
});

// Profile picture upload endpoint
app.post('/api/user/profile-picture', authenticateToken, upload.single('profilePicture'), async (req, res) => {try {
    const userId = req.user.userId;
    
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    const connection = await pool.getConnection();
    
    try {
      // Get the file URL
      const fileUrl = `http://localhost:5000/uploads/${req.file.filename}`;
      
      // Update user's profile picture
      await connection.query(
        'UPDATE users SET profile_picture = ?, updated_at = NOW() WHERE id = ?',
        [fileUrl, userId]
      );
      
      res.json({ 
        message: 'Profile picture updated successfully',
        profilePicture: fileUrl
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Profile picture upload error:', error);
    res.status(500).json({ error: 'Failed to upload profile picture' });
  }
});

// Billing endpoints
app.get('/api/user/billing', async (req, res) => {
  try {
    const { userId } = req.query;
    const connection = await pool.getConnection();
    
    try {
      const [billingInfo] = await connection.query(
        'SELECT subscription_plan, trial_end_date, is_trial, monthly_price, card_last4 FROM user_billing WHERE user_id = ?',
        [userId]
      );
      
      if (billingInfo.length === 0) {
        // Return default trial info
        return res.json({
          currentPlan: 'Standard',
          isTrial: true,
          trialDaysLeft: 14,
          trialEndDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric' }),
          monthlyPrice: 29,
          cardNumber: ''
        });
      }
      
      const billing = billingInfo[0];
      const trialEnd = new Date(billing.trial_end_date);
      const now = new Date();
      const daysLeft = Math.max(0, Math.ceil((trialEnd - now) / (1000 * 60 * 60 * 24)));
      
      res.json({
        currentPlan: billing.subscription_plan || 'Standard',
        isTrial: billing.is_trial === 1,
        trialDaysLeft: daysLeft,
        trialEndDate: trialEnd.toLocaleDateString('en-US', { month: 'long', day: 'numeric' }),
        monthlyPrice: billing.monthly_price || 29,
        cardNumber: billing.card_last4 ? `****${billing.card_last4}` : ''
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Get billing error:', error);
    res.status(500).json({ error: 'Failed to fetch billing information' });
  }
});

app.post('/api/user/billing/subscription', async (req, res) => {
  try {
    const { userId, plan, cardNumber, expiryMonth, expiryYear, cvc } = req.body;
    const connection = await pool.getConnection();
    
    try {
      // In a real application, you would integrate with a payment processor here
      // For now, we'll just store the subscription info
      
      const cardLast4 = cardNumber.slice(-4);
      const trialEndDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
      
      await connection.query(
        'INSERT INTO user_billing (user_id, subscription_plan, monthly_price, card_last4, trial_end_date, is_trial, created_at) VALUES (?, ?, ?, ?, ?, 1, NOW()) ON DUPLICATE KEY UPDATE subscription_plan = ?, monthly_price = ?, card_last4 = ?, trial_end_date = ?, is_trial = 0, updated_at = NOW()',
        [userId, plan, 29, cardLast4, trialEndDate, plan, 29, cardLast4, trialEndDate]
      );
      
      res.json({ message: 'Subscription created successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Create subscription error:', error);
    res.status(500).json({ error: 'Failed to create subscription' });
  }
});

// Payment settings endpoints
app.get('/api/user/payment-settings', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const connection = await pool.getConnection();
    
    try {
      const [settings] = await connection.query(
        'SELECT * FROM user_payment_settings WHERE user_id = ?',
        [userId]
      );
      
      if (settings.length === 0) {
        // Return default settings
        return res.json({
          onlineBookingTips: false,
          invoicePaymentTips: false,
          showServicePrices: true,
          showServiceDescriptions: false,
          paymentDueDays: 15,
          paymentDueUnit: 'days',
          defaultMemo: '',
          invoiceFooter: '',
          paymentProcessor: null,
          paymentProcessorConnected: false
        });
      }
      
      const setting = settings[0];
      res.json({
        onlineBookingTips: setting.online_booking_tips === 1,
        invoicePaymentTips: setting.invoice_payment_tips === 1,
        showServicePrices: setting.show_service_prices === 1,
        showServiceDescriptions: setting.show_service_descriptions === 1,
        paymentDueDays: setting.payment_due_days,
        paymentDueUnit: setting.payment_due_unit,
        defaultMemo: setting.default_memo || '',
        invoiceFooter: setting.invoice_footer || '',
        paymentProcessor: setting.payment_processor,
        paymentProcessorConnected: setting.payment_processor_connected === 1
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Get payment settings error:', error);
    res.status(500).json({ error: 'Failed to fetch payment settings' });
  }
});

app.put('/api/user/payment-settings', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const {
      onlineBookingTips,
      invoicePaymentTips,
      showServicePrices,
      showServiceDescriptions,
      paymentDueDays,
      paymentDueUnit,
      defaultMemo,
      invoiceFooter,
      paymentProcessor,
      paymentProcessorConnected
    } = req.body;
    
    const connection = await pool.getConnection();
    
    try {
      await connection.query(
        `INSERT INTO user_payment_settings (
          user_id, online_booking_tips, invoice_payment_tips, show_service_prices, 
          show_service_descriptions, payment_due_days, payment_due_unit, default_memo, 
          invoice_footer, payment_processor, payment_processor_connected, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE
          online_booking_tips = VALUES(online_booking_tips),
          invoice_payment_tips = VALUES(invoice_payment_tips),
          show_service_prices = VALUES(show_service_prices),
          show_service_descriptions = VALUES(show_service_descriptions),
          payment_due_days = VALUES(payment_due_days),
          payment_due_unit = VALUES(payment_due_unit),
          default_memo = VALUES(default_memo),
          invoice_footer = VALUES(invoice_footer),
          payment_processor = VALUES(payment_processor),
          payment_processor_connected = VALUES(payment_processor_connected),
          updated_at = NOW()`,
        [
          userId,
          onlineBookingTips ? 1 : 0,
          invoicePaymentTips ? 1 : 0,
          showServicePrices ? 1 : 0,
          showServiceDescriptions ? 1 : 0,
          paymentDueDays,
          paymentDueUnit,
          defaultMemo,
          invoiceFooter,
          paymentProcessor,
          paymentProcessorConnected ? 1 : 0
        ]
      );
      
      res.json({ message: 'Payment settings updated successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Update payment settings error:', error);
    res.status(500).json({ error: 'Failed to update payment settings' });
  }
});

// Custom payment methods endpoints
app.get('/api/user/payment-methods', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const connection = await pool.getConnection();
    
    try {
      const [methods] = await connection.query(
        'SELECT id, name, description, is_active FROM custom_payment_methods WHERE user_id = ? AND is_active = 1 ORDER BY created_at ASC',
        [userId]
      );
      
      res.json(methods);
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Get payment methods error:', error);
    res.status(500).json({ error: 'Failed to fetch payment methods' });
  }
});

app.post('/api/user/payment-methods', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { name, description } = req.body;
    
    if (!name || name.trim().length === 0) {
      return res.status(400).json({ error: 'Payment method name is required' });
    }
    
    const connection = await pool.getConnection();
    
    try {
      const [result] = await connection.query(
        'INSERT INTO custom_payment_methods (user_id, name, description) VALUES (?, ?, ?)',
        [userId, name.trim(), description || null]
      );
      
      const [newMethod] = await connection.query(
        'SELECT id, name, description FROM custom_payment_methods WHERE id = ?',
        [result.insertId]
      );
      
      res.status(201).json(newMethod[0]);
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Create payment method error:', error);
    res.status(500).json({ error: 'Failed to create payment method' });
  }
});

app.put('/api/user/payment-methods/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const methodId = req.params.id;
    const { name, description } = req.body;
    
    if (!name || name.trim().length === 0) {
      return res.status(400).json({ error: 'Payment method name is required' });
    }
    
    const connection = await pool.getConnection();
    
    try {
      const [result] = await connection.query(
        'UPDATE custom_payment_methods SET name = ?, description = ?, updated_at = NOW() WHERE id = ? AND user_id = ?',
        [name.trim(), description || null, methodId, userId]
      );
      
      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Payment method not found' });
      }
      
      res.json({ message: 'Payment method updated successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Update payment method error:', error);
    res.status(500).json({ error: 'Failed to update payment method' });
  }
});

app.delete('/api/user/payment-methods/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const methodId = req.params.id;
    
    const connection = await pool.getConnection();
    
    try {
      const [result] = await connection.query(
        'UPDATE custom_payment_methods SET is_active = 0, updated_at = NOW() WHERE id = ? AND user_id = ?',
        [methodId, userId]
      );
      
      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Payment method not found' });
      }
      
      res.json({ message: 'Payment method deleted successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Delete payment method error:', error);
    res.status(500).json({ error: 'Failed to delete payment method' });
  }
});

// Payment processor setup endpoint
app.post('/api/user/payment-processor/setup', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { processor } = req.body;
    
    if (!processor || !['stripe', 'paypal', 'square'].includes(processor)) {
      return res.status(400).json({ error: 'Invalid payment processor' });
    }
    
    const connection = await pool.getConnection();
    
    try {
      // In a real application, you would integrate with the payment processor here
      // For now, we'll just mark it as connected
      await connection.query(
        `INSERT INTO user_payment_settings (user_id, payment_processor, payment_processor_connected, updated_at) 
         VALUES (?, ?, 1, NOW())
         ON DUPLICATE KEY UPDATE 
           payment_processor = VALUES(payment_processor),
           payment_processor_connected = VALUES(payment_processor_connected),
           updated_at = NOW()`,
        [userId, processor]
      );
      
      res.json({ 
        message: 'Payment processor connected successfully',
        processor: processor,
        connected: true
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Setup payment processor error:', error);
    res.status(500).json({ error: 'Failed to setup payment processor' });
  }
});

// Availability endpoints
app.get('/api/user/availability', async (req, res) => {
  try {
    const { userId } = req.query;
    const connection = await pool.getConnection();
    
    try {
      const [availabilityInfo] = await connection.query(
        'SELECT business_hours, timeslot_templates FROM user_availability WHERE user_id = ?',
        [userId]
      );
      
      if (availabilityInfo.length === 0) {
        return res.json({
          businessHours: {
            monday: { start: '09:00', end: '17:00', enabled: true },
            tuesday: { start: '09:00', end: '17:00', enabled: true },
            wednesday: { start: '09:00', end: '17:00', enabled: true },
            thursday: { start: '09:00', end: '17:00', enabled: true },
            friday: { start: '09:00', end: '17:00', enabled: true },
            saturday: { start: '09:00', end: '17:00', enabled: false },
            sunday: { start: '09:00', end: '17:00', enabled: false }
          },
          timeslotTemplates: []
        });
      }
      
      const availability = availabilityInfo[0];
      res.json({
        businessHours: JSON.parse(availability.business_hours || '{}'),
        timeslotTemplates: JSON.parse(availability.timeslot_templates || '[]')
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Get availability error:', error);
    res.status(500).json({ error: 'Failed to fetch availability information' });
  }
});

app.put('/api/user/availability', async (req, res) => {
  try {
    const { userId, businessHours, timeslotTemplates } = req.body;
    const connection = await pool.getConnection();
    
    try {
      await connection.query(
        'INSERT INTO user_availability (user_id, business_hours, timeslot_templates, created_at) VALUES (?, ?, ?, NOW()) ON DUPLICATE KEY UPDATE business_hours = ?, timeslot_templates = ?, updated_at = NOW()',
        [userId, JSON.stringify(businessHours), JSON.stringify(timeslotTemplates), JSON.stringify(businessHours), JSON.stringify(timeslotTemplates)]
      );
      
      res.json({ message: 'Availability updated successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Update availability error:', error);
    res.status(500).json({ error: 'Failed to update availability' });
  }
});

// Territory Management API endpoints
app.get('/api/territories', async (req, res) => {
  try {
    const { userId, status, search, page = 1, limit = 20, sortBy = 'name', sortOrder = 'ASC' } = req.query;
    const connection = await pool.getConnection();
    
    try {
      let query = `
        SELECT 
          t.*,
          COUNT(DISTINCT j.id) as total_jobs,
          COUNT(DISTINCT CASE WHEN j.status = 'completed' THEN j.id END) as completed_jobs,
          SUM(CASE WHEN j.status = 'completed' THEN COALESCE(i.total_amount, 0) ELSE 0 END) as total_revenue,
          AVG(CASE WHEN j.status = 'completed' THEN i.total_amount ELSE NULL END) as avg_job_value
        FROM territories t
        LEFT JOIN jobs j ON t.id = j.territory_id
        LEFT JOIN invoices i ON j.id = i.job_id
        WHERE t.user_id = ?
      `;
      let params = [userId];
      
      if (status) {
        query += ' AND t.status = ?';
        params.push(status);
      }
      
      if (search) {
        query += ' AND (t.name LIKE ? OR t.location LIKE ?)';
        const searchTerm = `%${search}%`;
        params.push(searchTerm, searchTerm);
      }
      
      query += ` GROUP BY t.id ORDER BY t.${sortBy} ${sortOrder}`;
      
      const [territories] = await connection.query(query, params);
      
      // Get territory statistics
      const territoryStats = territories.map(territory => ({
        ...territory,
        zip_codes: JSON.parse(territory.zip_codes || '[]'),
        business_hours: JSON.parse(territory.business_hours || '{}'),
        team_members: JSON.parse(territory.team_members || '[]'),
        services: JSON.parse(territory.services || '[]')
      }));
      
      res.json({
        territories: territoryStats,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: territoryStats.length
        }
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Get territories error:', error);
    res.status(500).json({ error: 'Failed to fetch territories' });
  }
});

app.get('/api/territories/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const connection = await pool.getConnection();
    
    try {
      const [territories] = await connection.query(`
        SELECT 
          t.*,
          COUNT(DISTINCT j.id) as total_jobs,
          COUNT(DISTINCT CASE WHEN j.status = 'completed' THEN j.id END) as completed_jobs,
          SUM(CASE WHEN j.status = 'completed' THEN COALESCE(i.total_amount, 0) ELSE 0 END) as total_revenue,
          AVG(CASE WHEN j.status = 'completed' THEN i.total_amount ELSE NULL END) as avg_job_value
        FROM territories t
        LEFT JOIN jobs j ON t.id = j.territory_id
        LEFT JOIN invoices i ON j.id = i.job_id
        WHERE t.id = ?
        GROUP BY t.id
      `, [id]);
      
      if (territories.length === 0) {
        return res.status(404).json({ error: 'Territory not found' });
      }
      
      const territory = territories[0];
      territory.zip_codes = JSON.parse(territory.zip_codes || '[]');
      territory.business_hours = JSON.parse(territory.business_hours || '{}');
      territory.team_members = JSON.parse(territory.team_members || '[]');
      territory.services = JSON.parse(territory.services || '[]');
      
      // Get territory pricing
      const [pricing] = await connection.query(`
        SELECT tp.*, s.name as service_name, s.description as service_description
        FROM territory_pricing tp
        JOIN services s ON tp.service_id = s.id
        WHERE tp.territory_id = ?
      `, [id]);
      
      territory.pricing = pricing;
      
      res.json(territory);
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Get territory error:', error);
    res.status(500).json({ error: 'Failed to fetch territory' });
  }
});

app.post('/api/territories', async (req, res) => {
  try {
    const { 
      userId, 
      name, 
      description, 
      location, 
      zipCodes, 
      radiusMiles, 
      timezone, 
      businessHours, 
      teamMembers, 
      services, 
      pricingMultiplier 
    } = req.body;
    
    console.log('Received territory data:', req.body)
    console.log('Required fields check:', { userId, name, location })
    
        if (!userId || !name || !location) {
      console.log('Missing required fields:', { userId: !!userId, name: !!name, location: !!location })
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const connection = await pool.getConnection();
    
    try {
      const [result] = await connection.query(`
        INSERT INTO territories (
          user_id, name, description, location, zip_codes, radius_miles, 
          timezone, business_hours, team_members, services, pricing_multiplier, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
      `, [
        userId, name, description, location, 
        JSON.stringify(zipCodes || []), 
        radiusMiles || 25.00, 
        timezone || 'America/New_York',
        JSON.stringify(businessHours || {}),
        JSON.stringify(teamMembers || []),
        JSON.stringify(services || []),
        pricingMultiplier || 1.00
      ]);
      
      res.status(201).json({
        message: 'Territory created successfully',
        territoryId: result.insertId
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Create territory error:', error);
    res.status(500).json({ error: 'Failed to create territory' });
  }
});

app.put('/api/territories/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      name, 
      description, 
      location, 
      zipCodes, 
      radiusMiles, 
      timezone, 
      status,
      businessHours, 
      teamMembers, 
      services, 
      pricingMultiplier 
    } = req.body;
    
    const connection = await pool.getConnection();
    
    try {
      await connection.query(`
        UPDATE territories 
        SET name = ?, description = ?, location = ?, zip_codes = ?, 
            radius_miles = ?, timezone = ?, status = ?, business_hours = ?, 
            team_members = ?, services = ?, pricing_multiplier = ?, updated_at = NOW()
        WHERE id = ?
      `, [
        name, description, location, JSON.stringify(zipCodes || []),
        radiusMiles || 25.00, timezone || 'America/New_York', status,
        JSON.stringify(businessHours || {}), JSON.stringify(teamMembers || []),
        JSON.stringify(services || []), pricingMultiplier || 1.00, id
      ]);
      
      res.json({ message: 'Territory updated successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Update territory error:', error);
    res.status(500).json({ error: 'Failed to update territory' });
  }
});

app.delete('/api/territories/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const connection = await pool.getConnection();
    
    try {
      await connection.query('DELETE FROM territories WHERE id = ?', [id]);
      res.json({ message: 'Territory deleted successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Delete territory error:', error);
    res.status(500).json({ error: 'Failed to delete territory' });
  }
});

// Territory detection based on customer location
app.post('/api/territories/detect', async (req, res) => {
  try {
    const { userId, customerAddress, customerZipCode } = req.body;
    
    if (!userId || (!customerAddress && !customerZipCode)) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const connection = await pool.getConnection();
    
    try {
      // Get all active territories for the user
      const [territories] = await connection.query(`
        SELECT * FROM territories 
        WHERE user_id = ? AND status = 'active'
      `, [userId]);
      
      let matchedTerritory = null;
      
      for (const territory of territories) {
        const territoryZipCodes = JSON.parse(territory.zip_codes || '[]');
        const territoryRadius = territory.radius_miles || 25;
        
        // Check if customer ZIP code matches territory ZIP codes
        if (customerZipCode && territoryZipCodes.includes(customerZipCode)) {
          matchedTerritory = territory;
          break;
        }
        
        // Check if customer address is within territory radius
        if (customerAddress && territoryRadius > 0) {
          try {
            // Get coordinates for customer address
            const customerGeocodeResponse = await fetch(
              `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(customerAddress)}&key=${process.env.GOOGLE_MAPS_API_KEY}`
            )
            const customerGeocodeData = await customerGeocodeResponse.json()
            
            if (customerGeocodeData.results && customerGeocodeData.results.length > 0) {
              const customerCoords = customerGeocodeData.results[0].geometry.location
              
              // Get coordinates for territory center (using location field)
              const territoryGeocodeResponse = await fetch(
                `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(territory.location)}&key=${process.env.GOOGLE_MAPS_API_KEY}`
              )
              const territoryGeocodeData = await territoryGeocodeResponse.json()
              
              if (territoryGeocodeData.results && territoryGeocodeData.results.length > 0) {
                const territoryCoords = territoryGeocodeData.results[0].geometry.location
                
                // Calculate distance between points
                const distance = calculateDistance(
                  customerCoords.lat, customerCoords.lng,
                  territoryCoords.lat, territoryCoords.lng
                )
                
                if (distance <= territoryRadius) {
                  matchedTerritory = territory
                  break
                }
              }
            }
          } catch (error) {
            console.error('Error in geocoding:', error)
            // Continue to next territory if geocoding fails
          }
        }
      }
      
      if (matchedTerritory) {
        matchedTerritory.zip_codes = JSON.parse(matchedTerritory.zip_codes || '[]');
        matchedTerritory.business_hours = JSON.parse(matchedTerritory.business_hours || '{}');
        matchedTerritory.team_members = JSON.parse(matchedTerritory.team_members || '[]');
        matchedTerritory.services = JSON.parse(matchedTerritory.services || '[]');
      }
      
      res.json({
        territory: matchedTerritory,
        available: !!matchedTerritory
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Territory detection error:', error);
    res.status(500).json({ error: 'Failed to detect territory' });
  }
});

// Get available team members for a territory
app.get('/api/territories/:id/team-members', async (req, res) => {
  try {
    const { id } = req.params;
    const connection = await pool.getConnection();
    
    try {
      const [territory] = await connection.query(`
        SELECT team_members FROM territories WHERE id = ?
      `, [id]);
      
      if (territory.length === 0) {
        return res.status(404).json({ error: 'Territory not found' });
      }
      
      const teamMemberIds = JSON.parse(territory[0].team_members || '[]');
      
      if (teamMemberIds.length === 0) {
        return res.json({ teamMembers: [] });
      }
      
      const [teamMembers] = await connection.query(`
        SELECT id, first_name, last_name, email, phone, status, is_service_provider
        FROM team_members 
        WHERE id IN (${teamMemberIds.map(() => '?').join(',')}) AND status = 'active'
      `, teamMemberIds);
      
      res.json({ teamMembers });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Get territory team members error:', error);
    res.status(500).json({ error: 'Failed to fetch territory team members' });
  }
});

// Get territory business hours
app.get('/api/territories/:id/business-hours', async (req, res) => {
  try {
    const { id } = req.params;
    const connection = await pool.getConnection();
    
    try {
      const [territory] = await connection.query(`
        SELECT business_hours, timezone FROM territories WHERE id = ?
      `, [id]);
      
      if (territory.length === 0) {
        return res.status(404).json({ error: 'Territory not found' });
      }
      
      const businessHours = JSON.parse(territory[0].business_hours || '{}');
      const timezone = territory[0].timezone || 'America/New_York';
      
      res.json({ businessHours, timezone });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Get territory business hours error:', error);
    res.status(500).json({ error: 'Failed to fetch territory business hours' });
  }
});

// Territory pricing endpoints
app.get('/api/territories/:id/pricing', async (req, res) => {
  try {
    const { id } = req.params;
    const connection = await pool.getConnection();
    
    try {
      const [pricing] = await connection.query(`
        SELECT tp.*, s.name as service_name, s.description as service_description
        FROM territory_pricing tp
        JOIN services s ON tp.service_id = s.id
        WHERE tp.territory_id = ?
      `, [id]);
      
      res.json(pricing);
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Get territory pricing error:', error);
    res.status(500).json({ error: 'Failed to fetch territory pricing' });
  }
});

app.post('/api/territories/:id/pricing', async (req, res) => {
  try {
    const { id } = req.params;
    const { serviceId, basePrice, priceMultiplier, minimumPrice, maximumPrice } = req.body;
    
    const connection = await pool.getConnection();
    
    try {
      await connection.query(`
        INSERT INTO territory_pricing (
          territory_id, service_id, base_price, price_multiplier, 
          minimum_price, maximum_price, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE
          base_price = VALUES(base_price),
          price_multiplier = VALUES(price_multiplier),
          minimum_price = VALUES(minimum_price),
          maximum_price = VALUES(maximum_price),
          updated_at = NOW()
      `, [id, serviceId, basePrice, priceMultiplier || 1.00, minimumPrice, maximumPrice]);
      
      res.json({ message: 'Territory pricing updated successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Update territory pricing error:', error);
    res.status(500).json({ error: 'Failed to update territory pricing' });
  }
});

// Invoices endpoints
app.get('/api/invoices', async (req, res) => {
  try {
    const { userId, search = '', status = '', page = 1, limit = 10, sortBy = 'created_at', sortOrder = 'DESC', customerId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const connection = await pool.getConnection();
    
    try {
      const offset = (parseInt(page) - 1) * parseInt(limit);
      
      let whereClause = 'WHERE i.user_id = ?';
      let params = [userId];
      
      if (search) {
        whereClause += ' AND (c.first_name LIKE ? OR c.last_name LIKE ? OR c.email LIKE ? OR i.invoice_number LIKE ?)';
        const searchTerm = `%${search}%`;
        params.push(searchTerm, searchTerm, searchTerm, searchTerm);
      }
      
      if (status) {
        whereClause += ' AND i.status = ?';
        params.push(status);
      }
      
      // Handle customer filtering
      if (customerId) {
        whereClause += ' AND i.customer_id = ?';
        params.push(customerId);
      }
      
      // Get invoices with customer info
      const [invoices] = await connection.query(`
        SELECT 
          i.*,
          c.first_name as customer_first_name,
          c.last_name as customer_last_name,
          c.email as customer_email,
          c.phone as customer_phone,
          s.name as service_name,
          j.scheduled_date,
          j.status as job_status
        FROM invoices i
        LEFT JOIN customers c ON i.customer_id = c.id
        LEFT JOIN jobs j ON i.job_id = j.id
        LEFT JOIN services s ON j.service_id = s.id
        ${whereClause}
        ORDER BY i.${sortBy} ${sortOrder}
        LIMIT ? OFFSET ?
      `, [...params, parseInt(limit), offset]);
      
      // Get total count
      const [countResult] = await connection.query(`
        SELECT COUNT(*) as total
        FROM invoices i
        LEFT JOIN customers c ON i.customer_id = c.id
        ${whereClause}
      `, params);
      
      const total = countResult[0].total;
      const totalPages = Math.ceil(total / parseInt(limit));
      
      res.json({
        invoices,
        pagination: {
          current_page: parseInt(page),
          total_pages: totalPages,
          total_items: total,
          items_per_page: parseInt(limit)
        }
      });
      
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Get invoices error:', error);
    res.status(500).json({ error: 'Failed to fetch invoices' });
  }
});

app.get('/api/invoices/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const connection = await pool.getConnection();
    
    try {
      const [invoices] = await connection.query(`
        SELECT 
          i.*,
          c.first_name as customer_first_name,
          c.last_name as customer_last_name,
          c.email as customer_email,
          c.phone as customer_phone,
          s.name as service_name,
          j.scheduled_date,
          j.status as job_status
        FROM invoices i
        LEFT JOIN customers c ON i.customer_id = c.id
        LEFT JOIN jobs j ON i.job_id = j.id
        LEFT JOIN services s ON j.service_id = s.id
        WHERE i.id = ? AND i.user_id = ?
      `, [id, userId]);
      
      if (invoices.length === 0) {
        return res.status(404).json({ error: 'Invoice not found' });
      }
      
      res.json(invoices[0]);
      
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Get invoice error:', error);
    res.status(500).json({ error: 'Failed to fetch invoice' });
  }
});

app.post('/api/invoices', async (req, res) => {
  try {
    console.log('Invoice creation request:', req.body);
    const { 
      userId, customerId, jobId, estimateId, invoiceNumber, 
      subtotal, taxAmount, discountAmount, totalAmount, 
      status = 'sent', dueDate, notes 
    } = req.body;
    
    if (!userId || !customerId || !totalAmount) {
      return res.status(400).json({ error: 'userId, customerId, and totalAmount are required' });
    }

    const connection = await pool.getConnection();
    
    try {
      // Validate that the customer exists and belongs to the user
      const [customerCheck] = await connection.query('SELECT id FROM customers WHERE id = ? AND user_id = ?', [customerId, userId]);
      if (customerCheck.length === 0) {
        return res.status(400).json({ error: 'Customer not found or does not belong to user' });
      }

      // Validate that the job exists if jobId is provided
      if (jobId) {
        const [jobCheck] = await connection.query('SELECT id FROM jobs WHERE id = ? AND user_id = ?', [jobId, userId]);
        if (jobCheck.length === 0) {
          return res.status(400).json({ error: 'Job not found or does not belong to user' });
        }
      }
      const [result] = await connection.query(`
        INSERT INTO invoices (
          user_id, customer_id, job_id, estimate_id,
          amount, tax_amount, total_amount,
          status, due_date, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
      `, [
        userId, customerId, jobId || null, estimateId || null,
        totalAmount, taxAmount || 0, totalAmount,
        status, dueDate || null
      ]);
      
      const invoiceId = result.insertId;
      
      // Update job invoice_status if jobId is provided
      if (jobId) {
        await connection.query(`
          UPDATE jobs SET 
            invoice_status = 'invoiced',
            invoice_id = ?,
            invoice_amount = ?,
            invoice_date = CURDATE(),
            updated_at = NOW()
          WHERE id = ?
        `, [invoiceId, totalAmount, jobId]);
        console.log('Updated job invoice status for job ID:', jobId);
      }
      
      // Get the created invoice
      const [invoices] = await connection.query(`
        SELECT 
          i.*,
          c.first_name as customer_first_name,
          c.last_name as customer_last_name,
          c.email as customer_email
        FROM invoices i
        LEFT JOIN customers c ON i.customer_id = c.id
        WHERE i.id = ?
      `, [invoiceId]);
      
      res.status(201).json(invoices[0]);
      
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Create invoice error:', error);
    console.error('Error details:', {
      message: error.message,
      code: error.code,
      sqlMessage: error.sqlMessage
    });
    res.status(500).json({ error: 'Failed to create invoice', details: error.message });
  }
});

app.put('/api/invoices/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      userId, status, amount, taxAmount, 
      totalAmount, dueDate, notes 
    } = req.body;
    
    console.log('Invoice update request:', { id, userId, status, amount, taxAmount, totalAmount });
    
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const connection = await pool.getConnection();
    
    try {
      // Convert string values to numbers for decimal fields
      const amountValue = parseFloat(amount) || 0;
      const taxAmountValue = parseFloat(taxAmount) || 0;
      const totalAmountValue = parseFloat(totalAmount) || 0;
      
      console.log('Converted values:', { amountValue, taxAmountValue, totalAmountValue });
      
      const [result] = await connection.query(`
        UPDATE invoices SET
          status = ?,
          amount = ?,
          tax_amount = ?,
          total_amount = ?,
          due_date = ?,
          notes = ?,
          updated_at = NOW()
        WHERE id = ? AND user_id = ?
      `, [
        status, amountValue, taxAmountValue,
        totalAmountValue, dueDate || null, notes || null, id, userId
      ]);
      
      console.log('Update result:', result);
      
      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Invoice not found' });
      }
      
      // Get the updated invoice
      const [invoices] = await connection.query(`
        SELECT 
          i.*,
          c.first_name as customer_first_name,
          c.last_name as customer_last_name,
          c.email as customer_email
        FROM invoices i
        LEFT JOIN customers c ON i.customer_id = c.id
        WHERE i.id = ?
      `, [id]);
      
      console.log('Updated invoice:', invoices[0]);
      res.json(invoices[0]);
      
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Update invoice error:', error);
    console.error('Request body:', req.body);
    console.error('Invoice ID:', id);
    res.status(500).json({ error: 'Failed to update invoice' });
  }
});

app.delete('/api/invoices/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const connection = await pool.getConnection();
    
    try {
      const [result] = await connection.query(`
        DELETE FROM invoices WHERE id = ? AND user_id = ?
      `, [id, userId]);
      
      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Invoice not found' });
      }
      
      res.json({ message: 'Invoice deleted successfully' });
      
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Delete invoice error:', error);
    res.status(500).json({ error: 'Failed to delete invoice' });
  }
});

// Analytics endpoints
app.get('/api/analytics/overview', async (req, res) => {
  try {
    const { userId, startDate, endDate } = req.query;
    const connection = await pool.getConnection();
    
    try {
      let dateFilter = '';
      let params = [userId];
      
      if (startDate && endDate) {
        dateFilter = 'AND j.scheduled_date BETWEEN ? AND ?';
        params.push(startDate, endDate);
      }
      
      // Get job statistics
      const [jobStats] = await connection.query(`
        SELECT 
          COUNT(DISTINCT j.id) as total_jobs,
          COUNT(DISTINCT CASE WHEN j.status = 'completed' THEN j.id END) as completed_jobs,
          COUNT(DISTINCT CASE WHEN j.status = 'pending' THEN j.id END) as pending_jobs,
          COUNT(DISTINCT CASE WHEN j.status = 'cancelled' THEN j.id END) as cancelled_jobs,
          AVG(CASE WHEN j.status = 'completed' THEN s.duration ELSE NULL END) as avg_job_duration
        FROM jobs j
        LEFT JOIN services s ON j.service_id = s.id
        WHERE j.user_id = ? ${dateFilter}
      `, params);
      
      // Get revenue statistics
      const [revenueStats] = await connection.query(`
        SELECT 
          SUM(i.total_amount) as total_revenue,
          AVG(i.total_amount) as avg_job_value,
          COUNT(DISTINCT i.id) as total_invoices
        FROM invoices i
        WHERE i.user_id = ? ${dateFilter.replace('j.scheduled_date', 'i.created_at')}
      `, params);
      
      // Get customer statistics
      const [customerStats] = await connection.query(`
        SELECT 
          COUNT(DISTINCT c.id) as total_customers,
          COUNT(DISTINCT CASE WHEN c.status = 'active' THEN c.id END) as active_customers,
          COUNT(DISTINCT CASE WHEN c.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN c.id END) as new_customers
        FROM customers c
        WHERE c.user_id = ?
      `, [userId]);
      
      const overview = {
        ...jobStats[0],
        ...revenueStats[0],
        ...customerStats[0],
        completion_rate: jobStats[0].total_jobs > 0 ? 
          (jobStats[0].completed_jobs / jobStats[0].total_jobs * 100).toFixed(1) : 0
      };
      
      res.json(overview);
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Get analytics overview error:', error);
    res.status(500).json({ error: 'Failed to fetch analytics overview' });
  }
});

app.get('/api/analytics/revenue', async (req, res) => {
  try {
    const { userId, startDate, endDate, groupBy = 'day' } = req.query;
    const connection = await pool.getConnection();
    
    try {
      let dateFilter = '';
      let params = [userId];
      
      if (startDate && endDate) {
        dateFilter = 'AND i.created_at BETWEEN ? AND ?';
        params.push(startDate, endDate);
      }
      
      let groupByClause = 'DATE(i.created_at)';
      if (groupBy === 'week') {
        groupByClause = 'YEARWEEK(i.created_at)';
      } else if (groupBy === 'month') {
        groupByClause = 'DATE_FORMAT(i.created_at, "%Y-%m")';
      }
      
      const [revenueData] = await connection.query(`
        SELECT 
          ${groupByClause} as date,
          SUM(i.total_amount) as revenue,
          COUNT(DISTINCT i.id) as invoice_count
        FROM invoices i
        WHERE i.user_id = ? ${dateFilter}
        GROUP BY ${groupByClause}
        ORDER BY date ASC
      `, params);
      
      res.json(revenueData);
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Get revenue analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch revenue analytics' });
  }
});

app.get('/api/analytics/team-performance', async (req, res) => {
  try {
    const { userId, startDate, endDate } = req.query;
    const connection = await pool.getConnection();
    
    try {
      let dateFilter = '';
      let params = [userId];
      
      if (startDate && endDate) {
        dateFilter = 'AND j.scheduled_date BETWEEN ? AND ?';
        params.push(startDate, endDate);
      }
      
      const [teamPerformance] = await connection.query(`
        SELECT 
          tm.id,
          tm.first_name,
          tm.last_name,
          tm.role,
          COUNT(DISTINCT j.id) as total_jobs,
          COUNT(DISTINCT CASE WHEN j.status = 'completed' THEN j.id END) as completed_jobs,
          AVG(CASE WHEN j.status = 'completed' THEN s.price ELSE NULL END) as avg_job_value,
          SUM(CASE WHEN j.status = 'completed' THEN s.price ELSE 0 END) as total_revenue
        FROM team_members tm
        LEFT JOIN jobs j ON tm.id = j.team_member_id AND j.user_id = ? ${dateFilter}
        LEFT JOIN services s ON j.service_id = s.id
        WHERE tm.user_id = ?
        GROUP BY tm.id
        ORDER BY total_jobs DESC
      `, [...params, userId]);
      
      const performanceWithRates = teamPerformance.map(member => ({
        ...member,
        completion_rate: member.total_jobs > 0 ? 
          (member.completed_jobs / member.total_jobs * 100).toFixed(1) : 0
      }));
      
      res.json(performanceWithRates);
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Get team performance error:', error);
    res.status(500).json({ error: 'Failed to fetch team performance' });
  }
});

app.get('/api/analytics/customer-insights', async (req, res) => {
  try {
    const { userId, startDate, endDate } = req.query;
    const connection = await pool.getConnection();
    
    try {
      let dateFilter = '';
      let params = [userId];
      
      if (startDate && endDate) {
        dateFilter = 'AND j.scheduled_date BETWEEN ? AND ?';
        params.push(startDate, endDate);
      }
      
      // Customer lifetime value
      const [customerLTV] = await connection.query(`
        SELECT 
          c.id,
          c.first_name,
          c.last_name,
          c.email,
          COUNT(DISTINCT j.id) as total_jobs,
          SUM(CASE WHEN j.status = 'completed' THEN s.price ELSE 0 END) as lifetime_value,
          AVG(CASE WHEN j.status = 'completed' THEN s.price ELSE NULL END) as avg_job_value,
          MAX(j.scheduled_date) as last_job_date
        FROM customers c
        LEFT JOIN jobs j ON c.id = j.customer_id AND j.user_id = ? ${dateFilter}
        LEFT JOIN services s ON j.service_id = s.id
        WHERE c.user_id = ?
        GROUP BY c.id
        ORDER BY lifetime_value DESC
        LIMIT 10
      `, [...params, userId]);
      
      // Customer acquisition
      const [customerAcquisition] = await connection.query(`
        SELECT 
          DATE_FORMAT(c.created_at, '%Y-%m') as month,
          COUNT(DISTINCT c.id) as new_customers
        FROM customers c
        WHERE c.user_id = ? AND c.created_at >= DATE_SUB(NOW(), INTERVAL 12 MONTH)
        GROUP BY DATE_FORMAT(c.created_at, '%Y-%m')
        ORDER BY month DESC
      `, [userId]);
      
      res.json({
        topCustomers: customerLTV,
        customerAcquisition
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Get customer insights error:', error);
    res.status(500).json({ error: 'Failed to fetch customer insights' });
  }
});

app.get('/api/analytics/service-performance', async (req, res) => {
  try {
    const { userId, startDate, endDate } = req.query;
    const connection = await pool.getConnection();
    
    try {
      let dateFilter = '';
      let params = [userId];
      
      if (startDate && endDate) {
        dateFilter = 'AND j.scheduled_date BETWEEN ? AND ?';
        params.push(startDate, endDate);
      }
      
      const [servicePerformance] = await connection.query(`
        SELECT 
          s.id,
          s.name,
          s.price,
          COUNT(DISTINCT j.id) as total_jobs,
          COUNT(DISTINCT CASE WHEN j.status = 'completed' THEN j.id END) as completed_jobs,
          SUM(CASE WHEN j.status = 'completed' THEN s.price ELSE 0 END) as total_revenue,
          AVG(CASE WHEN j.status = 'completed' THEN s.price ELSE NULL END) as avg_job_value
        FROM services s
        LEFT JOIN jobs j ON s.id = j.service_id AND j.user_id = ? ${dateFilter}
        WHERE s.user_id = ?
        GROUP BY s.id
        ORDER BY total_jobs DESC
      `, [...params, userId]);
      
      res.json(servicePerformance);
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Get service performance error:', error);
    res.status(500).json({ error: 'Failed to fetch service performance' });
  }
});

// Territory analytics endpoints
app.get('/api/territories/:id/analytics', async (req, res) => {
  try {
    const { id } = req.params;
    const { startDate, endDate } = req.query;
    const connection = await pool.getConnection();
    
    try {
      let dateFilter = '';
      let params = [id];
      
      if (startDate && endDate) {
        dateFilter = 'AND j.scheduled_date BETWEEN ? AND ?';
        params.push(startDate, endDate);
      }
      
      const [analytics] = await connection.query(`
        SELECT 
          COUNT(DISTINCT j.id) as total_jobs,
          COUNT(DISTINCT CASE WHEN j.status = 'completed' THEN j.id END) as completed_jobs,
          COUNT(DISTINCT CASE WHEN j.status = 'cancelled' THEN j.id END) as cancelled_jobs,
          SUM(CASE WHEN j.status = 'completed' THEN COALESCE(i.total_amount, 0) ELSE 0 END) as total_revenue,
          AVG(CASE WHEN j.status = 'completed' THEN i.total_amount ELSE NULL END) as avg_job_value,
          COUNT(DISTINCT j.customer_id) as unique_customers
        FROM jobs j
        LEFT JOIN invoices i ON j.id = i.job_id
        WHERE j.territory_id = ? ${dateFilter}
      `, params);
      
      // Get monthly trends
      const [monthlyTrends] = await connection.query(`
        SELECT 
          DATE_FORMAT(j.scheduled_date, '%Y-%m') as month,
          COUNT(DISTINCT j.id) as job_count,
          SUM(CASE WHEN j.status = 'completed' THEN COALESCE(i.total_amount, 0) ELSE 0 END) as revenue
        FROM jobs j
        LEFT JOIN invoices i ON j.id = i.job_id
        WHERE j.territory_id = ? ${dateFilter}
        GROUP BY DATE_FORMAT(j.scheduled_date, '%Y-%m')
        ORDER BY month DESC
        LIMIT 12
      `, params);
      
      res.json({
        overview: analytics[0],
        monthlyTrends
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Get territory analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch territory analytics' });
  }
});

// Service areas endpoints
app.get('/api/user/service-areas', async (req, res) => {
  try {
    const { userId } = req.query;
    const connection = await pool.getConnection();
    
    try {
      // Get service areas settings
      const [serviceAreasInfo] = await connection.query(
        'SELECT enforce_service_area FROM user_service_areas WHERE user_id = ?',
        [userId]
      );
      
      // Get territories for this user
      const [territories] = await connection.query(
        'SELECT id, name, description, location, radius_miles, status FROM territories WHERE user_id = ? AND status = "active"',
        [userId]
      );
      
      const enforceServiceArea = serviceAreasInfo.length > 0 ? serviceAreasInfo[0].enforce_service_area === 1 : true;
      
      res.json({
        enforceServiceArea: enforceServiceArea,
        territories: territories
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Get service areas error:', error);
    res.status(500).json({ error: 'Failed to fetch service areas information' });
  }
});

app.put('/api/user/service-areas', async (req, res) => {
  try {
    const { userId, enforceServiceArea, territories } = req.body;
    const connection = await pool.getConnection();
    
    try {
      await connection.query(
        'INSERT INTO user_service_areas (user_id, enforce_service_area, territories, created_at) VALUES (?, ?, ?, NOW()) ON DUPLICATE KEY UPDATE enforce_service_area = ?, territories = ?, updated_at = NOW()',
        [userId, enforceServiceArea ? 1 : 0, JSON.stringify(territories), enforceServiceArea ? 1 : 0, JSON.stringify(territories)]
      );
      
      res.json({ message: 'Service areas updated successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Update service areas error:', error);
    res.status(500).json({ error: 'Failed to update service areas' });
  }
});

// Service templates endpoints
app.get('/api/service-templates', async (req, res) => {
  try {
    const templates = [
      { 
        id: "junk-removal", 
        name: "Junk Removal", 
        icon: "🗑️",
        description: "Remove unwanted items from homes, offices, or construction sites",
        price: "150",
        duration: { hours: 2, minutes: 0 },
        category: "Removal",
        modifiers: []
      },
      { 
        id: "home-cleaning", 
        name: "Home Cleaning", 
        icon: "🧹",
        description: "Comprehensive home cleaning services for residential properties",
        price: "80",
        duration: { hours: 3, minutes: 0 },
        category: "Cleaning",
        modifiers: []
      },
      { 
        id: "tv-mounting", 
        name: "TV Mounting", 
        icon: "📺",
        description: "Professional TV mounting and installation services",
        price: "120",
        duration: { hours: 1, minutes: 30 },
        category: "Installation",
        modifiers: []
      },
      { 
        id: "plumbing", 
        name: "Plumbing Service", 
        icon: "🔧",
        description: "Emergency and routine plumbing repairs and installations",
        price: "95",
        duration: { hours: 1, minutes: 0 },
        category: "Repair",
        modifiers: []
      },
      { 
        id: "hvac", 
        name: "HVAC Service", 
        icon: "❄️",
        description: "Heating, ventilation, and air conditioning maintenance",
        price: "125",
        duration: { hours: 2, minutes: 0 },
        category: "Maintenance",
        modifiers: []
      },
      { 
        id: "carpet-cleaning", 
        name: "Carpet Cleaning", 
        icon: "🧼",
        description: "Deep carpet cleaning and stain removal services",
        price: "75",
        duration: { hours: 2, minutes: 30 },
        category: "Cleaning",
        modifiers: []
      },
      { 
        id: "window-cleaning", 
        name: "Window Cleaning", 
        icon: "🪟",
        description: "Interior and exterior window cleaning services",
        price: "60",
        duration: { hours: 1, minutes: 0 },
        category: "Cleaning",
        modifiers: []
      },
      { 
        id: "pressure-washing", 
        name: "Pressure Washing", 
        icon: "💦",
        description: "Exterior surface cleaning with high-pressure water",
        price: "200",
        duration: { hours: 3, minutes: 0 },
        category: "Cleaning",
        modifiers: []
      },
      { 
        id: "landscaping", 
        name: "Landscaping", 
        icon: "🌿",
        description: "Lawn maintenance, gardening, and landscape design",
        price: "100",
        duration: { hours: 2, minutes: 0 },
        category: "Landscaping",
        modifiers: []
      },
      { 
        id: "electrical", 
        name: "Electrical Service", 
        icon: "⚡",
        description: "Electrical repairs, installations, and safety inspections",
        price: "110",
        duration: { hours: 1, minutes: 30 },
        category: "Repair",
        modifiers: []
      },
      { 
        id: "painting", 
        name: "Painting Service", 
        icon: "🎨",
        description: "Interior and exterior painting services",
        price: "300",
        duration: { hours: 4, minutes: 0 },
        category: "Painting",
        modifiers: []
      },
      { 
        id: "moving", 
        name: "Moving Service", 
        icon: "📦",
        description: "Residential and commercial moving services",
        price: "250",
        duration: { hours: 4, minutes: 0 },
        category: "Moving",
        modifiers: []
      }
    ];
    
    res.json(templates);
  } catch (error) {
    console.error('Get service templates error:', error);
    res.status(500).json({ error: 'Failed to fetch service templates' });
  }
});

// Service availability endpoints
app.get('/api/services/:serviceId/availability', async (req, res) => {
  try {
    const { serviceId } = req.params;
    const connection = await pool.getConnection();
    
    try {
      // Get service availability
      const [availability] = await connection.query(
        'SELECT * FROM service_availability WHERE service_id = ?',
        [serviceId]
      );
      
      // Get scheduling rules
      const [schedulingRules] = await connection.query(
        'SELECT * FROM service_scheduling_rules WHERE service_id = ? ORDER BY start_date ASC',
        [serviceId]
      );
      
      // Get timeslot templates
      const [timeslotTemplates] = await connection.query(
        'SELECT * FROM service_timeslot_templates WHERE service_id = ? AND is_active = 1',
        [serviceId]
      );
      
      if (availability.length === 0) {
        // Return default availability
        return res.json({
          availabilityType: 'default',
          businessHoursOverride: null,
          timeslotTemplateId: null,
          minimumBookingNotice: 0,
          maximumBookingAdvance: 525600,
          bookingInterval: 30,
          schedulingRules: [],
          timeslotTemplates: []
        });
      }
      
      const serviceAvailability = availability[0];
      res.json({
        availabilityType: serviceAvailability.availability_type,
        businessHoursOverride: serviceAvailability.business_hours_override ? JSON.parse(serviceAvailability.business_hours_override) : null,
        timeslotTemplateId: serviceAvailability.timeslot_template_id,
        minimumBookingNotice: serviceAvailability.minimum_booking_notice,
        maximumBookingAdvance: serviceAvailability.maximum_booking_advance,
        bookingInterval: serviceAvailability.booking_interval,
        schedulingRules: schedulingRules.map(rule => ({
          ...rule,
          daysOfWeek: rule.days_of_week ? JSON.parse(rule.days_of_week) : null
        })),
        timeslotTemplates: timeslotTemplates.map(template => ({
          ...template,
          timeslots: JSON.parse(template.timeslots)
        }))
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Get service availability error:', error);
    res.status(500).json({ error: 'Failed to fetch service availability' });
  }
});

app.put('/api/services/:serviceId/availability', async (req, res) => {
  try {
    const { serviceId } = req.params;
    const { 
      availabilityType, 
      businessHoursOverride, 
      timeslotTemplateId, 
      minimumBookingNotice, 
      maximumBookingAdvance, 
      bookingInterval 
    } = req.body;
    
    const connection = await pool.getConnection();
    
    try {
      // Get user ID from service
      const [services] = await connection.query(
        'SELECT user_id FROM services WHERE id = ?',
        [serviceId]
      );
      
      if (services.length === 0) {
        return res.status(404).json({ error: 'Service not found' });
      }
      
      const userId = services[0].user_id;
      
      // Insert or update service availability
      await connection.query(
        `INSERT INTO service_availability 
         (service_id, user_id, availability_type, business_hours_override, timeslot_template_id, 
          minimum_booking_notice, maximum_booking_advance, booking_interval, created_at) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW()) 
         ON DUPLICATE KEY UPDATE 
         availability_type = ?, business_hours_override = ?, timeslot_template_id = ?,
         minimum_booking_notice = ?, maximum_booking_advance = ?, booking_interval = ?, updated_at = NOW()`,
        [
          serviceId, userId, availabilityType, 
          businessHoursOverride ? JSON.stringify(businessHoursOverride) : null, 
          timeslotTemplateId, minimumBookingNotice, maximumBookingAdvance, bookingInterval,
          availabilityType, 
          businessHoursOverride ? JSON.stringify(businessHoursOverride) : null, 
          timeslotTemplateId, minimumBookingNotice, maximumBookingAdvance, bookingInterval
        ]
      );
      
      res.json({ message: 'Service availability updated successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Update service availability error:', error);
    res.status(500).json({ error: 'Failed to update service availability' });
  }
});

// Service scheduling rules endpoints
app.post('/api/services/:serviceId/scheduling-rules', async (req, res) => {
  try {
    const { serviceId } = req.params;
    const { ruleType, startDate, endDate, startTime, endTime, daysOfWeek, capacityLimit, reason } = req.body;
    
    const connection = await pool.getConnection();
    
    try {
      const [result] = await connection.query(
        `INSERT INTO service_scheduling_rules 
         (service_id, rule_type, start_date, end_date, start_time, end_time, days_of_week, capacity_limit, reason, created_at) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
          serviceId, ruleType, startDate, endDate, startTime, endTime,
          daysOfWeek ? JSON.stringify(daysOfWeek) : null, capacityLimit, reason
        ]
      );
      
      res.status(201).json({ 
        message: 'Scheduling rule created successfully',
        ruleId: result.insertId 
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Create scheduling rule error:', error);
    res.status(500).json({ error: 'Failed to create scheduling rule' });
  }
});

app.delete('/api/services/:serviceId/scheduling-rules/:ruleId', async (req, res) => {
  try {
    const { serviceId, ruleId } = req.params;
    const connection = await pool.getConnection();
    
    try {
      await connection.query(
        'DELETE FROM service_scheduling_rules WHERE id = ? AND service_id = ?',
        [ruleId, serviceId]
      );
      
      res.json({ message: 'Scheduling rule deleted successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Delete scheduling rule error:', error);
    res.status(500).json({ error: 'Failed to delete scheduling rule' });
  }
});

// Service timeslot templates endpoints
app.post('/api/services/:serviceId/timeslot-templates', async (req, res) => {
  try {
    const { serviceId } = req.params;
    const { name, description, timeslots } = req.body;
    
    const connection = await pool.getConnection();
    
    try {
      const [result] = await connection.query(
        `INSERT INTO service_timeslot_templates 
         (service_id, name, description, timeslots, created_at) 
         VALUES (?, ?, ?, ?, NOW())`,
        [serviceId, name, description, JSON.stringify(timeslots)]
      );
      
      res.status(201).json({ 
        message: 'Timeslot template created successfully',
        templateId: result.insertId 
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Create timeslot template error:', error);
    res.status(500).json({ error: 'Failed to create timeslot template' });
  }
});

app.put('/api/services/:serviceId/timeslot-templates/:templateId', async (req, res) => {
  try {
    const { serviceId, templateId } = req.params;
    const { name, description, timeslots, isActive } = req.body;
    
    const connection = await pool.getConnection();
    
    try {
      await connection.query(
        `UPDATE service_timeslot_templates 
         SET name = ?, description = ?, timeslots = ?, is_active = ?, updated_at = NOW() 
         WHERE id = ? AND service_id = ?`,
        [name, description, JSON.stringify(timeslots), isActive ? 1 : 0, templateId, serviceId]
      );
      
      res.json({ message: 'Timeslot template updated successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Update timeslot template error:', error);
    res.status(500).json({ error: 'Failed to update timeslot template' });
  }
});

app.delete('/api/services/:serviceId/timeslot-templates/:templateId', async (req, res) => {
  try {
    const { serviceId, templateId } = req.params;
    const connection = await pool.getConnection();
    
    try {
      await connection.query(
        'DELETE FROM service_timeslot_templates WHERE id = ? AND service_id = ?',
        [templateId, serviceId]
      );
      
      res.json({ message: 'Timeslot template deleted successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Delete timeslot template error:', error);
    res.status(500).json({ error: 'Failed to delete timeslot template' });
  }
});

// Job templates endpoints
app.get('/api/job-templates', async (req, res) => {
  try {
    const { userId } = req.query;
    const connection = await pool.getConnection();
    
    try {
      const [templates] = await connection.query(`
        SELECT 
          jt.*,
          s.name as service_name,
          s.price as service_price,
          s.duration as service_duration
        FROM job_templates jt
        LEFT JOIN services s ON jt.service_id = s.id
        WHERE jt.user_id = ? AND jt.is_active = TRUE
        ORDER BY jt.name ASC
      `, [userId]);
      
      res.json(templates);
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Get job templates error:', error);
    res.status(500).json({ error: 'Failed to fetch job templates' });
  }
});

app.post('/api/job-templates', async (req, res) => {
  try {
    const { 
      userId, 
      name, 
      description, 
      serviceId, 
      estimatedDuration, 
      estimatedPrice, 
      defaultNotes 
    } = req.body;
    
    if (!userId || !name || !serviceId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const connection = await pool.getConnection();
    
    try {
      const [result] = await connection.query(
        `INSERT INTO job_templates (
          user_id, name, description, service_id, 
          estimated_duration, estimated_price, default_notes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
          userId, 
          name, 
          description || null, 
          serviceId, 
          estimatedDuration || null, 
          estimatedPrice || null, 
          defaultNotes || null
        ]
      );
      
      // Get the created template with service details
      const [templates] = await connection.query(`
        SELECT 
          jt.*,
          s.name as service_name,
          s.price as service_price,
          s.duration as service_duration
        FROM job_templates jt
        LEFT JOIN services s ON jt.service_id = s.id
        WHERE jt.id = ?
      `, [result.insertId]);
      
      res.status(201).json({
        message: 'Job template created successfully',
        template: templates[0]
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Create job template error:', error);
    res.status(500).json({ error: 'Failed to create job template' });
  }
});

app.put('/api/job-templates/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      name, 
      description, 
      serviceId, 
      estimatedDuration, 
      estimatedPrice, 
      defaultNotes,
      isActive 
    } = req.body;
    
    const connection = await pool.getConnection();
    
    try {
      const updateFields = [];
      const updateValues = [];
      
      if (name) {
        updateFields.push('name = ?');
        updateValues.push(name);
      }
      
      if (description !== undefined) {
        updateFields.push('description = ?');
        updateValues.push(description);
      }
      
      if (serviceId) {
        updateFields.push('service_id = ?');
        updateValues.push(serviceId);
      }
      
      if (estimatedDuration !== undefined) {
        updateFields.push('estimated_duration = ?');
        updateValues.push(estimatedDuration);
      }
      
      if (estimatedPrice !== undefined) {
        updateFields.push('estimated_price = ?');
        updateValues.push(estimatedPrice);
      }
      
      if (defaultNotes !== undefined) {
        updateFields.push('default_notes = ?');
        updateValues.push(defaultNotes);
      }
      
      if (isActive !== undefined) {
        updateFields.push('is_active = ?');
        updateValues.push(isActive);
      }
      
      updateFields.push('updated_at = NOW()');
      updateValues.push(id);
      
      const query = `UPDATE job_templates SET ${updateFields.join(', ')} WHERE id = ?`;
      
      await connection.query(query, updateValues);
      
      res.json({ message: 'Job template updated successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Update job template error:', error);
    res.status(500).json({ error: 'Failed to update job template' });
  }
});

app.delete('/api/job-templates/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const connection = await pool.getConnection();
    
    try {
      // Soft delete by setting is_active to false
      await connection.query(
        'UPDATE job_templates SET is_active = FALSE, updated_at = NOW() WHERE id = ?',
        [id]
      );
      
      res.json({ message: 'Job template deleted successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Delete job template error:', error);
    res.status(500).json({ error: 'Failed to delete job template' });
  }
});

// Team Management endpoints
app.get('/api/team-members', async (req, res) => {
  console.log('🔄 Team members request received:', req.query);
  try {
    const { userId, status, search, page = 1, limit = 20, sortBy = 'first_name', sortOrder = 'ASC' } = req.query;
    const connection = await pool.getConnection();
    
    try {
      let query = `
        SELECT 
          tm.*,
          COUNT(j.id) as total_jobs,
          COUNT(CASE WHEN j.status = 'completed' THEN 1 END) as completed_jobs,
          AVG(CASE WHEN j.status = 'completed' THEN j.invoice_amount END) as avg_job_value
        FROM team_members tm
        LEFT JOIN jobs j ON tm.id = j.team_member_id
        WHERE tm.user_id = ?
      `;
      let params = [userId];
      
      if (status) {
        query += ' AND tm.status = ?';
        params.push(status);
      }
      
      if (search) {
        query += ' AND (tm.first_name LIKE ? OR tm.last_name LIKE ? OR tm.email LIKE ?)';
        const searchTerm = `%${search}%`;
        params.push(searchTerm, searchTerm, searchTerm);
      }
      
      query += ' GROUP BY tm.id';
      
      // Handle sorting
      const allowedSortFields = ['first_name', 'last_name', 'email', 'role', 'total_jobs', 'completed_jobs', 'avg_job_value'];
      const allowedSortOrders = ['ASC', 'DESC'];
      
      if (allowedSortFields.includes(sortBy) && allowedSortOrders.includes(sortOrder.toUpperCase())) {
        query += ` ORDER BY ${sortBy} ${sortOrder.toUpperCase()}`;
      } else {
        query += ' ORDER BY tm.first_name ASC';
      }
      
      // Add pagination
      const offset = (page - 1) * limit;
      query += ' LIMIT ? OFFSET ?';
      params.push(parseInt(limit), offset);
      
      const [teamMembers] = await connection.query(query, params);
      
      // Get total count for pagination
      let countQuery = `
        SELECT COUNT(*) as total 
        FROM team_members tm
        WHERE tm.user_id = ?
      `;
      let countParams = [userId];
      
      if (status) {
        countQuery += ' AND tm.status = ?';
        countParams.push(status);
      }
      
      if (search) {
        countQuery += ' AND (tm.first_name LIKE ? OR tm.last_name LIKE ? OR tm.email LIKE ?)';
        const searchTerm = `%${search}%`;
        countParams.push(searchTerm, searchTerm, searchTerm);
      }
      
      const [countResult] = await connection.query(countQuery, countParams);
      const total = countResult[0].total;
      
      res.json({
        teamMembers,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / limit)
        }
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Get team members error:', error);
    res.status(500).json({ error: 'Failed to fetch team members' });
  }
});

app.get('/api/team-members/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { startDate, endDate } = req.query;
    const connection = await pool.getConnection();
    
    try {
      // Get team member info
      let teamMembers = [];
      try {
        const [teamMembersResult] = await connection.query(
          'SELECT * FROM team_members WHERE id = ?',
          [id]
        );
        teamMembers = teamMembersResult;
      } catch (teamMemberError) {
        console.error('Error fetching team member:', teamMemberError);
        return res.status(500).json({ error: 'Failed to fetch team member data' });
      }
      
      if (teamMembers.length === 0) {
        return res.status(404).json({ error: 'Team member not found' });
      }
      
      const teamMember = teamMembers[0];
      
      // Get jobs assigned to this team member
      let jobs = [];
      try {
        const [jobsResult] = await connection.query(`
          SELECT 
            j.*,
            c.first_name as customer_first_name,
            c.last_name as customer_last_name,
            c.phone as customer_phone,
            c.address as customer_address,
            s.name as service_name,
            s.duration
          FROM jobs j
          LEFT JOIN customers c ON j.customer_id = c.id
          LEFT JOIN services s ON j.service_id = s.id
          WHERE j.team_member_id = ?
          AND j.scheduled_date BETWEEN ? AND ?
          ORDER BY j.scheduled_date ASC
        `, [id, startDate || '2024-01-01', endDate || '2030-12-31']);
        jobs = jobsResult;
      } catch (jobsError) {
        console.error('Error fetching jobs for team member:', jobsError);
        // Return empty jobs array if query fails
        jobs = [];
      }
      
      res.json({
        teamMember,
        jobs
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Get team member error:', error);
    res.status(500).json({ error: 'Failed to fetch team member' });
  }
});

app.post('/api/team-members', async (req, res) => {
  try {
    const { 
      userId, 
      firstName, 
      lastName, 
      email, 
      phone, 
      username,
      password,
      role, 
      skills, 
      hourlyRate,
      availability,
      location,
      city,
      state,
      zipCode,
      isServiceProvider,
      territories,
      permissions
    } = req.body;
    
    if (!userId || !firstName || !lastName || !email || !username || !password) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Validate email format
    if (!validateEmail(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    
    const connection = await pool.getConnection();
    
    try {
      // Check if username or email already exists for this user
      const [existing] = await connection.query(
        'SELECT id FROM team_members WHERE user_id = ? AND (email = ? OR username = ?)',
        [userId, email, username]
      );
      
      if (existing.length > 0) {
        return res.status(400).json({ error: 'Team member with this email or username already exists' });
      }
      
      // Hash password
      const hashedPassword = await bcrypt.hash(password, 10);
      
      const [result] = await connection.query(
        `INSERT INTO team_members (
          user_id, first_name, last_name, email, phone, username, password, role, 
          skills, hourly_rate, availability, location, city, state, zip_code, 
          is_service_provider, territories, permissions, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NOW())`,
        [
          userId, 
          firstName, 
          lastName, 
          email, 
          phone || null, 
          username,
          hashedPassword,
          role || null, 
          skills ? JSON.stringify(skills) : null,
          hourlyRate || null,
          availability ? JSON.stringify(availability) : null,
          location || null,
          city || null,
          state || null,
          zipCode || null,
          isServiceProvider || false,
          territories ? JSON.stringify(territories) : null,
          permissions ? JSON.stringify(permissions) : null
        ]
      );
      
      // Get the created team member
      const [teamMembers] = await connection.query(`
        SELECT * FROM team_members WHERE id = ?
      `, [result.insertId]);
      
      const teamMember = teamMembers[0];
      delete teamMember.password; // Don't send password back
      
      res.status(201).json({
        message: 'Team member created successfully',
        teamMember
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Create team member error:', error);
    res.status(500).json({ error: 'Failed to create team member' });
  }
});

app.put('/api/team-members/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      firstName, 
      lastName, 
      email, 
      phone, 
      username,
      password,
      role, 
      skills, 
      hourlyRate,
      availability,
      status,
      location,
      city,
      state,
      zipCode,
      isServiceProvider,
      territories,
      permissions
    } = req.body;
    
    const connection = await pool.getConnection();
    
    try {
      const updateFields = [];
      const updateValues = [];
      
      if (firstName) {
        updateFields.push('first_name = ?');
        updateValues.push(firstName);
      }
      
      if (lastName) {
        updateFields.push('last_name = ?');
        updateValues.push(lastName);
      }
      
      if (email) {
        if (!validateEmail(email)) {
          return res.status(400).json({ error: 'Invalid email format' });
        }
        updateFields.push('email = ?');
        updateValues.push(email);
      }
      
      if (phone !== undefined) {
        updateFields.push('phone = ?');
        updateValues.push(phone);
      }
      
      if (username !== undefined) {
        updateFields.push('username = ?');
        updateValues.push(username);
      }
      
      if (password !== undefined) {
        const hashedPassword = await bcrypt.hash(password, 10);
        updateFields.push('password = ?');
        updateValues.push(hashedPassword);
      }
      
      if (role !== undefined) {
        updateFields.push('role = ?');
        updateValues.push(role);
      }
      
      if (skills !== undefined) {
        updateFields.push('skills = ?');
        updateValues.push(JSON.stringify(skills));
      }
      
      if (hourlyRate !== undefined) {
        updateFields.push('hourly_rate = ?');
        updateValues.push(hourlyRate);
      }
      
      if (availability !== undefined) {
        updateFields.push('availability = ?');
        updateValues.push(JSON.stringify(availability));
      }
      
      if (status !== undefined) {
        updateFields.push('status = ?');
        updateValues.push(status);
      }
      
      if (location !== undefined) {
        updateFields.push('location = ?');
        updateValues.push(location);
      }
      
      if (city !== undefined) {
        updateFields.push('city = ?');
        updateValues.push(city);
      }
      
      if (state !== undefined) {
        updateFields.push('state = ?');
        updateValues.push(state);
      }
      
      if (zipCode !== undefined) {
        updateFields.push('zip_code = ?');
        updateValues.push(zipCode);
      }
      
      if (isServiceProvider !== undefined) {
        updateFields.push('is_service_provider = ?');
        updateValues.push(isServiceProvider);
      }
      
      if (territories !== undefined) {
        updateFields.push('territories = ?');
        updateValues.push(JSON.stringify(territories));
      }
      
      if (permissions !== undefined) {
        updateFields.push('permissions = ?');
        updateValues.push(JSON.stringify(permissions));
      }
      
      updateFields.push('updated_at = NOW()');
      updateValues.push(id);
      
      const query = `UPDATE team_members SET ${updateFields.join(', ')} WHERE id = ?`;
      
      await connection.query(query, updateValues);
      
      res.json({ message: 'Team member updated successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Update team member error:', error);
    res.status(500).json({ error: 'Failed to update team member' });
  }
});

app.delete('/api/team-members/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const connection = await pool.getConnection();
    
    try {
      // Check if team member has assigned jobs
      const [assignedJobs] = await connection.query(
        'SELECT COUNT(*) as count FROM jobs WHERE team_member_id = ? AND status IN ("pending", "confirmed", "in_progress")',
        [id]
      );
      
      if (assignedJobs[0].count > 0) {
        return res.status(400).json({ 
          error: 'Cannot delete team member with active job assignments. Please reassign or complete their jobs first.' 
        });
      }
      
      // Soft delete by setting status to inactive
      await connection.query(
        'UPDATE team_members SET status = "inactive", updated_at = NOW() WHERE id = ?',
        [id]
      );
      
      res.json({ message: 'Team member deleted successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Delete team member error:', error);
    res.status(500).json({ error: 'Failed to delete team member' });
  }
});

// Team member availability endpoints
app.get('/api/team-members/:id/availability', async (req, res) => {
  try {
    const { id } = req.params;
    const { startDate, endDate } = req.query;
    const connection = await pool.getConnection();
    
    try {
      const [teamMember] = await connection.query(
        'SELECT availability FROM team_members WHERE id = ?',
        [id]
      );
      
      if (teamMember.length === 0) {
        return res.status(404).json({ error: 'Team member not found' });
      }
      
      // Get scheduled jobs for the date range
      let jobsQuery = `
        SELECT scheduled_date, duration 
        FROM jobs 
        WHERE team_member_id = ? AND status IN ("pending", "confirmed", "in_progress")
      `;
      let jobsParams = [id];
      
      if (startDate && endDate) {
        jobsQuery += ' AND DATE(scheduled_date) BETWEEN ? AND ?';
        jobsParams.push(startDate, endDate);
      }
      
      const [scheduledJobs] = await connection.query(jobsQuery, jobsParams);
      
      res.json({
        availability: teamMember[0].availability ? JSON.parse(teamMember[0].availability) : null,
        scheduledJobs
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Get team member availability error:', error);
    res.status(500).json({ error: 'Failed to fetch team member availability' });
  }
});

app.put('/api/team-members/:id/availability', async (req, res) => {
  try {
    const { id } = req.params;
    const { availability } = req.body;
    const connection = await pool.getConnection();
    
    try {
      await connection.query(
        'UPDATE team_members SET availability = ?, updated_at = NOW() WHERE id = ?',
        [JSON.stringify(availability), id]
      );
      
      res.json({ message: 'Team member availability updated successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Update team member availability error:', error);
    res.status(500).json({ error: 'Failed to update team member availability' });
  }
});

// Team member authentication endpoints
app.post('/api/team-members/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const connection = await pool.getConnection();
    
    try {
      // Find team member by username or email
      const [teamMembers] = await connection.query(
        'SELECT * FROM team_members WHERE (username = ? OR email = ?) AND is_active = 1',
        [username, username]
      );
      
      if (teamMembers.length === 0) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      
      const teamMember = teamMembers[0];
      
      // Check password (handle case where password might not be set for existing team members)
      if (!teamMember.password) {
        return res.status(401).json({ error: 'Account not set up for login. Please contact your manager.' });
      }
      
      const isValidPassword = await bcrypt.compare(password, teamMember.password);
      if (!isValidPassword) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      
      // Update last login
      await connection.query(
        'UPDATE team_members SET last_login = NOW() WHERE id = ?',
        [teamMember.id]
      );
      
      // Generate session token
      const sessionToken = jwt.sign(
        { 
          teamMemberId: teamMember.id, 
          userId: teamMember.user_id,
          type: 'team_member'
        },
        JWT_SECRET,
        { expiresIn: '7d' }
      );
      
      // Store session (with error handling in case table doesn't exist yet)
      try {
        await connection.query(
          'INSERT INTO team_member_sessions (team_member_id, session_token, device_info, ip_address, expires_at) VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 7 DAY))',
          [teamMember.id, sessionToken, req.headers['user-agent'], req.ip]
        );
      } catch (sessionError) {
        console.warn('Session storage failed (table may not exist):', sessionError.message);
        // Continue without session storage for now
      }
      
      // Remove password from response
      delete teamMember.password;
      
      res.json({
        message: 'Login successful',
        teamMember,
        token: sessionToken
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Team member login error:', error);
    
    // Provide more specific error messages
    if (error.code === 'ER_NO_SUCH_TABLE') {
      res.status(500).json({ error: 'Database tables not set up. Please contact administrator.' });
    } else if (error.code === 'ECONNREFUSED') {
      res.status(500).json({ error: 'Database connection failed. Please try again.' });
    } else {
      res.status(500).json({ error: 'Login failed. Please try again.' });
    }
  }
});

app.post('/api/team-members/register', async (req, res) => {
  try {
    const { 
      userId, 
      firstName, 
      lastName, 
      email, 
      phone, 
      location,
      city,
      state,
      zipCode,
      role,
      isServiceProvider,
      territories,
      permissions
    } = req.body;
    
    const connection = await pool.getConnection();
    
    try {
      // Check if email already exists for this user
      const [existing] = await connection.query(
        'SELECT id FROM team_members WHERE email = ? AND user_id = ?',
        [email, userId]
      );
      
      if (existing.length > 0) {
        return res.status(400).json({ error: 'Email already exists for this team' });
      }
      
      // Generate a unique invitation token
      const invitationToken = crypto.randomBytes(32).toString('hex');
      
      // Create team member with 'invited' status
      const [result] = await connection.query(`
        INSERT INTO team_members (
          user_id, first_name, last_name, email, phone, location, city, state, zip_code,
          role, is_service_provider, territories, permissions, invitation_token, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'invited', NOW())`,
        [
          userId, 
          sanitizeInput(firstName), 
          sanitizeInput(lastName), 
          sanitizeInput(email), 
          phone ? sanitizeInput(phone) : null,
          location ? sanitizeInput(location) : null,
          city ? sanitizeInput(city) : null,
          state ? sanitizeInput(state) : null,
          zipCode ? sanitizeInput(zipCode) : null,
          role || 'worker',
          isServiceProvider ? 1 : 0,
          territories ? JSON.stringify(territories) : JSON.stringify([]),
          permissions ? JSON.stringify(permissions) : JSON.stringify({}),
          invitationToken
        ]
      );
      
      // Get the created team member
      const [teamMembers] = await connection.query(
        'SELECT * FROM team_members WHERE id = ?',
        [result.insertId]
      );
      
      const teamMember = teamMembers[0];
      
      // Send invitation email
      try {
        const invitationLink = `${process.env.FRONTEND_URL || 'https://zenbooker.com'}/team-member-signup?token=${invitationToken}`;
        
        await sendEmail({
          to: email,
          subject: 'You\'ve been invited to join Zenbooker',
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #2563eb;">Welcome to Zenbooker!</h2>
              <p>Hello ${firstName},</p>
              <p>You've been invited to join your team on Zenbooker. To get started, please click the link below to create your account:</p>
              <div style="text-align: center; margin: 30px 0;">
                <a href="${invitationLink}" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                  Create Your Account
                </a>
              </div>
              <p>This link will expire in 7 days. If you have any questions, please contact your team administrator.</p>
              <p>Best regards,<br>The Zenbooker Team</p>
            </div>
          `,
          text: `Welcome to Zenbooker! You've been invited to join your team. Please visit ${invitationLink} to create your account.`
        });
      } catch (emailError) {
        console.error('Failed to send invitation email:', emailError);
        // Don't fail the request if email fails
      }
      
      res.json({
        message: 'Team member invited successfully',
        teamMember: {
          id: teamMember.id,
          first_name: teamMember.first_name,
          last_name: teamMember.last_name,
          email: teamMember.email,
          phone: teamMember.phone,
          location: teamMember.location,
          city: teamMember.city,
          state: teamMember.state,
          zip_code: teamMember.zip_code,
          role: teamMember.role,
          is_service_provider: teamMember.is_service_provider,
          territories: teamMember.territories,
          permissions: teamMember.permissions,
          status: teamMember.status,
          created_at: teamMember.created_at
        }
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Team member registration error:', error);
    console.error('Error details:', {
      message: error.message,
      code: error.code,
      sqlMessage: error.sqlMessage,
      sqlState: error.sqlState
    });
    res.status(500).json({ error: 'Registration failed', details: error.message });
  }
});

app.post('/api/team-members/logout', async (req, res) => {
  try {
    const { token } = req.body;
    const connection = await pool.getConnection();
    
    try {
      // Remove session
      await connection.query(
        'DELETE FROM team_member_sessions WHERE session_token = ?',
        [token]
      );
      
      res.json({ message: 'Logout successful' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Team member logout error:', error);
    res.status(500).json({ error: 'Logout failed' });
  }
});

// Resend invitation endpoint
app.post('/api/team-members/:id/resend-invite', async (req, res) => {
  try {
    const { id } = req.params;
    console.log('Resending invite for team member ID:', id);
    
    const connection = await pool.getConnection();
    
    try {
      // Get team member details
      const [teamMembers] = await connection.query(
        'SELECT * FROM team_members WHERE id = ?',
        [id]
      );
      
      if (teamMembers.length === 0) {
        return res.status(404).json({ error: 'Team member not found' });
      }
      
      const teamMember = teamMembers[0];
      
      if (teamMember.status !== 'invited') {
        return res.status(400).json({ error: 'Team member is not in invited status' });
      }
      
      // Generate new invitation token
      const invitationToken = crypto.randomBytes(32).toString('hex');
      const invitationExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
      
      // Update invitation token
      await connection.query(
        'UPDATE team_members SET invitation_token = ?, invitation_expires = ? WHERE id = ?',
        [invitationToken, invitationExpires, id]
      );
      
      // Send new invitation email
      try {
        const invitationLink = `${process.env.FRONTEND_URL || 'https://zenbooker.com'}/team-member-signup?token=${invitationToken}`;
        
        await sendEmail({
          to: teamMember.email,
          subject: 'You\'ve been invited to join Zenbooker',
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #2563eb;">Welcome to Zenbooker!</h2>
              <p>Hello ${teamMember.first_name},</p>
              <p>You've been invited to join your team on Zenbooker. To get started, please click the link below to create your account:</p>
              <div style="text-align: center; margin: 30px 0;">
                <a href="${invitationLink}" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                  Create Your Account
                </a>
              </div>
              <p>This link will expire in 7 days. If you have any questions, please contact your team administrator.</p>
              <p>Best regards,<br>The Zenbooker Team</p>
            </div>
          `,
          text: `Welcome to Zenbooker! You've been invited to join your team. Please visit ${invitationLink} to create your account.`
        });
      } catch (emailError) {
        console.error('Failed to send invitation email:', emailError);
        console.error('Email error details:', {
          message: emailError.message,
          code: emailError.code,
          command: emailError.command
        });
        return res.status(500).json({ 
          error: 'Failed to send invitation email',
          details: emailError.message 
        });
      }
      
      res.json({ message: 'Invitation resent successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Resend invitation error:', error);
    res.status(500).json({ error: 'Failed to resend invitation' });
  }
});

// Team member dashboard endpoints
app.get('/api/team-members/dashboard/:teamMemberId', async (req, res) => {
  try {
    const { teamMemberId } = req.params;
    const { startDate, endDate } = req.query;
    
    console.log('🔍 Team member dashboard request:', { teamMemberId, startDate, endDate });
    
    const connection = await pool.getConnection();
    
    try {
      // Get team member info
      let teamMembers = [];
      try {
        console.log('📋 Fetching team member with ID:', teamMemberId);
        const [teamMembersResult] = await connection.query(
          'SELECT * FROM team_members WHERE id = ?',
          [teamMemberId]
        );
        teamMembers = teamMembersResult;
        console.log('✅ Team member found:', teamMembers.length > 0);
      } catch (teamMemberError) {
        console.error('❌ Error fetching team member:', teamMemberError);
        return res.status(500).json({ error: 'Failed to fetch team member data' });
      }
      
      if (teamMembers.length === 0) {
        console.log('❌ Team member not found with ID:', teamMemberId);
        return res.status(404).json({ error: 'Team member not found' });
      }
      
      const teamMember = teamMembers[0];
      console.log('✅ Team member data:', { id: teamMember.id, name: `${teamMember.first_name} ${teamMember.last_name}` });
      
      // Get jobs assigned to this team member
      let jobs = [];
      try {
        console.log('📋 Fetching jobs for team member:', teamMemberId);
        const [jobsResult] = await connection.query(`
          SELECT 
            j.*,
            c.first_name as customer_first_name,
            c.last_name as customer_last_name,
            c.phone as customer_phone,
            c.address as customer_address,
            s.name as service_name,
            s.duration
          FROM jobs j
          LEFT JOIN customers c ON j.customer_id = c.id
          LEFT JOIN services s ON j.service_id = s.id
          WHERE j.team_member_id = ?
          AND j.scheduled_date BETWEEN ? AND ?
          ORDER BY j.scheduled_date ASC
        `, [teamMemberId, startDate || '2024-01-01', endDate || '2030-12-31']);
        jobs = jobsResult;
        console.log('✅ Jobs found:', jobs.length);
      } catch (jobsError) {
        console.error('❌ Error fetching jobs for team member:', jobsError);
        console.error('❌ Jobs query failed with error:', jobsError.message);
        // Return empty jobs array if query fails
        jobs = [];
      }
      
      // Calculate stats
      const today = new Date().toISOString().split('T')[0];
      const todayJobs = jobs.filter(job => job.scheduled_date.split('T')[0] === today);
      const completedJobs = jobs.filter(job => job.status === 'completed');
      
      const stats = {
        totalJobs: jobs.length,
        todayJobs: todayJobs.length,
        completedJobs: completedJobs.length,
        avgJobValue: completedJobs.length > 0 
          ? completedJobs.reduce((sum, job) => sum + (job.invoice_amount || 0), 0) / completedJobs.length 
          : 0
      };
      
      console.log('📊 Stats calculated:', stats);
      
      // Get notifications (with error handling for missing table)
      let notifications = [];
      try {
        console.log('📋 Fetching notifications for team member:', teamMemberId);
        const [notificationsResult] = await connection.query(`
          SELECT * FROM team_member_notifications 
          WHERE team_member_id = ? 
          ORDER BY created_at DESC 
          LIMIT 10
        `, [teamMemberId]);
        notifications = notificationsResult;
        console.log('✅ Notifications found:', notifications.length);
      } catch (notificationError) {
        console.warn('⚠️ Team member notifications table not found, skipping notifications:', notificationError.message);
        // Continue without notifications
      }
      
      const response = {
        teamMember: {
          id: teamMember.id,
          first_name: teamMember.first_name,
          last_name: teamMember.last_name,
          email: teamMember.email,
          phone: teamMember.phone,
          role: teamMember.role,
          username: teamMember.username,
          status: teamMember.status,
          hourly_rate: teamMember.hourly_rate,
          skills: teamMember.skills,
          availability: teamMember.availability
        },
        jobs: jobs,
        stats: stats,
        notifications: notifications
      };
      
      console.log('✅ Dashboard response prepared successfully');
      res.json(response);
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('❌ Team member dashboard error:', error);
    console.error('❌ Error details:', {
      message: error.message,
      stack: error.stack,
      code: error.code,
      errno: error.errno
    });
    res.status(500).json({ error: 'Failed to load dashboard data' });
  }
});

// Team member job actions
app.put('/api/team-members/jobs/:jobId/status', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { teamMemberId, status, notes } = req.body;
    const connection = await pool.getConnection();
    
    try {
      // Update job status
      await connection.query(
        'UPDATE jobs SET status = ?, notes = CONCAT(IFNULL(notes, ""), "\n", ?), updated_at = NOW() WHERE id = ? AND team_member_id = ?',
        [status, notes || '', jobId, teamMemberId]
      );
      
      // Create notification for business owner
      await connection.query(`
        INSERT INTO team_member_notifications (team_member_id, type, title, message, data)
        VALUES (?, 'job_completed', 'Job Status Updated', ?, ?)
      `, [teamMemberId, `Job #${jobId} status updated to ${status}`, JSON.stringify({ jobId, status })]);
      
      res.json({ message: 'Job status updated successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Update job status error:', error);
    res.status(500).json({ error: 'Failed to update job status' });
  }
});

// Team performance analytics
app.get('/api/team-analytics', async (req, res) => {
  try {
    const { userId, startDate, endDate } = req.query;
    const connection = await pool.getConnection();
    
    try {
      // Get team performance summary
      const [performanceSummary] = await connection.query(`
        SELECT 
          tm.id,
          tm.first_name,
          tm.last_name,
          tm.role,
          COUNT(j.id) as total_jobs,
          COUNT(CASE WHEN j.status = 'completed' THEN 1 END) as completed_jobs,
          COUNT(CASE WHEN j.status IN ('pending', 'confirmed', 'in_progress') THEN 1 END) as active_jobs,
          AVG(CASE WHEN j.status = 'completed' THEN j.invoice_amount END) as avg_job_value,
          SUM(CASE WHEN j.status = 'completed' THEN j.invoice_amount END) as total_revenue,
          AVG(CASE WHEN j.status = 'completed' THEN TIMESTAMPDIFF(MINUTE, j.scheduled_date, j.updated_at) END) as avg_completion_time
        FROM team_members tm
        LEFT JOIN jobs j ON tm.id = j.team_member_id
        WHERE tm.user_id = ? AND tm.status = 'active'
        ${startDate && endDate ? 'AND DATE(j.scheduled_date) BETWEEN ? AND ?' : ''}
        GROUP BY tm.id
        ORDER BY total_revenue DESC
      `, startDate && endDate ? [userId, startDate, endDate] : [userId]);
      
      // Get overall team stats
      const [teamStats] = await connection.query(`
        SELECT 
          COUNT(DISTINCT tm.id) as total_team_members,
          COUNT(DISTINCT j.id) as total_jobs,
          COUNT(CASE WHEN j.status = 'completed' THEN 1 END) as completed_jobs,
          SUM(CASE WHEN j.status = 'completed' THEN j.invoice_amount END) as total_revenue,
          AVG(CASE WHEN j.status = 'completed' THEN j.invoice_amount END) as avg_job_value
        FROM team_members tm
        LEFT JOIN jobs j ON tm.id = j.team_member_id
        WHERE tm.user_id = ? AND tm.status = 'active'
        ${startDate && endDate ? 'AND DATE(j.scheduled_date) BETWEEN ? AND ?' : ''}
      `, startDate && endDate ? [userId, startDate, endDate] : [userId]);
      
      res.json({
        performanceSummary,
        teamStats: teamStats[0]
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Get team analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch team analytics' });
  }
});

app.get('/api/public/user/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const decodedSlug = decodeURIComponent(slug);
    const connection = await pool.getConnection();
    
    try {
      // First try to find by business_name (slug)
      let [users] = await connection.query(`
        SELECT id, business_name, email, phone, first_name, last_name, profile_picture
        FROM users 
        WHERE business_name = ? AND is_active = 1
      `, [decodedSlug]);
      
      // If not found, try to find by id (for backward compatibility)
      if (users.length === 0) {
        [users] = await connection.query(`
          SELECT id, business_name, email, phone, first_name, last_name, profile_picture
          FROM users 
          WHERE id = ? AND is_active = 1
        `, [decodedSlug]);
      }
      
      // If still not found, try to find by original business name (for backward compatibility)
      if (users.length === 0) {
        [users] = await connection.query(`
          SELECT id, business_name, email, phone, first_name, last_name, profile_picture
          FROM users 
          WHERE business_name LIKE ? AND is_active = 1
        `, [`%${decodedSlug}%`]);
      }
      
      if (users.length === 0) {
        return res.status(404).json({ 
          error: 'Business not found',
          message: `No business found with slug: ${decodedSlug}`,
          availableSlugs: ['now2code-academy', 'zenbooker-cleaning-services', 'test-business']
        });
      }
      
      res.json(users[0]);
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Get user by slug error:', error);
    res.status(500).json({ error: 'Failed to fetch business information' });
  }
});

app.get('/api/public/services/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const connection = await pool.getConnection();
    
    try {
      const [services] = await connection.query(`
        SELECT id, name, description, price, duration, category
        FROM services 
        WHERE user_id = ? AND is_active = 1
        ORDER BY name
      `, [userId]);
      
      res.json(services);
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Get public services error:', error);
    res.status(500).json({ error: 'Failed to fetch services' });
  }
});

app.get('/api/public/availability/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { date } = req.query;
    const connection = await pool.getConnection();
    
    try {
      // Get business hours for the user
      const [availability] = await connection.query(`
        SELECT business_hours FROM user_availability WHERE user_id = ?
      `, [userId]);
      
      // Generate time slots based on business hours
      const businessHours = availability[0]?.business_hours || {
        monday: { start: '09:00', end: '17:00' },
        tuesday: { start: '09:00', end: '17:00' },
        wednesday: { start: '09:00', end: '17:00' },
        thursday: { start: '09:00', end: '17:00' },
        friday: { start: '09:00', end: '17:00' },
        saturday: { start: '09:00', end: '17:00' },
        sunday: { start: '09:00', end: '17:00' }
      };
      
      // Get existing bookings for the date
      const [bookings] = await connection.query(`
        SELECT scheduled_date FROM jobs 
        WHERE user_id = ? AND DATE(scheduled_date) = ? AND status != 'cancelled'
      `, [userId, date]);
      
      const bookedTimes = bookings.map(booking => 
        new Date(booking.scheduled_date).toTimeString().slice(0, 5)
      );
      
      // Generate available time slots
      const dayOfWeek = new Date(date).toLocaleDateString('en-US', { weekday: 'lowercase' });
      const hours = businessHours[dayOfWeek];
      
      const availableSlots = [];
      if (hours) {
        const startTime = new Date(`2000-01-01T${hours.start}`);
        const endTime = new Date(`2000-01-01T${hours.end}`);
        
        while (startTime < endTime) {
          const timeSlot = startTime.toTimeString().slice(0, 5);
          if (!bookedTimes.includes(timeSlot)) {
            availableSlots.push(timeSlot);
          }
          startTime.setMinutes(startTime.getMinutes() + 30);
        }
      }
      
      res.json({ availableSlots });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Get public availability error:', error);
    res.status(500).json({ error: 'Failed to fetch availability' });
  }
});

// Coupon API endpoints
app.post('/api/coupons', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const {
      code,
      discountType,
      discountAmount,
      applicationType,
      selectedServices,
      doesntExpire,
      expirationDate,
      restrictBeforeExpiration,
      limitTotalUses,
      canCombineWithRecurring,
      recurringApplicationType
    } = req.body;

    const connection = await pool.getConnection();
    
    try {
      // Check if coupon code already exists
      const [existingCoupons] = await connection.query(
        'SELECT id FROM coupons WHERE code = ?',
        [code]
      );
      
      if (existingCoupons.length > 0) {
        return res.status(400).json({ error: 'Coupon code already exists' });
      }

      // Create coupon
      const [result] = await connection.query(`
        INSERT INTO coupons (
          user_id, code, discount_type, discount_amount, application_type,
          selected_services, doesnt_expire, expiration_date, restrict_before_expiration,
          limit_total_uses, can_combine_with_recurring, recurring_application_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        userId, code, discountType, discountAmount, applicationType,
        JSON.stringify(selectedServices), doesntExpire, 
        doesntExpire ? null : expirationDate, restrictBeforeExpiration,
        limitTotalUses, canCombineWithRecurring, recurringApplicationType
      ]);

      res.status(201).json({
        message: 'Coupon created successfully',
        couponId: result.insertId
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Create coupon error:', error);
    res.status(500).json({ error: 'Failed to create coupon' });
  }
});

app.get('/api/coupons', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const connection = await pool.getConnection();
    
    try {
      const [coupons] = await connection.query(`
        SELECT * FROM coupons WHERE user_id = ? ORDER BY created_at DESC
      `, [userId]);
      
      res.json({ coupons });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Get coupons error:', error);
    res.status(500).json({ error: 'Failed to get coupons' });
  }
});

app.put('/api/coupons/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const couponId = req.params.id;
    const updateData = req.body;

    const connection = await pool.getConnection();
    
    try {
      // Verify coupon belongs to user
      const [coupons] = await connection.query(
        'SELECT id FROM coupons WHERE id = ? AND user_id = ?',
        [couponId, userId]
      );
      
      if (coupons.length === 0) {
        return res.status(404).json({ error: 'Coupon not found' });
      }

      // Update coupon
      await connection.query(`
        UPDATE coupons SET 
          code = ?, discount_type = ?, discount_amount = ?, application_type = ?,
          selected_services = ?, doesnt_expire = ?, expiration_date = ?, 
          restrict_before_expiration = ?, limit_total_uses = ?, 
          can_combine_with_recurring = ?, recurring_application_type = ?,
          is_active = ?, updated_at = NOW()
        WHERE id = ?
      `, [
        updateData.code, updateData.discountType, updateData.discountAmount,
        updateData.applicationType, JSON.stringify(updateData.selectedServices),
        updateData.doesntExpire, updateData.doesntExpire ? null : updateData.expirationDate,
        updateData.restrictBeforeExpiration, updateData.limitTotalUses,
        updateData.canCombineWithRecurring, updateData.recurringApplicationType,
        updateData.isActive, couponId
      ]);

      res.json({ message: 'Coupon updated successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Update coupon error:', error);
    res.status(500).json({ error: 'Failed to update coupon' });
  }
});

app.delete('/api/coupons/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const couponId = req.params.id;

    const connection = await pool.getConnection();
    
    try {
      // Verify coupon belongs to user
      const [coupons] = await connection.query(
        'SELECT id FROM coupons WHERE id = ? AND user_id = ?',
        [couponId, userId]
      );
      
      if (coupons.length === 0) {
        return res.status(404).json({ error: 'Coupon not found' });
      }

      // Delete coupon
      await connection.query('DELETE FROM coupons WHERE id = ?', [couponId]);

      res.json({ message: 'Coupon deleted successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Delete coupon error:', error);
    res.status(500).json({ error: 'Failed to delete coupon' });
  }
});

// Public coupon validation endpoint for customers
app.post('/api/coupons/validate', async (req, res) => {
  try {
    const { code, businessSlug, serviceId, totalAmount } = req.body;

    if (!code || !businessSlug) {
      return res.status(400).json({ error: 'Coupon code and business slug are required' });
    }

    const connection = await pool.getConnection();
    
    try {
      // Get business user ID from slug or user ID
      let businessUserId;
      
      // First try to find by business slug
      const [businesses] = await connection.query(
        'SELECT id FROM users WHERE business_name = ?',
        [businessSlug]
      );
      
      if (businesses.length > 0) {
        businessUserId = businesses[0].id;
      } else {
        // Try to parse as user ID directly
        const userId = parseInt(businessSlug);
        if (!isNaN(userId)) {
          const [usersById] = await connection.query(
            'SELECT id FROM users WHERE id = ?',
            [userId]
          );
          if (usersById.length === 0) {
            return res.status(404).json({ error: 'Business not found' });
          }
          businessUserId = usersById[0].id;
        } else {
          // Try to extract user ID from business-{id} format
          const match = businessSlug.match(/business-(\d+)/);
          if (match) {
            const userId = parseInt(match[1]);
            const [usersById] = await connection.query(
              'SELECT id FROM users WHERE id = ?',
              [userId]
            );
            if (usersById.length === 0) {
              return res.status(404).json({ error: 'Business not found' });
            }
            businessUserId = usersById[0].id;
          } else {
            return res.status(404).json({ error: 'Business not found' });
          }
        }
      }

      // Get coupon details
      const [coupons] = await connection.query(`
        SELECT * FROM coupons 
        WHERE code = ? AND user_id = ? AND is_active = 1
      `, [code, businessUserId]);
      
      if (coupons.length === 0) {
        return res.status(404).json({ error: 'Invalid coupon code' });
      }

      const coupon = coupons[0];

      // Check if coupon is expired
      if (!coupon.doesnt_expire && coupon.expiration_date) {
        const expirationDate = new Date(coupon.expiration_date);
        if (expirationDate < new Date()) {
          return res.status(400).json({ error: 'Coupon has expired' });
        }
      }

      // Check usage limits
      if (coupon.limit_total_uses && coupon.total_uses_limit) {
        if (coupon.current_uses >= coupon.total_uses_limit) {
          return res.status(400).json({ error: 'Coupon usage limit reached' });
        }
      }

      // Check if coupon applies to specific services
      if (coupon.application_type === 'specific' && serviceId) {
        const selectedServices = JSON.parse(coupon.selected_services || '[]');
        if (!selectedServices.includes(parseInt(serviceId))) {
          return res.status(400).json({ error: 'Coupon does not apply to this service' });
        }
      }

      // Calculate discount
      let discountAmount = 0;
      if (coupon.discount_type === 'percentage') {
        discountAmount = (totalAmount * coupon.discount_amount) / 100;
      } else {
        discountAmount = parseFloat(coupon.discount_amount);
        // Ensure discount doesn't exceed total amount
        if (discountAmount > totalAmount) {
          discountAmount = totalAmount;
        }
      }

      const finalAmount = totalAmount - discountAmount;

      res.json({
        valid: true,
        coupon: {
          id: coupon.id,
          code: coupon.code,
          discountType: coupon.discount_type,
          discountAmount: coupon.discount_amount,
          calculatedDiscount: discountAmount,
          finalAmount: finalAmount
        }
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Coupon validation error:', error);
    res.status(500).json({ error: 'Failed to validate coupon' });
  }
});

// Apply coupon to booking/invoice
app.post('/api/coupons/apply', async (req, res) => {
  try {
    const { couponId, customerId, jobId, invoiceId, discountAmount } = req.body;

    const connection = await pool.getConnection();
    
    try {
      // Record coupon usage
      await connection.query(`
        INSERT INTO coupon_usage (coupon_id, customer_id, job_id, invoice_id, discount_amount)
        VALUES (?, ?, ?, ?, ?)
      `, [couponId, customerId, jobId, invoiceId, discountAmount]);

      // Update coupon usage count
      await connection.query(`
        UPDATE coupons SET current_uses = current_uses + 1 WHERE id = ?
      `, [couponId]);

      res.json({ message: 'Coupon applied successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Apply coupon error:', error);
    res.status(500).json({ error: 'Failed to apply coupon' });
  }
});

// Stripe payment endpoints
app.post('/api/payments/create-payment-intent', authenticateToken, async (req, res) => {
  try {
    const { amount, currency = 'usd', metadata = {} } = req.body;
    
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // Convert to cents
      currency,
      metadata,
      automatic_payment_methods: {
        enabled: true,
      },
    });
    
    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id
    });
  } catch (error) {
    console.error('Payment intent creation error:', error);
    res.status(500).json({ error: 'Failed to create payment intent' });
  }
});

app.post('/api/payments/confirm-payment', authenticateToken, async (req, res) => {
  try {
    const { paymentIntentId, invoiceId, customerId } = req.body;
    
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    
    if (paymentIntent.status === 'succeeded') {
      // Update invoice status
      const connection = await pool.getConnection();
      try {
        await connection.query(`
          UPDATE invoices SET 
            status = 'paid', 
            payment_date = NOW(),
            stripe_payment_intent_id = ?
          WHERE id = ?
        `, [paymentIntentId, invoiceId]);
        
        // Get invoice details for email
        const [invoices] = await connection.query(`
          SELECT i.*, c.email, c.first_name, c.last_name
          FROM invoices i
          JOIN customers c ON i.customer_id = c.id
          WHERE i.id = ?
        `, [invoiceId]);
        
        if (invoices.length > 0) {
          const invoice = invoices[0];
          
          // Send payment confirmation email
          await sendEmail({
            to: invoice.email,
            subject: 'Payment Confirmation',
            html: `
              <h2>Payment Confirmation</h2>
              <p>Hello ${invoice.first_name},</p>
              <p>Thank you for your payment of $${invoice.total_amount}.</p>
              <p>Invoice #: ${invoice.id}</p>
              <p>Payment Date: ${new Date().toLocaleDateString()}</p>
              <p>Transaction ID: ${paymentIntentId}</p>
              <p>Thank you for your business!</p>
            `
          });
        }
        
        res.json({ 
          success: true, 
          message: 'Payment confirmed successfully',
          paymentIntent 
        });
      } finally {
        connection.release();
      }
    } else {
      res.status(400).json({ error: 'Payment not completed' });
    }
  } catch (error) {
    console.error('Payment confirmation error:', error);
    res.status(500).json({ error: 'Failed to confirm payment' });
  }
});

app.post('/api/payments/create-subscription', authenticateToken, async (req, res) => {
  try {
    const { customerId, priceId, metadata = {} } = req.body;
    
    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      metadata,
      payment_behavior: 'default_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription' },
      expand: ['latest_invoice.payment_intent'],
    });
    
    res.json({
      subscriptionId: subscription.id,
      clientSecret: subscription.latest_invoice.payment_intent.client_secret
    });
  } catch (error) {
    console.error('Subscription creation error:', error);
    res.status(500).json({ error: 'Failed to create subscription' });
  }
});

// Tax calculation endpoint
app.post('/api/tax/calculate', authenticateToken, async (req, res) => {
  try {
    const { subtotal, state, city, zipCode } = req.body;
    
    // Simple tax calculation (you can integrate with tax APIs like TaxJar)
    const taxRates = {
      'CA': 0.0825, // 8.25% for California
      'NY': 0.085,  // 8.5% for New York
      'TX': 0.0625, // 6.25% for Texas
      'FL': 0.06,   // 6% for Florida
      'default': 0.07 // 7% default
    };
    
    const taxRate = taxRates[state] || taxRates.default;
    const taxAmount = subtotal * taxRate;
    const total = subtotal + taxAmount;
    
    res.json({
      subtotal,
      taxRate: taxRate * 100,
      taxAmount,
      total,
      breakdown: {
        subtotal,
        tax: taxAmount,
        total
      }
    });
  } catch (error) {
    console.error('Tax calculation error:', error);
    res.status(500).json({ error: 'Failed to calculate tax' });
  }
});

// Email notification endpoints
app.post('/api/notifications/send-email', authenticateToken, async (req, res) => {
  try {
    const { to, subject, html, text } = req.body;
    
    const result = await sendEmail({ to, subject, html, text });
    
    res.json({ 
      success: true, 
      messageId: result.messageId,
      message: 'Email sent successfully' 
    });
  } catch (error) {
    console.error('Email sending error:', error);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

app.post('/api/public/bookings', async (req, res) => {
  try {
    const { 
      userId, customerData, services, scheduledDate, scheduledTime, 
      totalAmount, notes 
    } = req.body;
    
    if (!userId || !customerData || !services || !scheduledDate || !scheduledTime) {
      return res.status(400).json({ error: 'Missing required booking information' });
    }

    const connection = await pool.getConnection();
    
    try {
      // Create or find customer
      let [existingCustomer] = await connection.query(`
        SELECT id FROM customers WHERE email = ? AND user_id = ?
      `, [customerData.email, userId]);
      
      let customerId;
      if (existingCustomer.length > 0) {
        customerId = existingCustomer[0].id;
        // Update customer info
        await connection.query(`
          UPDATE customers SET 
            first_name = ?, last_name = ?, phone = ?, address = ?
          WHERE id = ?
        `, [customerData.firstName, customerData.lastName, customerData.phone, customerData.address, customerId]);
      } else {
        // Create new customer
        const [customerResult] = await connection.query(`
          INSERT INTO customers (user_id, first_name, last_name, email, phone, address, status)
          VALUES (?, ?, ?, ?, ?, ?, 'active')
        `, [userId, customerData.firstName, customerData.lastName, customerData.email, customerData.phone, customerData.address]);
        customerId = customerResult.insertId;
      }
      
      // Create job for each service
      const scheduledDateTime = `${scheduledDate}T${scheduledTime}:00`;
      
      for (const service of services) {
        await connection.query(`
          INSERT INTO jobs (user_id, customer_id, service_id, scheduled_date, notes, status)
          VALUES (?, ?, ?, ?, ?, 'pending')
        `, [userId, customerId, service.id, scheduledDateTime, notes]);
      }
      
      // Create invoice
      const [invoiceResult] = await connection.query(`
        INSERT INTO invoices (user_id, customer_id, total_amount, status, created_at)
        VALUES (?, ?, ?, 'pending', NOW())
      `, [userId, customerId, totalAmount]);
      
      res.status(201).json({ 
        message: 'Booking created successfully',
        bookingId: invoiceResult.insertId
      });
      
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Create public booking error:', error);
    res.status(500).json({ error: 'Failed to create booking' });
  }
});

// Requests API endpoints
app.get('/api/requests', authenticateToken, async (req, res) => {
  try {
    const { userId, filter = 'all', status, page = 1, limit = 50, sortBy = 'created_at', sortOrder = 'DESC' } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }
    
    const connection = await pool.getConnection();
    
    try {
      let query = `
        SELECT r.*, 
               c.first_name as customer_first_name, 
               c.last_name as customer_last_name,
               c.email as customer_email,
               c.phone as customer_phone,
               s.name as service_name,
               s.price as service_price,
               s.duration as service_duration
        FROM requests r
        LEFT JOIN customers c ON r.customer_id = c.id
        LEFT JOIN services s ON r.service_id = s.id
        WHERE r.user_id = ?
      `;
      
      const params = [userId];
      
      // Add filter conditions
      if (filter === 'booking') {
        query += ' AND r.type = "booking"';
      } else if (filter === 'quote') {
        query += ' AND r.type = "quote"';
      }
      
      if (status) {
        query += ' AND r.status = ?';
        params.push(status);
      }
      
      // Add sorting
      query += ` ORDER BY r.${sortBy} ${sortOrder}`;
      
      // Add pagination
      const offset = (page - 1) * limit;
      query += ' LIMIT ? OFFSET ?';
      params.push(parseInt(limit), offset);
      
      const [requests] = await connection.query(query, params);
      
      // Get total count for pagination
      let countQuery = `
        SELECT COUNT(*) as total
        FROM requests r
        WHERE r.user_id = ?
      `;
      
      const countParams = [userId];
      
      if (filter === 'booking') {
        countQuery += ' AND r.type = "booking"';
      } else if (filter === 'quote') {
        countQuery += ' AND r.type = "quote"';
      }
      
      if (status) {
        countQuery += ' AND r.status = ?';
        countParams.push(status);
      }
      
      const [countResult] = await connection.query(countQuery, countParams);
      const total = countResult[0].total;
      
      res.json({
        requests,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / limit)
        }
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Get requests error:', error);
    res.status(500).json({ error: 'Failed to fetch requests' });
  }
});

app.get('/api/requests/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const connection = await pool.getConnection();
    
    try {
      const [requests] = await connection.query(`
        SELECT r.*, 
               c.first_name as customer_first_name, 
               c.last_name as customer_last_name,
               c.email as customer_email,
               c.phone as customer_phone,
               s.name as service_name,
               s.price as service_price,
               s.duration as service_duration
        FROM requests r
        LEFT JOIN customers c ON r.customer_id = c.id
        LEFT JOIN services s ON r.service_id = s.id
        WHERE r.id = ?
      `, [id]);
      
      if (requests.length === 0) {
        return res.status(404).json({ error: 'Request not found' });
      }
      
      res.json(requests[0]);
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Get request error:', error);
    res.status(500).json({ error: 'Failed to fetch request' });
  }
});

app.post('/api/requests', authenticateToken, async (req, res) => {
  try {
    const { 
      userId, customerId, serviceId, type, status = 'pending', 
      scheduledDate, scheduledTime, estimatedDuration, estimatedPrice,
      notes, customerName, customerEmail, customerPhone 
    } = req.body;
    
    if (!userId || !type) {
      return res.status(400).json({ error: 'User ID and type are required' });
    }
    
    const connection = await pool.getConnection();
    
    try {
      let actualCustomerId = customerId;
      
      // If no customerId provided, create or find customer
      if (!customerId && customerName && customerEmail) {
        let [existingCustomer] = await connection.query(`
          SELECT id FROM customers WHERE email = ? AND user_id = ?
        `, [customerEmail, userId]);
        
        if (existingCustomer.length > 0) {
          actualCustomerId = existingCustomer[0].id;
        } else {
          const [customerResult] = await connection.query(`
            INSERT INTO customers (user_id, first_name, last_name, email, phone, status)
            VALUES (?, ?, ?, ?, ?, 'active')
          `, [userId, customerName.split(' ')[0], customerName.split(' ').slice(1).join(' ') || '', customerEmail, customerPhone]);
          actualCustomerId = customerResult.insertId;
        }
      }
      
      const [result] = await connection.query(`
        INSERT INTO requests (
          user_id, customer_id, service_id, type, status, 
          scheduled_date, scheduled_time, estimated_duration, estimated_price,
          notes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
      `, [
        userId, actualCustomerId, serviceId, type, status,
        scheduledDate, scheduledTime, estimatedDuration, estimatedPrice,
        notes
      ]);
      
      // Get the created request
      const [requests] = await connection.query(`
        SELECT r.*, 
               c.first_name as customer_first_name, 
               c.last_name as customer_last_name,
               c.email as customer_email,
               c.phone as customer_phone,
               s.name as service_name,
               s.price as service_price,
               s.duration as service_duration
        FROM requests r
        LEFT JOIN customers c ON r.customer_id = c.id
        LEFT JOIN services s ON r.service_id = s.id
        WHERE r.id = ?
      `, [result.insertId]);
      
      res.status(201).json(requests[0]);
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Create request error:', error);
    res.status(500).json({ error: 'Failed to create request' });
  }
});

app.put('/api/requests/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      status, scheduledDate, scheduledTime, estimatedDuration, 
      estimatedPrice, notes 
    } = req.body;
    
    const connection = await pool.getConnection();
    
    try {
      await connection.query(`
        UPDATE requests SET 
          status = ?, scheduled_date = ?, scheduled_time = ?, 
          estimated_duration = ?, estimated_price = ?, notes = ?, updated_at = NOW()
        WHERE id = ?
      `, [status, scheduledDate, scheduledTime, estimatedDuration, estimatedPrice, notes, id]);
      
      // Get the updated request
      const [requests] = await connection.query(`
        SELECT r.*, 
               c.first_name as customer_first_name, 
               c.last_name as customer_last_name,
               c.email as customer_email,
               c.phone as customer_phone,
               s.name as service_name,
               s.price as service_price,
               s.duration as service_duration
        FROM requests r
        LEFT JOIN customers c ON r.customer_id = c.id
        LEFT JOIN services s ON r.service_id = s.id
        WHERE r.id = ?
      `, [id]);
      
      if (requests.length === 0) {
        return res.status(404).json({ error: 'Request not found' });
      }
      
      res.json(requests[0]);
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Update request error:', error);
    res.status(500).json({ error: 'Failed to update request' });
  }
});

app.delete('/api/requests/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const connection = await pool.getConnection();
    
    try {
      const [result] = await connection.query('DELETE FROM requests WHERE id = ?', [id]);
      
      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Request not found' });
      }
      
      res.json({ message: 'Request deleted successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Delete request error:', error);
    res.status(500).json({ error: 'Failed to delete request' });
  }
});

app.post('/api/requests/:id/approve', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const connection = await pool.getConnection();
    
    try {
      // Get the request first
      const [requests] = await connection.query(`
        SELECT r.*, c.first_name, c.last_name, c.email, s.name as service_name, s.price
        FROM requests r
        LEFT JOIN customers c ON r.customer_id = c.id
        LEFT JOIN services s ON r.service_id = s.id
        WHERE r.id = ?
      `, [id]);
      
      if (requests.length === 0) {
        return res.status(404).json({ error: 'Request not found' });
      }
      
      const request = requests[0];
      
      // Update request status
      await connection.query(`
        UPDATE requests SET status = 'approved', updated_at = NOW() WHERE id = ?
      `, [id]);
      
      // If it's a booking request, create a job AND an estimate
      if (request.type === 'booking') {
        // Create job
        await connection.query(`
          INSERT INTO jobs (user_id, customer_id, service_id, scheduled_date, notes, status)
          VALUES (?, ?, ?, ?, ?, 'confirmed')
        `, [request.user_id, request.customer_id, request.service_id, request.scheduled_date, request.notes]);
        
        // Create estimate
        const estimateData = {
          customer_name: `${request.first_name} ${request.last_name}`,
          customer_email: request.email,
          service_name: request.service_name,
          amount: request.estimated_price || request.price,
          notes: request.notes,
          valid_until: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], // 30 days from now
          status: 'draft'
        };
        
        await connection.query(`
          INSERT INTO estimates (user_id, customer_id, service_id, amount, notes, valid_until, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
        `, [
          request.user_id, 
          request.customer_id, 
          request.service_id, 
          estimateData.amount,
          estimateData.notes,
          estimateData.valid_until,
          estimateData.status
        ]);
      }
      
      res.json({ message: 'Request approved successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Approve request error:', error);
    res.status(500).json({ error: 'Failed to approve request' });
  }
});

app.post('/api/requests/:id/reject', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    
    const connection = await pool.getConnection();
    
    try {
      await connection.query(`
        UPDATE requests SET 
          status = 'rejected', 
          rejection_reason = ?, 
          updated_at = NOW() 
        WHERE id = ?
      `, [reason, id]);
      
      res.json({ message: 'Request rejected successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Reject request error:', error);
    res.status(500).json({ error: 'Failed to reject request' });
  }
});

// Public booking endpoints

// Public quote endpoint
app.post('/api/public/quotes', async (req, res) => {
  try {
    const { 
      userId = 1,
      customerData,
      serviceId,
      serviceName,
      description,
      preferredDate,
      preferredTime,
      estimatedDuration,
      estimatedPrice,
      notes
    } = req.body;
    
    if (!customerData || !serviceName || !description) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const connection = await pool.getConnection();
    
    try {
      // First, create or find customer
      let customerId;
      const [existingCustomers] = await connection.query(`
        SELECT id FROM customers 
        WHERE user_id = ? AND email = ?
      `, [userId, customerData.email]);
      
      if (existingCustomers.length > 0) {
        customerId = existingCustomers[0].id;
        // Update customer information
        await connection.query(`
          UPDATE customers 
          SET first_name = ?, last_name = ?, phone = ?, address = ?, updated_at = NOW()
          WHERE id = ?
        `, [customerData.firstName, customerData.lastName, customerData.phone, customerData.address, customerId]);
      } else {
        // Create new customer
        const [customerResult] = await connection.query(`
          INSERT INTO customers (user_id, first_name, last_name, email, phone, address, created_at)
          VALUES (?, ?, ?, ?, ?, ?, NOW())
        `, [userId, customerData.firstName, customerData.lastName, customerData.email, customerData.phone, customerData.address]);
        customerId = customerResult.insertId;
      }
      
      // Create quote request
      const [requestResult] = await connection.query(`
        INSERT INTO requests (
          user_id, customer_id, service_id, type, status,
          scheduled_date, scheduled_time, estimated_duration, estimated_price,
          notes, created_at
        ) VALUES (?, ?, ?, 'quote', 'pending', ?, ?, ?, ?, ?, NOW())
      `, [
        userId, customerId, serviceId, preferredDate, preferredTime,
        estimatedDuration, estimatedPrice, notes
      ]);
      
      res.status(201).json({
        message: 'Quote request submitted successfully',
        requestId: requestResult.insertId,
        customerId
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Create quote request error:', error);
    res.status(500).json({ error: 'Failed to submit quote request' });
  }
});

app.post('/api/public/bookings', async (req, res) => {
  try {
    const { 
      userId = 1,
      customerData,
      services,
      scheduledDate,
      scheduledTime,
      totalAmount,
      notes
    } = req.body;
    
    if (!customerData || !services || !scheduledDate || !scheduledTime || !totalAmount) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const connection = await pool.getConnection();
    
    try {
      // First, create or find customer
      let customerId;
      const [existingCustomers] = await connection.query(`
        SELECT id FROM customers 
        WHERE user_id = ? AND email = ?
      `, [userId, customerData.email]);
      
      if (existingCustomers.length > 0) {
        customerId = existingCustomers[0].id;
        // Update customer information
        await connection.query(`
          UPDATE customers 
          SET first_name = ?, last_name = ?, phone = ?, address = ?, updated_at = NOW()
          WHERE id = ?
        `, [customerData.firstName, customerData.lastName, customerData.phone, customerData.address, customerId]);
      } else {
        // Create new customer
        const [customerResult] = await connection.query(`
          INSERT INTO customers (user_id, first_name, last_name, email, phone, address, created_at)
          VALUES (?, ?, ?, ?, ?, ?, NOW())
        `, [userId, customerData.firstName, customerData.lastName, customerData.email, customerData.phone, customerData.address]);
        customerId = customerResult.insertId;
      }
      
      // Create booking (job) for each service
      const bookingIds = [];
      for (const service of services) {
        const fullScheduledDate = `${scheduledDate} ${scheduledTime}:00`;
        
        const [bookingResult] = await connection.query(`
          INSERT INTO jobs (
            user_id, customer_id, service_id, scheduled_date, notes, status, created_at
          ) VALUES (?, ?, ?, ?, ?, 'pending', NOW())
        `, [userId, customerId, service.id, fullScheduledDate, notes]);
        
        bookingIds.push(bookingResult.insertId);
      }
      
      // Create invoice for the booking
      const [invoiceResult] = await connection.query(`
        INSERT INTO invoices (
          user_id, customer_id, amount, total_amount, status, due_date, created_at
        ) VALUES (?, ?, ?, ?, 'draft', DATE_ADD(NOW(), INTERVAL 15 DAY), NOW())
      `, [userId, customerId, totalAmount, totalAmount]);
      
      res.status(201).json({
        message: 'Booking created successfully',
        bookingIds,
        invoiceId: invoiceResult.insertId,
        customerId
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Create booking error:', error);
    res.status(500).json({ error: 'Failed to create booking' });
  }
});

// Booking Settings API endpoints
app.get('/api/booking-settings/:userId', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;
    
    const [settings] = await pool.query(
      'SELECT * FROM booking_settings WHERE user_id = ?',
      [userId]
    );
    
    if (settings.length === 0) {
      // Return default settings if none exist
      const defaultSettings = {
        branding: {
          primaryColor: "#4CAF50",
          headerBackground: "#ffffff",
          headerIcons: "#4CAF50",
          hideZenbookerBranding: false,
          logo: null,
          favicon: null,
          heroImage: null
        },
        content: {
          heading: "Book Online",
          text: "Let's get started by entering your postal code."
        },
        general: {
          serviceArea: "postal-code",
          serviceLayout: "default",
          datePickerStyle: "available-days",
          language: "english",
          textSize: "big",
          showPrices: false,
          includeTax: false,
          autoAdvance: true,
          allowCoupons: true,
          showAllOptions: false,
          showEstimatedDuration: false,
          limitAnimations: false,
          use24Hour: false,
          allowMultipleServices: false
        },
        analytics: {
          googleAnalytics: "",
          facebookPixel: ""
        },
        customUrl: ""
      };
      
      return res.json(defaultSettings);
    }
    
    res.json(JSON.parse(settings[0].settings));
  } catch (error) {
    console.error('Error fetching booking settings:', error);
    res.status(500).json({ error: 'Failed to fetch booking settings' });
  }
});

app.put('/api/booking-settings/:userId', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const settings = req.body;
    
    const [existing] = await pool.query(
      'SELECT * FROM booking_settings WHERE user_id = ?',
      [userId]
    );
    
    if (existing.length === 0) {
      await pool.query(
        'INSERT INTO booking_settings (user_id, settings) VALUES (?, ?)',
        [userId, JSON.stringify(settings)]
      );
    } else {
      await pool.query(
        'UPDATE booking_settings SET settings = ? WHERE user_id = ?',
        [JSON.stringify(settings), userId]
      );
    }
    
    res.json({ message: 'Settings saved successfully' });
  } catch (error) {
    console.error('Error saving booking settings:', error);
    res.status(500).json({ error: 'Failed to save booking settings' });
  }
});

// File upload endpoints
app.post('/api/upload-logo', authenticateToken, upload.single('logo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    const fileUrl = `/uploads/${req.file.filename}`;
    res.json({ url: fileUrl });
  } catch (error) {
    console.error('Error uploading logo:', error);
    res.status(500).json({ error: 'Failed to upload logo' });
  }
});

app.post('/api/upload-favicon', authenticateToken, upload.single('favicon'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    const fileUrl = `/uploads/${req.file.filename}`;
    res.json({ url: fileUrl });
  } catch (error) {
    console.error('Error uploading favicon:', error);
    res.status(500).json({ error: 'Failed to upload favicon' });
  }
});

app.post('/api/upload-hero-image', authenticateToken, upload.single('heroImage'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    const fileUrl = `/uploads/${req.file.filename}`;
    res.json({ url: fileUrl });
  } catch (error) {
    console.error('Error uploading hero image:', error);
    res.status(500).json({ error: 'Failed to upload hero image' });
  }
});
// Public API endpoints for booking and quote pages
app.get('/api/public/business/:businessSlug/settings', async (req, res) => {
  try {
    const { businessSlug } = req.params;
    
    // Find user by business slug (converted from business name)
    const [users] = await pool.query(
      'SELECT id, business_name FROM users WHERE LOWER(REPLACE(business_name, " ", "")) = ?',
      [businessSlug.toLowerCase()]
    );
    
    if (users.length === 0) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const userId = users[0].id;
    
    // Get booking settings
    const [settings] = await pool.query(
      'SELECT settings FROM booking_settings WHERE user_id = ?',
      [userId]
    );
    
    if (settings.length === 0) {
      // Return default settings
      const defaultSettings = {
        branding: {
          primaryColor: "#4CAF50",
          headerBackground: "#ffffff",
          headerIcons: "#4CAF50",
          hideZenbookerBranding: false,
          logo: null,
          favicon: null,
          heroImage: null
        },
        content: {
          heading: "Book Online",
          text: "Let's get started by entering your postal code."
        },
        general: {
          serviceArea: "postal-code",
          serviceLayout: "default",
          datePickerStyle: "available-days",
          language: "english",
          textSize: "big",
          showPrices: false,
          includeTax: false,
          autoAdvance: true,
          allowCoupons: true,
          showAllOptions: false,
          showEstimatedDuration: false,
          limitAnimations: false,
          use24Hour: false,
          allowMultipleServices: false
        }
      };
      
      return res.json(defaultSettings);
    }
    
    res.json(JSON.parse(settings[0].settings));
  } catch (error) {
    console.error('Error fetching public business settings:', error);
    res.status(500).json({ error: 'Failed to fetch business settings' });
  }
});

app.get('/api/public/business/:businessSlug/services', async (req, res) => {
  try {
    const { businessSlug } = req.params;
    
    // Find user by business slug
    const [users] = await pool.query(
      'SELECT id FROM users WHERE LOWER(REPLACE(business_name, " ", "")) = ?',
      [businessSlug.toLowerCase()]
    );
    
    if (users.length === 0) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const userId = users[0].id;
    
    // Get services for this business
    const [services] = await pool.query(
      'SELECT id, name, description, price, duration FROM services WHERE user_id = ? AND is_active = 1',
      [userId]
    );
    
    res.json(services);
  } catch (error) {
    console.error('Error fetching public services:', error);
    res.status(500).json({ error: 'Failed to fetch services' });
  }
});

app.post('/api/public/business/:businessSlug/book', async (req, res) => {
  try {
    const { businessSlug } = req.params;
    const bookingData = req.body;
    
    // Find user by business slug
    const [users] = await pool.query(
      'SELECT id FROM users WHERE LOWER(REPLACE(business_name, " ", "")) = ?',
      [businessSlug.toLowerCase()]
    );
    
    if (users.length === 0) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const userId = users[0].id;
    
    // First, create or find customer
    let customerId;
    const [existingCustomers] = await pool.query(
      'SELECT id FROM customers WHERE user_id = ? AND email = ?',
      [userId, bookingData.email]
    );
    
    if (existingCustomers.length > 0) {
      customerId = existingCustomers[0].id;
      // Update customer information
      await pool.query(
        'UPDATE customers SET first_name = ?, last_name = ?, phone = ?, address = ?, updated_at = NOW() WHERE id = ?',
        [bookingData.name.split(' ')[0] || '', bookingData.name.split(' ').slice(1).join(' ') || '', bookingData.phone, bookingData.address, customerId]
      );
    } else {
      // Create new customer
      const [customerResult] = await pool.query(
        'INSERT INTO customers (user_id, first_name, last_name, email, phone, address, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW())',
        [
          userId,
          bookingData.name.split(' ')[0] || '',
          bookingData.name.split(' ').slice(1).join(' ') || '',
          bookingData.email,
          bookingData.phone,
          bookingData.address
        ]
      );
      customerId = customerResult.insertId;
    }
    
    // Create job record with customer_id
    const scheduledDateTime = `${bookingData.date}T${bookingData.time}:00`;
    const [jobResult] = await pool.query(
      'INSERT INTO jobs (user_id, customer_id, service_id, scheduled_date, notes, status) VALUES (?, ?, ?, ?, ?, ?)',
      [
        userId,
        customerId,
        bookingData.service,
        scheduledDateTime,
        bookingData.notes || '',
        'pending'
      ]
    );
    
    const jobId = jobResult.insertId;
    
    // Save intake question answers if provided
    if (bookingData.intakeAnswers && Object.keys(bookingData.intakeAnswers).length > 0) {
      // Get service intake questions to match with answers
      const [serviceData] = await pool.query(
        'SELECT intake_questions FROM services WHERE id = ?',
        [bookingData.service]
      );
      
      if (serviceData.length > 0 && serviceData[0].intake_questions) {
        try {
          // Handle both string and object formats with better validation
          let intakeQuestions;
          if (typeof serviceData[0].intake_questions === 'string') {
            try {
              intakeQuestions = JSON.parse(serviceData[0].intake_questions);
            } catch (parseError) {
              console.error('Error parsing intake_questions JSON string:', parseError);
              intakeQuestions = [];
            }
          } else if (Array.isArray(serviceData[0].intake_questions)) {
            intakeQuestions = serviceData[0].intake_questions;
          } else {
            console.warn('Invalid intake_questions format, treating as empty array');
            intakeQuestions = [];
          }
          
          // Validate that intakeQuestions is an array
          if (!Array.isArray(intakeQuestions)) {
            console.warn('intakeQuestions is not an array, treating as empty array');
            intakeQuestions = [];
          }
          
          // Save each answer
          for (const question of intakeQuestions) {
            // Validate question structure
            if (!question || typeof question !== 'object' || !question.id || !question.question || !question.questionType) {
              console.warn('Invalid question structure, skipping:', question);
              continue;
            }
            
            const answer = bookingData.intakeAnswers[question.id];
            if (answer !== undefined && answer !== null && answer !== '') {
              const answerToSave = (Array.isArray(answer) || typeof answer === 'object') ? JSON.stringify(answer) : answer;
              try {
                await pool.query(
                  'INSERT INTO job_answers (job_id, question_id, question_text, question_type, answer, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
                  [jobId, question.id, question.question, question.questionType, answerToSave]
                );
              } catch (insertError) {
                console.error('Error inserting job answer:', insertError);
                // Continue processing other answers even if one fails
              }
            }
          }
        } catch (error) {
          console.error('Error processing intake questions:', error);
          // Don't fail the entire operation if intake questions processing fails
        }
      }
    }
    
    // Create invoice record
    const [serviceResult] = await pool.query('SELECT price FROM services WHERE id = ?', [bookingData.service]);
    const price = serviceResult[0]?.price || 0;
    
    await pool.query(
      'INSERT INTO invoices (user_id, customer_id, job_id, amount, total_amount, status, due_date) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        userId,
        customerId,
        jobId,
        price,
        price,
        'draft',
        new Date()
      ]
    );
    
    res.json({ 
      success: true, 
      message: 'Booking created successfully',
      jobId: jobId
    });
  } catch (error) {
    console.error('Error creating public booking:', error);
    res.status(500).json({ error: 'Failed to create booking' });
  }
});

app.post('/api/public/business/:businessSlug/quote', async (req, res) => {
  try {
    const { businessSlug } = req.params;
    const quoteData = req.body;
    
    // Find user by business slug
    const [users] = await pool.query(
      'SELECT id FROM users WHERE LOWER(REPLACE(business_name, " ", "")) = ?',
      [businessSlug.toLowerCase()]
    );
    
    if (users.length === 0) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const userId = users[0].id;
    
    // First, create or find customer
    let customerId;
    const [existingCustomers] = await pool.query(
      'SELECT id FROM customers WHERE user_id = ? AND email = ?',
      [userId, quoteData.email]
    );
    
    if (existingCustomers.length > 0) {
      customerId = existingCustomers[0].id;
      // Update customer information
      await pool.query(
        'UPDATE customers SET first_name = ?, last_name = ?, phone = ?, address = ?, updated_at = NOW() WHERE id = ?',
        [quoteData.name.split(' ')[0] || '', quoteData.name.split(' ').slice(1).join(' ') || '', quoteData.phone, quoteData.address, customerId]
      );
    } else {
      // Create new customer
      const [customerResult] = await pool.query(
        'INSERT INTO customers (user_id, first_name, last_name, email, phone, address, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW())',
        [
          userId,
          quoteData.name.split(' ')[0] || '',
          quoteData.name.split(' ').slice(1).join(' ') || '',
          quoteData.email,
          quoteData.phone,
          quoteData.address
        ]
      );
      customerId = customerResult.insertId;
    }
    
    // Create request record in the requests table
    const [requestResult] = await pool.query(
      'INSERT INTO requests (user_id, customer_id, customer_name, customer_email, type, status, scheduled_date, scheduled_time, estimated_duration, estimated_price, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        userId,
        customerId,
        quoteData.name,
        quoteData.email,
        'quote',
        'pending',
        quoteData.preferredDate || null,
        quoteData.preferredTime || null,
        null, // Will be filled by business when they respond
        null, // Will be filled by business when they respond
        `Service Type: ${quoteData.serviceType}\nDescription: ${quoteData.description}\nUrgency: ${quoteData.urgency}\nBudget: ${quoteData.budget}\nAdditional Info: ${quoteData.additionalInfo}`
      ]
    );
    
    res.json({ 
      success: true, 
      message: 'Quote request submitted successfully',
      requestId: requestResult.insertId
    });
  } catch (error) {
    console.error('Error creating public quote request:', error);
    res.status(500).json({ error: 'Failed to submit quote request' });
  }
});

// Simple invoice status update (temporary workaround)
app.put('/api/invoices/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId, status } = req.body;
    
    console.log('Simple invoice status update:', { id, userId, status });
    
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const connection = await pool.getConnection();
    
    try {
      // Simple status update only
      const [result] = await connection.query(`
        UPDATE invoices SET
          status = ?,
          updated_at = NOW()
        WHERE id = ? AND user_id = ?
      `, [status, id, userId]);
      
      console.log('Simple update result:', result);
      
      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Invoice not found' });
      }
      
      res.json({ 
        message: 'Invoice status updated successfully',
        invoiceId: id,
        status: status
      });
      
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Simple invoice status update error:', error);
    res.status(500).json({ error: 'Failed to update invoice status' });
  }
});
// Google Places API endpoints (New)
app.get('/api/places/autocomplete', async (req, res) => {
  try {
    const { input } = req.query;
    
    if (!input || input.length < 3) {
      return res.json({ predictions: [] });
    }
    
    const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || "AIzaSyBFw0Qbyq9zTFTd-tUY6dZWTgaQzuU17R8";
    
    // Use the new Places API (New) format
    const requestBody = {
      input: input,
      languageCode: "en",
      regionCode: "US"
    };
    
    const options = {
      hostname: 'places.googleapis.com',
      path: `/v1/places:autocomplete?key=${GOOGLE_API_KEY}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': GOOGLE_API_KEY,
        'X-Goog-FieldMask': 'places.displayName,places.id'
      }
    };
    
    const postData = JSON.stringify(requestBody);
    
    const request = https.request(options, (response) => {
      let data = '';
      
      response.on('data', (chunk) => {
        data += chunk;
      });
      
      response.on('end', () => {
        try {
          console.log("Google API raw response:", data);
          const jsonData = JSON.parse(data);
          console.log("Parsed API response:", jsonData);
          
          // Convert new format to legacy format for compatibility
          const predictions = jsonData.places ? jsonData.places.map(place => ({
            place_id: place.id,
            description: place.displayName?.text || '',
            structured_formatting: {
              main_text: place.displayName?.text || '',
              secondary_text: ''
            }
          })) : [];
          
          console.log("Converted predictions:", predictions);
          res.json({ predictions });
        } catch (error) {
          console.error('Error parsing Google Places response:', error);
          res.status(500).json({ error: 'Failed to parse address suggestions' });
        }
      });
    });
    
    request.on('error', (error) => {
      console.error('Google Places autocomplete error:', error);
      res.status(500).json({ error: 'Failed to fetch address suggestions' });
    });
    
    request.write(postData);
    request.end();
  } catch (error) {
    console.error('Google Places autocomplete error:', error);
    res.status(500).json({ error: 'Failed to fetch address suggestions' });
  }
});

app.get('/api/places/details', async (req, res) => {
  try {
    const { place_id } = req.query;
    
    if (!place_id) {
      return res.status(400).json({ error: 'place_id is required' });
    }
    
    const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || "AIzaSyBFw0Qbyq9zTFTd-tUY6dZWTgaQzuU17R8";
    
    // Use the new Places API (New) format
    const options = {
      hostname: 'places.googleapis.com',
      path: `/v1/places/${place_id}?key=${GOOGLE_API_KEY}`,
      method: 'GET',
      headers: {
        'X-Goog-Api-Key': GOOGLE_API_KEY,
        'X-Goog-FieldMask': 'addressComponents,formattedAddress'
      }
    };
    
    console.log('Fetching place details for:', place_id);
    
    const request = https.request(options, (response) => {
      let data = '';
      
      response.on('data', (chunk) => {
        data += chunk;
      });
      
      response.on('end', () => {
        try {
          const jsonData = JSON.parse(data);
          
          // Convert new format to legacy format for compatibility
          const result = {
            address_components: jsonData.addressComponents || [],
            formatted_address: jsonData.formattedAddress || ''
          };
          
          res.json({ result });
        } catch (error) {
          console.error('Error parsing Google Places response:', error);
          res.status(500).json({ error: 'Failed to parse place details' });
        }
      });
    });
    
    request.on('error', (error) => {
      console.error('Google Places details error:', error);
      res.status(500).json({ error: 'Failed to fetch place details' });
    });
    
    request.end();
  } catch (error) {
    console.error('Google Places details error:', error);
    res.status(500).json({ error: 'Failed to fetch place details' });
  }
});
// Assign job to team member
app.post('/api/jobs/:jobId/assign', authenticateToken, async (req, res) => {
  // Set CORS headers explicitly
  const origin = req.headers.origin;
  if (origin) {
    res.header('Access-Control-Allow-Origin', origin);
  } else {
    res.header('Access-Control-Allow-Origin', '*');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin, Cache-Control');
  res.header('Access-Control-Allow-Credentials', 'true');
  
  try {
    const { jobId } = req.params;
    const { teamMemberId } = req.body;
    const userId = req.user.userId;
    const connection = await pool.getConnection();
    
    try {
      // Check if job exists and belongs to user
      const [jobCheck] = await connection.query('SELECT id, user_id FROM jobs WHERE id = ?', [jobId]);
      if (jobCheck.length === 0) {
        return res.status(404).json({ error: 'Job not found' });
      }
      
      if (jobCheck[0].user_id !== userId) {
        return res.status(403).json({ error: 'Access denied' });
      }
      
      // Check if team member exists (if teamMemberId is provided)
      if (teamMemberId) {
        const [memberCheck] = await connection.query('SELECT id FROM team_members WHERE id = ? AND user_id = ?', [teamMemberId, userId]);
        if (memberCheck.length === 0) {
          return res.status(404).json({ error: 'Team member not found' });
        }
      }
      
      // Remove existing assignments for this job
      await connection.query('DELETE FROM job_team_assignments WHERE job_id = ?', [jobId]);
      
      // Update the job with team member assignment (for backward compatibility)
      await connection.query(
        'UPDATE jobs SET team_member_id = ? WHERE id = ?',
        [teamMemberId || null, jobId]
      );
      
      // Create assignment in job_team_assignments table
      if (teamMemberId) {
        await connection.query(`
          INSERT INTO job_team_assignments (job_id, team_member_id, is_primary, assigned_by)
          VALUES (?, ?, 1, ?)
        `, [jobId, teamMemberId, userId]);
        
        console.log('🔄 Created team assignment for job:', jobId, 'team member:', teamMemberId);
      }
      
      // Create a notification for the team member (only if notifications table exists)
      if (teamMemberId) {
        try {
          const [jobData] = await connection.query(`
            SELECT j.*, c.first_name, c.last_name, s.name as service_name
            FROM jobs j
            LEFT JOIN customers c ON j.customer_id = c.id
            LEFT JOIN services s ON j.service_id = s.id
            WHERE j.id = ?
          `, [jobId]);
          
          if (jobData.length > 0) {
            const job = jobData[0];
            
            // Check if team_member_notifications table exists
            const [tableCheck] = await connection.query(`
              SELECT COUNT(*) as count 
              FROM INFORMATION_SCHEMA.TABLES 
              WHERE TABLE_SCHEMA = DATABASE() 
              AND TABLE_NAME = 'team_member_notifications'
            `);
            
            if (tableCheck[0].count > 0) {
              await connection.query(`
                INSERT INTO team_member_notifications 
                (team_member_id, type, title, message, data) 
                VALUES (?, 'job_assigned', 'New Job Assigned', ?, ?)
              `, [
                teamMemberId,
                `You have been assigned a new job: ${job.service_name} for ${job.first_name} ${job.last_name}`,
                JSON.stringify({ jobId: job.id, serviceName: job.service_name, customerName: `${job.first_name} ${job.last_name}` })
              ]);
            }
          }
        } catch (notificationError) {
          console.error('Notification creation error (non-critical):', notificationError);
          // Don't fail the job assignment if notification creation fails
        }
      }
      
      res.json({ message: 'Job assigned successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Job assignment error:', error);
    res.status(500).json({ error: 'Failed to assign job' });
  }
});

// Remove team member assignment from job
app.delete('/api/jobs/:jobId/assign/:teamMemberId', authenticateToken, async (req, res) => {
  // Set CORS headers explicitly
  const origin = req.headers.origin;
  if (origin) {
    res.header('Access-Control-Allow-Origin', origin);
  } else {
    res.header('Access-Control-Allow-Origin', '*');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin, Cache-Control');
  res.header('Access-Control-Allow-Credentials', 'true');
  
  try {
    const { jobId, teamMemberId } = req.params;
    const userId = req.user.userId;
    const connection = await pool.getConnection();
    
    try {
      // Check if job exists and belongs to user
      const [jobCheck] = await connection.query('SELECT id, user_id FROM jobs WHERE id = ?', [jobId]);
      if (jobCheck.length === 0) {
        return res.status(404).json({ error: 'Job not found' });
      }
      
      if (jobCheck[0].user_id !== userId) {
        return res.status(403).json({ error: 'Access denied' });
      }
      
      // Check if team member exists and belongs to user
      const [memberCheck] = await connection.query('SELECT id FROM team_members WHERE id = ? AND user_id = ?', [teamMemberId, userId]);
      if (memberCheck.length === 0) {
        return res.status(404).json({ error: 'Team member not found' });
      }
      
      // Remove the specific assignment
      const [deleteResult] = await connection.query(
        'DELETE FROM job_team_assignments WHERE job_id = ? AND team_member_id = ?',
        [jobId, teamMemberId]
      );
      
      if (deleteResult.affectedRows === 0) {
        return res.status(404).json({ error: 'Team member assignment not found' });
      }
      
      // Check if this was the primary assignment and update jobs table accordingly
      const [primaryCheck] = await connection.query(
        'SELECT COUNT(*) as count FROM job_team_assignments WHERE job_id = ? AND is_primary = 1',
        [jobId]
      );
      
      if (primaryCheck[0].count === 0) {
        // No more primary assignments, clear the team_member_id in jobs table
        await connection.query('UPDATE jobs SET team_member_id = NULL WHERE id = ?', [jobId]);
      } else {
        // Set the first remaining assignment as primary
        const [remainingAssignments] = await connection.query(
          'SELECT team_member_id FROM job_team_assignments WHERE job_id = ? ORDER BY assigned_at ASC LIMIT 1',
          [jobId]
        );
        
        if (remainingAssignments.length > 0) {
          await connection.query(
            'UPDATE jobs SET team_member_id = ? WHERE id = ?',
            [remainingAssignments[0].team_member_id, jobId]
          );
        }
      }
      
      console.log('🔄 Removed team assignment for job:', jobId, 'team member:', teamMemberId);
      res.json({ message: 'Team member assignment removed successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Remove team assignment error:', error);
    res.status(500).json({ error: 'Failed to remove team member assignment' });
  }
});

// Get team assignments for a job
app.get('/api/jobs/:jobId/assignments', authenticateToken, async (req, res) => {
  // Set CORS headers explicitly
  const origin = req.headers.origin;
  if (origin) {
    res.header('Access-Control-Allow-Origin', origin);
  } else {
    res.header('Access-Control-Allow-Origin', '*');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin, Cache-Control');
  res.header('Access-Control-Allow-Credentials', 'true');
  
  try {
    const { jobId } = req.params;
    const userId = req.user.userId;
    const connection = await pool.getConnection();
    
    try {
      // Check if job exists and belongs to user
      const [jobCheck] = await connection.query('SELECT id, user_id FROM jobs WHERE id = ?', [jobId]);
      if (jobCheck.length === 0) {
        return res.status(404).json({ error: 'Job not found' });
      }
      
      if (jobCheck[0].user_id !== userId) {
        return res.status(403).json({ error: 'Access denied' });
      }
      
      // Get team assignments for this job
      const [assignments] = await connection.query(`
        SELECT 
          jta.*,
          tm.first_name,
          tm.last_name,
          tm.email,
          tm.phone,
          tm.role
        FROM job_team_assignments jta
        LEFT JOIN team_members tm ON jta.team_member_id = tm.id
        WHERE jta.job_id = ?
        ORDER BY jta.is_primary DESC, jta.assigned_at ASC
      `, [jobId]);
      
      res.json({ assignments });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Get team assignments error:', error);
    res.status(500).json({ error: 'Failed to get team assignments' });
  }
});

// Assign multiple team members to a job
app.post('/api/jobs/:jobId/assign-multiple', authenticateToken, async (req, res) => {
  // Set CORS headers explicitly
  const origin = req.headers.origin;
  if (origin) {
    res.header('Access-Control-Allow-Origin', origin);
  } else {
    res.header('Access-Control-Allow-Origin', '*');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin, Cache-Control');
  res.header('Access-Control-Allow-Credentials', 'true');
  
  try {
    const { jobId } = req.params;
    const { teamMemberIds, primaryMemberId } = req.body;
    const userId = req.user.userId;
    const connection = await pool.getConnection();
    
    try {
      // Check if job exists and belongs to user
      const [jobCheck] = await connection.query('SELECT id, user_id FROM jobs WHERE id = ?', [jobId]);
      if (jobCheck.length === 0) {
        return res.status(404).json({ error: 'Job not found' });
      }
      
      if (jobCheck[0].user_id !== userId) {
        return res.status(403).json({ error: 'Access denied' });
      }
      
      // Validate team member IDs
      if (!Array.isArray(teamMemberIds) || teamMemberIds.length === 0) {
        return res.status(400).json({ error: 'Team member IDs array is required' });
      }
      
      // Check if all team members exist and belong to user
      for (const memberId of teamMemberIds) {
        const [memberCheck] = await connection.query('SELECT id FROM team_members WHERE id = ? AND user_id = ?', [memberId, userId]);
        if (memberCheck.length === 0) {
          return res.status(404).json({ error: `Team member ${memberId} not found` });
        }
      }
      
      // Remove existing assignments for this job
      await connection.query('DELETE FROM job_team_assignments WHERE job_id = ?', [jobId]);
      
      // Create new assignments
      for (const memberId of teamMemberIds) {
        const isPrimary = memberId === primaryMemberId || (primaryMemberId === undefined && teamMemberIds.indexOf(memberId) === 0);
        
        await connection.query(`
          INSERT INTO job_team_assignments (job_id, team_member_id, is_primary, assigned_by)
          VALUES (?, ?, ?, ?)
        `, [jobId, memberId, isPrimary ? 1 : 0, userId]);
      }
      
      // Update the job with the primary team member (for backward compatibility)
      const primaryId = primaryMemberId || teamMemberIds[0];
      await connection.query(
        'UPDATE jobs SET team_member_id = ? WHERE id = ?',
        [primaryId, jobId]
      );
      
      console.log('🔄 Created multiple team assignments for job:', jobId, 'team members:', teamMemberIds);
      res.json({ message: 'Team members assigned successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Multiple team assignment error:', error);
    res.status(500).json({ error: 'Failed to assign team members' });
  }
});

// Test team assignment endpoint
app.get('/api/test-team-assignment/:jobId', authenticateToken, async (req, res) => {
  try {
    const { jobId } = req.params;
    const userId = req.user.userId;
    const connection = await pool.getConnection();
    
    try {
      // Check if job exists
      const [jobCheck] = await connection.query('SELECT id, user_id, team_member_id FROM jobs WHERE id = ?', [jobId]);
      if (jobCheck.length === 0) {
        return res.status(404).json({ error: 'Job not found' });
      }
      
      // Check if job_team_assignments table exists
      const [tableCheck] = await connection.query(`
        SELECT COUNT(*) as count 
        FROM INFORMATION_SCHEMA.TABLES 
        WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = 'job_team_assignments'
      `);
      
      // Get team assignments
      let assignments = [];
      if (tableCheck[0].count > 0) {
        const [assignmentsResult] = await connection.query(`
          SELECT 
            jta.*,
            tm.first_name,
            tm.last_name,
            tm.email
          FROM job_team_assignments jta
          LEFT JOIN team_members tm ON jta.team_member_id = tm.id
          WHERE jta.job_id = ?
        `, [jobId]);
        assignments = assignmentsResult;
      }
      
      res.json({
        job: jobCheck[0],
        tableExists: tableCheck[0].count > 0,
        assignments: assignments,
        message: 'Team assignment test completed'
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Test team assignment error:', error);
    res.status(500).json({ error: 'Failed to test team assignment' });
  }
});

// Database health check endpoint
app.get('/api/health/database', async (req, res) => {
  try {
    console.log('🔍 Database health check requested');
    const connection = await pool.getConnection();
    
    try {
      // Test basic connection
      const [result] = await connection.query('SELECT 1 as test');
      console.log('✅ Database connection successful');
      
      // Test team_members table
      let teamMembersTable = false;
      try {
        const [teamMembersResult] = await connection.query('SELECT COUNT(*) as count FROM team_members LIMIT 1');
        teamMembersTable = true;
        console.log('✅ team_members table exists');
      } catch (error) {
        console.log('❌ team_members table error:', error.message);
      }
      
      // Test jobs table
      let jobsTable = false;
      try {
        const [jobsResult] = await connection.query('SELECT COUNT(*) as count FROM jobs LIMIT 1');
        jobsTable = true;
        console.log('✅ jobs table exists');
      } catch (error) {
        console.log('❌ jobs table error:', error.message);
      }
      
      // Test customers table
      let customersTable = false;
      try {
        const [customersResult] = await connection.query('SELECT COUNT(*) as count FROM customers LIMIT 1');
        customersTable = true;
        console.log('✅ customers table exists');
      } catch (error) {
        console.log('❌ customers table error:', error.message);
      }
      
      // Test services table
      let servicesTable = false;
      try {
        const [servicesResult] = await connection.query('SELECT COUNT(*) as count FROM services LIMIT 1');
        servicesTable = true;
        console.log('✅ services table exists');
      } catch (error) {
        console.log('❌ services table error:', error.message);
      }
      
      res.json({
        status: 'healthy',
        database: 'connected',
        tables: {
          team_members: teamMembersTable,
          jobs: jobsTable,
          customers: customersTable,
          services: servicesTable
        }
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('❌ Database health check failed:', error);
    res.status(500).json({
      status: 'unhealthy',
      error: error.message
    });
  }
});

// Team member dashboard endpoints

// Test team member endpoint
app.get('/api/test/team-member/:id', async (req, res) => {
  try {
    const { id } = req.params;
    console.log('🔍 Testing team member with ID:', id);
    
    const connection = await pool.getConnection();
    
    try {
      const [teamMembers] = await connection.query(
        'SELECT id, first_name, last_name, email, username FROM team_members WHERE id = ?',
        [id]
      );
      
      if (teamMembers.length === 0) {
        console.log('❌ Team member not found');
        return res.json({ 
          found: false, 
          message: 'Team member not found',
          availableIds: []
        });
      }
      
      console.log('✅ Team member found:', teamMembers[0]);
      res.json({ 
        found: true, 
        teamMember: teamMembers[0] 
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('❌ Test team member error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Test jobs table structure
app.get('/api/test/jobs-structure', async (req, res) => {
  try {
    console.log('🔍 Testing jobs table structure');
    
    const connection = await pool.getConnection();
    
    try {
      // Get table structure
      const [columns] = await connection.query(`
        SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT 
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'jobs'
        ORDER BY ORDINAL_POSITION
      `);
      
      console.log('✅ Jobs table columns:', columns.map(c => c.COLUMN_NAME));
      
      // Check if team_member_id column exists
      const hasTeamMemberId = columns.some(col => col.COLUMN_NAME === 'team_member_id');
      
      // Test a simple jobs query
      let jobsCount = 0;
      try {
        const [jobsResult] = await connection.query('SELECT COUNT(*) as count FROM jobs');
        jobsCount = jobsResult[0].count;
        console.log('✅ Jobs table accessible, count:', jobsCount);
      } catch (jobsError) {
        console.error('❌ Jobs table error:', jobsError.message);
      }
      
      // Test jobs with team_member_id if column exists
      let teamMemberJobs = [];
      if (hasTeamMemberId) {
        try {
          const [teamJobsResult] = await connection.query(`
            SELECT j.id, j.team_member_id, j.scheduled_date, j.status
            FROM jobs j 
            WHERE j.team_member_id = 3 
            LIMIT 5
          `);
          teamMemberJobs = teamJobsResult;
          console.log('✅ Team member jobs found:', teamMemberJobs.length);
        } catch (teamJobsError) {
          console.error('❌ Team member jobs query error:', teamJobsError.message);
        }
      }
      
      res.json({
        tableExists: true,
        columns: columns.map(c => c.COLUMN_NAME),
        hasTeamMemberId: hasTeamMemberId,
        jobsCount: jobsCount,
        teamMemberJobs: teamMemberJobs
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('❌ Jobs structure test error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Test job answers endpoint
app.get('/api/test/job-answers/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const connection = await pool.getConnection();
    
    try {
      const [answers] = await connection.query(`
        SELECT 
          id,
          job_id,
          question_id,
          question_text,
          question_type,
          answer,
          created_at
        FROM job_answers 
        WHERE job_id = ?
        ORDER BY created_at ASC
      `, [jobId]);
      
      res.json({
        jobId: jobId,
        count: answers.length,
        answers: answers
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Test job answers error:', error);
    res.status(500).json({ error: 'Failed to get job answers' });
  }
});

// Test team member endpoint

// Team member performance endpoint
app.get('/api/team-members/:id/performance', async (req, res) => {
  try {
    const { id } = req.params;
    const connection = await pool.getConnection();
    
    try {
      // Get team member info
      const [teamMembers] = await connection.query(
        'SELECT * FROM team_members WHERE id = ?',
        [id]
      );
      
      if (teamMembers.length === 0) {
        return res.status(404).json({ error: 'Team member not found' });
      }
      
      // Check if team_member_id column exists in jobs table
      let hasTeamMemberIdColumn = false;
      try {
        const [columnCheck] = await connection.query(`
          SELECT COUNT(*) as count
          FROM INFORMATION_SCHEMA.COLUMNS 
          WHERE TABLE_SCHEMA = DATABASE() 
          AND TABLE_NAME = 'jobs' 
          AND COLUMN_NAME = 'team_member_id'
        `);
        hasTeamMemberIdColumn = columnCheck[0].count > 0;
      } catch (error) {
        console.error('Error checking team_member_id column:', error);
        hasTeamMemberIdColumn = false;
      }
      
      let performanceMetrics = [{ jobs_completed: 0, average_rating: 0, hours_worked: 0, revenue_generated: 0 }];
      let recentJobs = [];
      
      if (hasTeamMemberIdColumn) {
        try {
          // Get performance metrics
          const [metricsResult] = await connection.query(`
            SELECT 
              COUNT(CASE WHEN j.status = 'completed' THEN 1 END) as jobs_completed,
              AVG(CASE WHEN j.rating IS NOT NULL THEN j.rating ELSE NULL END) as average_rating,
              SUM(CASE WHEN j.status = 'completed' THEN j.duration ELSE 0 END) as hours_worked,
              SUM(CASE WHEN j.status = 'completed' THEN j.total_amount ELSE 0 END) as revenue_generated
            FROM jobs j
            WHERE j.team_member_id = ?
            AND j.scheduled_date >= DATE_SUB(NOW(), INTERVAL 30 DAY)
          `, [id]);
          
          performanceMetrics = metricsResult;
          
          // Get recent jobs (last 10 completed jobs)
          const [jobsResult] = await connection.query(`
            SELECT 
              j.*,
              c.first_name as customer_first_name,
              c.last_name as customer_last_name,
              s.name as service_name
            FROM jobs j
            LEFT JOIN customers c ON j.customer_id = c.id
            LEFT JOIN services s ON j.service_id = s.id
            WHERE j.team_member_id = ?
            AND j.status = 'completed'
            ORDER BY j.completed_date DESC
            LIMIT 10
          `, [id]);
          
          recentJobs = jobsResult;
        } catch (queryError) {
          console.error('Error querying jobs for team member:', queryError);
          // Use default values if query fails
        }
      } else {
        console.log('team_member_id column does not exist in jobs table, using default values');
      }
      
      const performance = performanceMetrics[0] || {
        jobs_completed: 0,
        average_rating: 0,
        hours_worked: 0,
        revenue_generated: 0
      };
      
      res.json({
        performance: {
          jobsCompleted: performance.jobs_completed || 0,
          averageRating: parseFloat(performance.average_rating) || 0,
          hoursWorked: Math.round((performance.hours_worked || 0) / 60), // Convert minutes to hours
          revenueGenerated: parseFloat(performance.revenue_generated) || 0
        },
        recentJobs: recentJobs || []
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Get team member performance error:', error);
    res.status(500).json({ error: 'Failed to fetch team member performance' });
  }
});

// Team member settings endpoint
app.put('/api/team-members/:id/settings', async (req, res) => {
  try {
    const { id } = req.params;
    const { settings } = req.body;
    const connection = await pool.getConnection();
    
    try {
      // Check if team member exists
      const [teamMembers] = await connection.query(
        'SELECT * FROM team_members WHERE id = ?',
        [id]
      );
      
      if (teamMembers.length === 0) {
        return res.status(404).json({ error: 'Team member not found' });
      }
      
      // Update team member settings
      await connection.query(
        'UPDATE team_members SET settings = ? WHERE id = ?',
        [JSON.stringify(settings), id]
      );
      
      res.json({
        success: true,
        message: 'Settings updated successfully'
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Update team member settings error:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// Get team member settings endpoint
app.get('/api/team-members/:id/settings', async (req, res) => {
  try {
    const { id } = req.params;
    const connection = await pool.getConnection();
    
    try {
      // Get team member settings
      const [teamMembers] = await connection.query(
        'SELECT settings FROM team_members WHERE id = ?',
        [id]
      );
      
      if (teamMembers.length === 0) {
        return res.status(404).json({ error: 'Team member not found' });
      }
      
      let settings = {};
      try {
        if (teamMembers[0].settings) {
          settings = JSON.parse(teamMembers[0].settings);
        }
      } catch (error) {
        console.error('Error parsing settings:', error);
        settings = {};
      }
      
      res.json({
        settings: settings
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Get team member settings error:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// Database migration endpoint for team member settings
app.post('/api/migrate/team-member-settings', async (req, res) => {
  try {
    console.log('🔧 Adding settings column to team_members table...');
    
    const connection = await pool.getConnection();
    
    try {
      // Check if settings column exists
      const [columnCheck] = await connection.query(`
        SELECT COUNT(*) as count
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = 'team_members' 
        AND COLUMN_NAME = 'settings'
      `);
      
      if (columnCheck[0].count === 0) {
        // Add settings column to team_members table
        await connection.query('ALTER TABLE team_members ADD COLUMN settings JSON NULL');
        console.log('✅ Added settings column to team_members table');
        
        // Update existing team members with default settings
        await connection.query(`
          UPDATE team_members SET settings = JSON_OBJECT(
            'isServiceProvider', true,
            'emailNotifications', true,
            'smsNotifications', false,
            'role', 'service_provider',
            'permissions', JSON_OBJECT(
              'createJobs', false,
              'editJobs', false,
              'deleteJobs', false,
              'manageTeam', false,
              'viewReports', false,
              'manageSettings', false
            )
          ) WHERE settings IS NULL
        `);
        console.log('✅ Updated existing team members with default settings');
      } else {
        console.log('✅ Settings column already exists');
      }
      
      // Show table structure
      const [columns] = await connection.query('DESCRIBE team_members');
      console.log('📋 Team members table structure:', columns.map(c => c.Field));
      
      res.json({
        success: true,
        message: 'Team member settings migration completed successfully',
        teamMemberColumns: columns.map(c => c.Field)
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('❌ Team member settings migration error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Database migration endpoint for jobs team member assignment
app.post('/api/migrate/jobs-team-member', async (req, res) => {
  try {
    console.log('🔧 Adding team_member_id column to jobs table...');
    
    const connection = await pool.getConnection();
    
    try {
      // Check if team_member_id column exists
      const [columnCheck] = await connection.query(`
        SELECT COUNT(*) as count
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = 'jobs' 
        AND COLUMN_NAME = 'team_member_id'
      `);
      
      if (columnCheck[0].count === 0) {
        // Add team_member_id column to jobs table
        await connection.query('ALTER TABLE jobs ADD COLUMN team_member_id INT NULL');
        console.log('✅ Added team_member_id column to jobs table');
        
        // Add foreign key constraint if team_members table exists
        try {
          await connection.query(`
            ALTER TABLE jobs 
            ADD CONSTRAINT fk_jobs_team_member 
            FOREIGN KEY (team_member_id) REFERENCES team_members(id) 
            ON DELETE SET NULL
          `);
          console.log('✅ Added foreign key constraint');
        } catch (fkError) {
          console.log('⚠️ Could not add foreign key constraint:', fkError.message);
        }
        
        // Add index for better performance
        try {
          await connection.query('CREATE INDEX idx_jobs_team_member_id ON jobs(team_member_id)');
          console.log('✅ Added index for team_member_id');
        } catch (indexError) {
          console.log('⚠️ Could not add index:', indexError.message);
        }
      } else {
        console.log('✅ team_member_id column already exists');
      }
      
      // Show table structure
      const [columns] = await connection.query('DESCRIBE jobs');
      console.log('📋 Jobs table structure:', columns.map(c => c.Field));
      
      res.json({
        success: true,
        message: 'Jobs team member migration completed successfully',
        jobsColumns: columns.map(c => c.Field)
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('❌ Jobs team member migration error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Database migration endpoint for team member skills
app.post('/api/migrate/team-member-skills', async (req, res) => {
  try {
    console.log('🔧 Adding skills column to team_members table...');
    
    const connection = await pool.getConnection();
    
    try {
      // Check if skills column exists
      const [columnCheck] = await connection.query(`
        SELECT COUNT(*) as count
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = 'team_members' 
        AND COLUMN_NAME = 'skills'
      `);
      
      if (columnCheck[0].count === 0) {
        // Add skills column to team_members table
        await connection.query('ALTER TABLE team_members ADD COLUMN skills JSON NULL');
        console.log('✅ Added skills column to team_members table');
        
        // Update existing team members with sample skills
        await connection.query(`
          UPDATE team_members SET skills = JSON_ARRAY(
            JSON_OBJECT('name', 'Regular Cleaning', 'level', 'Expert'),
            JSON_OBJECT('name', 'Deep Cleaning', 'level', 'Advanced'),
            JSON_OBJECT('name', 'Window Cleaning', 'level', 'Intermediate')
          ) WHERE skills IS NULL
        `);
        console.log('✅ Updated existing team members with sample skills');
      } else {
        console.log('✅ Skills column already exists');
      }
      
      // Show table structure
      const [columns] = await connection.query('DESCRIBE team_members');
      console.log('📋 Team members table structure:', columns.map(c => c.Field));
      
      res.json({
        success: true,
        message: 'Team member skills migration completed successfully',
        teamMemberColumns: columns.map(c => c.Field)
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('❌ Team member skills migration error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Database migration endpoint for team member territories
app.post('/api/migrate/team-member-territories', async (req, res) => {
  try {
    console.log('🔧 Adding territories column to team_members table...');
    
    const connection = await pool.getConnection();
    
    try {
      // Check if territories column exists
      const [columnCheck] = await connection.query(`
        SELECT COUNT(*) as count
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = 'team_members' 
        AND COLUMN_NAME = 'territories'
      `);
      
      if (columnCheck[0].count === 0) {
        // Add territories column to team_members table
        await connection.query('ALTER TABLE team_members ADD COLUMN territories JSON NULL');
        console.log('✅ Added territories column to team_members table');
        
        // Assign territory 1 to team member 3 (Mike Davis) for testing
        await connection.query(`
          UPDATE team_members SET territories = JSON_ARRAY(1) WHERE id = 3
        `);
        console.log('✅ Assigned territory 1 to team member 3 for testing');
      } else {
        console.log('✅ Territories column already exists');
      }
      
      // Show table structure
      const [columns] = await connection.query('DESCRIBE team_members');
      console.log('📋 Team members table structure:', columns.map(c => c.Field));
      
      res.json({
        success: true,
        message: 'Team member territories migration completed successfully',
        teamMemberColumns: columns.map(c => c.Field)
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('❌ Team member territories migration error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Manual endpoint to add territories column for testing
app.post('/api/test/add-territories-column', async (req, res) => {
  try {
    console.log('🔧 Manually adding territories column for testing...');
    
    const connection = await pool.getConnection();
    
    try {
      // Add territories column to team_members table
      await connection.query('ALTER TABLE team_members ADD COLUMN IF NOT EXISTS territories JSON NULL');
      console.log('✅ Added territories column to team_members table');
      
      // Assign territory 1 to team member 3 (Mike Davis) for testing
      await connection.query(`
        UPDATE team_members SET territories = JSON_ARRAY(1) WHERE id = 3
      `);
      console.log('✅ Assigned territory 1 to team member 3 for testing');
      
      // Verify the update
      const [result] = await connection.query(`
        SELECT id, first_name, last_name, territories FROM team_members WHERE id = 3
      `);
      console.log('✅ Verification result:', result[0]);
      
      res.json({
        success: true,
        message: 'Territories column added and test data assigned',
        teamMember: result[0]
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('❌ Add territories column error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Debug endpoint to test database connections
app.get('/api/debug/database', async (req, res) => {
  try {
    console.log('🔍 Database debug requested');
    const connection = await pool.getConnection();
    
    try {
      // Test basic connection
      const [result] = await connection.query('SELECT 1 as test');
      console.log('✅ Database connection successful');
      
      // Test all tables
      const tables = ['jobs', 'team_members', 'customers', 'services', 'users'];
      const tableStatus = {};
      
      for (const table of tables) {
        try {
          const [tableResult] = await connection.query(`SELECT COUNT(*) as count FROM ${table} LIMIT 1`);
          tableStatus[table] = { exists: true, count: tableResult[0].count };
          console.log(`✅ ${table} table exists with ${tableResult[0].count} records`);
        } catch (error) {
          tableStatus[table] = { exists: false, error: error.message };
          console.log(`❌ ${table} table error:`, error.message);
        }
      }
      
      // Test team_member_notifications table specifically
      try {
        const [notificationsResult] = await connection.query('SELECT COUNT(*) as count FROM team_member_notifications LIMIT 1');
        tableStatus.team_member_notifications = { exists: true, count: notificationsResult[0].count };
        console.log(`✅ team_member_notifications table exists with ${notificationsResult[0].count} records`);
      } catch (error) {
        tableStatus.team_member_notifications = { exists: false, error: error.message };
        console.log(`❌ team_member_notifications table error:`, error.message);
      }
      
      res.json({
        success: true,
        database: 'connected',
        tables: tableStatus
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('❌ Database debug error:', error);
    res.status(500).json({ 
      error: error.message,
      stack: error.stack 
    });
  }
});

// Test jobs structure endpoint
app.get('/api/test/jobs-structure', async (req, res) => {
  try {
    const connection = await pool.getConnection();
    try {
      const [columns] = await connection.query('DESCRIBE jobs');
      const [customerColumns] = await connection.query('DESCRIBE customers');
      const [serviceColumns] = await connection.query('DESCRIBE services');
      
      res.json({
        success: true,
        jobsColumns: columns.map(c => c.Field),
        customerColumns: customerColumns.map(c => c.Field),
        serviceColumns: serviceColumns.map(c => c.Field)
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('❌ Test jobs structure error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Add sample jobs for testing
app.post('/api/test/add-sample-jobs', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    const connection = await pool.getConnection();
    try {
      // First, ensure we have some customers and services
      const [customers] = await connection.query('SELECT id FROM customers WHERE user_id = ? LIMIT 3', [userId]);
      const [services] = await connection.query('SELECT id FROM services WHERE user_id = ? LIMIT 2', [userId]);
      
      if (customers.length === 0 || services.length === 0) {
        return res.status(400).json({ error: 'Please create at least one customer and one service first' });
      }

      const sampleJobs = [
        {
          user_id: userId,
          customer_id: customers[0].id,
          service_id: services[0].id,
          scheduled_date: new Date(Date.now() + 24 * 60 * 60 * 1000), // Tomorrow
          status: 'pending',
          total_amount: 150.00,
          invoice_status: 'unpaid',
          notes: 'Customer requested extra attention to kitchen area',
          created_at: new Date()
        },
        {
          user_id: userId,
          customer_id: customers[0].id,
          service_id: services[0].id,
          scheduled_date: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000), // Day after tomorrow
          status: 'confirmed',
          total_amount: 200.00,
          invoice_status: 'invoiced',
          notes: 'Deep cleaning service with window cleaning',
          created_at: new Date()
        },
        {
          user_id: userId,
          customer_id: customers[0].id,
          service_id: services[0].id,
          scheduled_date: new Date(Date.now() - 24 * 60 * 60 * 1000), // Yesterday
          status: 'completed',
          total_amount: 175.00,
          invoice_status: 'paid',
          notes: 'Regular cleaning completed successfully',
          created_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
        }
      ];

      for (const job of sampleJobs) {
        await connection.query(`
          INSERT INTO jobs (user_id, customer_id, service_id, scheduled_date, status, total_amount, invoice_status, notes, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [job.user_id, job.customer_id, job.service_id, job.scheduled_date, job.status, job.total_amount, job.invoice_status, job.notes, job.created_at]);
      }

      res.json({
        success: true,
        message: 'Sample jobs added successfully',
        jobsAdded: sampleJobs.length
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('❌ Add sample jobs error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Test endpoint to verify server is running latest code
app.get('/api/test-branding', (req, res) => {
  res.json({ message: 'Branding endpoints are available', timestamp: new Date().toISOString() });
});

// Logo upload endpoint
app.post('/api/upload/logo', upload.single('logo'), async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No logo file provided' });
    }

    // Generate unique filename
    const timestamp = Date.now();
    const filename = `logo-${userId}-${timestamp}-${req.file.originalname}`;
    const logoUrl = `https://zenbookapi.now2code.online/uploads/${filename}`;
    
    // Move uploaded file to uploads directory with the new filename
    const fs = require('fs');
    const path = require('path');
    const uploadsDir = path.join(__dirname, 'uploads');
    const newFilePath = path.join(uploadsDir, filename);
    
    // Ensure uploads directory exists
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
    
    // Move the uploaded file to the uploads directory
    fs.renameSync(req.file.path, newFilePath);

    // Save file info to database
    const connection = await pool.getConnection();
    
    try {
      // Update user_branding table with logo URL
      await connection.query(`
        INSERT INTO user_branding (user_id, logo_url, show_logo_in_admin, primary_color)
        VALUES (?, ?, 0, '#4CAF50')
        ON DUPLICATE KEY UPDATE logo_url = ?
      `, [userId, logoUrl, logoUrl]);

      res.json({ 
        message: 'Logo uploaded successfully',
        logoUrl: logoUrl
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error uploading logo:', error);
    res.status(500).json({ error: 'Failed to upload logo' });
  }
});

// Profile picture upload endpoint
app.post('/api/upload/profile-picture', upload.single('profilePicture'), async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No profile picture file provided' });
    }

    // Generate unique filename
    const timestamp = Date.now();
    const filename = `profile-${userId}-${timestamp}-${req.file.originalname}`;
    const profilePictureUrl = `https://zenbookapi.now2code.online/uploads/${filename}`;
    
    // Move uploaded file to uploads directory with the new filename
    const fs = require('fs');
    const path = require('path');
    const uploadsDir = path.join(__dirname, 'uploads');
    const newFilePath = path.join(uploadsDir, filename);
    
    // Ensure uploads directory exists
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
    
    // Move the uploaded file to the uploads directory
    fs.renameSync(req.file.path, newFilePath);

    // Save file info to database
    const connection = await pool.getConnection();
    
    try {
      // Update users table with profile picture URL
      await connection.query(`
        UPDATE users SET profile_picture = ? WHERE id = ?
      `, [profilePictureUrl, userId]);

      res.json({ 
        message: 'Profile picture uploaded successfully',
        profilePictureUrl: profilePictureUrl
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error uploading profile picture:', error);
    res.status(500).json({ error: 'Failed to upload profile picture' });
  }
});

// Service image upload endpoint
app.post('/api/upload-service-image', authenticateToken, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image uploaded' });
    }

    // Generate unique filename
    const timestamp = Date.now();
    const randomString = Math.random().toString(36).substring(2, 15);
    const extension = path.extname(req.file.originalname);
    const filename = `service-image-${timestamp}-${randomString}${extension}`;

    const imageUrl = `https://zenbookapi.now2code.online/uploads/${filename}`;

    // Move uploaded file to uploads directory with the new filename
    const oldFilePath = req.file.path;
    const uploadsDir = path.join(__dirname, 'uploads');
    const newFilePath = path.join(uploadsDir, filename);

    // Ensure uploads directory exists
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    // Move the uploaded file to the uploads directory
    fs.renameSync(oldFilePath, newFilePath);

    res.json({
      success: true,
      imageUrl: imageUrl,
      message: 'Service image uploaded successfully'
    });
  } catch (error) {
    console.error('Error uploading service image:', error);
    res.status(500).json({ error: 'Failed to upload service image' });
  }
});

// Modifier image upload endpoint
app.post('/api/upload-modifier-image', authenticateToken, upload.single('image'), async (req, res) => {
  console.log('🔍 Modifier image upload endpoint called');
  console.log('🔍 Request file:', req.file);
  console.log('🔍 Request body:', req.body);
  
  try {
    if (!req.file) {
      console.log('❌ No file uploaded');
      return res.status(400).json({ error: 'No image uploaded' });
    }

    // Generate unique filename
    const timestamp = Date.now();
    const randomString = Math.random().toString(36).substring(2, 15);
    const extension = path.extname(req.file.originalname);
    const filename = `modifier-image-${timestamp}-${randomString}${extension}`;

    const imageUrl = `https://zenbookapi.now2code.online/uploads/${filename}`;

    // Move uploaded file to uploads directory with the new filename
    const oldFilePath = req.file.path;
    const uploadsDir = path.join(__dirname, 'uploads');
    const newFilePath = path.join(uploadsDir, filename);

    // Ensure uploads directory exists
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    // Move the uploaded file to the uploads directory
    fs.renameSync(oldFilePath, newFilePath);

    console.log('✅ Modifier image uploaded successfully:', imageUrl);
    res.json({
      success: true,
      imageUrl: imageUrl,
      message: 'Modifier image uploaded successfully'
    });
  } catch (error) {
    console.error('❌ Error uploading modifier image:', error);
    res.status(500).json({ error: 'Failed to upload modifier image' });
  }
});

// Intake image upload endpoint
app.post('/api/upload-intake-image', authenticateToken, upload.single('image'), async (req, res) => {
  console.log('🔍 Intake image upload endpoint called');
  console.log('🔍 Request file:', req.file);
  console.log('🔍 Request body:', req.body);
  
  try {
    if (!req.file) {
      console.log('❌ No file uploaded');
      return res.status(400).json({ error: 'No image uploaded' });
    }

    // Generate unique filename
    const timestamp = Date.now();
    const randomString = Math.random().toString(36).substring(2, 15);
    const extension = path.extname(req.file.originalname);
    const filename = `intake-image-${timestamp}-${randomString}${extension}`;

    const imageUrl = `https://zenbookapi.now2code.online/uploads/${filename}`;

    // Move uploaded file to uploads directory with the new filename
    const oldFilePath = req.file.path;
    const uploadsDir = path.join(__dirname, 'uploads');
    const newFilePath = path.join(uploadsDir, filename);

    // Ensure uploads directory exists
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    // Move the uploaded file to the uploads directory
    fs.renameSync(oldFilePath, newFilePath);

    console.log('✅ Intake image uploaded successfully:', imageUrl);
    res.json({
      success: true,
      imageUrl: imageUrl,
      message: 'Intake image uploaded successfully'
    });
  } catch (error) {
    console.error('❌ Error uploading intake image:', error);
    res.status(500).json({ error: 'Failed to upload intake image' });
  }
});

// Remove profile picture endpoint
app.delete('/api/user/profile-picture', async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    const connection = await pool.getConnection();
    
    try {
      // Remove profile picture URL from database
      await connection.query(`
        UPDATE users SET profile_picture = NULL WHERE id = ?
      `, [userId]);

      res.json({ 
        message: 'Profile picture removed successfully'
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error removing profile picture:', error);
    res.status(500).json({ error: 'Failed to remove profile picture' });
  }
});

// Update password endpoint
app.put('/api/user/password', async (req, res) => {
  try {
    console.log('🔍 PUT /api/user/password called with body:', req.body);
    const { userId, currentPassword, newPassword } = req.body;
    
    if (!userId || !currentPassword || !newPassword) {
      return res.status(400).json({ error: 'User ID, current password, and new password are required' });
    }

    const connection = await pool.getConnection();
    
    try {
      // Get current user to verify password
      const [userData] = await connection.query(`
        SELECT password FROM users WHERE id = ?
      `, [userId]);

      if (userData.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Verify current password (you'll need to implement password hashing)
      // For now, we'll assume the password is stored as-is (not recommended for production)
      if (userData[0].password !== currentPassword) {
        return res.status(400).json({ error: 'Current password is incorrect' });
      }

      // Update password
      await connection.query(`
        UPDATE users SET password = ?, updated_at = NOW() WHERE id = ?
      `, [newPassword, userId]);

      console.log('🔍 Password updated successfully');
      res.json({ 
        message: 'Password updated successfully'
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error updating password:', error);
    res.status(500).json({ error: 'Failed to update password' });
  }
});

// Update email endpoint
app.put('/api/user/email', async (req, res) => {
  try {
    console.log('🔍 PUT /api/user/email called with body:', req.body);
    const { userId, newEmail, password } = req.body;
    
    if (!userId || !newEmail || !password) {
      return res.status(400).json({ error: 'User ID, new email, and password are required' });
    }

    const connection = await pool.getConnection();
    
    try {
      // Get current user to verify password
      const [userData] = await connection.query(`
        SELECT password FROM users WHERE id = ?
      `, [userId]);

      if (userData.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Verify password
      if (userData[0].password !== password) {
        return res.status(400).json({ error: 'Password is incorrect' });
      }

      // Check if email already exists
      const [existingEmail] = await connection.query(`
        SELECT id FROM users WHERE email = ? AND id != ?
      `, [newEmail, userId]);

      if (existingEmail.length > 0) {
        return res.status(400).json({ error: 'Email already exists' });
      }

      // Update email
      await connection.query(`
        UPDATE users SET email = ?, updated_at = NOW() WHERE id = ?
      `, [newEmail, userId]);

      console.log('🔍 Email updated successfully');
      res.json({ 
        message: 'Email updated successfully',
        email: newEmail
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error updating email:', error);
    res.status(500).json({ error: 'Failed to update email' });
  }
});

// Branding API endpoints
app.get('/api/user/branding', async (req, res) => {
  try {
    console.log('🔍 GET /api/user/branding called with query:', req.query);
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    const connection = await pool.getConnection();
    
    try {
      // Get branding settings for the user
      console.log('🔍 Querying user_branding table for userId:', userId);
      const [brandingData] = await connection.query(`
        SELECT 
          logo_url as logo,
          show_logo_in_admin as showLogoInAdmin,
          primary_color as primaryColor
        FROM user_branding 
        WHERE user_id = ?
      `, [userId]);

      console.log('🔍 Branding data found:', brandingData);
      if (brandingData.length > 0) {
        const branding = brandingData[0];
        // Ensure logo URL is complete
        if (branding.logo && !branding.logo.startsWith('http')) {
          branding.logo = `https://zenbookapi.now2code.online${branding.logo}`;
        }
        res.json(branding);
      } else {
        // Return default branding if none exists
        console.log('🔍 No branding data found, returning defaults');
        res.json({
          logo: null,
          showLogoInAdmin: false,
          primaryColor: "#4CAF50"
        });
      }
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching branding:', error);
    res.status(500).json({ error: 'Failed to fetch branding settings' });
  }
});

app.put('/api/user/branding', async (req, res) => {
  try {
    console.log('🔍 PUT /api/user/branding called with body:', req.body);
    const { userId, logo, showLogoInAdmin, primaryColor } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    const connection = await pool.getConnection();
    
    try {
      // Check if branding record exists
      console.log('🔍 Checking if branding record exists for userId:', userId);
      const [existing] = await connection.query(`
        SELECT id FROM user_branding WHERE user_id = ?
      `, [userId]);

      console.log('🔍 Existing branding records:', existing);
      if (existing.length > 0) {
        // Update existing record
        console.log('🔍 Updating existing branding record');
        await connection.query(`
          UPDATE user_branding 
          SET 
            logo_url = ?,
            show_logo_in_admin = ?,
            primary_color = ?,
            updated_at = NOW()
          WHERE user_id = ?
        `, [logo, showLogoInAdmin ? 1 : 0, primaryColor, userId]);
        console.log('🔍 Branding record updated successfully');
      } else {
        // Create new record
        console.log('🔍 Creating new branding record');
        await connection.query(`
          INSERT INTO user_branding (user_id, logo_url, show_logo_in_admin, primary_color)
          VALUES (?, ?, ?, ?)
        `, [userId, logo, showLogoInAdmin ? 1 : 0, primaryColor]);
        console.log('🔍 Branding record created successfully');
      }

      res.json({ 
        message: 'Branding settings updated successfully',
        branding: {
          logo,
          showLogoInAdmin,
          primaryColor
        }
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error updating branding:', error);
    res.status(500).json({ error: 'Failed to update branding settings' });
  }
});

// User Profile API endpoints
app.get('/api/user/profile', async (req, res) => {
  try {
    console.log('🔍 GET /api/user/profile called with query:', req.query);
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    const connection = await pool.getConnection();
    
    try {
      // Get user profile data
      console.log('🔍 Querying users table for userId:', userId);
      const [userData] = await connection.query(`
        SELECT 
          id,
          first_name,
          last_name,
          email,
          phone,
          business_name,
          business_email,
          profile_picture,
          email_notifications,
          sms_notifications,
          created_at,
          updated_at
        FROM users 
        WHERE id = ?
      `, [userId]);

      console.log('🔍 User data found:', userData);
      if (userData.length > 0) {
        const user = userData[0];
        // Ensure profile picture URL is complete
        if (user.profile_picture && !user.profile_picture.startsWith('http')) {
          user.profile_picture = `https://zenbookapi.now2code.online${user.profile_picture}`;
        }
        
        // Add both business name fields for consistency
        const responseData = {
          ...user,
          businessName: user.business_name, // Add camelCase version
          business_name: user.business_name // Keep snake_case version
        };
        
        res.json(responseData);
      } else {
        console.log('🔍 No user data found');
        res.status(404).json({ error: 'User not found' });
      }
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching user profile:', error);
    res.status(500).json({ error: 'Failed to fetch user profile' });
  }
});

app.put('/api/user/profile', async (req, res) => {
  try {
    console.log('🔍 PUT /api/user/profile called with body:', req.body);
    const { userId, firstName, lastName, email, phone, businessName, businessEmail, emailNotifications, smsNotifications } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    const connection = await pool.getConnection();
    
    try {
      // Update user profile
      console.log('🔍 Updating user profile for userId:', userId);
      await connection.query(`
        UPDATE users 
        SET 
          first_name = ?,
          last_name = ?,
          email = ?,
          phone = ?,
          business_name = ?,
          business_email = ?,
          email_notifications = ?,
          sms_notifications = ?,
          updated_at = NOW()
        WHERE id = ?
      `, [firstName, lastName, email, phone, businessName, businessEmail, emailNotifications ? 1 : 0, smsNotifications ? 1 : 0, userId]);

      console.log('🔍 User profile updated successfully');
      res.json({ 
        message: 'Profile updated successfully',
        profile: {
          firstName,
          lastName,
          email,
          phone,
          businessName,
          business_name: businessName, // Add both for consistency
          businessEmail,
          emailNotifications,
          smsNotifications
        }
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error updating user profile:', error);
    res.status(500).json({ error: 'Failed to update user profile' });
  }
});

// Notification Templates API endpoints
app.get('/api/user/notification-templates', async (req, res) => {
  try {
    console.log('🔍 GET /api/user/notification-templates called with query:', req.query);
    const { userId, templateType, notificationName } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    const connection = await pool.getConnection();
    
    try {
      let query = `
        SELECT 
          id,
          template_type,
          notification_name,
          subject,
          content,
          is_enabled,
          created_at,
          updated_at
        FROM notification_templates 
        WHERE user_id = ?
      `;
      let params = [userId];

      if (templateType) {
        query += ' AND template_type = ?';
        params.push(templateType);
      }

      if (notificationName) {
        query += ' AND notification_name = ?';
        params.push(notificationName);
      }

      query += ' ORDER BY notification_name, template_type';

      console.log('🔍 Querying notification templates for userId:', userId);
      const [templates] = await connection.query(query, params);

      console.log('🔍 Templates found:', templates.length);
      res.json(templates);
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching notification templates:', error);
    res.status(500).json({ error: 'Failed to fetch notification templates' });
  }
});

app.put('/api/user/notification-templates', async (req, res) => {
  try {
    console.log('🔍 PUT /api/user/notification-templates called with body:', req.body);
    const { userId, templateType, notificationName, subject, content, isEnabled } = req.body;
    
    if (!userId || !templateType || !notificationName) {
      return res.status(400).json({ error: 'User ID, template type, and notification name are required' });
    }

    const connection = await pool.getConnection();
    
    try {
      // Check if template exists
      const [existing] = await connection.query(`
        SELECT id FROM notification_templates 
        WHERE user_id = ? AND template_type = ? AND notification_name = ?
      `, [userId, templateType, notificationName]);

      if (existing.length > 0) {
        // Update existing template
        await connection.query(`
          UPDATE notification_templates 
          SET 
            subject = ?,
            content = ?,
            is_enabled = ?,
            updated_at = NOW()
          WHERE user_id = ? AND template_type = ? AND notification_name = ?
        `, [subject, content, isEnabled ? 1 : 0, userId, templateType, notificationName]);
      } else {
        // Create new template
        await connection.query(`
          INSERT INTO notification_templates (user_id, template_type, notification_name, subject, content, is_enabled)
          VALUES (?, ?, ?, ?, ?, ?)
        `, [userId, templateType, notificationName, subject, content, isEnabled ? 1 : 0]);
      }

      console.log('🔍 Notification template updated successfully');
      res.json({ 
        message: 'Notification template updated successfully'
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error updating notification template:', error);
    res.status(500).json({ error: 'Failed to update notification template' });
  }
});

// Notification Settings API endpoints
app.get('/api/user/notification-settings', async (req, res) => {
  try {
    console.log('🔍 GET /api/user/notification-settings called with query:', req.query);
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    const connection = await pool.getConnection();
    
    try {
      console.log('🔍 Querying notification settings for userId:', userId);
      const [settings] = await connection.query(`
        SELECT 
          notification_type,
          email_enabled,
          sms_enabled,
          push_enabled,
          created_at,
          updated_at
        FROM user_notification_settings 
        WHERE user_id = ?
        ORDER BY notification_type
      `, [userId]);

      console.log('🔍 Settings found:', settings.length);
      res.json(settings);
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching notification settings:', error);
    res.status(500).json({ error: 'Failed to fetch notification settings' });
  }
});

app.put('/api/user/notification-settings', async (req, res) => {
  try {
    console.log('🔍 PUT /api/user/notification-settings called with body:', req.body);
    const { userId, notificationType, emailEnabled, smsEnabled, pushEnabled } = req.body;
    
    if (!userId || !notificationType) {
      return res.status(400).json({ error: 'User ID and notification type are required' });
    }

    const connection = await pool.getConnection();
    
    try {
      // Check if setting exists
      const [existing] = await connection.query(`
        SELECT id FROM user_notification_settings 
        WHERE user_id = ? AND notification_type = ?
      `, [userId, notificationType]);

      if (existing.length > 0) {
        // Update existing setting
        await connection.query(`
          UPDATE user_notification_settings 
          SET 
            email_enabled = ?,
            sms_enabled = ?,
            push_enabled = ?,
            updated_at = NOW()
          WHERE user_id = ? AND notification_type = ?
        `, [emailEnabled ? 1 : 0, smsEnabled ? 1 : 0, pushEnabled ? 1 : 0, userId, notificationType]);
      } else {
        // Create new setting
        await connection.query(`
          INSERT INTO user_notification_settings (user_id, notification_type, email_enabled, sms_enabled, push_enabled)
          VALUES (?, ?, ?, ?, ?)
        `, [userId, notificationType, emailEnabled ? 1 : 0, smsEnabled ? 1 : 0, pushEnabled ? 1 : 0]);
      }

      console.log('🔍 Notification setting updated successfully');
      res.json({ 
        message: 'Notification setting updated successfully'
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error updating notification setting:', error);
    res.status(500).json({ error: 'Failed to update notification setting' });
  }
});
// Service Categories endpoints
app.get('/api/servi/categories', async (req, res) => {
  const { userId } = req.query;
  console.log('🔄 Categories request for user:', userId);

  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  let connection;
  try {
    connection = await pool.getConnection();

    // Directly query categories (assuming migration created table)
    const [categories] = await connection.query(`
      SELECT 
        c.id,
        c.name,
        c.description,
        c.color,
        c.created_at,
        c.updated_at,
        COUNT(s.id) as serviceCount
      FROM service_categories c
      LEFT JOIN services s 
        ON c.id = s.category_id 
       AND s.user_id = c.user_id
      WHERE c.user_id = ?
      GROUP BY c.id, c.name, c.description, c.color, c.created_at, c.updated_at
      ORDER BY c.name ASC
    `, [userId]);

    console.log('✅ Found categories:', categories.length, 'for user:', userId);

    res.json({ data: categories });
  } catch (error) {
    console.error('❌ Get categories error for user:', userId, error);
    res.status(500).json({ error: 'Failed to fetch categories' });
  } finally {
    if (connection) connection.release();
  }
});

app.post('/api/services/categories', async (req, res) => {
  try {
    const { userId, name, description, color } = req.body;
    
    console.log('Creating category with data:', { userId, name, description, color });
    
    // Validate required fields
    if (!userId || !name) {
      return res.status(400).json({ error: 'userId and name are required' });
    }
    
    const connection = await pool.getConnection();
    
    try {
      // Check if category name already exists for this user
      const [existing] = await connection.query(
        'SELECT id FROM service_categories WHERE user_id = ? AND name = ?',
        [userId, name]
      );
      
      if (existing.length > 0) {
        return res.status(400).json({ error: 'Category name already exists' });
      }
      
      const [result] = await connection.query(
        'INSERT INTO service_categories (user_id, name, description, color, created_at) VALUES (?, ?, ?, ?, NOW())',
        [userId, name, description || null, color || '#3B82F6']
      );
      
      // Get the created category
      const [categories] = await connection.query(
        'SELECT * FROM service_categories WHERE id = ?',
        [result.insertId]
      );
      
      if (categories.length === 0) {
        return res.status(500).json({ error: 'Failed to retrieve created category' });
      }
      
      res.status(201).json(categories[0]);
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Create category error:', error);
    res.status(500).json({ error: 'Failed to create category' });
  }
});

app.put('/api/services/categories/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, color } = req.body;
    
    console.log('🔄 Category update request for ID:', id);
    console.log('🔄 Request body:', req.body);
    
    const connection = await pool.getConnection();
    
    try {
      // Check if category exists
      const [existing] = await connection.query(
        'SELECT * FROM service_categories WHERE id = ?',
        [id]
      );
      
      if (existing.length === 0) {
        return res.status(404).json({ error: 'Category not found' });
      }
      
      // Check if new name conflicts with existing category (excluding current category)
      if (name && name !== existing[0].name) {
        const [nameConflict] = await connection.query(
          'SELECT id FROM service_categories WHERE user_id = ? AND name = ? AND id != ?',
          [existing[0].user_id, name, id]
        );
        
        if (nameConflict.length > 0) {
          return res.status(400).json({ error: 'Category name already exists' });
        }
      }
      
      // Build dynamic update query
      const updateFields = [];
      const updateParams = [];
      
      if (name !== undefined) {
        updateFields.push('name = ?');
        updateParams.push(name);
      }
      if (description !== undefined) {
        updateFields.push('description = ?');
        updateParams.push(description);
      }
      if (color !== undefined) {
        updateFields.push('color = ?');
        updateParams.push(color);
      }
      
      if (updateFields.length === 0) {
        return res.status(400).json({ error: 'No fields to update' });
      }
      
      updateFields.push('updated_at = NOW()');
      updateParams.push(id);
      
      const [result] = await connection.query(
        `UPDATE service_categories SET ${updateFields.join(', ')} WHERE id = ?`,
        updateParams
      );
      
      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Category not found' });
      }
      
      // Get the updated category
      const [categories] = await connection.query(
        'SELECT * FROM service_categories WHERE id = ?',
        [id]
      );
      
      res.json(categories[0]);
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Update category error:', error);
    res.status(500).json({ error: 'Failed to update category' });
  }
});

app.delete('/api/services/categories/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    console.log('🔄 Category delete request for ID:', id);
    
    const connection = await pool.getConnection();
    
    try {
      // Check if category exists
      const [existing] = await connection.query(
        'SELECT * FROM service_categories WHERE id = ?',
        [id]
      );
      
      if (existing.length === 0) {
        return res.status(404).json({ error: 'Category not found' });
      }
      
      // Check if any services are using this category
      const [servicesUsingCategory] = await connection.query(
        'SELECT COUNT(*) as count FROM services WHERE category_id = ?',
        [id]
      );
      
      if (servicesUsingCategory[0].count > 0) {
        // Instead of preventing deletion, set services to uncategorized
        console.log(`🔄 Setting ${servicesUsingCategory[0].count} services to uncategorized before deleting category`);
        await connection.query(
          'UPDATE services SET category_id = NULL WHERE category_id = ?',
          [id]
        );
      }
      
      // Delete the category
      const [result] = await connection.query(
        'DELETE FROM service_categories WHERE id = ?',
        [id]
      );
      
      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Category not found' });
      }
      
      // Create response message based on whether services were affected
      let message = 'Category deleted successfully';
      if (servicesUsingCategory[0].count > 0) {
        message = `Category deleted successfully. ${servicesUsingCategory[0].count} service(s) have been set to uncategorized.`;
      }
      
      res.json({ message });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Delete category error:', error);
    res.status(500).json({ error: 'Failed to delete category' });
  }
});
// Business Details API endpoints
app.get('/api/user/business-details', async (req, res) => {
  try {
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    const connection = await pool.getConnection();
    
    try {
      // Get business details from users table
      const [userData] = await connection.query(`
        SELECT 
          business_name,
          business_email,
          phone,
          email,
          first_name,
          last_name,
          business_slug
        FROM users 
        WHERE id = ?
      `, [userId]);

      if (userData.length > 0) {
        res.json({
          businessName: userData[0].business_name || '',
          businessEmail: userData[0].business_email || '',
          phone: userData[0].phone || '',
          email: userData[0].email || '',
          firstName: userData[0].first_name || '',
          lastName: userData[0].last_name || '',
          businessSlug: userData[0].business_slug || ''
        });
      } else {
        res.status(404).json({ error: 'User not found' });
      }
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching business details:', error);
    res.status(500).json({ error: 'Failed to fetch business details' });
  }
});

app.put('/api/user/business-details', async (req, res) => {
  try {
    const { userId, businessName, businessEmail, phone, email, firstName, lastName } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    const connection = await pool.getConnection();
    
    try {
      // Update business details in users table
      await connection.query(`
        UPDATE users 
        SET 
          business_name = ?,
          business_email = ?,
          phone = ?,
          email = ?,
          first_name = ?,
          last_name = ?,
          updated_at = NOW()
        WHERE id = ?
      `, [businessName, businessEmail, phone, email, firstName, lastName, userId]);

      res.json({ 
        message: 'Business details updated successfully',
        businessDetails: {
          businessName,
          businessEmail,
          phone,
          email,
          firstName,
          lastName
        }
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error updating business details:', error);
    res.status(500).json({ error: 'Failed to update business details' });
  }
});

// Initialize database schema on startup
const initializeDatabase = async () => {
  try {
    console.log('🔧 Initializing database schema...');
    const connection = await pool.getConnection();
    
    try {
      // Ensure the service_categories table exists
      await connection.query(`
        CREATE TABLE IF NOT EXISTS service_categories (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          name VARCHAR(100) NOT NULL,
          description TEXT,
          color VARCHAR(16) DEFAULT '#3B82F6',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY unique_name (user_id, name)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;`
      );
      console.log('✅ service_categories table created/verified');
      
      // Add intake_questions column to services table if it doesn't exist
      const [servicesColumnCheck] = await connection.query(`
        SELECT COUNT(*) as count
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = 'services' 
        AND COLUMN_NAME = 'intake_questions'
      `);
      
      if (servicesColumnCheck[0].count === 0) {
        await connection.query('ALTER TABLE services ADD COLUMN intake_questions JSON DEFAULT NULL');
        console.log('✅ Added intake_questions column to services table');
      } else {
        console.log('✅ intake_questions column already exists in services table');
      }

      // Add business_email column to users table if it doesn't exist
      const [businessEmailColumnCheck] = await connection.query(`
        SELECT COUNT(*) as count
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = 'users' 
        AND COLUMN_NAME = 'business_email'
      `);
      
      if (businessEmailColumnCheck[0].count === 0) {
        await connection.query('ALTER TABLE users ADD COLUMN business_email VARCHAR(255) DEFAULT NULL AFTER business_name');
        console.log('✅ Added business_email column to users table');
      } else {
        console.log('✅ business_email column already exists in users table');
      }
      
          // Create job_answers table if it doesn't exist
    await connection.query(`
      CREATE TABLE IF NOT EXISTS job_answers (
        id int(11) NOT NULL AUTO_INCREMENT,
        job_id int(11) NOT NULL,
        question_id varchar(255) NOT NULL COMMENT 'ID of the intake question',
        question_text text NOT NULL COMMENT 'The actual question text',
        question_type varchar(50) NOT NULL COMMENT 'Type of question (dropdown, multiple_choice, text, etc.)',
        answer text DEFAULT NULL COMMENT 'Customer answer to the question',
        created_at timestamp NOT NULL DEFAULT current_timestamp(),
        updated_at timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
        PRIMARY KEY (id),
        KEY idx_job_answers_job_id (job_id),
        KEY idx_job_answers_question_id (question_id),
        CONSTRAINT job_answers_ibfk_1 FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    // Create notification_templates table if it doesn't exist
    await connection.query(`
      CREATE TABLE IF NOT EXISTS notification_templates (
        id int(11) NOT NULL AUTO_INCREMENT,
        user_id int(11) NOT NULL,
        template_type enum('email','sms') NOT NULL,
        notification_name varchar(100) NOT NULL,
        subject varchar(255) DEFAULT NULL,
        content text NOT NULL,
        is_enabled tinyint(1) DEFAULT 1,
        created_at timestamp NOT NULL DEFAULT current_timestamp(),
        updated_at timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
        PRIMARY KEY (id),
        UNIQUE KEY user_template_type_name (user_id, template_type, notification_name),
        KEY idx_notification_templates_user_id (user_id),
        CONSTRAINT notification_templates_ibfk_1 FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    // Create job_team_assignments table if it doesn't exist
    await connection.query(`
      CREATE TABLE IF NOT EXISTS job_team_assignments (
        id int(11) NOT NULL AUTO_INCREMENT,
        job_id int(11) NOT NULL,
        team_member_id int(11) NOT NULL,
        is_primary tinyint(1) DEFAULT 0,
        assigned_at timestamp NOT NULL DEFAULT current_timestamp(),
        assigned_by int(11) NOT NULL,
        PRIMARY KEY (id),
        KEY idx_job_team_assignments_job_id (job_id),
        KEY idx_job_team_assignments_team_member_id (team_member_id),
        KEY idx_job_team_assignments_lookup (job_id, is_primary),
        CONSTRAINT job_team_assignments_ibfk_1 FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE CASCADE,
        CONSTRAINT job_team_assignments_ibfk_2 FOREIGN KEY (team_member_id) REFERENCES team_members (id) ON DELETE CASCADE,
        CONSTRAINT job_team_assignments_ibfk_3 FOREIGN KEY (assigned_by) REFERENCES users (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);
    console.log('✅ job_team_assignments table created/verified');

    // Create team_member_notifications table if it doesn't exist
    await connection.query(`
      CREATE TABLE IF NOT EXISTS team_member_notifications (
        id int(11) NOT NULL AUTO_INCREMENT,
        team_member_id int(11) NOT NULL,
        type enum('job_assigned','job_reminder','job_completed','system','payment') NOT NULL,
        title varchar(255) NOT NULL,
        message text NOT NULL,
        data longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(data)),
        is_read tinyint(1) DEFAULT 0,
        created_at timestamp NOT NULL DEFAULT current_timestamp(),
        PRIMARY KEY (id),
        KEY idx_team_member_notifications_team_member_id (team_member_id),
        CONSTRAINT team_member_notifications_ibfk_1 FOREIGN KEY (team_member_id) REFERENCES team_members (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);
    console.log('✅ team_member_notifications table created/verified');

    // Migrate existing team member assignments to job_team_assignments table
    try {
      const [existingAssignments] = await connection.query(`
        SELECT COUNT(*) as count FROM job_team_assignments
      `);
      
      if (existingAssignments[0].count === 0) {
        // Only migrate if the table is empty
        const [jobsWithTeamMembers] = await connection.query(`
          SELECT id, team_member_id, user_id 
          FROM jobs 
          WHERE team_member_id IS NOT NULL AND team_member_id != ''
        `);
        
        if (jobsWithTeamMembers.length > 0) {
          for (const job of jobsWithTeamMembers) {
            await connection.query(`
              INSERT INTO job_team_assignments (job_id, team_member_id, is_primary, assigned_by)
              VALUES (?, ?, 1, ?)
            `, [job.id, job.team_member_id, job.user_id]);
          }
          console.log(`✅ Migrated ${jobsWithTeamMembers.length} existing team member assignments`);
        }
      }
    } catch (migrationError) {
      console.log('⚠️ Team member assignment migration failed:', migrationError.message);
    }

    // Create user_notification_settings table if it doesn't exist
    await connection.query(`
      CREATE TABLE IF NOT EXISTS user_notification_settings (
        id int(11) NOT NULL AUTO_INCREMENT,
        user_id int(11) NOT NULL,
        notification_type varchar(50) NOT NULL,
        email_enabled tinyint(1) DEFAULT 1,
        sms_enabled tinyint(1) DEFAULT 0,
        push_enabled tinyint(1) DEFAULT 0,
        created_at timestamp NOT NULL DEFAULT current_timestamp(),
        updated_at timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
        PRIMARY KEY (id),
        UNIQUE KEY user_notification_type (user_id, notification_type),
        KEY idx_user_notification_settings_user_id (user_id),
        CONSTRAINT user_notification_settings_ibfk_1 FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);
      console.log('✅ job_answers table created/verified');
      console.log('✅ notification_templates table created/verified');
      console.log('✅ user_notification_settings table created/verified');
      
      // Insert default notification templates if they don't exist
      const defaultTemplates = [
        ['email', 'appointment_confirmation', 'Appointment Confirmed - {business_name}', 'Hi {customer_name},\n\nYour appointment has been confirmed for {appointment_date} at {appointment_time}.\n\nService: {service_name}\nLocation: {location}\n\nWe look forward to serving you!\n\nBest regards,\n{business_name}'],
        ['sms', 'appointment_confirmation', null, 'Hi {customer_name}, your appointment is confirmed for {appointment_date} at {appointment_time}. Service: {service_name}. Location: {location}. - {business_name}'],
        ['email', 'appointment_reminder', 'Appointment Reminder - {business_name}', 'Hi {customer_name},\n\nThis is a friendly reminder about your upcoming appointment:\n\nDate: {appointment_date}\nTime: {appointment_time}\nService: {service_name}\nLocation: {location}\n\nPlease let us know if you need to reschedule.\n\nBest regards,\n{business_name}'],
        ['sms', 'appointment_reminder', null, 'Reminder: Your appointment is tomorrow at {appointment_time}. Service: {service_name}. Location: {location}. - {business_name}'],
        ['email', 'appointment_cancelled', 'Appointment Cancelled - {business_name}', 'Hi {customer_name},\n\nYour appointment scheduled for {appointment_date} at {appointment_time} has been cancelled.\n\nService: {service_name}\n\nIf you have any questions, please contact us.\n\nBest regards,\n{business_name}'],
        ['sms', 'appointment_cancelled', null, 'Your appointment for {appointment_date} at {appointment_time} has been cancelled. Service: {service_name}. - {business_name}'],
        ['email', 'appointment_rescheduled', 'Appointment Rescheduled - {business_name}', 'Hi {customer_name},\n\nYour appointment has been rescheduled:\n\nNew Date: {new_appointment_date}\nNew Time: {new_appointment_time}\nService: {service_name}\nLocation: {location}\n\nWe apologize for any inconvenience.\n\nBest regards,\n{business_name}'],
        ['sms', 'appointment_rescheduled', null, 'Your appointment has been rescheduled to {new_appointment_date} at {new_appointment_time}. Service: {service_name}. - {business_name}'],
        ['email', 'enroute', 'We\'re On Our Way - {business_name}', 'Hi {customer_name},\n\nWe\'re on our way to your appointment!\n\nEstimated arrival: {eta}\nService: {service_name}\nLocation: {location}\n\nWe\'ll see you soon!\n\nBest regards,\n{business_name}'],
        ['sms', 'enroute', null, 'We\'re on our way! ETA: {eta}. Service: {service_name}. Location: {location}. - {business_name}'],
        ['email', 'job_follow_up', 'How Was Your Service? - {business_name}', 'Hi {customer_name},\n\nThank you for choosing {business_name} for your recent service.\n\nWe hope you were satisfied with our work. Please take a moment to rate your experience and provide feedback.\n\nService: {service_name}\nDate: {service_date}\n\nYour feedback helps us improve our services.\n\nBest regards,\n{business_name}'],
        ['email', 'payment_receipt', 'Payment Receipt - {business_name}', 'Hi {customer_name},\n\nThank you for your payment. Here is your receipt:\n\nService: {service_name}\nDate: {service_date}\nAmount: {amount}\nPayment Method: {payment_method}\n\nThank you for choosing {business_name}!\n\nBest regards,\n{business_name}'],
        ['email', 'invoice', 'Invoice - {business_name}', 'Hi {customer_name},\n\nPlease find attached your invoice for the following service:\n\nService: {service_name}\nDate: {service_date}\nAmount: {amount}\n\nPlease pay by {due_date}.\n\nThank you,\n{business_name}'],
        ['email', 'estimate', 'Your Estimate is Ready - {business_name}', 'Hi {customer_name},\n\nYour estimate is ready!\n\nService: {service_name}\nEstimated Amount: {estimated_amount}\n\nPlease review the details and let us know if you\'d like to proceed with the booking.\n\nBest regards,\n{business_name}'],
        ['sms', 'estimate', null, 'Your estimate is ready! Service: {service_name}. Amount: {estimated_amount}. - {business_name}'],
        ['email', 'quote_request_processing', 'Quote Request Received - {business_name}', 'Hi {customer_name},\n\nThank you for your quote request. We have received your inquiry and will review it carefully.\n\nWe\'ll get back to you within 24 hours with a detailed quote.\n\nBest regards,\n{business_name}'],
        ['email', 'booking_request_acknowledgment', 'Booking Request Received - {business_name}', 'Hi {customer_name},\n\nThank you for your booking request. We have received your inquiry and will confirm your appointment shortly.\n\nWe\'ll contact you within 2 hours to confirm the details.\n\nBest regards,\n{business_name}'],
        ['email', 'recurring_booking_cancelled', 'Recurring Booking Cancelled - {business_name}', 'Hi {customer_name},\n\nYour recurring booking has been cancelled as requested.\n\nService: {service_name}\n\nIf you need to reschedule or have any questions, please contact us.\n\nBest regards,\n{business_name}'],
        ['sms', 'recurring_booking_cancelled', null, 'Your recurring booking has been cancelled. Service: {service_name}. - {business_name}'],
        ['email', 'contact_customer', 'Message from {business_name}', 'Hi {customer_name},\n\n{message_content}\n\nBest regards,\n{business_name}'],
        ['email', 'team_member_invite', 'Welcome to {business_name} Team', 'Hi {team_member_name},\n\nWelcome to the {business_name} team!\n\nYour account has been created. Please click the link below to set up your password and complete your profile:\n\n{invite_link}\n\nIf you have any questions, please contact us.\n\nBest regards,\n{business_name}'],
        ['email', 'assigned_job_cancelled', 'Job Assignment Cancelled - {business_name}', 'Hi {team_member_name},\n\nThe job you were assigned to has been cancelled:\n\nJob: {job_title}\nCustomer: {customer_name}\nDate: {job_date}\nTime: {job_time}\n\nYou are no longer assigned to this job.\n\nBest regards,\n{business_name}'],
        ['email', 'assigned_job_rescheduled', 'Job Assignment Rescheduled - {business_name}', 'Hi {team_member_name},\n\nThe job you were assigned to has been rescheduled:\n\nJob: {job_title}\nCustomer: {customer_name}\nNew Date: {new_job_date}\nNew Time: {new_job_time}\n\nPlease update your schedule accordingly.\n\nBest regards,\n{business_name}']
      ];

      for (const [templateType, notificationName, subject, content] of defaultTemplates) {
        await connection.query(`
          INSERT IGNORE INTO notification_templates (user_id, template_type, notification_name, subject, content, is_enabled)
          VALUES (1, ?, ?, ?, ?, 1)
        `, [templateType, notificationName, subject, content]);
      }

      // Insert default notification settings if they don't exist
      const defaultSettings = [
        ['appointment_confirmation', 1, 1, 0],
        ['appointment_reminder', 1, 1, 0],
        ['appointment_cancelled', 1, 1, 0],
        ['appointment_rescheduled', 1, 1, 0],
        ['enroute', 0, 1, 0],
        ['job_follow_up', 1, 0, 0],
        ['payment_receipt', 1, 0, 0],
        ['invoice', 1, 0, 0],
        ['estimate', 1, 1, 0],
        ['quote_request_processing', 1, 0, 0],
        ['booking_request_acknowledgment', 1, 0, 0],
        ['recurring_booking_cancelled', 1, 1, 0],
        ['contact_customer', 1, 0, 0],
        ['team_member_invite', 1, 0, 0],
        ['assigned_job_cancelled', 1, 1, 1],
        ['assigned_job_rescheduled', 1, 1, 1]
      ];

      for (const [notificationType, emailEnabled, smsEnabled, pushEnabled] of defaultSettings) {
        await connection.query(`
          INSERT IGNORE INTO user_notification_settings (user_id, notification_type, email_enabled, sms_enabled, push_enabled)
          VALUES (1, ?, ?, ?, ?)
        `, [notificationType, emailEnabled, smsEnabled, pushEnabled]);
      }
      
      console.log('✅ Database schema initialization complete');
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('❌ Database initialization error:', error);
  }
};
// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Global error handler caught:', err);
  console.error('Error stack:', err.stack);
  console.error('Request URL:', req.url);
  console.error('Request method:', req.method);
  console.error('Request headers:', req.headers);
  
  // Handle CORS errors specifically
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({
      error: 'CORS Error',
      message: 'Cross-origin request not allowed',
      details: 'The request origin is not in the allowed list'
    });
  }
  
  // Handle JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      error: 'Authentication Error',
      message: 'Invalid token provided'
    });
  }
  
  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({
      error: 'Authentication Error',
      message: 'Token has expired'
    });
  }
  
  // Default error response
  res.status(500).json({
    error: 'Internal Server Error',
    message: 'Something went wrong on the server',
    ...(process.env.NODE_ENV === 'development' && { details: err.message })
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});
// Start server
app.listen(PORT, async () => {
  console.log(`ZenBooker API server running on port ${PORT}`);
  console.log(`Health check: http://127.0.0.1:${PORT}/api/health`);
  console.log('🔍 Branding endpoints registered: /api/user/branding (GET, PUT)');
  console.log('🔍 Test endpoint available: /api/test-branding');
  
  // Initialize database schema
  await initializeDatabase();
});

// Fix database schema endpoint
app.post('/api/fix-schema', async (req, res) => {
  try {
    console.log('🔧 Fixing database schema...');
    
    const connection = await pool.getConnection();
    
    try {
      // Check if team_member_id column exists
      const [columnCheck] = await connection.query(`
        SELECT COUNT(*) as count
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = 'jobs' 
        AND COLUMN_NAME = 'team_member_id'
      `);
      
      if (columnCheck[0].count === 0) {
        // Add team_member_id column to jobs table
        await connection.query('ALTER TABLE jobs ADD COLUMN team_member_id INT NULL');
        console.log('✅ Added team_member_id column to jobs table');
      } else {
        console.log('✅ team_member_id column already exists');
      }
      
      // Check if index exists
      const [indexCheck] = await connection.query(`
        SELECT COUNT(*) as count
        FROM INFORMATION_SCHEMA.STATISTICS 
        WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = 'jobs' 
        AND INDEX_NAME = 'idx_jobs_team_member_id'
      `);
      
      if (indexCheck[0].count === 0) {
        // Add index for better performance
        await connection.query('CREATE INDEX idx_jobs_team_member_id ON jobs(team_member_id)');
        console.log('✅ Added index for team_member_id');
      } else {
        console.log('✅ Index already exists');
      }
      
      // Check if intake_questions column exists in services table
      const [servicesColumnCheck] = await connection.query(`
        SELECT COUNT(*) as count
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = 'services' 
        AND COLUMN_NAME = 'intake_questions'
      `);
      
      if (servicesColumnCheck[0].count === 0) {
        // Add intake_questions column to services table
        await connection.query('ALTER TABLE services ADD COLUMN intake_questions JSON DEFAULT NULL');
        console.log('✅ Added intake_questions column to services table');
      } else {
        console.log('✅ intake_questions column already exists in services table');
      }
      
      // Show table structure
      const [columns] = await connection.query('DESCRIBE jobs');
      const [servicesColumns] = await connection.query('DESCRIBE services');
      console.log('📋 Jobs table structure:', columns.map(c => c.Field));
      console.log('📋 Services table structure:', servicesColumns.map(c => c.Field));
      
      res.json({
        success: true,
        message: 'Database schema updated successfully',
        jobsColumns: columns.map(c => c.Field),
        servicesColumns: servicesColumns.map(c => c.Field)
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('❌ Schema fix error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Test team member endpoint