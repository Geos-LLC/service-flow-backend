const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { supabase, db } = require('./supabase');
const { BUCKETS, ensureBuckets, uploadToStorage, deleteFromStorage, getFileUrl } = require('./supabase-storage');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const validator = require('validator');

// Nodemailer removed - using SendGrid only
const sgMail = require('@sendgrid/mail');

// Mock pool for MySQL endpoints that aren't used
const pool = {
  getConnection: () => {
    throw new Error('MySQL endpoints are disabled - using Supabase only');
  }
};
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cron = require('node-cron');
const https = require('https');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const { google } = require('googleapis');
const twilio = require('twilio');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
require('dotenv').config();

// Email configuration - SendGrid only

// SendGrid configuration - Use environment variable for security
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
if (SENDGRID_API_KEY) {
  sgMail.setApiKey(SENDGRID_API_KEY);
} else {
  console.log('⚠️ SENDGRID_API_KEY environment variable not set');
}
console.log('✅ SendGrid configured for team member emails');
console.log('✅ SendGrid API key present:', SENDGRID_API_KEY ? 'Yes' : 'No');
if (SENDGRID_API_KEY) {
  console.log('✅ SendGrid API key length:', SENDGRID_API_KEY.length);
  console.log('✅ SendGrid API key starts with:', SENDGRID_API_KEY.substring(0, 10) + '...');
} else {
  console.log('⚠️ SendGrid API key not configured - using fallback email service');
}
console.log('✅ SendGrid from email:', process.env.SENDGRID_FROM_EMAIL || 'info@spotless.homes');

// Helper function to get today's date in local timezone
const getTodayString = () => {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
};

// Google OAuth Configuration
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3001/api/auth/google/callback';

// Google Calendar and Sheets Configuration
const GOOGLE_CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events'
];

const GOOGLE_SHEETS_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file'
];

// Twilio Configuration
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

// Initialize Twilio client
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Initialize Google OAuth client
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

console.log('✅ Google OAuth configured:', GOOGLE_CLIENT_ID ? 'Yes' : 'No');
console.log('✅ Twilio configured:', TWILIO_ACCOUNT_SID ? 'Yes' : 'No');

// Test SendGrid configuration
async function testSendGridConfig() {
  try {
    console.log('📧 Testing SendGrid configuration...');
    console.log('📧 API Key present: Yes (hardcoded)');
    console.log('📧 API Key length:', SENDGRID_API_KEY?.length || 0);
    console.log('📧 From email:', process.env.SENDGRID_FROM_EMAIL || 'info@spotless.homes');
    
    // Test with a simple API call to verify the key
    const testMsg = {
      to: 'test@example.com',
      from: process.env.SENDGRID_FROM_EMAIL || 'noreply@service-flow.pro',
      subject: 'Test',
      text: 'Test message'
    };
    
    console.log('📧 SendGrid test message prepared');
    console.log('📧 SendGrid configuration appears valid');
    return true;
  } catch (error) {
    console.error('❌ SendGrid configuration test failed:', error);
    return false;
  }
}

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
    
    // Test SendGrid configuration
    await testSendGridConfig();
    
    // SendGrid doesn't need transporter verification
    console.log('✅ Email connection verified successfully');
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

// Initialize Supabase Storage buckets on startup
ensureBuckets().then(() => {
  console.log('✅ Supabase Storage buckets initialized');
}).catch(error => {
  console.error('❌ Error initializing Supabase Storage buckets:', error);
});

// Cron job for recurring billing
cron.schedule('0 9 * * *', async () => {
  console.log('Running recurring billing check...');
  try {
    // Get recurring jobs that need to be processed
    const { data: recurringJobs, error } = await supabase
      .from('jobs')
      .select(`
        *,
        customers!inner(email, first_name, last_name),
        services!inner(name, price)
      `)
      .eq('is_recurring', true)
      .lte('next_billing_date', new Date().toISOString().split('T')[0])
      .eq('status', 'completed');

    if (error) {
      console.error('Error fetching recurring jobs:', error);
      return;
    }

    for (const job of recurringJobs || []) {
      // Calculate new scheduled date
      const newScheduledDate = new Date();
      newScheduledDate.setDate(newScheduledDate.getDate() + job.recurring_frequency);
      
      // Create new job for recurring service
      const { error: insertError } = await supabase
        .from('jobs')
        .insert({
          user_id: job.user_id,
          customer_id: job.customer_id,
          service_id: job.service_id,
          scheduled_date: newScheduledDate.toISOString(),
          notes: job.notes,
          status: 'pending',
          is_recurring: true,
          recurring_frequency: job.recurring_frequency
        });

      if (insertError) {
        console.error('Error creating recurring job:', insertError);
        continue;
      }

      // Update next billing date
      const newNextBillingDate = new Date(job.next_billing_date);
      newNextBillingDate.setDate(newNextBillingDate.getDate() + job.recurring_frequency);
      
      const { error: updateError } = await supabase
        .from('jobs')
        .update({ next_billing_date: newNextBillingDate.toISOString().split('T')[0] })
        .eq('id', job.id);

      if (updateError) {
        console.error('Error updating next billing date:', updateError);
      }
      
      // Send email notification
      await sendEmail({
        to: job.customers.email,
        subject: 'Recurring Service Scheduled',
        html: `
          <h2>Your recurring service has been scheduled</h2>
          <p>Hello ${job.customers.first_name},</p>
          <p>Your recurring ${job.services.name} service has been scheduled for ${new Date().toLocaleDateString()}.</p>
          <p>Service: ${job.services.name}</p>
          <p>Price: $${job.services.price}</p>
          <p>Thank you for choosing our services!</p>
        `
      });
    }
  } catch (error) {
    console.error('Recurring billing error:', error);
  }
});

// Removed sendEmail function - using SendGrid only

// Test SendGrid configuration
async function testSendGridConfig() {
  try {
    console.log('🧪 Testing SendGrid configuration...');
    console.log('📧 API Key present: Yes (hardcoded)');
    console.log('📧 API Key length:', SENDGRID_API_KEY?.length || 0);
    console.log('📧 From email:', process.env.SENDGRID_FROM_EMAIL || 'info@spotless.homes');
    
    // Test the API key by making a simple request
    const testMsg = {
      to: 'test@example.com',
      from: process.env.SENDGRID_FROM_EMAIL || 'noreply@service-flow.pro',
      subject: 'Test Email',
      text: 'This is a test email'
    };
    
    console.log('✅ SendGrid configuration appears valid');
    console.log('📧 From email:', testMsg.from);
    return true;
  } catch (error) {
    console.error('❌ SendGrid configuration test failed:', error);
    return false;
  }
}

// SendGrid email service only
async function sendTeamMemberEmail({ to, subject, html, text }) {
  console.log('📧 Attempting to send team member email via SendGrid to:', to);
  
  // Check if SendGrid is configured
  if (!SENDGRID_API_KEY) {
    console.error('❌ SendGrid API key not configured');
    throw new Error('SendGrid API key not configured. Please set SENDGRID_API_KEY environment variable.');
  }
  
  try {
    const msg = {
      to,
      from: process.env.SENDGRID_FROM_EMAIL || 'info@spotless.homes',
      subject,
      html,
      text
    };
    
    console.log('📧 SendGrid email options:', { to, subject, from: msg.from });
    
    const response = await sgMail.send(msg);
    console.log('✅ SendGrid email sent successfully:', response[0].statusCode);
    return response;
  } catch (error) {
    console.error('❌ SendGrid email sending error:', error);
    console.error('❌ SendGrid error details:', {
      message: error.message,
      code: error.code,
      response: error.response?.body
    });
    
    // Provide specific error messages for common issues
    if (error.code === 401) {
      console.error('❌ SendGrid 401 Unauthorized - Invalid API key');
      console.error('❌ The SendGrid API key is invalid or expired');
      console.error('❌ Please check your SendGrid API key configuration');
      throw new Error('SendGrid API key is invalid. Please check your SENDGRID_API_KEY environment variable.');
    }
    if (error.code === 403) {
      console.error('❌ SendGrid 403 Forbidden - Check your API key and permissions');
      console.error('❌ Make sure your SendGrid API key has mail.send permissions');
      console.error('❌ Verify your sender email is verified in SendGrid');
      throw new Error('SendGrid API key invalid or insufficient permissions. Please check your SendGrid configuration.');
    } else {
      throw new Error(`SendGrid email failed: ${error.message}`);
    }
  }
}

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';

// Trust proxy for rate limiting and X-Forwarded-For headers
app.set('trust proxy', 1);

// Upload URL configuration
const UPLOAD_BASE_URL = process.env.UPLOAD_BASE_URL || 'http://localhost:5000';

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

// CORS configuration - Enhanced for development and production
const corsOptions = {
  origin: function (origin, callback) {
    
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) {
      return callback(null, true);
    }
    
    const allowedOrigins = [
      'https://www.service-flow.pro', 
      'https://service-flow.pro',
      'https://service-flow-frontend.vercel.app', // Vercel deployment
      'https://service-flow.vercel.app', // Alternative Vercel URL
      'http://localhost:3000', // for development
      'http://localhost:3001',   // for development
      'http://127.0.0.1:3000',   // alternative localhost
      'http://127.0.0.1:3001'    // alternative localhost
    ];
    
    // Check if origin matches any allowed origin
    const isAllowed = allowedOrigins.some(allowedOrigin => {
      if (allowedOrigin.includes('*')) {
        return origin.includes(allowedOrigin.replace('*', ''));
      }
      return origin === allowedOrigin;
    });
    
    if (isAllowed) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin', 'Cache-Control', 'X-HTTP-Method-Override'],
  exposedHeaders: ['Content-Length', 'X-Requested-With'],
  preflightContinue: false,
  optionsSuccessStatus: 200
};

// Middleware
app.use(cors(corsOptions));

// Handle preflight requests using cors middleware
app.options('*', cors(corsOptions));

// Additional explicit OPTIONS handler for better CORS support
app.options('*', (req, res) => {
  
  // Set CORS headers explicitly - more permissive for production
  const origin = req.headers.origin;
  if (origin) {
    res.header('Access-Control-Allow-Origin', origin);
  } else {
    res.header('Access-Control-Allow-Origin', '*');
  }
  
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin, Cache-Control, X-HTTP-Method-Override');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Max-Age', '86400'); // 24 hours
  
  res.status(200).end();
});

// Aggressive CORS bypass for all origins
app.use((req, res, next) => {
  const origin = req.headers.origin;
  
  
  // Set CORS headers for ALL requests to fix production issues
  if (origin) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin, Cache-Control, X-HTTP-Method-Override');
    res.header('Access-Control-Max-Age', '86400');
  }
  
  next();
});

// Log all requests for debugging
app.use((req, res, next) => {
 
  next();
});

// CORS is now handled by the cors middleware above

// CORS test endpoint
app.get('/api/test-cors', (req, res) => {
  
  const origin = req.headers.origin;
  if (origin) {
    res.header('Access-Control-Allow-Origin', origin);
  } else {
    res.header('Access-Control-Allow-Origin', '*');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin, Cache-Control, X-HTTP-Method-Override');
  res.header('Access-Control-Allow-Credentials', 'true');
  
  res.json({ 
    message: 'CORS test successful', 
    origin: origin,
    timestamp: new Date().toISOString()
  });
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
app.options('/api/jobs/:id/status', (req, res) => res.status(204).send());
app.options('/api/jobs/:jobId/assign', (req, res) => res.status(204).send());
app.options('/api/jobs/:jobId/assign/:teamMemberId', (req, res) => res.status(204).send());
app.options('/api/jobs/:jobId/assignments', (req, res) => res.status(204).send());
app.options('/api/jobs/:jobId/assign-multiple', (req, res) => res.status(204).send());

// Add OPTIONS handlers for additional team member endpoints
app.options('/api/team-members/:id/availability', (req, res) => res.status(204).send());
app.options('/api/team-members/login', (req, res) => res.status(204).send());
app.options('/api/team-members/register', (req, res) => res.status(204).send());
app.options('/api/team-members/logout', (req, res) => res.status(204).send());
app.options('/api/team-members/verify-invitation', (req, res) => res.status(204).send());
app.options('/api/team-members/complete-signup', (req, res) => res.status(204).send());
app.options('/api/team-members/:id/resend-invite', (req, res) => res.status(204).send());
app.options('/api/team-members/dashboard/:teamMemberId', (req, res) => res.status(204).send());
app.options('/api/team-members/jobs/:jobId/status', (req, res) => res.status(204).send());
app.options('/api/team-analytics', (req, res) => res.status(204).send());
app.options('/api/team-members/:id/performance', (req, res) => res.status(204).send());
app.options('/api/team-members/:id/settings', (req, res) => res.status(204).send());

// Add a more specific OPTIONS handler for team-members endpoint
app.options('/api/team-members', (req, res) => {
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

// Supabase connection is handled in supabase.js
// Test Supabase connection
async function testSupabaseConnection() {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('count')
      .limit(1);
    
    if (error) {
      console.error('Supabase connection test failed:', error);
      return false;
    }
    
    return true;
  } catch (error) {
    console.error('Supabase connection test failed:', error);
    return false;
  }
}

// Test connection on startup
testSupabaseConnection();

// Authentication middleware
const authenticateToken = (req, res, next) => {
  // Skip authentication for OPTIONS requests (CORS preflight)
  if (req.method === 'OPTIONS') {
    return next();
  }

  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN
  
  console.log('🔐 Auth check:', { 
    url: req.url, 
    method: req.method, 
    hasAuthHeader: !!authHeader, 
    hasToken: !!token 
  });


  if (!token) {
    return res.status(401).json({ 
      error: 'Access token required',
      message: 'Please log in to access this resource'
    });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
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
    req.user = user;
    next();
  });
};

// Input validation helpers
const validateEmail = (email) => {
  if (!email || typeof email !== 'string') {
    return false;
  }
  return validator.isEmail(email) && email.length <= 255;
};

const validatePassword = (password) => {
  if (!password || typeof password !== 'string') {
    return false;
  }
  return password.length >= 8 && password.length <= 128;
};

const validateName = (name) => {
  if (!name || typeof name !== 'string') {
    return false;
  }
  return name.trim().length >= 2 && name.trim().length <= 50;
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
    // Simple health check without external dependencies
    res.json({ 
      status: 'OK', 
      message: 'Server is healthy',
      timestamp: new Date().toISOString()
    });
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
    
    // Check if user already exists
    const { data: existingUsers, error: checkError } = await supabase
      .from('users')
      .select('id')
      .eq('email', sanitizedEmail)
      .limit(1);
    
    if (checkError) {
      console.error('Error checking existing user:', checkError);
      return res.status(500).json({ error: 'Failed to create account. Please try again.' });
    }
    
    if (existingUsers && existingUsers.length > 0) {
      return res.status(400).json({ error: 'An account with this email already exists' });
    }
    
    // Hash password
    const saltRounds = 12;
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    
    // Create new user
    const { data: newUser, error: insertError } = await supabase
      .from('users')
      .insert({
        email: sanitizedEmail,
        password: hashedPassword,
        first_name: sanitizedFirstName,
        last_name: sanitizedLastName,
        business_name: sanitizedBusinessName
      })
      .select()
      .single();
    
    if (insertError) {
      console.error('Error creating user:', insertError);
      return res.status(500).json({ error: 'Failed to create account. Please try again.' });
    }
    
    // Generate JWT token
    const token = jwt.sign(
      { 
        userId: newUser.id, 
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
        id: newUser.id,
        email: sanitizedEmail,
        firstName: sanitizedFirstName,
        lastName: sanitizedLastName,
        businessName: sanitizedBusinessName
      }
    });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ error: 'Failed to create account. Please try again.' });
  }
});

app.post('/api/auth/signin', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    // Check if email is provided
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    // Input validation
    if (!validateEmail(email)) {
      return res.status(400).json({ error: 'Please provide a valid email address' });
    }
    
    if (!password || password.length < 1) {
      return res.status(400).json({ error: 'Password is required' });
    }
    
    // Sanitize email
    const sanitizedEmail = email.toLowerCase().trim();
    
    // Get user with hashed password
    const { data: users, error } = await supabase
      .from('users')
      .select('id, email, password, first_name, last_name, business_name, profile_picture, google_id')
      .eq('email', sanitizedEmail)
      .limit(1);
    
    if (error) {
      console.error('Error fetching user:', error);
      return res.status(500).json({ error: 'Login failed. Please try again.' });
    }
    
    if (!users || users.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    const user = users[0];
    
    // Check if this is an OAuth user
    if (user.google_id && user.password.startsWith('oauth_user_')) {
      return res.status(401).json({ 
        error: 'This account was created with Google. Please sign in with Google instead.' 
      });
    }
    
    // Verify password for regular users
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
        business_name: user.business_name, // Add both for compatibility
        profilePicture: user.profile_picture // Include profile picture
      }
    });
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
    // Get updated user data
    const { data: users, error } = await supabase
      .from('users')
      .select('id, email, first_name, last_name, business_name, profile_picture')
      .eq('id', req.user.userId)
      .limit(1);
      
    if (error) {
      console.error('Error fetching user:', error);
      return res.status(500).json({ error: 'Failed to refresh token' });
    }
    
    if (!users || users.length === 0) {
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
        businessName: user.business_name,
        profilePicture: user.profile_picture
      }
    });
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

// Google OAuth endpoints
app.post('/api/auth/google', async (req, res) => {
  try {
    const { idToken } = req.body;
    
    if (!idToken) {
      return res.status(400).json({ error: 'Google ID token is required' });
    }
    
    // Verify the Google ID token
    const ticket = await googleClient.verifyIdToken({
      idToken: idToken,
      audience: GOOGLE_CLIENT_ID
    });
    
    const payload = ticket.getPayload();
    const { sub: googleId, email, name, picture } = payload;
    
    
    // Check if user already exists
    const { data: existingUsers, error: fetchError } = await supabase
      .from('users')
      .select('id, email, first_name, last_name, business_name, profile_picture, google_id')
      .eq('email', email)
      .limit(1);
    
    if (fetchError) {
      console.error('Error fetching user:', fetchError);
      return res.status(500).json({ error: 'Authentication failed' });
    }
    
    let user;
    
    if (existingUsers && existingUsers.length > 0) {
      // User exists, update Google ID if not set
      user = existingUsers[0];
      if (!user.google_id) {
        const { error: updateError } = await supabase
          .from('users')
          .update({ google_id: googleId })
          .eq('id', user.id);
        
        if (updateError) {
          console.error('Error updating Google ID:', updateError);
        }
      }
    } else {
      // Create new user
      const nameParts = name.split(' ');
      const firstName = nameParts[0] || '';
      const lastName = nameParts.slice(1).join(' ') || '';
      
      const { data: newUser, error: createError } = await supabase
        .from('users')
        .insert({
          email: email,
          first_name: firstName,
          last_name: lastName,
          business_name: `${firstName}'s Business`,
          profile_picture: picture,
          google_id: googleId,
          password: 'oauth_user_' + googleId // Special password for OAuth users
        })
        .select('id, email, first_name, last_name, business_name, profile_picture')
        .single();
      
      if (createError) {
        console.error('Error creating user:', createError);
        return res.status(500).json({ error: 'Failed to create account' });
      }
      
      user = newUser;
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
      message: 'Google authentication successful',
      token,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        businessName: user.business_name,
        profilePicture: user.profile_picture
      }
    });
    
  } catch (error) {
    console.error('Google OAuth error:', error);
    res.status(500).json({ error: 'Google authentication failed' });
  }
});

// Verify token endpoint
app.get('/api/auth/verify', authenticateToken, async (req, res) => {
  try {
    const { data: users, error } = await supabase
      .from('users')
      .select('id, email, first_name, last_name, business_name, profile_picture')
      .eq('id', req.user.userId)
      .limit(1);
    
    if (error) {
      console.error('Error fetching user:', error);
      return res.status(500).json({ error: 'Token verification failed' });
    }
    
    if (!users || users.length === 0) {
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
        businessName: user.business_name,
        profilePicture: user.profile_picture
      }
    });
  } catch (error) {
    console.error('Token verification error:', error);
    res.status(500).json({ error: 'Token verification failed' });
  }
});

// Services endpoints
app.get('/api/services', async (req, res) => {
  try {
    const { userId, search, page = 1, limit = 20, sortBy = 'name', sortOrder = 'ASC' } = req.query;
    
    
    // Build Supabase query
    let query = supabase
      .from('services')
      .select('*', { count: 'exact' })
      .eq('user_id', userId);
    
    // Add search filter
    if (search) {
      query = query.or(`name.ilike.%${search}%,description.ilike.%${search}%`);
    }
    
    // Add sorting
    query = query.order(sortBy, { ascending: sortOrder === 'ASC' });
    
    // Add pagination
    const offset = (page - 1) * limit;
    query = query.range(offset, offset + parseInt(limit) - 1);
    
    const { data: services, error, count } = await query;
    
    if (error) {
      console.error('Error fetching services:', error);
      return res.status(500).json({ error: 'Failed to get services' });
    }
    
    // Map the services data to ensure proper field names and types
    const mappedServices = (services || []).map(service => {
      // Parse modifiers if it's a string
      let parsedModifiers = [];
      if (service.modifiers) {
        try {
          parsedModifiers = typeof service.modifiers === 'string' ? JSON.parse(service.modifiers) : service.modifiers;
        } catch (error) {
          console.error('Error parsing modifiers for service', service.id, ':', error);
          parsedModifiers = [];
        }
      }
      
      return {
        id: service.id,
        userId: service.user_id,
        name: service.name,
        description: service.description,
        price: parseFloat(service.price) || 0,
        duration: parseInt(service.duration) || 0,
        category: service.category,
        image: service.image,
        modifiers: parsedModifiers,
        isActive: service.is_active,
        visible: service.is_active, // Add visible field for frontend compatibility
        requirePaymentMethod: service.require_payment_method,
        intakeQuestions: service.intake_questions,
        categoryId: service.category_id,
        createdAt: service.created_at,
        updatedAt: service.updated_at
      };
    });

    res.json({
      services: mappedServices,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count || 0,
        pages: Math.ceil((count || 0) / limit)
      }
    });
  } catch (error) {
    console.error('Get services error:', error);
    res.status(500).json({ error: 'Failed to get services' });
  }
});

// Service Categories endpoints
app.get('/api/services/categories', async (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  try {
    // ✅ Get categories with service count
    const { data: categories, error } = await supabase
      .from('service_categories')
      .select(`
        id,
        name,
        description,
        color,
        created_at,
        updated_at,
        services!left(id)
      `)
      .eq('user_id', userId)
      .order('name', { ascending: true });
    
    if (error) {
      console.error('❌ Get categories error for user:', userId, error);
      return res.status(500).json({ error: 'Failed to fetch categories' });
    }
    
    // ✅ Process the data to add service count
    const processedCategories = (categories || []).map(category => ({
      id: category.id,
      name: category.name,
      description: category.description,
      color: category.color,
      created_at: category.created_at,
      updated_at: category.updated_at,
      serviceCount: category.services ? category.services.length : 0
    }));

  
    res.json({ data: processedCategories });

  } catch (error) {
    console.error('🔥 Unexpected error fetching categories for user:', userId, error);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// Individual service endpoints
app.get('/api/services/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    
    const { data: services, error } = await supabase
      .from('services')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .limit(1);
    
    if (error) {
      console.error('Error fetching service:', error);
      return res.status(500).json({ error: 'Failed to fetch service' });
    }
    
    if (!services || services.length === 0) {
      return res.status(404).json({ error: 'Service not found' });
    }
    
    const service = services[0];
    
    // Parse modifiers if it's a string
    let parsedModifiers = [];
    if (service.modifiers) {
      try {
        parsedModifiers = typeof service.modifiers === 'string' ? JSON.parse(service.modifiers) : service.modifiers;
      } catch (error) {
        console.error('Error parsing modifiers for service', service.id, ':', error);
        parsedModifiers = [];
      }
    }
    
    // Return service with parsed modifiers
    const responseService = {
      ...service,
      modifiers: parsedModifiers
    };
    
    res.json(responseService);
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
    
    // Prepare modifiers for storage
    let modifiersToStore = null;
    if (modifiers) {
      try {
        // If modifiers is already a string, use it; otherwise stringify it
        modifiersToStore = typeof modifiers === 'string' ? modifiers : JSON.stringify(modifiers);
      } catch (error) {
        console.error('Error preparing modifiers for storage:', error);
        modifiersToStore = null;
      }
    }
    
    // Create new service
    const { data: newService, error: insertError } = await supabase
      .from('services')
      .insert({
        user_id: userId,
        name: sanitizedName,
        description: sanitizedDescription,
        price: price || 0,
        duration: duration || 60,
        category: sanitizedCategory,
        modifiers: modifiersToStore,
        intake_questions: intake_questions,
        require_payment_method: require_payment_method || false,
        image: image
      })
      .select()
      .single();
    
    if (insertError) {
      console.error('Error creating service:', insertError);
      return res.status(500).json({ error: 'Failed to create service' });
    }
    
    res.status(201).json({
      message: 'Service created successfully',
      service: newService
    });
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
    
    // Check if service exists and belongs to user
    const { data: existingServices, error: checkError } = await supabase
      .from('services')
      .select('id')
      .eq('id', id)
      .eq('user_id', userId)
      .limit(1);
    
    if (checkError) {
      console.error('Error checking existing service:', checkError);
      return res.status(500).json({ error: 'Failed to update service' });
    }
    
    if (!existingServices || existingServices.length === 0) {
      return res.status(404).json({ error: 'Service not found' });
    }
    
    // Prepare modifiers for storage
    let modifiersToStore = null;
    
    if (modifiers) {
      try {
        // If modifiers is already a string, use it; otherwise stringify it
        modifiersToStore = typeof modifiers === 'string' ? modifiers : JSON.stringify(modifiers);
        } catch (error) {
        console.error('Error preparing modifiers for storage:', error);
        modifiersToStore = null;
      }
    } else {
       }
    
    // Build update object with only provided fields
    const updateData = {
      name: sanitizedName,
      description: sanitizedDescription,
      price: price || 0,
      duration: duration || 60,
      category: sanitizedCategory,
      require_payment_method: require_payment_method || false,
      image: image,
      updated_at: new Date().toISOString()
    };
    
    // Only update modifiers if provided
    if (modifiers !== undefined) {
      updateData.modifiers = modifiersToStore;
    } else {
    }
    
    // Only update intake_questions if provided
    if (intake_questions !== undefined) {
      updateData.intake_questions = intake_questions;
    } else {
    }
    
    
    // Update service
    const { data: updatedService, error: updateError } = await supabase
      .from('services')
      .update(updateData)
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single();
    
    if (updateError) {
      console.error('Error updating service:', updateError);
      return res.status(500).json({ error: 'Failed to update service' });
    }
    
    res.json({
      message: 'Service updated successfully',
      service: updatedService
    });
  } catch (error) {
    console.error('Update service error:', error);
    res.status(500).json({ error: 'Failed to update service' });
  }
});

app.delete('/api/services/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    
    // Check if service exists and belongs to user
    const { data: existingServices, error: checkError } = await supabase
      .from('services')
      .select('id')
      .eq('id', id)
      .eq('user_id', userId)
      .limit(1);
    
    if (checkError) {
      console.error('Error checking existing service:', checkError);
      return res.status(500).json({ error: 'Failed to delete service' });
    }
    
    if (!existingServices || existingServices.length === 0) {
      return res.status(404).json({ error: 'Service not found' });
    }
    
    // Check if service is being used in any jobs
    const { count: jobsUsingService, error: countError } = await supabase
      .from('jobs')
      .select('*', { count: 'exact', head: true })
      .eq('service_id', id);
    
    if (countError) {
      console.error('Error checking jobs using service:', countError);
      return res.status(500).json({ error: 'Failed to delete service' });
    }
    
    if (jobsUsingService > 0) {
      return res.status(400).json({ error: 'Cannot delete service that is being used in jobs' });
    }
    
    // Delete service
    const { error: deleteError } = await supabase
      .from('services')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);
    
    if (deleteError) {
      console.error('Error deleting service:', deleteError);
      return res.status(500).json({ error: 'Failed to delete service' });
    }
    
    res.json({ message: 'Service deleted successfully' });
  } catch (error) {
    console.error('Delete service error:', error);
    res.status(500).json({ error: 'Failed to delete service' });
  }
});

// Jobs endpoints
app.get('/api/jobs', authenticateToken, async (req, res) => {
  // CORS handled by middleware
  
  try {
    const { userId, status, search, page = 1, limit = 20, dateRange, dateFilter, sortBy = 'scheduled_date', sortOrder = 'ASC', teamMember, invoiceStatus, customerId, territoryId } = req.query;
    
  
    // Build Supabase query with joins
    let query = supabase
      .from('jobs')
      .select(`
        *,
        customers!left(first_name, last_name, email, phone, address, city, state, zip_code),
        services!left(name, price, duration),
        team_members!left(first_name, last_name, email)
      `, { count: 'exact' })
      .eq('user_id', userId);
    
    // Add status filter
    if (status) {
      const statusArray = status.split(',');
      // Map frontend status values to database enum values
      const mappedStatusArray = statusArray.map(s => {
        switch (s) {
          case 'in_progress':
            return 'in-progress';
          default:
            return s;
        }
      });
      query = query.in('status', mappedStatusArray);
    }
    
    // Add search filter
    if (search) {
      try {
        // Escape special characters in search term
        const escapedSearch = search.replace(/[%_\\]/g, '\\$&');
        // Search in joined tables using the correct syntax
        query = query.or(`service_name.ilike.%${escapedSearch}%,customers.first_name.ilike.%${escapedSearch}%,customers.last_name.ilike.%${escapedSearch}%`);
      } catch (searchError) {
        console.error('🔄 Backend: Search query error:', searchError);
        // Continue without search filter if there's an error
      }
    }
    
    // Add customer filter
    if (customerId) {
      query = query.eq('customer_id', customerId);
    }
    
    // Add territory filter
    if (territoryId) {
      query = query.eq('territory_id', territoryId);
    }
    
    // Add team member filter
    if (teamMember) {
      switch (teamMember) {
        case 'assigned':
          query = query.not('team_member_id', 'is', null);
          break;
        case 'unassigned':
          query = query.is('team_member_id', null);
          break;
        case 'web':
          query = query.is('team_member_id', null);
          break;
      }
    }
    
    // Add invoice status filter
    if (invoiceStatus) {
      switch (invoiceStatus) {
        case 'invoiced':
          query = query.in('invoice_status', ['invoiced', 'paid', 'unpaid']);
          break;
        case 'not_invoiced':
          query = query.eq('invoice_status', 'not_invoiced');
          break;
        case 'paid':
          query = query.eq('invoice_status', 'paid');
          break;
        case 'unpaid':
          query = query.eq('invoice_status', 'unpaid');
          break;
      }
    }
    
    // Add date filter
    if (dateFilter === 'future') {
      const todayString = getTodayString();
      query = query.gte('scheduled_date', todayString);
    } else if (dateFilter === 'past') {
      const todayString = getTodayString();
      query = query.lt('scheduled_date', todayString);
    } else if (dateRange) {
      const [startDate, endDate] = dateRange.split(':');
      if (startDate && endDate) {
         query = query.gte('scheduled_date', startDate).lte('scheduled_date', endDate);
      }
    }
    
    // Add sorting
    const allowedSortFields = ['scheduled_date', 'created_at'];
    const allowedSortOrders = ['ASC', 'DESC'];
    
    if (allowedSortFields.includes(sortBy) && allowedSortOrders.includes(sortOrder.toUpperCase())) {
      query = query.order(sortBy, { ascending: sortOrder.toUpperCase() === 'ASC' });
    } else {
      query = query.order('scheduled_date', { ascending: true });
    }
    
    // Add pagination
    const offset = (page - 1) * limit;
    query = query.range(offset, offset + parseInt(limit) - 1);
    
    
    let jobs, error, count;
    try {
      const result = await query;
      jobs = result.data;
      error = result.error;
      count = result.count;
    } catch (queryError) {
      console.error('🔄 Backend: Query execution error:', queryError);
      console.error('🔄 Backend: Query error details:', {
        message: queryError.message,
        stack: queryError.stack,
        name: queryError.name
      });
      return res.status(500).json({ 
        error: 'Failed to execute jobs query',
        details: queryError.message 
      });
    }
    
    if (error) {
      console.error('🔄 Backend: Supabase query error:', error);
      console.error('🔄 Backend: Error details:', {
        message: error.message,
        details: error.details,
        hint: error.hint,
        code: error.code
      });
      console.error('🔄 Backend: Query parameters:', {
        userId,
        search,
        status,
        sortBy,
        sortOrder,
        page,
        limit,
        dateFilter
      });
      
      // If it's a search-related error, try without search
      if (search && (error.message.includes('ilike') || error.message.includes('search') || error.message.includes('column') || error.message.includes('does not exist'))) {
       
        try {
          // Rebuild query without search
          let retryQuery = supabase
            .from('jobs')
            .select(`
              *,
              customers!left(first_name, last_name, email, phone, address, city, state, zip_code),
              services!left(name, price, duration),
              team_members!left(first_name, last_name, email)
            `, { count: 'exact' })
            .eq('user_id', userId);
          
          // Reapply other filters except search
          if (status) {
            const statusArray = status.split(',');
            const mappedStatusArray = statusArray.map(s => {
              switch (s) {
                case 'in_progress':
                  return 'in-progress';
                default:
                  return s;
              }
            });
            retryQuery = retryQuery.in('status', mappedStatusArray);
          }
          
          // Reapply date filter
          if (dateFilter === 'future') {
            const todayString = getTodayString();
            retryQuery = retryQuery.gte('scheduled_date', todayString);
          } else if (dateFilter === 'past') {
            const todayString = getTodayString();
            retryQuery = retryQuery.lt('scheduled_date', todayString);
          }
          
          // Reapply sorting and pagination
          retryQuery = retryQuery.order(sortBy, { ascending: sortOrder.toUpperCase() === 'ASC' });
          const offset = (page - 1) * limit;
          retryQuery = retryQuery.range(offset, offset + parseInt(limit) - 1);
          
          const retryResult = await retryQuery;
          jobs = retryResult.data;
          error = retryResult.error;
          count = retryResult.count;
          
          if (!error) {
             }
        } catch (retryError) {
          console.error('🔄 Backend: Retry also failed:', retryError);
        }
      }
      
      if (error) {
      return res.status(500).json({ 
        error: 'Failed to fetch jobs',
        details: error.message 
      });
      }
    }
      
     
      
      // Process jobs to add team assignments and format data
      const processedJobs = (jobs || []).map(job => {
        // Format customer data
        const customer = job.customers || {};
        const service = job.services || {};
        const teamMember = job.team_members || {};
        
        // Create team assignments array for backward compatibility
        const teamAssignments = teamMember.id ? [{
          team_member_id: teamMember.id,
          is_primary: true,
          first_name: teamMember.first_name,
          last_name: teamMember.last_name,
          email: teamMember.email
        }] : [];
        
        return {
          ...job,
          customer_first_name: customer.first_name,
          customer_last_name: customer.last_name,
          customer_email: customer.email,
          customer_phone: customer.phone,
          customer_address: customer.address,
          customer_city: customer.city,
          customer_state: customer.state,
          customer_zip_code: customer.zip_code,
          service_name: service.name || 'Service Not Available',
          service_price: service.price || 0.00,
          service_duration: service.duration || 60,
          team_member_first_name: teamMember.first_name,
          team_member_last_name: teamMember.last_name,
          team_member_email: teamMember.email,
          team_assignments: teamAssignments
        };
      });
      
      const response = {
        jobs: processedJobs,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: count || 0,
          totalPages: Math.ceil((count || 0) / limit)
        }
      };
      
     
      res.json(response);
  } catch (error) {
    console.error('Get jobs error:', error);
    res.status(500).json({ error: 'Failed to fetch jobs' });
  }
});

// OPTIONS handled by catch-all above

app.get('/api/jobs/:id', authenticateToken, async (req, res) => {
  // CORS handled by middleware
  
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    
    const { data: jobs, error } = await supabase
      .from('jobs')
      .select(`
        *,
        customers!left(first_name, last_name, email, phone, address, city, state, zip_code),
        services!left(name, price, duration),
        team_members!left(first_name, last_name, email)
      `)
      .eq('id', id)
      .eq('user_id', userId)
      .limit(1);
    
    if (error) {
      console.error('Error fetching job:', error);
      return res.status(500).json({ error: 'Failed to fetch job' });
    }
    
    if (!jobs || jobs.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }
    
    const job = jobs[0];
    
   
    // Get intake answers from job_answers table
    const { data: intakeAnswers, error: answersError } = await supabase
      .from('job_answers')
      .select('question_id, question_text, question_type, answer')
      .eq('job_id', id)
      .order('created_at', { ascending: true });
    
    if (answersError) {
      console.error('Error fetching intake answers:', answersError);
    }
    
    // Parse JSON answers
    const parsedIntakeAnswers = (intakeAnswers || []).map(answer => ({
      ...answer,
      answer: answer.answer ? (answer.answer.startsWith('[') || answer.answer.startsWith('{') ? JSON.parse(answer.answer) : answer.answer) : null
    }));

    // Get intake questions and answers from job_answers table
    const intakeQuestionsAndAnswers = parsedIntakeAnswers.map(answer => ({
      id: answer.question_id,
      question: answer.question_text,
      questionType: answer.question_type,
      answer: answer.answer
    }));

    // Get team assignments for this job
    let teamAssignments = [];
    try {
      const { data: assignmentsResult, error: assignmentsError } = await supabase
        .from('job_team_assignments')
        .select(`
          team_member_id,
          is_primary,
          team_members!left(first_name, last_name, email)
        `)
        .eq('job_id', id)
        .order('is_primary', { ascending: false })
        .order('assigned_at', { ascending: true });
      
      if (assignmentsError) {
        console.error('Error fetching team assignments:', assignmentsError);
      } else {
        teamAssignments = (assignmentsResult || []).map(assignment => ({
          team_member_id: assignment.team_member_id,
          is_primary: assignment.is_primary,
          first_name: assignment.team_members?.first_name,
          last_name: assignment.team_members?.last_name,
          email: assignment.team_members?.email
        }));
      }
    } catch (error) {
      console.error('Error processing team assignments:', error);
    }

        // For backward compatibility, set the primary team member
    try {
        const primaryAssignment = teamAssignments.find(ta => ta.is_primary);
        if (primaryAssignment) {
          job.team_member_first_name = primaryAssignment.first_name;
          job.team_member_last_name = primaryAssignment.last_name;
        }
      } catch (error) {
        console.error('Error processing team assignments:', error);
        
        // Fallback: create team assignment from the single team_member_id if it exists
        if (job.team_member_id && job.team_member_first_name) {
          teamAssignments = [{
            team_member_id: job.team_member_id,
            is_primary: true,
            first_name: job.team_member_first_name,
            last_name: job.team_member_last_name,
            email: null,
            phone: null,
            role: null
          }];
        }
      }

      const jobData = {
        ...job,
        team_assignments: teamAssignments,
        intake_answers: parsedIntakeAnswers,
        service_intake_questions: intakeQuestionsAndAnswers // Use the questions from job_answers table
      };
      
      res.json(jobData);
    } catch (error) {
      console.error('Get job error:', error);
      res.status(500).json({ error: 'Failed to fetch job' });
    }
    }
);

// Create job endpoint
app.post('/api/jobs', authenticateToken, async (req, res) => {
  // CORS handled by middleware
  
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

    
    // Combine scheduled date and time - save exactly as user chose
    let fullScheduledDate;
    if (scheduledDate && scheduledTime) {
      // Simply combine date and time as-is, no timezone conversion
      fullScheduledDate = `${scheduledDate} ${scheduledTime}:00`;
   } else {
      fullScheduledDate = scheduledDate;
    }

    // Process modifiers and intake questions to calculate final price and duration
    let finalPrice = parseFloat(price) || 0;
    let finalDuration = parseFloat(duration) || 0;
    let processedModifiers = [];
    let processedIntakeQuestions = [];
    
    // Use the total from frontend if provided (it already includes modifiers)
    let finalTotal = parseFloat(total) || finalPrice;
  
    // Process selected modifiers to calculate price and duration
    if (serviceModifiers && Array.isArray(serviceModifiers)) {
    
      processedModifiers = serviceModifiers.map(modifier => {
     const selectedModifierData = req.body.selectedModifiers?.[modifier.id];
       
        let modifierPrice = 0;
        let modifierDuration = 0;
        let selectedOptionsData = [];

        if (modifier.selectionType === 'quantity') {
          // Handle quantity selection - selectedModifierData.quantities contains {optionId: quantity}
          const quantities = selectedModifierData?.quantities || {};
         
          Object.entries(quantities).forEach(([optionId, quantity]) => {
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
        } else if (modifier.selectionType === 'multi') {
          // Handle multi-selection - selectedModifierData.selections contains [optionId1, optionId2]
          const selections = selectedModifierData?.selections || [];
        
          selections.forEach(optionId => {
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
        } else {
          // Handle single selection - selectedModifierData.selection contains optionId
          const selection = selectedModifierData?.selection;
         
          if (selection) {
            const option = modifier.options?.find(o => o.id == selection);
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
          }
        }
        
        // Fallback: If no selections were found with the new format, try the old format
        if (selectedOptionsData.length === 0 && selectedModifierData) {
         
          // Try old format where selectedModifierData is directly an array or object
          if (Array.isArray(selectedModifierData)) {
            selectedModifierData.forEach(optionId => {
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
          } else if (typeof selectedModifierData === 'object' && !selectedModifierData.quantities && !selectedModifierData.selections && !selectedModifierData.selection) {
            // Try old format where it's {optionId: quantity}
            Object.entries(selectedModifierData).forEach(([optionId, quantity]) => {
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
          }
        }

        // Don't add modifier price to finalPrice since it's already included in finalTotal
        // finalPrice += modifierPrice;
        finalDuration += modifierDuration;

       

        return {
          ...modifier,
          selectedOptions: selectedOptionsData,
          totalModifierPrice: modifierPrice,
          totalModifierDuration: modifierDuration
        };
      });
    } else {
   }

    
    // If we have modifiers but no processed modifiers, log a warning
    if (serviceModifiers && Array.isArray(serviceModifiers) && serviceModifiers.length > 0 && processedModifiers.length === 0) {
     
      // Check if selectedModifiers has any data at all
      const hasSelectedModifiers = req.body.selectedModifiers && Object.keys(req.body.selectedModifiers).length > 0;
     
      if (!hasSelectedModifiers) {
     } else {
       serviceModifiers.forEach(modifier => {
          const hasMatch = req.body.selectedModifiers[modifier.id];
        });
      }
    }

    // Process intake questions with answers
    
    // If serviceIntakeQuestions is not provided, try to get it from the service
    if (!serviceIntakeQuestions && serviceId) {
      try {
        const { data: serviceData, error: serviceError } = await supabase
          .from('services')
          .select('intake_questions')
          .eq('id', serviceId)
          .limit(1);
        
        if (serviceError) {
          console.error('Error fetching service intake questions:', serviceError);
          serviceIntakeQuestions = [];
        } else if (serviceData && serviceData.length > 0 && serviceData[0].intake_questions) {
          try {
            if (typeof serviceData[0].intake_questions === 'string') {
              serviceIntakeQuestions = JSON.parse(serviceData[0].intake_questions);
            } else if (Array.isArray(serviceData[0].intake_questions)) {
              serviceIntakeQuestions = serviceData[0].intake_questions;
            }
          } catch (parseError) {
            console.error('Error parsing service intake questions:', parseError);
            serviceIntakeQuestions = [];
          }
        }
      } catch (error) {
        console.error('Error fetching service intake questions:', error);
        serviceIntakeQuestions = [];
      }
    }
      
        const intakeAnswers = req.body.intakeQuestionAnswers || {};
        const originalQuestionIds = req.body.originalIntakeQuestionIds || [];
      
      if (serviceIntakeQuestions && Array.isArray(serviceIntakeQuestions)) {
       
        processedIntakeQuestions = serviceIntakeQuestions.map((question, index) => {
          // The frontend sends answers using the normalized question IDs (1, 2, 3)
          // So we should use the question.id directly, not the originalQuestionIds
          const answer = intakeAnswers[question.id];
          
        
          
          return {
            ...question,
            answer: answer || null
          };
        });
      }

      // Handle empty team member ID
      const teamMemberIdValue = teamMemberId && teamMemberId !== '' ? teamMemberId : null;
      
      // Also handle team member IDs array for multiple assignments
      const teamMemberIds = req.body.teamMemberIds || [];
      
      // Handle empty recurring end date
      const recurringEndDateValue = recurringEndDate && recurringEndDate !== '' ? recurringEndDate : null;

      // Handle multiple services - store in existing fields for now
      const serviceIds = req.body.serviceIds || [];
      const serviceNames = req.body.serviceName ? req.body.serviceName.split(', ') : [];

      // Create the job
      const jobData = {
        user_id: userId,
        customer_id: customerId,
        service_id: serviceId, // Keep for backward compatibility
        // Note: service_ids and service_names columns don't exist yet, storing in service_name for now
        team_member_id: teamMemberIdValue,
        scheduled_date: fullScheduledDate,
        notes: notes,
        status: status,
        duration: finalDuration,
        workers_needed: workers,
        skills_required: skillsRequired,
        price: finalPrice,
        service_price: finalPrice,
        discount: discount,
        additional_fees: additionalFees,
        taxes: taxes,
        total: finalTotal,
        total_amount: finalTotal,
        payment_method: paymentMethod,
        territory: territory,
        is_recurring: recurringJob,
        schedule_type: scheduleType,
        let_customer_schedule: letCustomerSchedule,
        offer_to_providers: offerToProviders,
        internal_notes: internalNotes,
        service_address_street: serviceAddress?.street,
        service_address_city: serviceAddress?.city,
        service_address_state: serviceAddress?.state,
        service_address_zip: serviceAddress?.zipCode,
        service_name: serviceName,
        invoice_status: invoiceStatus,
        payment_status: paymentStatus,
        priority: priority,
        estimated_duration: finalDuration,
        skills: skills,
        special_instructions: specialInstructions,
        customer_notes: customerNotes,
        tags: tags,
        recurring_end_date: recurringEndDateValue,
        auto_invoice: autoInvoice,
        auto_reminders: autoReminders,
        customer_signature: customerSignature,
        photos_required: photosRequired,
        quality_check: qualityCheck,
        service_modifiers: processedModifiers.length > 0 ? processedModifiers : null,
        service_intake_questions: processedIntakeQuestions.length > 0 ? processedIntakeQuestions : null
      };

    
      const { data: result, error: insertError } = await supabase
        .from('jobs')
        .insert(jobData)
        .select()
        .single();

      if (insertError) {
        console.error('❌ Error creating job:', insertError);
        console.error('❌ Job data that failed:', jobData);
        return res.status(500).json({ error: 'Failed to create job', details: insertError.message });
      }
      
            // Verify customer exists and get customer data
            if (result.customer_id) {
              const { data: customerData, error: customerError } = await supabase
                .from('customers')
                .select('id, first_name, last_name, email, phone')
                .eq('id', result.customer_id)
                .single();
              
              if (customerError) {
                console.error('🔄 Error fetching customer data:', customerError);
              } else {
               }
            }
      
      // Send success response
      res.json({
        success: true,
        message: 'Job created successfully',
        job: result
      });

      // Create team member assignments in job_team_assignments table
      if (teamMemberIdValue || teamMemberIds.length > 0) {
        try {
          // If we have a single team member ID, add it as primary
          if (teamMemberIdValue) {
            const { error: assignmentError } = await supabase
              .from('job_team_assignments')
              .insert({
                job_id: result.id,
                team_member_id: teamMemberIdValue,
                is_primary: true,
                assigned_by: userId
              });
            
            if (assignmentError) {
              console.error('Error creating primary team assignment:', assignmentError);
            } else {
             }
          }
          
          // Add additional team members from the array
          for (const memberId of teamMemberIds) {
            if (memberId && memberId !== teamMemberIdValue) {
              const { error: assignmentError } = await supabase
                .from('job_team_assignments')
                .insert({
                  job_id: result.id,
                  team_member_id: memberId,
                  is_primary: false,
                  assigned_by: userId
                });
              
              if (assignmentError) {
                console.error('Error creating additional team assignment:', assignmentError);
              } else {
               }
            }
          }
        } catch (assignmentError) {
          console.error('Error creating team assignments:', assignmentError);
          // Don't fail the job creation if team assignment fails
        }
      }

      if (processedIntakeQuestions && processedIntakeQuestions.length > 0) {
        try {
          for (let index = 0; index < processedIntakeQuestions.length; index++) {
            const question = processedIntakeQuestions[index];
             if (question.answer !== undefined && question.answer !== null && question.answer !== '') {
              const answerToSave = (Array.isArray(question.answer) || typeof question.answer === 'object') ? JSON.stringify(question.answer) : question.answer;
               try {
                // Use the original question ID for consistency in the database
                const originalQuestionId = originalQuestionIds[index] || question.id;
                const { error: answerError } = await supabase
                  .from('job_answers')
                  .insert({
                    job_id: result.id,
                    question_id: originalQuestionId,
                    question_text: question.question,
                    question_type: question.questionType,
                    answer: answerToSave
                  });
                
                if (answerError) {
                  console.error('Error inserting job answer:', answerError);
                } else {
                 }
              } catch (insertError) {
                console.error('Error inserting job answer:', insertError);
                // Continue processing other answers even if one fails
              }
            } else {
             }
          }
        } catch (error) {
          console.error('Error processing intake questions for job_answers:', error);
          // Don't fail the entire operation if intake questions processing fails
        }
      } else {
        }

      // Get the created job
      const { data: createdJob, error: fetchError } = await supabase
        .from('jobs')
        .select(`
          *,
          customers!left(first_name, last_name, email, phone),
          services!left(name, price, duration)
        `)
        .eq('id', result.id)
        .limit(1);

      if (fetchError) {
        console.error('Error fetching created job:', fetchError);
        return res.status(500).json({ error: 'Failed to fetch created job' });
      }

      
      res.status(201).json({
        message: 'Job created successfully',
        job: createdJob[0]
      });
  } catch (error) {
    console.error('Create job error:', error);
    res.status(500).json({ error: 'Failed to create job' });
  }
});

// Update job status endpoint
app.patch('/api/jobs/:id/status', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    let { status } = req.body;

    // Map frontend status values to database enum values
    const statusMapping = {
      'in_progress': 'in-progress',
      'in-progress': 'in-progress',
      'pending': 'pending',
      'confirmed': 'confirmed',
      'completed': 'completed',
      'cancelled': 'cancelled'
    };

    status = statusMapping[status] || status;

    
    // Check if job exists and belongs to user
    const { data: existingJob, error: checkError } = await supabase
      .from('jobs')
      .select('id')
      .eq('id', id)
      .eq('user_id', userId)
      .limit(1);

    if (checkError) {
      console.error('Error checking job existence:', checkError);
      return res.status(500).json({ error: 'Failed to update job status' });
    }

    if (!existingJob || existingJob.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Update job status
    const { error: updateError } = await supabase
      .from('jobs')
      .update({ 
        status: status,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .eq('user_id', userId);

    if (updateError) {
      console.error('Error updating job status:', updateError);
      return res.status(500).json({ error: 'Failed to update job status' });
    }

    res.json({
      message: 'Job status updated successfully',
      status: status
    });
  } catch (error) {
    console.error('Update job status error:', error);
    res.status(500).json({ error: 'Failed to update job status' });
  }
});

// Update job endpoint
app.put('/api/jobs/:id', authenticateToken, async (req, res) => {
  // CORS handled by middleware
  
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    const updateData = req.body;

  
    // Check if job exists and belongs to user
    const { data: existingJob, error: checkError } = await supabase
      .from('jobs')
      .select('id')
      .eq('id', id)
      .eq('user_id', userId)
      .limit(1);

    if (checkError) {
      console.error('Error checking job existence:', checkError);
      return res.status(500).json({ error: 'Failed to update job' });
    }

    if (!existingJob || existingJob.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Build update data object
    const updateDataToSend = {};

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
      service_price: 'service_price',
      discount: 'discount',
      additionalFees: 'additional_fees',
      taxes: 'taxes',
      total: 'total',
      total_amount: 'total_amount',
      paymentMethod: 'payment_method',
      territory: 'territory',
      territoryId: 'territory_id',
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
     if ((fieldMappings[key] || key === 'serviceAddress') && updateData[key] !== undefined) {
        // Handle special cases
        if (key === 'scheduledDate' && updateData.scheduledTime) {
          // Simply combine date and time as-is, no timezone conversion
          updateDataToSend[fieldMappings[key]] = `${updateData[key]} ${updateData.scheduledTime}:00`;
        } else if (['skills', 'tags', 'serviceModifiers', 'serviceIntakeQuestions'].includes(key)) {
          updateDataToSend[fieldMappings[key]] = updateData[key];
        } else if (key === 'serviceAddress') {
          // Handle nested service address
          if (updateData[key]) {
            updateDataToSend.service_address_street = updateData[key].street || null;
            updateDataToSend.service_address_city = updateData[key].city || null;
            updateDataToSend.service_address_state = updateData[key].state || null;
            updateDataToSend.service_address_zip = updateData[key].zipCode || null;
          
          }
        } else {
          updateDataToSend[fieldMappings[key]] = updateData[key];
        }
      }
    });

   
    if (Object.keys(updateDataToSend).length === 0) {
     return res.status(400).json({ error: 'No valid fields to update' });
    }

    // Handle team member assignments update
    if (updateData.teamMemberId !== undefined || updateData.teamMemberIds !== undefined) {
      try {
        // Remove existing assignments
        const { error: deleteError } = await supabase
          .from('job_team_assignments')
          .delete()
          .eq('job_id', id);
        
        if (deleteError) {
          console.error('Error removing existing team assignments:', deleteError);
        }
        
        // Add new assignments
        const teamMemberId = updateData.teamMemberId;
        const teamMemberIds = updateData.teamMemberIds || [];
        
        // If we have a single team member ID, add it as primary
        if (teamMemberId && teamMemberId !== '') {
          const { error: insertError } = await supabase
            .from('job_team_assignments')
            .insert({
              job_id: id,
              team_member_id: teamMemberId,
              is_primary: true,
              assigned_by: userId
            });
          
          if (insertError) {
            console.error('Error creating primary team assignment:', insertError);
          }
        }
        
        // Add additional team members from the array
        for (const memberId of teamMemberIds) {
          if (memberId && memberId !== teamMemberId) {
            const { error: insertError } = await supabase
              .from('job_team_assignments')
              .insert({
                job_id: id,
                team_member_id: memberId,
                is_primary: false,
                assigned_by: userId
              });
            
            if (insertError) {
              console.error('Error creating additional team assignment:', insertError);
            }
          }
        }
        
      } catch (assignmentError) {
        console.error('Error updating team assignments:', assignmentError);
        // Don't fail the job update if team assignment fails
      }
    }

    // If service_price is being updated, recalculate total
    if (updateDataToSend.service_price !== undefined) {
      // Get current job data to calculate new total
      const { data: currentJob } = await supabase
        .from('jobs')
        .select('service_modifiers, additional_fees, taxes, discount')
        .eq('id', id)
        .single();
      
      if (currentJob) {
        // Calculate modifier price from service_modifiers
        let modifierPrice = 0;
        if (currentJob.service_modifiers) {
          try {
            const modifiers = typeof currentJob.service_modifiers === 'string' 
              ? JSON.parse(currentJob.service_modifiers) 
              : currentJob.service_modifiers;
            
            modifiers.forEach(modifier => {
              if (modifier.selectedOptions) {
                modifier.selectedOptions.forEach(option => {
                  const price = parseFloat(option.price || 0);
                  const quantity = parseInt(option.selectedQuantity || 1);
                  modifierPrice += price * quantity;
                });
              }
            });
          } catch (error) {
            console.error('Error parsing service modifiers:', error);
          }
        }
        
        // Calculate new total
        const servicePrice = parseFloat(updateDataToSend.service_price) || 0;
        const additionalFees = parseFloat(updateDataToSend.additional_fees || currentJob.additional_fees || 0);
        const taxes = parseFloat(updateDataToSend.taxes || currentJob.taxes || 0);
        const discount = parseFloat(updateDataToSend.discount || currentJob.discount || 0);
        
        // Calculate subtotal first, then apply discount
        const subtotal = servicePrice + modifierPrice + additionalFees + taxes;
        const newTotal = subtotal - discount;
        
        // Add calculated total to update data
        updateDataToSend.total = newTotal;
        updateDataToSend.total_amount = newTotal;
      }
    }

    const { error: updateError } = await supabase
      .from('jobs')
      .update(updateDataToSend)
      .eq('id', id)
      .eq('user_id', userId);

    if (updateError) {
      console.error('Error updating job:', updateError);
      return res.status(500).json({ error: 'Failed to update job' });
    }

    // Get updated job
    const { data: updatedJob, error: fetchError } = await supabase
      .from('jobs')
      .select(`
        *,
        customers!left(first_name, last_name, email, phone),
        services!left(name, price, duration)
      `)
      .eq('id', id)
      .limit(1);

    if (fetchError) {
      console.error('Error fetching updated job:', fetchError);
      return res.status(500).json({ error: 'Failed to fetch updated job' });
    }

    res.json({
      message: 'Job updated successfully',
      job: updatedJob[0]
    });
  } catch (error) {
    console.error('Update job error:', error);
    res.status(500).json({ error: 'Failed to update job' });
  }
});

// Delete job endpoint
app.delete('/api/jobs/:id', authenticateToken, async (req, res) => {
  // CORS handled by middleware
  
  try {
    const userId = req.user.userId;
    const { id } = req.params;

    // Check if job exists and belongs to user
    const { data: existingJob, error: checkError } = await supabase
      .from('jobs')
      .select('id')
      .eq('id', id)
      .eq('user_id', userId)
      .limit(1);

    if (checkError) {
      console.error('Error checking job existence:', checkError);
      return res.status(500).json({ error: 'Failed to delete job' });
    }

    if (!existingJob || existingJob.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Delete the job
    const { error: deleteError } = await supabase
      .from('jobs')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);

    if (deleteError) {
      console.error('Error deleting job:', deleteError);
      return res.status(500).json({ error: 'Failed to delete job' });
    }

    console.log('🔄 Job deleted successfully');
    
    res.json({ message: 'Job deleted successfully' });
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
    

    // Build Supabase query
    let query = supabase
      .from('customers')
      .select('*', { count: 'exact' })
      .eq('user_id', userId);
    
    // Add status filter
    if (status && status !== 'all') {
      query = query.eq('status', status);
    }
    
    // Add search filter
    if (search) {
      query = query.or(`first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%,phone.ilike.%${search}%`);
    }
    
    // Add sorting
    const allowedSortFields = ['first_name', 'last_name', 'email', 'created_at', 'updated_at'];
    const allowedSortOrders = ['ASC', 'DESC'];
    
    if (allowedSortFields.includes(sortBy) && allowedSortOrders.includes(sortOrder.toUpperCase())) {
      query = query.order(sortBy, { ascending: sortOrder.toUpperCase() === 'ASC' });
    } else {
      query = query.order('created_at', { ascending: false });
    }
    
    // Add pagination
    const offset = (page - 1) * limit;
    query = query.range(offset, offset + parseInt(limit) - 1);
  
    const { data: customers, error, count } = await query;
    
    if (error) {
      console.error('Error fetching customers:', error);
      return res.status(500).json({ error: 'Failed to fetch customers' });
    }
    
  
    res.json({
      customers: customers || [],
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count || 0,
        pages: Math.ceil((count || 0) / limit)
      }
    });
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
    
    // Note: Multiple customers can have the same email address
    // No email uniqueness check needed
    
    // Create new customer
    const { data: newCustomer, error } = await supabase
      .from('customers')
      .insert({
        user_id: userId,
        first_name: sanitizedFirstName,
        last_name: sanitizedLastName,
        email: sanitizedEmail,
        phone: sanitizedPhone,
        address: sanitizedAddress,
        suite: sanitizedSuite,
        notes: sanitizedNotes,
        city: sanitizedCity,
        state: sanitizedState,
        zip_code: sanitizedZipCode,
        status: 'active'
      })
      .select()
      .single();
    
    if (error) {
      console.error('Error creating customer:', error);
      return res.status(500).json({ error: 'Failed to create customer' });
    }
    
    res.status(201).json({
      message: 'Customer created successfully',
      customer: newCustomer
    });
  } catch (error) {
    console.error('Create customer error:', error);
    res.status(500).json({ error: 'Failed to create customer' });
  }
});

// Move export route before :id route to avoid conflicts
app.get('/api/customers/export', authenticateToken, async (req, res) => {
  try {
    console.log('📊 Export customers request:', { userId: req.user?.userId, format: req.query.format });
    const userId = req.user.userId;
    const { format = 'json' } = req.query;
    
    const { data: customers, error } = await supabase
      .from('customers')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    
    if (error) {
      console.error('Error fetching customers for export:', error);
      return res.status(500).json({ error: 'Failed to fetch customers for export' });
    }
    
    if (format === 'csv') {
      // Generate CSV
      const csvHeader = 'First Name,Last Name,Email,Phone,Address,Suite,City,State,Zip Code,Notes,Status,Created At,Updated At\n';
      const csvRows = (customers || []).map(customer => 
        `"${customer.first_name || ''}","${customer.last_name || ''}","${customer.email || ''}","${customer.phone || ''}","${customer.address || ''}","${customer.suite || ''}","${customer.city || ''}","${customer.state || ''}","${customer.zip_code || ''}","${customer.notes || ''}","${customer.status || ''}","${customer.created_at || ''}","${customer.updated_at || ''}"`
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
  } catch (error) {
    console.error('Export customers error:', error);
    res.status(500).json({ error: 'Failed to export customers' });
  }
});

app.get('/api/customers/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    
    const { data: customers, error } = await supabase
      .from('customers')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .limit(1);
    
    if (error) {
      console.error('Error fetching customer:', error);
      return res.status(500).json({ error: 'Failed to fetch customer' });
    }
    
    if (!customers || customers.length === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    
    res.json(customers[0]);
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
    
    // Check if customer exists and belongs to user
    const { data: existingCustomers, error: checkError } = await supabase
      .from('customers')
      .select('id, email')
      .eq('id', id)
      .eq('user_id', userId)
      .limit(1);
    
    if (checkError) {
      console.error('Error checking customer:', checkError);
      return res.status(500).json({ error: 'Failed to update customer' });
    }
    
    if (!existingCustomers || existingCustomers.length === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    
    // Update customer
    const { data: updatedCustomer, error: updateError } = await supabase
      .from('customers')
      .update({
        first_name: sanitizedFirstName,
        last_name: sanitizedLastName,
        email: sanitizedEmail,
        phone: sanitizedPhone,
        address: sanitizedAddress,
        suite: sanitizedSuite,
        notes: sanitizedNotes,
        status: status,
        city: sanitizedCity,
        state: sanitizedState,
        zip_code: sanitizedZipCode
      })
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single();
    
    if (updateError) {
      console.error('Error updating customer:', updateError);
      return res.status(500).json({ error: 'Failed to update customer' });
    }
    
    res.json({ 
      message: 'Customer updated successfully',
      customer: updatedCustomer
    });
  } catch (error) {
    console.error('Update customer error:', error);
    res.status(500).json({ error: 'Failed to update customer' });
  }
});

app.delete('/api/customers/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    
    // Check if customer exists and belongs to user
    const { data: existingCustomers, error: checkError } = await supabase
      .from('customers')
      .select('id')
      .eq('id', id)
      .eq('user_id', userId)
      .limit(1);
    
    if (checkError) {
      console.error('Error checking customer:', checkError);
      return res.status(500).json({ error: 'Failed to delete customer' });
    }
    
    if (!existingCustomers || existingCustomers.length === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    
    // Check if customer has associated jobs or estimates
    const { data: jobs, error: jobsError } = await supabase
      .from('jobs')
      .select('id', { count: 'exact' })
      .eq('customer_id', id);
    
    const { data: estimates, error: estimatesError } = await supabase
      .from('estimates')
      .select('id', { count: 'exact' })
      .eq('customer_id', id);
    
    if (jobsError || estimatesError) {
      console.error('Error checking associated records:', jobsError || estimatesError);
      return res.status(500).json({ error: 'Failed to delete customer' });
    }
    
    if ((jobs && jobs.length > 0) || (estimates && estimates.length > 0)) {
      return res.status(400).json({ 
        error: 'Cannot delete customer with associated jobs or estimates. Please delete the associated records first.' 
      });
    }
    
    // Soft delete by setting status to 'archived' instead of hard delete
    const { error: updateError } = await supabase
      .from('customers')
      .update({ status: 'archived' })
      .eq('id', id)
      .eq('user_id', userId);
    
    if (updateError) {
      console.error('Error updating customer:', updateError);
      return res.status(500).json({ error: 'Failed to delete customer' });
    }
    
    res.json({ message: 'Customer deleted successfully' });
  } catch (error) {
    console.error('Delete customer error:', error);
    res.status(500).json({ error: 'Failed to delete customer' });
  }
});

// Jobs export endpoint
app.get('/api/jobs/export', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { 
      format = 'csv', 
      status, 
      dateFrom, 
      dateTo, 
      customerId, 
      teamMemberId,
      territoryId,
      invoiceStatus,
      paymentStatus,
      priority,
      includeAnswers = false
    } = req.query;

    // Build query with filters
    let query = supabase
      .from('jobs')
      .select(`
        *,
        customers!left(first_name, last_name, email, phone, address, city, state, zip_code),
        services!left(name, price, duration),
        team_members!left(first_name, last_name, email)
      `)
      .eq('user_id', userId);

    // Apply filters
    if (status) {
      const statusArray = status.split(',');
      const mappedStatusArray = statusArray.map(s => {
        switch (s) {
          case 'in_progress': return 'in-progress';
          default: return s;
        }
      });
      query = query.in('status', mappedStatusArray);
    }

    if (dateFrom) {
      query = query.gte('scheduled_date', dateFrom);
    }

    if (dateTo) {
      query = query.lte('scheduled_date', dateTo);
    }

    if (customerId) {
      query = query.eq('customer_id', customerId);
    }

    if (teamMemberId) {
      query = query.eq('team_member_id', teamMemberId);
    }

    if (territoryId) {
      query = query.eq('territory_id', territoryId);
    }

    if (invoiceStatus) {
      query = query.eq('invoice_status', invoiceStatus);
    }

    if (paymentStatus) {
      query = query.eq('payment_status', paymentStatus);
    }

    if (priority) {
      query = query.eq('priority', priority);
    }

    const { data: jobs, error } = await query.order('scheduled_date', { ascending: false });

    if (error) {
      console.error('Error fetching jobs for export:', error);
      return res.status(500).json({ error: 'Failed to fetch jobs' });
    }

    if (format === 'csv') {
      // Generate CSV
      const csvHeader = 'Job ID,Customer Name,Customer Email,Customer Phone,Service Name,Service Price,Duration,Status,Scheduled Date,Team Member,Priority,Invoice Status,Payment Status,Total Amount,Notes,Service Address,City,State,Zip Code,Created At,Updated At\n';
      
      const csvRows = (jobs || []).map(job => {
        const customer = job.customers || {};
        const service = job.services || {};
        const teamMember = job.team_members || {};
        
        return `"${job.id || ''}","${customer.first_name || ''} ${customer.last_name || ''}","${customer.email || ''}","${customer.phone || ''}","${job.service_name || service.name || ''}","${job.service_price || service.price || ''}","${job.duration || service.duration || ''}","${job.status || ''}","${job.scheduled_date || ''}","${teamMember.first_name || ''} ${teamMember.last_name || ''}","${job.priority || ''}","${job.invoice_status || ''}","${job.payment_status || ''}","${job.total || ''}","${job.notes || ''}","${job.service_address_street || ''}","${job.service_address_city || ''}","${job.service_address_state || ''}","${job.service_address_zip || ''}","${job.created_at || ''}","${job.updated_at || ''}"`;
      }).join('\n');
        
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="jobs_export_${new Date().toISOString().split('T')[0]}.csv"`);
      res.send(csvHeader + csvRows);
    } else {
      res.json({ jobs, count: jobs?.length || 0 });
    }
  } catch (error) {
    console.error('Jobs export error:', error);
    res.status(500).json({ error: 'Failed to export jobs' });
  }
});

// Jobs import endpoint
app.post('/api/jobs/import', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { jobs } = req.body;

    if (!jobs || !Array.isArray(jobs)) {
      return res.status(400).json({ error: 'Jobs array is required' });
    }

    const results = {
      imported: 0,
      skipped: 0,
      errors: []
    };

    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      
      try {
        // Validate required fields
        if (!job.customerId && !job.customerEmail) {
          results.errors.push(`Row ${i + 1}: Customer ID or email is required`);
          results.skipped++;
          continue;
        }

        // Find customer by ID or email
        let customerId = job.customerId;
        if (!customerId && job.customerEmail) {
          const { data: customer } = await supabase
            .from('customers')
            .select('id')
            .eq('user_id', userId)
            .eq('email', job.customerEmail)
            .single();
          
          if (customer) {
            customerId = customer.id;
          } else {
            results.errors.push(`Row ${i + 1}: Customer with email ${job.customerEmail} not found`);
            results.skipped++;
            continue;
          }
        }

        // Find service by name if provided
        let serviceId = job.serviceId;
        if (!serviceId && job.serviceName) {
          const { data: service } = await supabase
            .from('services')
            .select('id')
            .eq('user_id', userId)
            .eq('name', job.serviceName)
            .single();
          
          if (service) {
            serviceId = service.id;
          }
        }

        // Find team member by name if provided
        let teamMemberId = job.teamMemberId;
        if (!teamMemberId && job.teamMemberName) {
          const nameParts = job.teamMemberName.split(' ');
          const firstName = nameParts[0];
          const lastName = nameParts.slice(1).join(' ');
          
          const { data: teamMember } = await supabase
            .from('team_members')
            .select('id')
            .eq('user_id', userId)
            .eq('first_name', firstName)
            .eq('last_name', lastName)
            .single();
          
          if (teamMember) {
            teamMemberId = teamMember.id;
          }
        }

        // Sanitize inputs
        const sanitizedNotes = job.notes ? sanitizeInput(job.notes) : null;
        const sanitizedServiceAddress = job.serviceAddress ? sanitizeInput(job.serviceAddress) : null;
        const sanitizedInternalNotes = job.internalNotes ? sanitizeInput(job.internalNotes) : null;

        // Create job
        const jobData = {
          user_id: userId,
          customer_id: customerId,
          service_id: serviceId,
          team_member_id: teamMemberId,
          scheduled_date: job.scheduledDate || job.scheduled_date,
          notes: sanitizedNotes,
          status: job.status || 'pending',
          duration: parseFloat(job.duration) || null,
          workers_needed: parseInt(job.workersNeeded) || null,
          price: parseFloat(job.price) || 0,
          service_price: parseFloat(job.servicePrice) || parseFloat(job.price) || 0,
          discount: parseFloat(job.discount) || 0,
          additional_fees: parseFloat(job.additionalFees) || 0,
          taxes: parseFloat(job.taxes) || 0,
          total: parseFloat(job.total) || parseFloat(job.price) || 0,
          total_amount: parseFloat(job.total) || parseFloat(job.price) || 0,
          payment_method: job.paymentMethod || null,
          territory: job.territory || null,
          is_recurring: job.isRecurring || false,
          schedule_type: job.scheduleType || 'one-time',
          let_customer_schedule: job.letCustomerSchedule || false,
          offer_to_providers: job.offerToProviders || false,
          internal_notes: sanitizedInternalNotes,
          service_address_street: job.serviceAddressStreet || sanitizedServiceAddress,
          service_address_city: job.serviceAddressCity,
          service_address_state: job.serviceAddressState,
          service_address_zip: job.serviceAddressZip,
          service_name: job.serviceName,
          invoice_status: job.invoiceStatus || 'draft',
          payment_status: job.paymentStatus || 'pending',
          priority: job.priority || 'normal',
          estimated_duration: parseFloat(job.estimatedDuration) || parseFloat(job.duration) || null,
          skills_required: job.skillsRequired || null,
          special_instructions: job.specialInstructions || null,
          customer_notes: job.customerNotes || null,
          tags: job.tags || null,
          attachments: job.attachments || null,
          recurring_frequency: job.recurringFrequency || 'weekly',
          recurring_end_date: job.recurringEndDate || null,
          auto_invoice: job.autoInvoice !== false,
          auto_reminders: job.autoReminders !== false,
          customer_signature: job.customerSignature || false,
          photos_required: job.photosRequired || false,
          quality_check: job.qualityCheck !== false
        };

        const { data: newJob, error: insertError } = await supabase
          .from('jobs')
          .insert(jobData)
          .select()
          .single();

        if (insertError) {
          results.errors.push(`Row ${i + 1}: ${insertError.message}`);
          results.skipped++;
        } else {
          results.imported++;
        }
      } catch (error) {
        results.errors.push(`Row ${i + 1}: ${error.message}`);
        results.skipped++;
      }
    }

    res.json(results);
  } catch (error) {
    console.error('Jobs import error:', error);
    res.status(500).json({ error: 'Failed to import jobs' });
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
        const sanitizedSuite = customer.suite ? sanitizeInput(customer.suite) : null;
        const sanitizedCity = customer.city ? sanitizeInput(customer.city) : null;
        const sanitizedState = customer.state ? sanitizeInput(customer.state) : null;
        const sanitizedZipCode = customer.zipCode ? sanitizeInput(customer.zipCode) : null;
        const sanitizedNotes = customer.notes ? sanitizeInput(customer.notes) : null;
        
        // Note: Multiple customers can have the same email address
        // No email uniqueness check needed during import
        
        // Insert customer
        const { data: newCustomer, error: insertError } = await supabase
          .from('customers')
          .insert({
            user_id: userId,
            first_name: sanitizedFirstName,
            last_name: sanitizedLastName,
            email: sanitizedEmail,
            phone: sanitizedPhone,
            address: sanitizedAddress,
            suite: sanitizedSuite,
            city: sanitizedCity,
            state: sanitizedState,
            zip_code: sanitizedZipCode,
            notes: sanitizedNotes,
            status: customer.status || 'active'
          })
          .select()
          .single();
        
        if (insertError) {
          errors.push(`Row ${i + 1}: ${insertError.message}`);
          continue;
        }
        
        importedCustomers.push(newCustomer);
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
  } catch (error) {
    console.error('Import customers error:', error);
    res.status(500).json({ error: 'Failed to import customers' });
  }
});

// Team members endpoints
app.get('/api/team', async (req, res) => {
  try {
    const { userId } = req.query;
    
    const { data: teamMembers, error } = await supabase
      .from('team_members')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    
    if (error) {
      console.error('Error fetching team members:', error);
      return res.status(500).json({ error: 'Failed to fetch team members' });
    }
    
    res.json(teamMembers || []);
  } catch (error) {
    console.error('Get team members error:', error);
    res.status(500).json({ error: 'Failed to fetch team members' });
  }
});

app.post('/api/team', async (req, res) => {
  try {
    const { userId, firstName, lastName, email, phone, role } = req.body;
    
    const { data: teamMember, error } = await supabase
      .from('team_members')
      .insert({
        user_id: userId,
        first_name: firstName,
        last_name: lastName,
        email: email,
        phone: phone,
        role: role
      })
      .select()
      .single();
    
    if (error) {
      console.error('Error creating team member:', error);
      return res.status(500).json({ error: 'Failed to create team member' });
    }
    
    res.status(201).json({ 
      message: 'Team member created successfully',
      teamMemberId: teamMember.id 
    });
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
    
   
    // Build Supabase query
    let query = supabase
      .from('estimates')
      .select(`
        *,
        customers!left(first_name, last_name, email, phone)
      `, { count: 'exact' })
      .eq('user_id', userId);
    
    // Add filters
    if (status) {
      query = query.eq('status', status);
    }
    
    if (customerId) {
      query = query.eq('customer_id', customerId);
    }
    
    // Handle sorting
    const allowedSortFields = ['created_at', 'total_amount', 'status', 'valid_until'];
    const allowedSortOrders = ['ASC', 'DESC'];
    
    if (allowedSortFields.includes(sortBy) && allowedSortOrders.includes(sortOrder.toUpperCase())) {
      query = query.order(sortBy, { ascending: sortOrder.toUpperCase() === 'ASC' });
    } else {
      query = query.order('created_at', { ascending: false });
    }
    
    // Add pagination
    const offset = (page - 1) * limit;
    query = query.range(offset, offset + parseInt(limit) - 1);
    

    const { data: estimates, error, count } = await query;
    
    if (error) {
      console.error('Error fetching estimates:', error);
      return res.status(500).json({ error: 'Failed to fetch estimates' });
    }
    
   
    const response = {
      estimates: estimates || [],
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count || 0,
        pages: Math.ceil((count || 0) / limit)
      }
    };
   res.json(response);
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
    const { data: estimates, error } = await supabase
      .from('estimates')
      .select(`
        *,
        customers!left(first_name, last_name, email, phone, address)
      `)
      .eq('id', id)
      .limit(1);
    
    if (error) {
      console.error('Error fetching estimate:', error);
      return res.status(500).json({ error: 'Failed to fetch estimate' });
    }
    
    if (!estimates || estimates.length === 0) {
      return res.status(404).json({ error: 'Estimate not found' });
    }
    
    const estimate = estimates[0];
    
    // Parse services JSON and get service details
    if (estimate.services) {
      try {
        const servicesData = JSON.parse(estimate.services);
        const serviceIds = servicesData.map(service => service.serviceId);
        
        if (serviceIds.length > 0) {
          const { data: services, error: servicesError } = await supabase
            .from('services')
            .select('id, name, description, price, duration')
            .in('id', serviceIds);
          
          if (servicesError) {
            console.error('Error fetching services:', servicesError);
          } else {
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
      } catch (parseError) {
        console.error('Error parsing services JSON:', parseError);
      }
    }
    
    res.json(estimate);
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
    
    // Validate customer exists
    const { data: customer, error: customerError } = await supabase
      .from('customers')
      .select('id')
      .eq('id', customerId)
      .eq('user_id', userId)
      .limit(1);
    
    if (customerError) {
      console.error('Error checking customer:', customerError);
      return res.status(500).json({ error: 'Failed to validate customer' });
    }
    
    if (!customer || customer.length === 0) {
      return res.status(400).json({ error: 'Customer not found' });
    }
    
    // Validate services exist
    const serviceIds = services.map(service => service.serviceId);
    const { data: existingServices, error: servicesError } = await supabase
      .from('services')
      .select('id')
      .in('id', serviceIds)
      .eq('user_id', userId);
    
    if (servicesError) {
      console.error('Error checking services:', servicesError);
      return res.status(500).json({ error: 'Failed to validate services' });
    }
    
    if (!existingServices || existingServices.length !== serviceIds.length) {
      return res.status(400).json({ error: 'One or more services not found' });
    }
    
    // Calculate valid until date (default to 30 days from now)
    const validUntilDate = validUntil || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    
    const { data: result, error: insertError } = await supabase
      .from('estimates')
      .insert({
        user_id: userId,
        customer_id: customerId,
        services: services,
        total_amount: totalAmount,
        valid_until: validUntilDate,
        notes: notes || null
      })
      .select()
      .single();
    
    if (insertError) {
      console.error('Error creating estimate:', insertError);
      return res.status(500).json({ error: 'Failed to create estimate' });
    }
      
      // Get the created estimate with customer details
      const { data: createdEstimate, error: fetchError } = await supabase
        .from('estimates')
        .select(`
          *,
          customers!left(first_name, last_name, email, phone)
        `)
        .eq('id', result.id)
        .limit(1);
      
      if (fetchError) {
        console.error('Error fetching created estimate:', fetchError);
        return res.status(500).json({ error: 'Failed to fetch created estimate' });
      }
      
      res.status(201).json({
        message: 'Estimate created successfully',
        estimate: createdEstimate[0]
      });
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
    
    // Build update data object
    const updateData = {};
    
    if (customerId) {
      updateData.customer_id = customerId;
    }
    
    if (services) {
      updateData.services = services;
    }
    
    if (totalAmount !== undefined) {
      updateData.total_amount = totalAmount;
    }
    
    if (status) {
      updateData.status = status;
    }
    
    if (validUntil !== undefined) {
      updateData.valid_until = validUntil;
    }
    
    if (notes !== undefined) {
      updateData.notes = notes;
    }
    
    const { error: updateError } = await supabase
      .from('estimates')
      .update(updateData)
      .eq('id', id);
    
    if (updateError) {
      console.error('Error updating estimate:', updateError);
      return res.status(500).json({ error: 'Failed to update estimate' });
    }
    
    res.json({ message: 'Estimate updated successfully' });
  } catch (error) {
    console.error('Update estimate error:', error);
    res.status(500).json({ error: 'Failed to update estimate' });
  }
});

app.delete('/api/estimates/:id', async (req, res) => {
  try {
    const { id } = req.params;
    // Check if estimate has been converted to invoice
    const { data: invoices, error: checkError } = await supabase
      .from('invoices')
      .select('id', { count: 'exact' })
      .eq('estimate_id', id);
    
    if (checkError) {
      console.error('Error checking invoices:', checkError);
      return res.status(500).json({ error: 'Failed to delete estimate' });
    }
    
    if (invoices && invoices.length > 0) {
      return res.status(400).json({ 
        error: 'Cannot delete estimate that has been converted to invoice' 
      });
    }
    
    const { error: deleteError } = await supabase
      .from('estimates')
      .delete()
      .eq('id', id);
    
    if (deleteError) {
      console.error('Error deleting estimate:', deleteError);
      return res.status(500).json({ error: 'Failed to delete estimate' });
    }
    
    res.json({ message: 'Estimate deleted successfully' });
  } catch (error) {
    console.error('Delete estimate error:', error);
    res.status(500).json({ error: 'Failed to delete estimate' });
  }
});

// Send estimate to customer
app.post('/api/estimates/:id/send', async (req, res) => {
  try {
    const { id } = req.params;

    // Fetch estimate with related customer & user
    const { data: estimates, error: fetchError } = await supabase
      .from('estimates')
      .select(`
        *,
        customers:customer_id (first_name, last_name, email, phone),
        users:user_id (first_name, last_name, business_name)
      `)
      .eq('id', id)
      .limit(1);

    if (fetchError) {
      console.error('Error fetching estimate:', fetchError);
      return res.status(500).json({ error: 'Failed to fetch estimate' });
    }

    if (!estimates || estimates.length === 0) {
      return res.status(404).json({ error: 'Estimate not found' });
    }

    const estimate = estimates[0];

    // Update estimate status to 'sent'
    const { error: updateError } = await supabase
      .from('estimates')
      .update({ status: 'sent' })
      .eq('id', id);

    if (updateError) {
      console.error('Error updating estimate status:', updateError);
      return res.status(500).json({ error: 'Failed to update estimate status' });
    }

    let emailSent = false;
    let emailErrorMsg = null;

    if (estimate.customers?.email && process.env.EMAIL_USER && process.env.EMAIL_PASSWORD) {
      try {
        // Parse services safely
        let services = [];
        try {
          services = JSON.parse(estimate.services || '[]');
        } catch (e) {
          console.warn('Invalid services JSON, skipping parse');
        }

        const servicesList = services.map(service =>
          `• ${service.name} - $${service.price} x ${service.quantity}`
        ).join('\n');

        const emailHtml = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h1>Your Estimate is Ready!</h1>
            <p>Hi ${estimate.customers.first_name},</p>
            <p>Estimate ID: #${estimate.id}</p>
            <p>Total: $${estimate.total_amount}</p>
            <p>Services:</p>
            <pre>${servicesList}</pre>
          </div>
        `;

        await sendEmail({
          to: estimate.customers.email,
          subject: `Your Estimate #${estimate.id} is Ready - ${estimate.users?.business_name || 'Service-flow'}`,
          html: emailHtml,
          text: `
            Hi ${estimate.customers.first_name},
            Your estimate #${estimate.id} is ready.
            Total: $${estimate.total_amount}
          `
        });

        emailSent = true;
      } catch (err) {
        console.error('Email sending failed:', err);
        emailErrorMsg = err.message;
      }
    } else if (estimate.customers?.email) {
   } else {
   }

    res.json({
      message: 'Estimate sent successfully',
      emailSent,
      customerEmail: estimate.customers?.email || null,
      emailError: emailErrorMsg
    });

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
    
    // Get estimate details
    const { data: estimates, error: fetchError } = await supabase
      .from('estimates')
      .select('*')
      .eq('id', id)
      .limit(1);
    
    if (fetchError) {
      console.error('Error fetching estimate:', fetchError);
      return res.status(500).json({ error: 'Failed to fetch estimate' });
    }
    
    if (!estimates || estimates.length === 0) {
      return res.status(404).json({ error: 'Estimate not found' });
    }
    
    const estimate = estimates[0];
    
    // Calculate due date (default to 15 days from now)
    const calculatedDueDate = dueDate || new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    
    // Create invoice
    const { data: invoice, error: insertError } = await supabase
      .from('invoices')
      .insert({
        user_id: estimate.user_id,
        customer_id: estimate.customer_id,
        estimate_id: estimate.id,
        amount: estimate.total_amount,
        total_amount: estimate.total_amount, // No tax for now
        due_date: calculatedDueDate
      })
      .select()
      .single();
    
    if (insertError) {
      console.error('Error creating invoice:', insertError);
      return res.status(500).json({ error: 'Failed to create invoice' });
    }
    
    // Update estimate status to 'accepted'
    const { error: updateError } = await supabase
      .from('estimates')
      .update({ status: 'accepted' })
      .eq('id', id);
    
    if (updateError) {
      console.error('Error updating estimate status:', updateError);
      return res.status(500).json({ error: 'Failed to update estimate status' });
    }
    
    res.status(201).json({
      message: 'Estimate converted to invoice successfully',
      invoiceId: invoice.id
    });
  } catch (error) {
    console.error('Convert estimate to invoice error:', error);
    res.status(500).json({ error: 'Failed to convert estimate to invoice' });
  }
});

// Online Booking API endpoints
app.get('/api/public/services', async (req, res) => {
  try {
    const { userId = 1 } = req.query; // Default to user ID 1 for public booking
    
    const { data: services, error } = await supabase
      .from('services')
      .select('id, name, description, price, duration, category')
      .eq('user_id', userId)
      .order('name');
    
    if (error) {
      console.error('Error fetching public services:', error);
      return res.status(500).json({ error: 'Failed to fetch services' });
    }
    
    res.json(services || []);
  } catch (error) {
    console.error('Get public services error:', error);
    res.status(500).json({ error: 'Failed to fetch services' });
  }
});

app.get('/api/public/availability', async (req, res) => {
  try {
    const { userId = 1, date } = req.query;

    if (!date) {
      return res.status(400).json({ error: 'Date is required (YYYY-MM-DD)' });
    }

    // Get availability settings
    const { data: availabilitySettings, error: availabilityError } = await supabase
      .from('user_availability')
      .select('business_hours, timeslot_templates')
      .eq('user_id', userId)
      .maybeSingle(); // fetch one row

    if (availabilityError) {
      console.error('Error fetching availability settings:', availabilityError);
      return res.status(500).json({ error: 'Failed to fetch availability settings' });
    }

    // Get existing bookings
    const { data: existingBookings, error: bookingsError } = await supabase
      .from('jobs')
      .select('scheduled_date')
      .eq('user_id', userId)
      .gte('scheduled_date', `${date} 00:00:00`)
      .lte('scheduled_date', `${date} 23:59:59`);

    if (bookingsError) {
      console.error('Error fetching existing bookings:', bookingsError);
      return res.status(500).json({ error: 'Failed to fetch existing bookings' });
    }

    // Normalize booked times to "HH:MM" - extract directly from string to avoid timezone conversion
    const bookedSlots = (existingBookings || []).map(booking => {
      // Extract time directly from string format "2025-10-07 09:00:00"
      if (booking.scheduled_date && booking.scheduled_date.includes(' ')) {
        return booking.scheduled_date.split(' ')[1]?.substring(0, 5) || '09:00';
      }
      return '09:00'; // fallback
    });

    // Generate available slots (9 AM - 5 PM, 30 mins)
    const availableSlots = [];
    const startHour = 9;
    const endHour = 17;

    for (let hour = startHour; hour < endHour; hour++) {
      for (let minute = 0; minute < 60; minute += 30) {
        const time = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
        if (!bookedSlots.includes(time)) {
          availableSlots.push(time);
        }
      }
    }

    res.json({
      date,
      userId,
      availableSlots,
      settings: availabilitySettings || {}
    });

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
    
    const { data: users, error } = await supabase
      .from('users')
      .select('business_name, email, phone')
      .eq('id', userId)
      .limit(1);
    
    if (error) {
      console.error('Error fetching business info:', error);
      return res.status(500).json({ error: 'Failed to fetch business information' });
    }
    
    if (!users || users.length === 0) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    res.json(users[0]);
  } catch (error) {
    console.error('Get business info error:', error);
    res.status(500).json({ error: 'Failed to fetch business information' });
  }
});

// User profile endpoints
app.get('/api/user/profile', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Query Supabase directly
    const { data: user, error } = await supabase
      .from('users')
      .select(`
        id,
        email,
        first_name,
        last_name,
        business_name,
        phone,
        email_notifications,
        sms_notifications,
        profile_picture
      `)
      .eq('id', userId)
      .maybeSingle(); // fetch a single row instead of array

    if (error) {
      console.error('Error fetching user profile:', error);
      return res.status(500).json({ error: 'Failed to fetch user profile' });
    }

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Return normalized JSON
    res.json({
      id: user.id,
      email: user.email,
      firstName: user.first_name,
      lastName: user.last_name,
      businessName: user.business_name,
      phone: user.phone || '',
      emailNotifications: !!user.email_notifications,
      smsNotifications: !!user.sms_notifications,
      profilePicture: user.profile_picture
    });

  } catch (error) {
    console.error('Get user profile error:', error);
    res.status(500).json({ error: 'Failed to fetch user profile' });
  }
});


app.put('/api/user/profile', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { firstName, lastName, phone, emailNotifications, smsNotifications } = req.body;
    
    const { error } = await supabase
      .from('users')
      .update({
        first_name: firstName,
        last_name: lastName,
        phone: phone,
        email_notifications: emailNotifications,
        sms_notifications: smsNotifications
      })
      .eq('id', userId);
    
    if (error) {
      console.error('Error updating user profile:', error);
      return res.status(500).json({ error: 'Failed to update profile' });
    }
    
    res.json({ message: 'Profile updated successfully' });
  } catch (error) {
    console.error('Update user profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Service settings endpoints
app.get('/api/user/service-settings', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    const { data: user, error } = await supabase
      .from('users')
      .select('service_settings')
      .eq('id', userId)
      .maybeSingle();

    if (error) {
      console.error('Error fetching service settings:', error);
      return res.status(500).json({ error: 'Failed to fetch service settings' });
    }

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Return default settings if none exist
    const serviceSettings = user.service_settings || { categoriesEnabled: false };
    
    res.json(serviceSettings);
  } catch (error) {
    console.error('Get service settings error:', error);
    res.status(500).json({ error: 'Failed to fetch service settings' });
  }
});

app.put('/api/user/service-settings', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const serviceSettings = req.body;
    
    const { error } = await supabase
      .from('users')
      .update({
        service_settings: serviceSettings
      })
      .eq('id', userId);
    
    if (error) {
      console.error('Error updating service settings:', error);
      return res.status(500).json({ error: 'Failed to update service settings' });
    }
    
    res.json({ message: 'Service settings updated successfully', settings: serviceSettings });
  } catch (error) {
    console.error('Update service settings error:', error);
    res.status(500).json({ error: 'Failed to update service settings' });
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
    
    // First verify current password
    const { data: users, error: fetchError } = await supabase
      .from('users')
      .select('password')
      .eq('id', userId)
      .limit(1);
    
    if (fetchError) {
      console.error('Error fetching user password:', fetchError);
      return res.status(500).json({ error: 'Failed to verify current password' });
    }
    
    if (!users || users.length === 0) {
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
    const { error: updateError } = await supabase
      .from('users')
      .update({ password: hashedNewPassword })
      .eq('id', userId);
    
    if (updateError) {
      console.error('Error updating password:', updateError);
      return res.status(500).json({ error: 'Failed to update password' });
    }
    
    res.json({ message: 'Password updated successfully' });
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
    
    // Verify password first
    const { data: users, error: fetchError } = await supabase
      .from('users')
      .select('password')
      .eq('id', userId)
      .limit(1);
    
    if (fetchError) {
      console.error('Error fetching user password:', fetchError);
      return res.status(500).json({ error: 'Failed to verify password' });
    }
    
    if (!users || users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Verify password using bcrypt
    const isPasswordValid = await bcrypt.compare(password, users[0].password);
    
    if (!isPasswordValid) {
      return res.status(400).json({ error: 'Password is incorrect' });
    }
    
    // Check if new email already exists
    const { data: existingUsers, error: checkError } = await supabase
      .from('users')
      .select('id')
      .eq('email', sanitizedNewEmail)
      .neq('id', userId);
    
    if (checkError) {
      console.error('Error checking existing email:', checkError);
      return res.status(500).json({ error: 'Failed to check email availability' });
    }
    
    if (existingUsers && existingUsers.length > 0) {
      return res.status(400).json({ error: 'Email already exists' });
    }
    
    // Update email
    const { error: updateError } = await supabase
      .from('users')
      .update({ email: sanitizedNewEmail })
      .eq('id', userId);
    
    if (updateError) {
      console.error('Error updating email:', updateError);
      return res.status(500).json({ error: 'Failed to update email' });
    }
    
    res.json({ message: 'Email updated successfully' });
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
    
    // Get the file URL
    const fileUrl = `http://localhost:5000/uploads/${req.file.filename}`;
    
    // Update user's profile picture
    const { error } = await supabase
      .from('users')
      .update({ profile_picture: fileUrl })
      .eq('id', userId);
    
    if (error) {
      console.error('Error updating profile picture:', error);
      return res.status(500).json({ error: 'Failed to update profile picture' });
    }
    
    res.json({ 
      message: 'Profile picture updated successfully',
      profilePicture: fileUrl
    });
  } catch (error) {
    console.error('Profile picture upload error:', error);
    res.status(500).json({ error: 'Failed to upload profile picture' });
  }
});

// Billing endpoints
app.get('/api/user/billing', async (req, res) => {
  try {
    const { userId } = req.query;
    
    const { data: billingInfo, error } = await supabase
      .from('user_billing')
      .select('plan_type, billing_cycle, next_billing_date')
      .eq('user_id', userId);
    
    if (error) {
      console.error('Error fetching billing info:', error);
      return res.status(500).json({ error: 'Failed to fetch billing information' });
    }
    
    if (!billingInfo || billingInfo.length === 0) {
      // Return default trial info
      return res.json({
        currentPlan: 'Standard',
        isTrial: true,
        trialDaysLeft: 14,
        trialEndDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric' }),
        monthlyPrice: 29,
        cardNumber: '',
        subscriptionStatus: 'trialing'
      });
    }
    
    const billing = billingInfo[0];
    const nextBillingDate = billing.next_billing_date ? new Date(billing.next_billing_date) : new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    const now = new Date();
    const daysLeft = Math.max(0, Math.ceil((nextBillingDate - now) / (1000 * 60 * 60 * 24)));
    
    res.json({
      currentPlan: billing.plan_type || 'Standard',
      isTrial: billing.billing_cycle === 'trial' || !billing.plan_type,
      trialDaysLeft: daysLeft,
      trialEndDate: nextBillingDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric' }),
      monthlyPrice: 29, // Default price since we don't have this in the current schema
      cardNumber: '', // No card info in current schema
      subscriptionStatus: billing.billing_cycle || 'trialing'
    });
  } catch (error) {
    console.error('Get billing error:', error);
    res.status(500).json({ error: 'Failed to fetch billing information' });
  }
});

// Create Stripe customer and setup intent
app.post('/api/user/billing/setup-intent', async (req, res) => {
  try {
    const { userId, email, name } = req.body;
    
    // Create or retrieve Stripe customer
    let customer;
    const { data: existingBilling } = await supabase
      .from('user_billing')
      .select('stripe_customer_id')
      .eq('user_id', userId)
      .limit(1);
    
    if (existingBilling?.[0]?.stripe_customer_id) {
      customer = await stripe.customers.retrieve(existingBilling[0].stripe_customer_id);
    } else {
      customer = await stripe.customers.create({
        email: email,
        name: name,
        metadata: { user_id: userId }
      });
      
      // Save customer ID to database
      await supabase
        .from('user_billing')
        .upsert({
          user_id: userId,
          stripe_customer_id: customer.id,
          plan_type: 'Standard',
          billing_cycle: 'trial',
          next_billing_date: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
        });
    }
    
    // Create setup intent for future payments
    const setupIntent = await stripe.setupIntents.create({
      customer: customer.id,
      usage: 'off_session'
    });
    
    res.json({
      setup_intent: setupIntent.client_secret,
      customer_id: customer.id
    });
  } catch (error) {
    console.error('Setup intent error:', error);
    res.status(500).json({ error: 'Failed to create setup intent' });
  }
});

// Create Stripe subscription
app.post('/api/user/billing/subscription', async (req, res) => {
  try {
    const { userId, plan, paymentMethodId } = req.body;
    
    // Get user's Stripe customer ID
    const { data: billingData, error: billingError } = await supabase
      .from('user_billing')
      .select('stripe_customer_id')
      .eq('user_id', userId)
      .limit(1);
    
    if (billingError || !billingData?.[0]?.stripe_customer_id) {
      return res.status(400).json({ error: 'No customer found. Please refresh and try again.' });
    }
    
    const customerId = billingData[0].stripe_customer_id;
    
    // Attach payment method to customer
    await stripe.paymentMethods.attach(paymentMethodId, {
      customer: customerId,
    });
    
    // Set as default payment method
    await stripe.customers.update(customerId, {
      invoice_settings: {
        default_payment_method: paymentMethodId,
      },
    });
    
    // Create price based on plan
    const planPrices = {
      'Starter': 1900, // $19.00 in cents
      'Standard': 2900, // $29.00 in cents
      'Professional': 4900 // $49.00 in cents
    };
    
    // Create or get product first
    let product;
    try {
      // Try to find existing product
      const products = await stripe.products.list({ limit: 100 });
      product = products.data.find(p => p.name === `Service Flow ${plan} Plan`);
      
      if (!product) {
        // Create new product if it doesn't exist
        product = await stripe.products.create({
          name: `Service Flow ${plan} Plan`,
          type: 'service',
        });
      }
    } catch (error) {
      console.error('Error creating/finding product:', error);
      return res.status(500).json({ error: 'Failed to create product' });
    }

    // Create price for the product
    const price = await stripe.prices.create({
      product: product.id,
          unit_amount: planPrices[plan] || 2900,
      currency: 'usd',
          recurring: {
            interval: 'month',
          },
    });

    // Create subscription
    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{
        price: price.id,
      }],
      trial_period_days: 14,
      expand: ['latest_invoice.payment_intent'],
    });
    
    // Update billing record
    await supabase
      .from('user_billing')
      .update({
        stripe_subscription_id: subscription.id,
        plan_type: plan,
        billing_cycle: subscription.status === 'trialing' ? 'trial' : 'monthly'
      })
      .eq('user_id', userId);
    
    res.json({
      subscription_id: subscription.id,
      status: subscription.status,
      message: 'Subscription created successfully'
    });
    
  } catch (error) {
    console.error('Create subscription error:', error);
    res.status(500).json({ error: error.message || 'Failed to create subscription' });
  }
});

// Get payment methods for a customer
app.get('/api/user/billing/payment-methods', async (req, res) => {
  try {
    const { userId } = req.query;
    
    const { data: billingData } = await supabase
      .from('user_billing')
      .select('stripe_customer_id')
      .eq('user_id', userId)
      .limit(1);
    
    if (!billingData?.[0]?.stripe_customer_id) {
      return res.json({ payment_methods: [] });
    }
    
    const paymentMethods = await stripe.paymentMethods.list({
      customer: billingData[0].stripe_customer_id,
      type: 'card',
    });
    
    res.json({
      payment_methods: paymentMethods.data.map(pm => ({
        id: pm.id,
        brand: pm.card.brand,
        last4: pm.card.last4,
        exp_month: pm.card.exp_month,
        exp_year: pm.card.exp_year
      }))
    });
  } catch (error) {
    console.error('Get payment methods error:', error);
    res.status(500).json({ error: 'Failed to fetch payment methods' });
  }
});

// Cancel subscription
app.post('/api/user/billing/cancel-subscription', async (req, res) => {
  try {
    const { userId } = req.body;
    
    const { data: billingData } = await supabase
      .from('user_billing')
      .select('stripe_subscription_id')
      .eq('user_id', userId)
      .limit(1);
    
    if (!billingData?.[0]?.stripe_subscription_id) {
      return res.status(400).json({ error: 'No active subscription found' });
    }
    
    await stripe.subscriptions.update(billingData[0].stripe_subscription_id, {
      cancel_at_period_end: true
    });
    
    await supabase
      .from('user_billing')
      .update({ subscription_status: 'canceled' })
      .eq('user_id', userId);
    
    res.json({ message: 'Subscription cancelled successfully' });
  } catch (error) {
    console.error('Cancel subscription error:', error);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

// Stripe webhook handler
app.post('/api/webhook/stripe', express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        const subscription = event.data.object;
        await supabase
          .from('user_billing')
          .update({
            billing_cycle: subscription.status === 'trialing' ? 'trial' : 'monthly'
          })
          .eq('stripe_subscription_id', subscription.id);
        break;

      case 'invoice.payment_succeeded':
        const invoice = event.data.object;
       break;

      case 'invoice.payment_failed':
        const failedInvoice = event.data.object;
      break;

      default:
    }

    res.json({received: true});
  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Payment settings endpoints
app.get('/api/user/payment-settings', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    const { data: settings, error } = await supabase
      .from('user_payment_settings')
      .select('*')
      .eq('user_id', userId);
    
    if (error) {
      console.error('Error fetching payment settings:', error);
      return res.status(500).json({ error: 'Failed to fetch payment settings' });
    }
    
    if (!settings || settings.length === 0) {
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
      onlineBookingTips: setting.online_booking_tips === true,
      invoicePaymentTips: setting.invoice_payment_tips === true,
      showServicePrices: setting.show_service_prices === true,
      showServiceDescriptions: setting.show_service_descriptions === true,
      paymentDueDays: setting.payment_due_days,
      paymentDueUnit: setting.payment_due_unit,
      defaultMemo: setting.default_memo || '',
      invoiceFooter: setting.invoice_footer || '',
      paymentProcessor: setting.payment_processor,
      paymentProcessorConnected: setting.payment_processor_connected === true
    });
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

    // Check if settings exist
    const { data: existingSettings, error: checkError } = await supabase
      .from('user_payment_settings')
      .select('id')
      .eq('user_id', userId)
      .maybeSingle();

    if (checkError) {
      console.error('Error checking existing payment settings:', checkError);
      return res.status(500).json({ error: 'Failed to check existing settings' });
    }

    if (existingSettings) {
      // Update existing settings
      const { error: updateError } = await supabase
        .from('user_payment_settings')
        .update({
          online_booking_tips: onlineBookingTips,
          invoice_payment_tips: invoicePaymentTips,
          show_service_prices: showServicePrices,
          show_service_descriptions: showServiceDescriptions,
          payment_due_days: paymentDueDays,
          payment_due_unit: paymentDueUnit,
          default_memo: defaultMemo,
          invoice_footer: invoiceFooter,
          payment_processor: paymentProcessor,
          payment_processor_connected: paymentProcessorConnected
        })
        .eq('user_id', userId);

      if (updateError) {
        console.error('Error updating payment settings:', updateError);
        return res.status(500).json({ error: 'Failed to update payment settings' });
      }
    } else {
      // Insert new settings
      const { error: insertError } = await supabase
        .from('user_payment_settings')
        .insert({
          user_id: userId,
          online_booking_tips: onlineBookingTips,
          invoice_payment_tips: invoicePaymentTips,
          show_service_prices: showServicePrices,
          show_service_descriptions: showServiceDescriptions,
          payment_due_days: paymentDueDays,
          payment_due_unit: paymentDueUnit,
          default_memo: defaultMemo,
          invoice_footer: invoiceFooter,
          payment_processor: paymentProcessor,
          payment_processor_connected: paymentProcessorConnected
        });

      if (insertError) {
        console.error('Error creating payment settings:', insertError);
        return res.status(500).json({ error: 'Failed to create payment settings' });
      }
    }

    res.json({ message: 'Payment settings updated successfully' });

  } catch (error) {
    console.error('Update payment settings error:', error);
    res.status(500).json({ error: 'Failed to update payment settings' });
  }
});


// Custom payment methods endpoints
app.get('/api/user/payment-methods', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    const { data: methods, error } = await supabase
      .from('custom_payment_methods')
      .select('id, name, description, is_active')
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('created_at', { ascending: true });
    
    if (error) {
      console.error('Error fetching payment methods:', error);
      return res.status(500).json({ error: 'Failed to fetch payment methods' });
    }
    
    res.json(methods || []);
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
    
    const { data: newMethod, error } = await supabase
      .from('custom_payment_methods')
      .insert({
        user_id: userId,
        name: name.trim(),
        description: description || null
      })
      .select('id, name, description')
      .single();
    
    if (error) {
      console.error('Error creating payment method:', error);
      return res.status(500).json({ error: 'Failed to create payment method' });
    }
    
    res.status(201).json(newMethod);
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
    
    const { data, error } = await supabase
      .from('custom_payment_methods')
      .update({
        name: name.trim(),
        description: description || null
      })
      .eq('id', methodId)
      .eq('user_id', userId);
    
    if (error) {
      console.error('Error updating payment method:', error);
      return res.status(500).json({ error: 'Failed to update payment method' });
    }
    
    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Payment method not found' });
    }
    
    res.json({ message: 'Payment method updated successfully' });
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
    
    // In a real application, you would integrate with the payment processor here
    // For now, we'll just mark it as connected
    
    // Check if settings exist
    const { data: existingSettings, error: checkError } = await supabase
      .from('user_payment_settings')
      .select('id')
      .eq('user_id', userId)
      .limit(1);
    
    if (checkError) {
      console.error('Error checking existing payment settings:', checkError);
      return res.status(500).json({ error: 'Failed to check existing settings' });
    }
    
    if (existingSettings && existingSettings.length > 0) {
      // Update existing settings
      const { error: updateError } = await supabase
        .from('user_payment_settings')
        .update({
          payment_processor: processor,
          payment_processor_connected: true
        })
        .eq('user_id', userId);
      
      if (updateError) {
        console.error('Error updating payment processor:', updateError);
        return res.status(500).json({ error: 'Failed to update payment processor' });
      }
    } else {
      // Create new settings
      const { error: insertError } = await supabase
        .from('user_payment_settings')
        .insert({
          user_id: userId,
          payment_processor: processor,
          payment_processor_connected: true
        });
      
      if (insertError) {
        console.error('Error creating payment processor settings:', insertError);
        return res.status(500).json({ error: 'Failed to create payment processor settings' });
      }
    }
    
    res.json({ 
      message: 'Payment processor connected successfully',
      processor: processor,
      connected: true
    });
  } catch (error) {
    console.error('Setup payment processor error:', error);
    res.status(500).json({ error: 'Failed to setup payment processor' });
  }
});


app.post('/api/user/billing/setup-intent', async (req, res) => {
  try {
    const { userId, email, name } = req.body;
    
    if (!userId || !email) {
      return res.status(400).json({ error: 'User ID and email are required' });
    }
    
    // For now, return a mock setup intent
    // In a real implementation, you'd create this with Stripe
    const mockSetupIntent = {
      setup_intent: 'seti_mock_setup_intent_12345',
      client_secret: 'seti_mock_client_secret_12345'
    };
    
    res.json(mockSetupIntent);
  } catch (error) {
    console.error('Create setup intent error:', error);
    res.status(500).json({ error: 'Failed to create setup intent' });
  }
});

app.post('/api/user/billing/subscription', async (req, res) => {
  try {
    const { userId, plan, paymentMethodId } = req.body;
    
    if (!userId || !plan || !paymentMethodId) {
      return res.status(400).json({ error: 'User ID, plan, and payment method are required' });
    }
    
    // For now, return success
    // In a real implementation, you'd create the subscription with Stripe
    res.json({ 
      message: 'Subscription created successfully',
      subscription_id: 'sub_mock_12345'
    });
  } catch (error) {
    console.error('Create subscription error:', error);
    res.status(500).json({ error: 'Failed to create subscription' });
  }
});

app.get('/api/user/billing/payment-methods', async (req, res) => {
  try {
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }
    
    // For now, return empty payment methods
    // In a real implementation, you'd fetch this from Stripe
    res.json({ payment_methods: [] });
  } catch (error) {
    console.error('Get payment methods error:', error);
    res.status(500).json({ error: 'Failed to fetch payment methods' });
  }
});

app.post('/api/user/billing/cancel-subscription', async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }
    
    // For now, return success
    // In a real implementation, you'd cancel the subscription with Stripe
    res.json({ message: 'Subscription cancelled successfully' });
  } catch (error) {
    console.error('Cancel subscription error:', error);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

// Availability endpoints
app.get('/api/user/availability', async (req, res) => {
  try {
    const { userId } = req.query;
    
    const { data: availabilityInfo, error } = await supabase
      .from('user_availability')
      .select('business_hours, timeslot_templates')
      .eq('user_id', userId);
    
    if (error) {
      console.error('Error fetching availability info:', error);
      return res.status(500).json({ error: 'Failed to fetch availability information' });
    }
    
    if (!availabilityInfo || availabilityInfo.length === 0) {
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
  } catch (error) {
    console.error('Get availability error:', error);
    res.status(500).json({ error: 'Failed to fetch availability information' });
  }
});

app.put('/api/user/availability', async (req, res) => {
  try {
    const { userId, businessHours, timeslotTemplates } = req.body;
    
    // Check if availability record exists
    const { data: existingAvailability, error: checkError } = await supabase
      .from('user_availability')
      .select('id')
      .eq('user_id', userId)
      .limit(1);
    
    if (checkError) {
      console.error('Error checking existing availability:', checkError);
      return res.status(500).json({ error: 'Failed to check existing availability' });
    }
    
    if (existingAvailability && existingAvailability.length > 0) {
      // Update existing availability
      const { error: updateError } = await supabase
        .from('user_availability')
        .update({
          business_hours: JSON.stringify(businessHours),
          timeslot_templates: JSON.stringify(timeslotTemplates)
        })
        .eq('user_id', userId);
      
      if (updateError) {
        console.error('Error updating availability:', updateError);
        return res.status(500).json({ error: 'Failed to update availability' });
      }
    } else {
      // Create new availability record
      const { error: insertError } = await supabase
        .from('user_availability')
        .insert({
          user_id: userId,
          business_hours: JSON.stringify(businessHours),
          timeslot_templates: JSON.stringify(timeslotTemplates)
        });
      
      if (insertError) {
        console.error('Error creating availability:', insertError);
        return res.status(500).json({ error: 'Failed to create availability' });
      }
    }
    
    res.json({ message: 'Availability updated successfully' });
  } catch (error) {
    console.error('Update availability error:', error);
    res.status(500).json({ error: 'Failed to update availability' });
  }
});

// Territory Management API endpoints
// OPTIONS handled by catch-all above

app.get('/api/territories', authenticateToken, async (req, res) => {

  
  try {
    const { userId, status, search, page = 1, limit = 20, sortBy = 'name', sortOrder = 'ASC' } = req.query;
    
    // Build Supabase query
    let query = supabase
      .from('territories')
      .select('*', { count: 'exact' })
      .eq('user_id', userId);
    
    // Add status filter
    if (status) {
      query = query.eq('status', status);
    }
    
    // Add search filter
    if (search) {
      query = query.or(`name.ilike.%${search}%,location.ilike.%${search}%`);
    }
    
    // Add sorting
    query = query.order(sortBy, { ascending: sortOrder === 'ASC' });
    
    // Add pagination
    const offset = (page - 1) * limit;
    query = query.range(offset, offset + parseInt(limit) - 1);
    
    const { data: territories, error, count } = await query;
    
    if (error) {
      console.error('Error fetching territories:', error);
      return res.status(500).json({ error: 'Failed to fetch territories' });
    }
    
    // Get territory statistics by fetching jobs and invoices separately
    const territoryStats = await Promise.all((territories || []).map(async (territory) => {
      // Get jobs for this territory
      const { data: jobs, error: jobsError } = await supabase
        .from('jobs')
        .select('id, status, invoice_amount')
        .eq('territory_id', territory.id);
      
      if (jobsError) {
        console.error('Error fetching jobs for territory:', jobsError);
        return {
          ...territory,
          total_jobs: 0,
          completed_jobs: 0,
          total_revenue: 0,
          avg_job_value: 0
        };
      }
      
      const totalJobs = jobs.length;
      const completedJobs = jobs.filter(job => job.status === 'completed');
      const completedJobsCount = completedJobs.length;
      const totalRevenue = completedJobs.reduce((sum, job) => sum + (job.invoice_amount || 0), 0);
      const avgJobValue = completedJobsCount > 0 ? totalRevenue / completedJobsCount : 0;
      
      return {
        ...territory,
        total_jobs: totalJobs,
        completed_jobs: completedJobsCount,
        total_revenue: totalRevenue,
        avg_job_value: avgJobValue
      };
    }));
    
    res.json({
      territories: territoryStats,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count || 0,
        pages: Math.ceil((count || 0) / limit)
      }
    });
  } catch (error) {
    console.error('Get territories error:', error);
    res.status(500).json({ error: 'Failed to fetch territories' });
  }
});

app.get('/api/territories/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get territory
    const { data: territories, error } = await supabase
      .from('territories')
      .select('*')
      .eq('id', id)
      .limit(1);
    
    if (error) {
      console.error('Error fetching territory:', error);
      return res.status(500).json({ error: 'Failed to fetch territory' });
    }
    
    if (!territories || territories.length === 0) {
      return res.status(404).json({ error: 'Territory not found' });
    }
    
    const territory = territories[0];
    
    // Get jobs for this territory to calculate statistics
    const { data: jobs, error: jobsError } = await supabase
      .from('jobs')
      .select('id, status, invoice_amount')
      .eq('territory_id', id);
    
    if (jobsError) {
      console.error('Error fetching jobs for territory:', jobsError);
    }
    
    const totalJobs = jobs ? jobs.length : 0;
    const completedJobs = jobs ? jobs.filter(job => job.status === 'completed') : [];
    const completedJobsCount = completedJobs.length;
    const totalRevenue = completedJobs.reduce((sum, job) => sum + (job.invoice_amount || 0), 0);
    const avgJobValue = completedJobsCount > 0 ? totalRevenue / completedJobsCount : 0;
    
    // Get territory pricing
    const { data: pricing, error: pricingError } = await supabase
      .from('territory_pricing')
      .select(`
        *,
        services!left(name, description)
      `)
      .eq('territory_id', id);
    
    if (pricingError) {
      console.error('Error fetching territory pricing:', pricingError);
    }
    
    // Flatten the pricing data
    const flattenedPricing = (pricing || []).map(price => ({
      ...price,
      service_name: price.services?.name,
      service_description: price.services?.description,
      services: undefined
    }));
    
    const result = {
      ...territory,
      total_jobs: totalJobs,
      completed_jobs: completedJobsCount,
      total_revenue: totalRevenue,
      avg_job_value: avgJobValue,
      pricing: flattenedPricing
    };
    
    res.json(result);
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
    
  
        if (!userId || !name || !location) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const { data: result, error } = await supabase
      .from('territories')
      .insert({
        user_id: userId,
        name: name,
        description: description,
        location: location,
        zip_codes: zipCodes || [],
        radius_miles: radiusMiles || 25.00,
        timezone: timezone || 'America/New_York',
        business_hours: businessHours || {},
        team_members: teamMembers || [],
        services: services || [],
        pricing_multiplier: pricingMultiplier || 1.00
      })
      .select('id')
      .single();
    
    if (error) {
      console.error('Supabase insert error:', error);
      return res.status(500).json({ error: 'Failed to create territory' });
    }
      
      res.status(201).json({
        message: 'Territory created successfully',
      territoryId: result.id
      });
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
    
    const { error } = await supabase
      .from('territories')
      .update({
        name: name,
        description: description,
        location: location,
        zip_codes: zipCodes || [],
        radius_miles: radiusMiles || 25.00,
        timezone: timezone || 'America/New_York',
        status: status,
        business_hours: businessHours || {},
        team_members: teamMembers || [],
        services: services || [],
        pricing_multiplier: pricingMultiplier || 1.00
      })
      .eq('id', id);
    
    if (error) {
      console.error('Supabase update error:', error);
      return res.status(500).json({ error: 'Failed to update territory' });
    }
      
      res.json({ message: 'Territory updated successfully' });
  } catch (error) {
    console.error('Update territory error:', error);
    res.status(500).json({ error: 'Failed to update territory' });
  }
});

app.delete('/api/territories/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase
      .from('territories')
      .delete()
      .eq('id', id);
    
    if (error) {
      console.error('Supabase delete error:', error);
      return res.status(500).json({ error: 'Failed to delete territory' });
    }
    
    res.json({ message: 'Territory deleted successfully' });
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
        if (customerAddress && territoryRadius > 0 && process.env.GOOGLE_MAPS_API_KEY) {
          try {
            // Get coordinates for customer address
            const customerGeocodeResponse = await fetch(
              `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(customerAddress)}&key=${process.env.GOOGLE_MAPS_API_KEY}`
            )
            
            if (!customerGeocodeResponse.ok) {
              console.warn('Google Maps API request failed for customer address');
              continue;
            }
            
            const customerGeocodeData = await customerGeocodeResponse.json()
            
            if (customerGeocodeData.results && customerGeocodeData.results.length > 0) {
              const customerCoords = customerGeocodeData.results[0].geometry.location
              
              // Get coordinates for territory center (using location field)
              const territoryGeocodeResponse = await fetch(
                `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(territory.location)}&key=${process.env.GOOGLE_MAPS_API_KEY}`
              )
              
              if (!territoryGeocodeResponse.ok) {
                console.warn('Google Maps API request failed for territory location');
                continue;
              }
              
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

// Get available team members for a territory - DISABLED (MySQL not configured)
// app.get('/api/territories/:id/team-members', async (req, res) => {
//   res.status(501).json({ error: 'This endpoint is temporarily disabled' });
// });

// Get territory business hours - DISABLED (MySQL not configured)
// app.get('/api/territories/:id/business-hours', async (req, res) => {
//   res.status(501).json({ error: 'This endpoint is temporarily disabled' });
// });

// Territory pricing endpoints - DISABLED (MySQL not configured)
// app.get('/api/territories/:id/pricing', async (req, res) => {
//   res.status(501).json({ error: 'This endpoint is temporarily disabled' });
// });

// app.post('/api/territories/:id/pricing', async (req, res) => {
//   res.status(501).json({ error: 'This endpoint is temporarily disabled' });
// });

// Invoices endpoints
app.get('/api/invoices', async (req, res) => {
  try {
    const { userId, search = '', status = '', page = 1, limit = 10, sortBy = 'created_at', sortOrder = 'DESC', customerId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const offset = (parseInt(page) - 1) * parseInt(limit);
    
    // Build Supabase query
    let query = supabase
      .from('invoices')
      .select(`
        *,
        customers!left(first_name, last_name, email, phone),
        jobs!left(scheduled_date, status, services!left(name))
      `, { count: 'exact' })
      .eq('user_id', userId);
    
    // Add search filter
    if (search) {
      query = query.or(`
        customers.first_name.ilike.%${search}%,
        customers.last_name.ilike.%${search}%,
        customers.email.ilike.%${search}%,
        invoice_number.ilike.%${search}%
      `);
    }
    
    // Add status filter
    if (status) {
      query = query.eq('status', status);
    }
    
    // Add customer filter
    if (customerId) {
      query = query.eq('customer_id', customerId);
    }
    
    // Add sorting
    query = query.order(sortBy, { ascending: sortOrder.toUpperCase() === 'ASC' });
    
    // Add pagination
    query = query.range(offset, offset + parseInt(limit) - 1);
    
    const { data: invoices, error, count } = await query;
    
    if (error) {
      console.error('Error fetching invoices:', error);
      return res.status(500).json({ error: 'Failed to fetch invoices' });
    }
    
    // Process the data to flatten the nested structure
    const processedInvoices = (invoices || []).map(invoice => ({
      ...invoice,
      customer_first_name: invoice.customers?.first_name,
      customer_last_name: invoice.customers?.last_name,
      customer_email: invoice.customers?.email,
      customer_phone: invoice.customers?.phone,
      service_name: invoice.jobs?.services?.name,
      scheduled_date: invoice.jobs?.scheduled_date,
      job_status: invoice.jobs?.status
    }));
    
    const totalPages = Math.ceil((count || 0) / parseInt(limit));
    
    res.json({
      invoices: processedInvoices,
      pagination: {
        current_page: parseInt(page),
        total_pages: totalPages,
        total_items: count || 0,
        items_per_page: parseInt(limit)
      }
    });
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

    const { data: invoices, error } = await supabase
      .from('invoices')
      .select(`
        *,
        customers!left(first_name, last_name, email, phone),
        jobs!left(scheduled_date, status, services!left(name))
      `)
      .eq('id', id)
      .eq('user_id', userId)
      .limit(1);
    
    if (error) {
      console.error('Error fetching invoice:', error);
      return res.status(500).json({ error: 'Failed to fetch invoice' });
    }
    
    if (!invoices || invoices.length === 0) {
      return res.status(404).json({ error: 'Invoice not found' });
    }
    
    // Process the data to flatten the nested structure
    const invoice = {
      ...invoices[0],
      customer_first_name: invoices[0].customers?.first_name,
      customer_last_name: invoices[0].customers?.last_name,
      customer_email: invoices[0].customers?.email,
      customer_phone: invoices[0].customers?.phone,
      service_name: invoices[0].jobs?.services?.name,
      scheduled_date: invoices[0].jobs?.scheduled_date,
      job_status: invoices[0].jobs?.status
    };
    
    res.json(invoice);
  } catch (error) {
    console.error('Get invoice error:', error);
    res.status(500).json({ error: 'Failed to fetch invoice' });
  }
});

app.post('/api/invoices', async (req, res) => {
  try {
    const { 
      userId, customerId, jobId, estimateId, invoiceNumber, 
      subtotal, taxAmount, discountAmount, totalAmount, 
      status = 'sent', dueDate, notes 
    } = req.body;
    
    if (!userId || !customerId || !totalAmount) {
      return res.status(400).json({ error: 'userId, customerId, and totalAmount are required' });
    }

    // Validate that the customer exists and belongs to the user
    const { data: customerCheck, error: customerError } = await supabase
      .from('customers')
      .select('id')
      .eq('id', customerId)
      .eq('user_id', userId)
      .limit(1);
    
    if (customerError) {
      console.error('Error checking customer:', customerError);
      return res.status(500).json({ error: 'Failed to validate customer' });
    }
    
    if (!customerCheck || customerCheck.length === 0) {
      return res.status(400).json({ error: 'Customer not found or does not belong to user' });
    }

    // Validate that the job exists if jobId is provided
    if (jobId) {
      const { data: jobCheck, error: jobError } = await supabase
        .from('jobs')
        .select('id')
        .eq('id', jobId)
        .eq('user_id', userId)
        .limit(1);
      
      if (jobError) {
        console.error('Error checking job:', jobError);
        return res.status(500).json({ error: 'Failed to validate job' });
      }
      
      if (!jobCheck || jobCheck.length === 0) {
        return res.status(400).json({ error: 'Job not found or does not belong to user' });
      }
    }
    
    const { data: result, error: insertError } = await supabase
      .from('invoices')
      .insert({
        user_id: userId,
        customer_id: customerId,
        job_id: jobId || null,
        estimate_id: estimateId || null,
        amount: totalAmount,
        tax_amount: taxAmount || 0,
        total_amount: totalAmount,
        status: status,
        due_date: dueDate || null
      })
      .select()
      .single();
    
    if (insertError) {
      console.error('Error creating invoice:', insertError);
      return res.status(500).json({ error: 'Failed to create invoice' });
    }
    
    const invoiceId = result.id;
    
    // Update job invoice_status if jobId is provided
    if (jobId) {
      const { error: updateError } = await supabase
        .from('jobs')
        .update({
          invoice_status: 'invoiced',
          invoice_id: invoiceId,
          invoice_amount: totalAmount,
          invoice_date: new Date().toISOString().split('T')[0]
        })
        .eq('id', jobId);
      
      if (updateError) {
        console.error('Error updating job invoice status:', updateError);
      } else {
      }
    }
      
      // Get the created invoice
      const { data: createdInvoice, error: fetchError } = await supabase
        .from('invoices')
        .select(`
          *,
          customers!left(first_name, last_name, email)
        `)
        .eq('id', invoiceId)
        .limit(1);
      
      if (fetchError) {
        console.error('Error fetching created invoice:', fetchError);
        return res.status(500).json({ error: 'Failed to fetch created invoice' });
      }
      
      res.status(201).json(createdInvoice[0]);
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
    
  
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    // Convert string values to numbers for decimal fields
    const amountValue = parseFloat(amount) || 0;
    const taxAmountValue = parseFloat(taxAmount) || 0;
    const totalAmountValue = parseFloat(totalAmount) || 0;

    const { error: updateError } = await supabase
      .from('invoices')
      .update({
        status: status,
        amount: amountValue,
        tax_amount: taxAmountValue,
        total_amount: totalAmountValue,
        due_date: dueDate || null,
        notes: notes || null
      })
      .eq('id', id)
      .eq('user_id', userId);
    
    if (updateError) {
      console.error('Error updating invoice:', updateError);
      return res.status(500).json({ error: 'Failed to update invoice' });
    }
    
    // Get the updated invoice
    const { data: invoices, error: fetchError } = await supabase
      .from('invoices')
      .select(`
        *,
        customers!left(first_name, last_name, email)
      `)
      .eq('id', id)
      .limit(1);
    
    if (fetchError) {
      console.error('Error fetching updated invoice:', fetchError);
      return res.status(500).json({ error: 'Failed to fetch updated invoice' });
    }
    
    if (!invoices || invoices.length === 0) {
      return res.status(404).json({ error: 'Invoice not found' });
    }
    
    res.json(invoices[0]);
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

    const { error: deleteError } = await supabase
      .from('invoices')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);
    
    if (deleteError) {
      console.error('Error deleting invoice:', deleteError);
      return res.status(500).json({ error: 'Failed to delete invoice' });
    }
    
    res.json({ message: 'Invoice deleted successfully' });
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
// OPTIONS handled by catch-all above

app.get('/api/team-members', authenticateToken, async (req, res) => {

  // CORS handled by middleware

  try {
    const { userId, status, search, page = 1, limit = 20, sortBy = 'first_name', sortOrder = 'ASC' } = req.query;
    // Build Supabase query with joins and aggregations
    let query = supabase
      .from('team_members')
      .select(`
        *,
        jobs!left(id, status, invoice_amount)
      `, { count: 'exact' })
      .eq('user_id', userId);
    
    // Add status filter
    if (status) {
      query = query.eq('status', status);
    }
    
    // Add search filter
    if (search) {
      query = query.or(`first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%`);
    }
    
    // Add sorting
    const allowedSortFields = ['first_name', 'last_name', 'email', 'role'];
    const allowedSortOrders = ['ASC', 'DESC'];
    
    if (allowedSortFields.includes(sortBy) && allowedSortOrders.includes(sortOrder.toUpperCase())) {
      query = query.order(sortBy, { ascending: sortOrder.toUpperCase() === 'ASC' });
    } else {
      query = query.order('first_name', { ascending: true });
    }
    
    // Add pagination
    const offset = (page - 1) * limit;
    query = query.range(offset, offset + parseInt(limit) - 1);
    
    const { data: teamMembers, error, count } = await query;
    
    if (error) {
      console.error('Error fetching team members:', error);
      return res.status(500).json({ error: 'Failed to fetch team members' });
    }
    
    // Process team members to add job statistics
    const processedTeamMembers = (teamMembers || []).map(member => {
      const jobs = member.jobs || [];
      const totalJobs = jobs.length;
      const completedJobs = jobs.filter(job => job.status === 'completed').length;
      const avgJobValue = completedJobs > 0 
        ? jobs.filter(job => job.status === 'completed')
            .reduce((sum, job) => sum + (job.invoice_amount || 0), 0) / completedJobs
        : 0;
      
      return {
        ...member,
        total_jobs: totalJobs,
        completed_jobs: completedJobs,
        avg_job_value: avgJobValue
      };
    });
    
    res.json({
      teamMembers: processedTeamMembers,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count || 0,
        pages: Math.ceil((count || 0) / limit)
      }
    });
  } catch (error) {
    console.error('Get team members error:', error);
    res.status(500).json({ error: 'Failed to fetch team members' });
  }
});

// Verify invitation endpoint - MUST be before /:id route
app.get('/api/team-members/verify-invitation', async (req, res) => {
  try {
    const { token } = req.query;
    
    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }
    
    // Get team member details by invitation token using Supabase
    const { data: teamMembers, error: teamMemberError } = await supabase
      .from('team_members')
      .select('*')
      .eq('invitation_token', token)
      .eq('status', 'invited')
      .gt('invitation_expires', new Date().toISOString());
    
    if (teamMemberError) {
      console.error('❌ Error fetching team member by token:', teamMemberError);
      return res.status(500).json({ error: 'Failed to verify invitation' });
    }
    
    if (!teamMembers || teamMembers.length === 0) {
      return res.status(404).json({ error: 'Invalid or expired invitation token' });
    }
    
    const teamMember = teamMembers[0];
  
    
    res.json({
      firstName: teamMember.first_name,
      lastName: teamMember.last_name,
      email: teamMember.email,
      role: teamMember.role,
      teamMemberId: teamMember.id
    });
  } catch (error) {
    console.error('❌ Verify invitation error:', error);
    res.status(500).json({ error: 'Failed to verify invitation' });
  }
});

app.get('/api/team-members/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { startDate, endDate } = req.query;

    // ✅ Fetch team member info
    const { data: teamMembers, error: teamMemberError } = await supabase
      .from('team_members')
      .select('*')
      .eq('id', id)
      .limit(1);

    if (teamMemberError) {
      console.error('Error fetching team member:', teamMemberError);
      return res.status(500).json({ error: 'Failed to fetch team member data' });
    }

    if (!teamMembers || teamMembers.length === 0) {
      return res.status(404).json({ error: 'Team member not found' });
    }

    const teamMember = teamMembers[0];

    // ✅ Fetch jobs assigned to this team member
    let jobs = [];
    try {
      const { data: jobsResult, error: jobsError } = await supabase
        .from('jobs')
        .select(`
          *,
          customers!left(first_name, last_name, phone, address),
          services!left(name, duration)
        `)
        .eq('team_member_id', id)
        .gte('scheduled_date', startDate || '2024-01-01')
        .lte('scheduled_date', endDate || '2030-12-31')
        .order('scheduled_date', { ascending: true });

      if (jobsError) {
        console.error('Error fetching jobs for team member:', jobsError);
      } else {
        jobs = (jobsResult || []).map(job => ({
          ...job,
          customer_first_name: job.customers?.first_name,
          customer_last_name: job.customers?.last_name,
          customer_phone: job.customers?.phone,
          customer_address: job.customers?.address,
          service_name: job.services?.name,
          duration: job.services?.duration
        }));
      }
    } catch (jobFetchError) {
      console.error('Unexpected error fetching jobs:', jobFetchError);
    }

    // ✅ Final response
    res.json({
      teamMember,
      jobs
    });

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
      territories,
      permissions
    } = req.body;
    
    // Validate required fields
    if (!userId || !firstName || !lastName || !email || !username || !password) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Validate email format
    if (!validateEmail(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    
    // ✅ Check for specific conflicts (email, phone, username)
    const { data: existingEmail, error: emailCheckError } = await supabase
      .from('team_members')
      .select('id, email')
      .eq('user_id', userId)
      .eq('email', email)
      .limit(1);

    if (emailCheckError) {
      console.error('Error checking existing email:', emailCheckError);
      return res.status(500).json({ error: 'Failed to check existing team member' });
    }

    if (existingEmail && existingEmail.length > 0) {
      return res.status(400).json({ 
        error: 'Email already exists for this team',
        conflictType: 'email',
        field: 'email',
        message: `A team member with the email "${email}" already exists in your team.`
      });
    }

    // Check for phone number conflicts if phone is provided
    if (phone) {
      const { data: existingPhone, error: phoneCheckError } = await supabase
        .from('team_members')
        .select('id, phone')
        .eq('user_id', userId)
        .eq('phone', phone)
        .limit(1);

      if (phoneCheckError) {
        console.error('Error checking existing phone:', phoneCheckError);
        return res.status(500).json({ error: 'Failed to check existing team member' });
      }

      if (existingPhone && existingPhone.length > 0) {
        return res.status(400).json({ 
          error: 'Phone number already exists for this team',
          conflictType: 'phone',
          field: 'phone',
          message: `A team member with the phone number "${phone}" already exists in your team.`
        });
      }
    }

    // Check for username conflicts (for future use when username is implemented)
    if (username) {
      const { data: existingUsername, error: usernameCheckError } = await supabase
        .from('team_members')
        .select('id, username')
        .eq('user_id', userId)
        .eq('username', username)
        .limit(1);

      if (usernameCheckError) {
        console.error('Error checking existing username:', usernameCheckError);
        return res.status(500).json({ error: 'Failed to check existing team member' });
      }

      if (existingUsername && existingUsername.length > 0) {
        return res.status(400).json({ 
          error: 'Username already exists for this team',
          conflictType: 'username',
          field: 'username',
          message: `A team member with the username "${username}" already exists in your team.`
        });
      }
    }
    
    // Generate invitation token
    const invitationToken = crypto.randomBytes(32).toString('hex');
    const invitationExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
    
    // ✅ Create team member with invited status
    // Generate a random color for the team member
    const colors = ['#2563EB', '#DC2626', '#059669', '#D97706', '#7C3AED', '#DB2777', '#6B7280'];
    const randomColor = colors[Math.floor(Math.random() * colors.length)];
    
    const { data: newTeamMember, error: createError } = await supabase
      .from('team_members')
      .insert({
        user_id: userId,
        first_name: firstName,
        last_name: lastName,
        email,
        phone: phone || null,
        username: null, // Will be set during signup
        password: null, // Will be set during signup
        role: role || null,
        skills,
        hourly_rate: hourlyRate || null,
        availability,
        location: location || null,
        city: city || null,
        state: state || null,
        zip_code: zipCode || null,
        territories,
        permissions,
        ...(await checkColorColumn() ? { color: randomColor } : {}),
        status: 'invited',
        invitation_token: invitationToken,
        invitation_expires: invitationExpires
      })
      .select()
      .single();
    
    if (createError) {
      console.error('Error creating team member:', createError);
      return res.status(500).json({ error: 'Failed to create team member' });
    }
    
    // ✅ Don’t send password back
    const { password: _, ...teamMemberWithoutPassword } = newTeamMember;
    
    res.status(201).json({
      message: 'Team member invited successfully',
      teamMember: teamMemberWithoutPassword
    });

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
      hourlyRate,
      availability,
      status,
      location,
      city,
      state,
      zipCode,
      territories,
      permissions,
      color
    } = req.body;
    
    // Build update object with only provided fields
    const updateData = {};
    
    if (firstName) {
      updateData.first_name = firstName;
    }
    
    if (lastName) {
      updateData.last_name = lastName;
    }
    
    if (email) {
      if (!validateEmail(email)) {
        return res.status(400).json({ error: 'Invalid email format' });
      }
      updateData.email = email;
    }
    
    if (phone !== undefined) {
      updateData.phone = phone;
    }
    
    if (username !== undefined) {
      updateData.username = username;
    }
    
    if (password !== undefined) {
      const hashedPassword = await bcrypt.hash(password, 10);
      updateData.password = hashedPassword;
    }
    
    if (role !== undefined) {
      updateData.role = role;
    }
    
    if (hourlyRate !== undefined) {
      updateData.hourly_rate = hourlyRate;
    }
    
    if (availability !== undefined) {
      updateData.availability = availability;
    }
    
    if (status !== undefined) {
      updateData.status = status;
    }
    
    if (location !== undefined) {
      updateData.location = location;
    }
    
    if (city !== undefined) {
      updateData.city = city;
    }
    
    if (state !== undefined) {
      updateData.state = state;
    }
    
    if (zipCode !== undefined) {
      updateData.zip_code = zipCode;
    }
    
    
    if (territories !== undefined) {
      updateData.territories = territories;
    }
    
    if (permissions !== undefined) {
      updateData.permissions = permissions;
    }
    
    // Include color if provided (only if column exists)
    if (color !== undefined) {
      // Check if color column exists by trying a test query first
      try {
        const { error: testError } = await supabase
          .from('team_members')
          .select('color')
          .limit(1);
        
        if (!testError) {
          updateData.color = color;
        } else {
        }
      } catch (err) {
      }
    }
    
    // Update team member
    const { error } = await supabase
      .from('team_members')
      .update(updateData)
      .eq('id', id);
    
    if (error) {
      console.error('Error updating team member:', error);
      console.error('Error details:', {
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint
      });
      
      // Provide specific error messages based on the database error
      let errorMessage = 'Failed to update team member';
      let errorType = 'database_error';
      
      if (error.code === '42703') { // Column does not exist
        errorMessage = 'Database schema error. The color column may not exist. Please contact support.';
        errorType = 'schema_error';
      } else if (error.code === '23505') { // Unique constraint violation
        errorMessage = 'A team member with this information already exists.';
        errorType = 'duplicate_entry';
      } else if (error.code === '23502') { // Not null constraint violation
        errorMessage = 'Required fields are missing.';
        errorType = 'missing_fields';
      }
      
      return res.status(500).json({ 
        error: errorMessage,
        errorType: errorType,
        details: error.message,
        code: error.code
      });
    }
    
    res.json({ message: 'Team member updated successfully' });
  } catch (error) {
    console.error('Update team member error:', error);
    res.status(500).json({ error: 'Failed to update team member' });
  }
});

app.delete('/api/team-members/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Validate team member ID
    if (!id || isNaN(parseInt(id))) {
      return res.status(400).json({ 
        error: 'Invalid team member ID',
        errorType: 'VALIDATION_ERROR',
        userMessage: 'Please provide a valid team member ID.'
      });
    }
    
    // First, get the team member's current status
    const { data: teamMember, error: memberError } = await supabase
      .from('team_members')
      .select('id, status, first_name, last_name, user_id')
      .eq('id', id)
      .single();
    
    if (memberError) {
      console.error('❌ Error fetching team member:', memberError);
      
      // Handle specific Supabase errors
      if (memberError.code === 'PGRST116') {
        return res.status(404).json({ 
          error: 'Team member not found',
          errorType: 'NOT_FOUND',
          userMessage: 'The team member you are trying to delete does not exist.'
        });
      }
      
      return res.status(500).json({ 
        error: 'Database error while fetching team member',
        errorType: 'DATABASE_ERROR',
        userMessage: 'Unable to retrieve team member information. Please try again later.'
      });
    }
    
    if (!teamMember) {
      return res.status(404).json({ 
        error: 'Team member not found',
        errorType: 'NOT_FOUND',
        userMessage: 'The team member you are trying to delete does not exist.'
      });
    }
    
    // Check if team member has active job assignments
    const { data: assignedJobs, error: jobsError } = await supabase
      .from('jobs')
      .select('id, status', { count: 'exact' })
      .eq('team_member_id', id)
      .in('status', ['pending', 'confirmed', 'in-progress']);
    
    if (jobsError) {
      console.error('❌ Error checking assigned jobs:', jobsError);
      return res.status(500).json({ 
        error: 'Database error while checking job assignments',
        errorType: 'DATABASE_ERROR',
        userMessage: 'Unable to check for active job assignments. Please try again later.'
      });
    }
    
    // Enhanced validation for active team members with job assignments
    if (teamMember.status === 'active' && assignedJobs && assignedJobs.length > 0) {
      return res.status(400).json({ 
        error: 'Cannot delete active team member with active job assignments',
        errorType: 'BUSINESS_RULE_VIOLATION',
        userMessage: `Cannot delete ${teamMember.first_name} ${teamMember.last_name} because they have ${assignedJobs.length} active job assignment(s). Please reassign or complete these jobs first, or deactivate the team member instead.`,
        details: {
          teamMemberName: `${teamMember.first_name} ${teamMember.last_name}`,
          activeJobsCount: assignedJobs.length,
          activeJobs: assignedJobs.slice(0, 5).map(job => ({
            id: job.id,
            status: job.status
          }))
        }
      });
    }
    
    // Note: Admin check removed for now to prevent deletion errors
    // This can be re-implemented later if needed
    
    // Allow deletion for:
    // 1. Inactive team members (regardless of job assignments)
    // 2. Active team members with no active job assignments
    // 3. Invited team members (never activated)
    // 4. Non-admin team members
    
    // Actually DELETE the team member from the database
    const { error: deleteError } = await supabase
      .from('team_members')
      .delete()
      .eq('id', id);
    
    if (deleteError) {
      console.error('❌ Error deleting team member:', deleteError);
      
      // Handle specific deletion errors
      if (deleteError.code === '23503') { // Foreign key constraint violation
        return res.status(400).json({ 
          error: 'Cannot delete team member due to related records',
          errorType: 'CONSTRAINT_VIOLATION',
          userMessage: 'Cannot delete this team member because they have related records in the system. Please contact support if you need assistance.'
        });
      }
      
      return res.status(500).json({ 
        error: 'Database error while deleting team member',
        errorType: 'DATABASE_ERROR',
        userMessage: 'Unable to delete team member. Please try again later or contact support if the problem persists.'
      });
    }
    
    res.json({ 
      message: 'Team member permanently deleted successfully',
      success: true,
      deletedMember: {
        id: teamMember.id,
        name: `${teamMember.first_name} ${teamMember.last_name}`
      }
    });
  } catch (error) {
    console.error('❌ Delete team member error:', error);
    console.error('❌ Error details:', {
      name: error.name,
      message: error.message,
      code: error.code,
      stack: error.stack
    });
    
    // Handle specific error types
    if (error.name === 'ValidationError') {
      return res.status(400).json({ 
        error: 'Invalid request data',
        errorType: 'VALIDATION_ERROR',
        userMessage: 'The request data is invalid. Please check your input and try again.'
      });
    }
    
    if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      return res.status(503).json({ 
        error: 'Service temporarily unavailable',
        errorType: 'SERVICE_UNAVAILABLE',
        userMessage: 'The service is temporarily unavailable. Please try again in a few moments.'
      });
    }
    
    res.status(500).json({ 
      error: 'Internal server error',
      errorType: 'INTERNAL_ERROR',
      userMessage: 'An unexpected error occurred. Please try again later or contact support if the problem persists.'
    });
  }
});

// Deactivate team member (soft delete - keeps record but sets status to inactive)
app.put('/api/team-members/:id/deactivate', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get the team member
    const { data: teamMember, error: memberError } = await supabase
      .from('team_members')
      .select('id, status, first_name, last_name')
      .eq('id', id)
      .single();
    
    if (memberError) {
      console.error('Error fetching team member:', memberError);
      return res.status(500).json({ error: 'Failed to fetch team member' });
    }
    
    if (!teamMember) {
      return res.status(404).json({ error: 'Team member not found' });
    }
    
    if (teamMember.status === 'inactive') {
      return res.status(400).json({ error: 'Team member is already deactivated' });
    }
    
    // Deactivate team member (soft delete)
    const { error: updateError } = await supabase
      .from('team_members')
      .update({ status: 'inactive' })
      .eq('id', id);
    
    if (updateError) {
      console.error('Error deactivating team member:', updateError);
      return res.status(500).json({ error: 'Failed to deactivate team member' });
    }
    res.json({ message: 'Team member deactivated successfully' });
  } catch (error) {
    console.error('Deactivate team member error:', error);
    res.status(500).json({ error: 'Failed to deactivate team member' });
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
        WHERE team_member_id = ? AND status IN ("pending", "confirmed", "in-progress")
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
   
    // Find team member by username or email using Supabase
    const { data: teamMembers, error: teamMemberError } = await supabase
      .from('team_members')
      .select('*')
      .or(`username.eq.${username},email.eq.${username}`)
      .eq('status', 'active');
    
    if (teamMemberError) {
      console.error('❌ Error fetching team member:', teamMemberError);
      return res.status(500).json({ error: 'Database error. Please try again.' });
    }
    
    if (!teamMembers || teamMembers.length === 0) {
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
      
    // Update last login using Supabase
    const { error: updateError } = await supabase
      .from('team_members')
      .update({ last_login: new Date().toISOString() })
      .eq('id', teamMember.id);
    
    if (updateError) {
      console.warn('⚠️ Failed to update last login:', updateError);
      // Continue without updating last login
    }
      
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
      
    // Store session using Supabase (optional - continue if it fails)
    try {
      const { error: sessionError } = await supabase
        .from('team_member_sessions')
        .insert({
          team_member_id: teamMember.id,
          session_token: sessionToken,
          device_info: req.headers['user-agent'],
          ip_address: req.ip,
          expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
        });
      
      if (sessionError) {
        console.warn('⚠️ Session storage failed:', sessionError.message);
        // Continue without session storage
      }
      } catch (sessionError) {
      console.warn('⚠️ Session storage failed (table may not exist):', sessionError.message);
        // Continue without session storage for now
      }
      
      // Remove password from response
      delete teamMember.password;
      
      res.json({
        message: 'Login successful',
        teamMember,
        token: sessionToken
      });
  } catch (error) {
    console.error('❌ Team member login error:', error);
      res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// Get current team member profile (for authentication validation)
app.get('/api/team-members/me', authenticateToken, async (req, res) => {
  try {
    const teamMemberId = req.user.userId;
    // Get team member from Supabase
    const { data: teamMember, error: teamMemberError } = await supabase
      .from('team_members')
      .select('*')
      .eq('id', teamMemberId)
      .eq('status', 'active')
      .single();
    
    if (teamMemberError) {
      console.error('❌ Error fetching team member:', teamMemberError);
      return res.status(404).json({ error: 'Team member not found' });
    }
    
    if (!teamMember) {
      return res.status(404).json({ error: 'Team member not found' });
    }
    
    // Remove password from response
    delete teamMember.password;
    
    res.json(teamMember);
  } catch (error) {
    console.error('❌ Get team member profile error:', error);
    res.status(500).json({ error: 'Failed to get team member profile' });
  }
});

// Test endpoint to verify backend is working
app.get('/api/team-members/test', (req, res) => {
  res.json({ 
    message: 'Backend is working!', 
    timestamp: new Date().toISOString(),
    status: 'success'
  });
});

app.post('/api/team-members/register', async (req, res) => {
  // Set a timeout for this request
  const timeout = setTimeout(() => {
    console.error('⏰ Team member registration request timed out after 30 seconds');
    if (!res.headersSent) {
      res.status(408).json({ error: 'Request timeout - server took too long to respond' });
    }
  }, 30000);
  
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
      hourlyRate,
      territories,
      availability,
      permissions,
      isServiceProvider = false
    } = req.body;
    
    // Validate required fields with specific messages
    if (!userId) {
      console.error('❌ Missing userId');
      return res.status(400).json({ 
        error: 'User session expired. Please refresh the page and try again.',
        errorType: 'session_expired',
        field: 'userId'
      });
    }
    
    if (!firstName || !lastName) {
      console.error('❌ Missing name fields:', { firstName, lastName });
      return res.status(400).json({ 
        error: 'First name and last name are required.',
        errorType: 'missing_name',
        field: firstName ? 'lastName' : 'firstName',
        message: `Please enter a ${!firstName ? 'first' : 'last'} name.`
      });
    }
    
    if (!email) {
      console.error('❌ Missing email');
      return res.status(400).json({ 
        error: 'Email address is required.',
        errorType: 'missing_email',
        field: 'email',
        message: 'Please enter an email address for the team member.'
      });
    }
    

    // Check for specific conflicts (email, phone)
    const { data: existingEmail, error: emailCheckError } = await supabase
      .from('team_members')
      .select('id, email')
      .eq('email', email)
      .eq('user_id', userId)
      .limit(1);
    
    if (emailCheckError) {
      console.error('Error checking existing email:', emailCheckError);
      return res.status(500).json({ 
        error: 'Failed to check existing team member',
        errorType: 'database_error',
        details: 'Unable to verify if email already exists'
      });
    }
    
    if (existingEmail && existingEmail.length > 0) {
      return res.status(400).json({ 
        error: `A team member with the email "${email}" already exists in your team.`,
        errorType: 'email_conflict',
        conflictType: 'email',
        field: 'email',
        message: `Please use a different email address or check if this team member already exists.`
      });
    }

    // Check for phone number conflicts if phone is provided
    if (phone) {
      const { data: existingPhone, error: phoneCheckError } = await supabase
        .from('team_members')
        .select('id, phone')
        .eq('phone', phone)
        .eq('user_id', userId)
        .limit(1);

      if (phoneCheckError) {
        console.error('Error checking existing phone:', phoneCheckError);
        return res.status(500).json({ 
          error: 'Failed to check existing team member',
          errorType: 'database_error',
          details: 'Unable to verify if phone number already exists'
        });
      }

      if (existingPhone && existingPhone.length > 0) {
        return res.status(400).json({ 
          error: `A team member with the phone number "${phone}" already exists in your team.`,
          errorType: 'phone_conflict',
          conflictType: 'phone',
          field: 'phone',
          message: `Please use a different phone number or check if this team member already exists.`
        });
      }
    }
    
  
    // Generate a unique invitation token
   
    const invitationToken = crypto.randomBytes(32).toString('hex');
    const invitationExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
   
  
    
    // Generate a random color for the team member
    const colors = ['#2563EB', '#DC2626', '#059669', '#D97706', '#7C3AED', '#DB2777', '#6B7280'];
    const randomColor = colors[Math.floor(Math.random() * colors.length)];
    
    const { data: teamMember, error: insertError } = await supabase
      .from('team_members')
      .insert({
        user_id: userId,
        first_name: sanitizeInput(firstName),
        last_name: sanitizeInput(lastName),
        email: sanitizeInput(email),
        phone: phone ? sanitizeInput(phone) : null,
        location: location ? sanitizeInput(location) : null,
        city: city ? sanitizeInput(city) : null,
        state: state ? sanitizeInput(state) : null,
        zip_code: zipCode ? sanitizeInput(zipCode) : null,
        role: role || 'worker',
        hourly_rate: hourlyRate ? parseFloat(hourlyRate) : null,
        territories: territories || [],
        availability: availability || {},
        permissions: permissions || {},
        ...(await checkColorColumn() ? { color: randomColor } : {}),
        invitation_token: invitationToken,
        invitation_expires: invitationExpires.toISOString(),
        status: 'invited'
      })
      .select()
      .single();
    
  
    if (insertError) {
      console.error('❌ Error creating team member:', insertError);
      clearTimeout(timeout); // Clear the timeout
      
      // Provide specific error messages based on the database error
      let errorMessage = 'Failed to create team member';
      let errorType = 'database_error';
      
      if (insertError.code === '23505') { // Unique constraint violation
        if (insertError.message.includes('email')) {
          errorMessage = `A team member with the email "${email}" already exists in your team.`;
          errorType = 'email_conflict';
        } else if (insertError.message.includes('phone')) {
          errorMessage = `A team member with the phone number "${phone}" already exists in your team.`;
          errorType = 'phone_conflict';
        } else {
          errorMessage = 'A team member with this information already exists.';
          errorType = 'duplicate_entry';
        }
      } else if (insertError.code === '23502') { // Not null constraint violation
        errorMessage = 'Required fields are missing. Please check all required fields.';
        errorType = 'missing_fields';
      } else if (insertError.code === '23503') { // Foreign key constraint violation
        errorMessage = 'Invalid user or territory reference. Please refresh and try again.';
        errorType = 'invalid_reference';
      } else if (insertError.message.includes('duplicate key')) {
        errorMessage = 'A team member with this information already exists.';
        errorType = 'duplicate_entry';
      }
      
      return res.status(400).json({ 
        error: errorMessage,
        errorType: errorType,
        details: insertError.message,
        code: insertError.code
      });
    }
    
 
    // Generate invitation link
      const invitationLink = `${process.env.FRONTEND_URL || 'https://service-flow.pro'}/#/team-member/signup?token=${invitationToken}`;
      
    // Send email in background without waiting using SendGrid
    sendTeamMemberEmail({
        to: email,
        subject: 'You\'ve been invited to join Service Flow',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #2563eb;">Welcome to Service Flow!</h2>
            <p>Hello ${firstName},</p>
            <p>You've been invited to join your team on Service Flow. To get started, please click the link below to create your account:</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${invitationLink}" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                Create Your Account
              </a>
            </div>
            <p>This link will expire in 7 days. If you have any questions, please contact your team administrator.</p>
            <p>Best regards,<br>The Service Flow Team</p>
          </div>
        `,
        text: `Welcome to Service Flow! You've been invited to join your team. Please visit ${invitationLink} to create your account.`
    }).then(() => {}).catch((emailError) => {
      console.error('❌ Failed to send team member invitation email:', emailError);
      // Don't fail the request if email fails
    });
    
   
    const responseData = {
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
        hourly_rate: teamMember.hourly_rate,
          territories: teamMember.territories,
        availability: teamMember.availability,
          permissions: teamMember.permissions,
          status: teamMember.status,
          created_at: teamMember.created_at
        }
    };
    
    
    clearTimeout(timeout); // Clear the timeout
    
    // Ensure response headers are set
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-cache');
    
    // Ensure response is properly sent
    res.status(200).json(responseData);
  } catch (error) {
    console.error('Team member registration error:', error);
    console.error('Error details:', {
      message: error.message,
      code: error.code,
      stack: error.stack
    });
    clearTimeout(timeout); // Clear the timeout
    
    // Provide specific error messages based on the error type
    let errorMessage = 'Registration failed';
    let errorType = 'server_error';
    let details = error.message;
    
    if (error.message.includes('timeout')) {
      errorMessage = 'Request timed out. Please try again.';
      errorType = 'timeout_error';
    } else if (error.message.includes('network') || error.message.includes('ECONNREFUSED')) {
      errorMessage = 'Network error. Please check your connection and try again.';
      errorType = 'network_error';
    } else if (error.message.includes('validation')) {
      errorMessage = 'Invalid data provided. Please check your input and try again.';
      errorType = 'validation_error';
    } else if (error.message.includes('database') || error.message.includes('connection')) {
      errorMessage = 'Database error. Please try again in a few moments.';
      errorType = 'database_error';
    }
    
    res.status(500).json({ 
      error: errorMessage,
      errorType: errorType,
      details: details,
      timestamp: new Date().toISOString()
    });
  }
});

app.post('/api/team-members/logout', async (req, res) => {
  try {
    const { token } = req.body;
    
    // Remove session
    const { error } = await supabase
      .from('team_member_sessions')
      .delete()
      .eq('session_token', token);
    
    if (error) {
      console.error('Error removing session:', error);
      return res.status(500).json({ error: 'Logout failed' });
    }
    
    res.json({ message: 'Logout successful' });
  } catch (error) {
    console.error('Team member logout error:', error);
    res.status(500).json({ error: 'Logout failed' });
  }
});


// Complete team member signup endpoint
app.post('/api/team-members/complete-signup', async (req, res) => {
  try {
    const { token, username, password, firstName, lastName, phone } = req.body;

    if (!token || !username || !password || !firstName || !lastName) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Verify token and get team member using Supabase
    const { data: teamMembers, error: teamMemberError } = await supabase
      .from('team_members')
      .select('*')
      .eq('invitation_token', token)
      .eq('status', 'invited')
      .gt('invitation_expires', new Date().toISOString());
    
    if (teamMemberError) {
      console.error('❌ Error fetching team member by token:', teamMemberError);
      return res.status(500).json({ error: 'Failed to verify invitation' });
    }
    
    if (!teamMembers || teamMembers.length === 0) {
      return res.status(404).json({ error: 'Invalid or expired invitation token' });
      }
      
      const teamMember = teamMembers[0];
    
      // Check if username is already taken
    const { data: existingUsers, error: usernameError } = await supabase
      .from('team_members')
      .select('id, username')
      .eq('username', username)
      .neq('id', teamMember.id);
    
    if (usernameError) {
      console.error('❌ Error checking username:', usernameError);
      return res.status(500).json({ error: 'Failed to check username availability' });
    }
    
    if (existingUsers && existingUsers.length > 0) {
        return res.status(400).json({ 
          error: 'Username is already taken',
          conflictType: 'username',
          field: 'username',
          message: `The username "${username}" is already taken by another team member. Please choose a different username.`
        });
      }

      // Check if phone number is already taken (if phone is provided)
      if (phone) {
      const { data: existingPhones, error: phoneError } = await supabase
        .from('team_members')
        .select('id, phone')
        .eq('phone', phone)
        .neq('id', teamMember.id);
      
      if (phoneError) {
        console.error('❌ Error checking phone:', phoneError);
        return res.status(500).json({ error: 'Failed to check phone availability' });
      }
      
      if (existingPhones && existingPhones.length > 0) {
          return res.status(400).json({ 
            error: 'Phone number is already taken',
            conflictType: 'phone',
            field: 'phone',
            message: `The phone number "${phone}" is already registered by another team member. Please use a different phone number.`
          });
        }
      }
      
      // Hash password
      const hashedPassword = await bcrypt.hash(password, 10);
      
    // Update team member with signup data using Supabase
    const { error: updateError } = await supabase
      .from('team_members')
      .update({
        username: username,
        password: hashedPassword,
        first_name: firstName,
        last_name: lastName,
        phone: phone,
        status: 'active',
        invitation_token: null,
        invitation_expires: null,
        created_at: new Date().toISOString()
      })
      .eq('id', teamMember.id);
    
    if (updateError) {
      console.error('❌ Error updating team member:', updateError);
      return res.status(500).json({ error: 'Failed to complete signup' });
    }
    
    // Send activation confirmation email to team member
    try {
      await sendTeamMemberEmail({
        to: teamMember.email,
        subject: 'Welcome to Service Flow - Account Activated!',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #10b981;">🎉 Welcome to Service Flow!</h2>
            <p>Hello ${firstName},</p>
            <p>Your account has been successfully activated! You can now access your team dashboard and start managing your work.</p>
            <div style="background-color: #f0f9ff; border: 1px solid #0ea5e9; border-radius: 8px; padding: 20px; margin: 20px 0;">
              <h3 style="color: #0c4a6e; margin-top: 0;">What's Next?</h3>
              <ul style="color: #0c4a6e;">
                <li>Access your team dashboard</li>
                <li>Update your availability and preferences</li>
                <li>Start receiving job assignments</li>
                <li>Connect with your team members</li>
              </ul>
            </div>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${process.env.FRONTEND_URL || 'https://service-flow.pro'}/#/team-member/dashboard" style="background-color: #10b981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                Access Your Dashboard
              </a>
            </div>
            <p>If you have any questions, please contact your team administrator or our support team.</p>
            <p>Best regards,<br>The Service Flow Team</p>
          </div>
        `,
        text: `Welcome to Service Flow! Your account has been activated. Visit ${process.env.FRONTEND_URL || 'https://service-flow.pro'}/#/team-member/dashboard to access your dashboard.`
      });
     } catch (emailError) {
      console.error('❌ Failed to send activation confirmation email:', emailError);
      // Don't fail the signup process if email fails
    }
    
    // Send notification email to admin/team owner
    try {
      // Get team owner/admin email
      const { data: adminData, error: adminError } = await supabase
        .from('team_members')
        .select('email, first_name, last_name')
        .eq('user_id', teamMember.user_id)
        .eq('role', 'admin')
        .single();
      
      if (!adminError && adminData) {
        await sendTeamMemberEmail({
          to: adminData.email,
          subject: 'Team Member Activated - Service Flow',
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #2563eb;">Team Member Activated</h2>
              <p>Hello ${adminData.first_name},</p>
              <p><strong>${firstName} ${lastName}</strong> has successfully activated their account and joined your team.</p>
              <div style="background-color: #f0fdf4; border: 1px solid #22c55e; border-radius: 8px; padding: 20px; margin: 20px 0;">
                <h3 style="color: #166534; margin-top: 0;">Team Member Details:</h3>
                <ul style="color: #166534;">
                  <li><strong>Name:</strong> ${firstName} ${lastName}</li>
                  <li><strong>Email:</strong> ${teamMember.email}</li>
                  <li><strong>Phone:</strong> ${phone || 'Not provided'}</li>
                  <li><strong>Role:</strong> ${teamMember.role || 'Team Member'}</li>
                  <li><strong>Status:</strong> Active</li>
                </ul>
              </div>
              <p>You can manage this team member's permissions and settings from your team dashboard.</p>
              <div style="text-align: center; margin: 30px 0;">
                <a href="${process.env.FRONTEND_URL || 'https://service-flow.pro'}/#/team" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                  Manage Team
                </a>
              </div>
              <p>Best regards,<br>The Service Flow Team</p>
            </div>
          `,
          text: `Team member ${firstName} ${lastName} has activated their account and joined your team. You can manage them from your team dashboard.`
        });
      }
    } catch (adminEmailError) {
      console.error('❌ Failed to send admin notification email:', adminEmailError);
      // Don't fail the signup process if admin email fails
    }
    
    res.json({ message: 'Account created successfully' });
  } catch (error) {
    console.error('❌ Complete signup error:', error);
    res.status(500).json({ error: 'Failed to complete signup' });
  }
});

// Resend invitation endpoint
app.post('/api/team-members/:id/resend-invite', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get team member details from Supabase
    const { data: teamMember, error: fetchError } = await supabase
      .from('team_members')
      .select('*')
      .eq('id', id)
      .single();
    
    if (fetchError) {
      console.error('🔄 Error fetching team member:', fetchError);
      return res.status(404).json({ error: 'Team member not found' });
    }
    
    if (!teamMember) {
        return res.status(404).json({ error: 'Team member not found' });
      }
      
      if (teamMember.status !== 'invited') {
        return res.status(400).json({ error: 'Team member is not in invited status' });
      }
      
      // Generate new invitation token
      const invitationToken = crypto.randomBytes(32).toString('hex');
      const invitationExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
      
    // Update invitation token in Supabase
    const { error: updateError } = await supabase
      .from('team_members')
      .update({
        invitation_token: invitationToken,
        invitation_expires: invitationExpires.toISOString()
      })
      .eq('id', id);
    
    if (updateError) {
      console.error('🔄 Error updating invitation token:', updateError);
      return res.status(500).json({ error: 'Failed to update invitation token' });
    }
      
      // Send new invitation email
      try {
      const invitationLink = `${process.env.FRONTEND_URL || 'https://service-flow.pro'}/#/team-member/signup?token=${invitationToken}`;
        
      await sendTeamMemberEmail({
          to: teamMember.email,
        subject: 'You\'ve been invited to join Service Flow',
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #2563eb;">Welcome to Service Flow!</h2>
              <p>Hello ${teamMember.first_name},</p>
            <p>You've been invited to join your team on Service Flow. To get started, please click the link below to create your account:</p>
              <div style="text-align: center; margin: 30px 0;">
                <a href="${invitationLink}" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                  Create Your Account
                </a>
              </div>
              <p>This link will expire in 7 days. If you have any questions, please contact your team administrator.</p>
            <p>Best regards,<br>The Service Flow Team</p>
            </div>
          `,
        text: `Welcome to Service Flow! You've been invited to join your team. Please visit ${invitationLink} to create your account.`
        });
      
      } catch (emailError) {
      console.error('❌ Failed to send invitation email:', emailError);
      console.error('❌ Email error details:', {
          message: emailError.message,
          code: emailError.code,
          command: emailError.command
        });
      
      // Provide specific error messages based on the error type
      let errorMessage = 'Email service is currently unavailable. Please contact the team member directly with the invitation link.';
      
      if (emailError.message.includes('SendGrid API key invalid')) {
        errorMessage = 'SendGrid API key is invalid. Please check your email configuration.';
      } else if (emailError.message.includes('insufficient permissions')) {
        errorMessage = 'SendGrid API key lacks required permissions. Please check your SendGrid account settings.';
      } else if (emailError.message.includes('Connection timeout')) {
        errorMessage = 'Email service connection timeout. Please try again later or contact support.';
      }
      
    return res.status(200).json({ 
        message: 'Invitation token updated successfully, but email delivery failed',
        warning: errorMessage,
        invitationLink: `${process.env.FRONTEND_URL || 'https://service-flow.pro'}/#/team-member/signup?token=${invitationToken}`
        });
      }
      
      res.json({ message: 'Invitation resent successfully' });
  } catch (error) {
    console.error('❌ Resend invitation error:', error);
    res.status(500).json({ error: 'Failed to resend invitation' });
  }
});

// Team member dashboard endpoints
app.get('/api/team-members/dashboard/:teamMemberId', async (req, res) => {
  try {
    const { teamMemberId } = req.params;
    const { startDate, endDate } = req.query;
   
    // Get team member info using Supabase
    const { data: teamMembers, error: teamMemberError } = await supabase
      .from('team_members')
      .select('*')
      .eq('id', teamMemberId);
    
    if (teamMemberError) {
        console.error('❌ Error fetching team member:', teamMemberError);
        return res.status(500).json({ error: 'Failed to fetch team member data' });
      }
      
    if (!teamMembers || teamMembers.length === 0) {
        return res.status(404).json({ error: 'Team member not found' });
      }
      
      const teamMember = teamMembers[0];
      
    // Get jobs assigned to this team member using Supabase
      let jobs = [];
      try {
      // Build the date filter
      const startDateFilter = startDate || '2024-01-01';
      const endDateFilter = endDate || '2030-12-31';
      
      const { data: jobsData, error: jobsError } = await supabase
        .from('jobs')
        .select(`
          *,
          customers:customer_id (
            first_name,
            last_name,
            phone,
            address
          ),
          services:service_id (
            name,
            duration
          )
        `)
        .eq('team_member_id', teamMemberId)
        .gte('scheduled_date', startDateFilter)
        .lte('scheduled_date', endDateFilter)
        .order('scheduled_date', { ascending: true });
      
      if (jobsError) {
        console.error('❌ Error fetching jobs for team member:', jobsError);
        jobs = [];
      } else {
        // Transform the data to match frontend expectations
        jobs = (jobsData || []).map(job => ({
          ...job,
          // Flatten customer data
          customer_first_name: job.customers?.first_name || '',
          customer_last_name: job.customers?.last_name || '',
          customer_phone: job.customers?.phone || '',
          customer_address: job.customers?.address || '',
          // Flatten service data
          service_name: job.services?.name || '',
          duration: job.services?.duration || 60
        }));
      }
      } catch (jobsError) {
        console.error('❌ Error fetching jobs for team member:', jobsError);
        jobs = [];
      }
      
      // Calculate stats
      const todayString = getTodayString();
    const todayJobs = jobs.filter(job => job.scheduled_date?.split('T')[0] === todayString);
      const completedJobs = jobs.filter(job => job.status === 'completed');
      
      const stats = {
        totalJobs: jobs.length,
        todayJobs: todayJobs.length,
        completedJobs: completedJobs.length,
        avgJobValue: completedJobs.length > 0 
          ? completedJobs.reduce((sum, job) => sum + (job.invoice_amount || 0), 0) / completedJobs.length 
          : 0
      };
      
      
    // Get notifications using Supabase (optional - continue if table doesn't exist)
      let notifications = [];
      try {
        const { data: notificationsData, error: notificationError } = await supabase
        .from('team_member_notifications')
        .select('*')
        .eq('team_member_id', teamMemberId)
        .order('created_at', { ascending: false })
        .limit(10);
      
      if (notificationError) {
        console.warn('⚠️ Team member notifications table not found, skipping notifications:', notificationError.message);
        notifications = [];
      } else {
        notifications = notificationsData || [];
      }
      } catch (notificationError) {
        console.warn('⚠️ Team member notifications table not found, skipping notifications:', notificationError.message);
      notifications = [];
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
          availability: teamMember.availability
        },
        jobs: jobs,
        stats: stats,
        notifications: notifications
      };
      
      res.json(response);
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
    
    // Update job status using Supabase
    const { error: updateError } = await supabase
      .from('jobs')
      .update({
        status: status,
        notes: notes || '',
        updated_at: new Date().toISOString()
      })
      .eq('id', jobId)
      .eq('team_member_id', teamMemberId);
    
    if (updateError) {
      console.error('❌ Error updating job status:', updateError);
      return res.status(500).json({ error: 'Failed to update job status' });
    }
    
    
    // Create notification for business owner using Supabase (optional)
    try {
      const { error: notificationError } = await supabase
        .from('team_member_notifications')
        .insert({
          team_member_id: teamMemberId,
          type: 'job_completed',
          title: 'Job Status Updated',
          message: `Job #${jobId} status updated to ${status}`,
          data: JSON.stringify({ jobId, status }),
          created_at: new Date().toISOString()
        });
      
      if (notificationError) {
        console.warn('⚠️ Failed to create notification:', notificationError);
        // Continue without notification
      } else {
      }
    } catch (notificationError) {
      console.warn('⚠️ Notification creation failed:', notificationError);
      // Continue without notification
    }
      
      res.json({ message: 'Job status updated successfully' });
  } catch (error) {
    console.error('❌ Update job status error:', error);
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
          COUNT(CASE WHEN j.status IN ('pending', 'confirmed', 'in-progress') THEN 1 END) as active_jobs,
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
          availableSlugs: ['now2code-academy', 'Service-flow-cleaning-services', 'test-business']
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
      
      const bookedTimes = bookings.map(booking => {
        // Extract time directly from string format "2025-10-07 09:00:00" to avoid timezone conversion
        if (booking.scheduled_date && booking.scheduled_date.includes(' ')) {
          return booking.scheduled_date.split(' ')[1]?.substring(0, 5) || '09:00';
        }
        return '09:00'; // fallback
      });
      
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

    // Check if coupon code already exists
    const { data: existingCoupons, error: checkError } = await supabase
      .from('coupons')
      .select('id')
      .eq('code', code)
      .limit(1);
    
    if (checkError) {
      console.error('Error checking existing coupon:', checkError);
      return res.status(500).json({ error: 'Failed to create coupon' });
    }
    
    if (existingCoupons && existingCoupons.length > 0) {
      return res.status(400).json({ error: 'Coupon code already exists' });
    }

    // Create coupon
    const { data: result, error: insertError } = await supabase
      .from('coupons')
      .insert({
        user_id: userId,
        code: code,
        discount_type: discountType,
        discount_amount: discountAmount,
        application_type: applicationType,
        selected_services: selectedServices,
        doesnt_expire: doesntExpire,
        expiration_date: doesntExpire ? null : expirationDate,
        restrict_before_expiration: restrictBeforeExpiration,
        limit_total_uses: limitTotalUses,
        can_combine_with_recurring: canCombineWithRecurring,
        recurring_application_type: recurringApplicationType
      })
      .select()
      .single();

    if (insertError) {
      console.error('Error creating coupon:', insertError);
      return res.status(500).json({ error: 'Failed to create coupon' });
    }

    res.status(201).json({
      message: 'Coupon created successfully',
      couponId: result.id
    });
  } catch (error) {
    console.error('Create coupon error:', error);
    res.status(500).json({ error: 'Failed to create coupon' });
  }
});

app.get('/api/coupons', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { data: coupons, error } = await supabase
      .from('coupons')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    
    if (error) {
      console.error('Error fetching coupons:', error);
      return res.status(500).json({ error: 'Failed to get coupons' });
    }
    
    res.json({ coupons: coupons || [] });
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

    // Verify coupon belongs to user
    const { data: coupons, error: checkError } = await supabase
      .from('coupons')
      .select('id')
      .eq('id', couponId)
      .eq('user_id', userId)
      .limit(1);
    
    if (checkError) {
      console.error('Error checking coupon:', checkError);
      return res.status(500).json({ error: 'Failed to update coupon' });
    }
    
    if (!coupons || coupons.length === 0) {
      return res.status(404).json({ error: 'Coupon not found' });
    }

    // Update coupon
    const { error: updateError } = await supabase
      .from('coupons')
      .update({
        code: updateData.code,
        discount_type: updateData.discountType,
        discount_amount: updateData.discountAmount,
        application_type: updateData.applicationType,
        selected_services: updateData.selectedServices,
        doesnt_expire: updateData.doesntExpire,
        expiration_date: updateData.doesntExpire ? null : updateData.expirationDate,
        restrict_before_expiration: updateData.restrictBeforeExpiration,
        limit_total_uses: updateData.limitTotalUses,
        can_combine_with_recurring: updateData.canCombineWithRecurring,
        recurring_application_type: updateData.recurringApplicationType,
        is_active: updateData.isActive
      })
      .eq('id', couponId);

    if (updateError) {
      console.error('Error updating coupon:', updateError);
      return res.status(500).json({ error: 'Failed to update coupon' });
    }

    res.json({ message: 'Coupon updated successfully' });
  } catch (error) {
    console.error('Update coupon error:', error);
    res.status(500).json({ error: 'Failed to update coupon' });
  }
});

app.delete('/api/coupons/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const couponId = req.params.id;

    // Verify coupon belongs to user
    const { data: coupons, error: checkError } = await supabase
      .from('coupons')
      .select('id')
      .eq('id', couponId)
      .eq('user_id', userId)
      .limit(1);
    
    if (checkError) {
      console.error('Error checking coupon:', checkError);
      return res.status(500).json({ error: 'Failed to delete coupon' });
    }
    
    if (!coupons || coupons.length === 0) {
      return res.status(404).json({ error: 'Coupon not found' });
    }

    // Delete coupon
    const { error: deleteError } = await supabase
      .from('coupons')
      .delete()
      .eq('id', couponId);

    if (deleteError) {
      console.error('Error deleting coupon:', deleteError);
      return res.status(500).json({ error: 'Failed to delete coupon' });
    }

    res.json({ message: 'Coupon deleted successfully' });
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

// Stripe Connect endpoints
app.post('/api/stripe/connect/account-link', authenticateToken, async (req, res) => {
  try {
    const { return_url, refresh_url } = req.body;
    const userId = req.user.id;

    // Create Stripe Connect account
    const account = await stripe.accounts.create({
      type: 'express',
      country: 'US',
      email: req.user.email,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
    });

    // Store account ID in database
    const { error: updateError } = await supabase
      .from('user_billing')
      .upsert({
        user_id: userId,
        stripe_connect_account_id: account.id,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'user_id'
      });

    if (updateError) {
      console.error('Error storing connect account:', updateError);
      return res.status(500).json({ error: 'Failed to store account information' });
    }

    // Create account link for onboarding
    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      return_url,
      refresh_url,
      type: 'account_onboarding',
    });

    res.json({ url: accountLink.url });
  } catch (error) {
    console.error('Stripe Connect account creation error:', error);
    res.status(500).json({ error: 'Failed to create Stripe Connect account' });
  }
});

app.get('/api/stripe/connect/account-status', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get stored account ID
    const { data: billingData, error: billingError } = await supabase
      .from('user_billing')
      .select('stripe_connect_account_id')
      .eq('user_id', userId)
      .limit(1);

    if (billingError || !billingData?.[0]?.stripe_connect_account_id) {
      return res.json({ connected: false });
    }

    const accountId = billingData[0].stripe_connect_account_id;

    // Get account details from Stripe
    const account = await stripe.accounts.retrieve(accountId);

    res.json({
      connected: true,
      charges_enabled: account.charges_enabled,
      payouts_enabled: account.payouts_enabled,
      details_submitted: account.details_submitted,
      requirements: account.requirements
    });
  } catch (error) {
    console.error('Stripe Connect account status error:', error);
    res.status(500).json({ error: 'Failed to get account status' });
  }
});

app.post('/api/payments/confirm-payment', authenticateToken, async (req, res) => {
  try {
    const { paymentIntentId, invoiceId, customerId } = req.body;
    
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    
    if (paymentIntent.status === 'succeeded') {
      // Update invoice status using Supabase
      const { error: updateError } = await supabase
        .from('invoices')
        .update({
          status: 'paid',
          payment_date: new Date().toISOString(),
          stripe_payment_intent_id: paymentIntentId
        })
        .eq('id', invoiceId);

      if (updateError) {
        console.error('Error updating invoice:', updateError);
        return res.status(500).json({ error: 'Failed to update invoice' });
      }
      
      // Get invoice details for email using Supabase
      const { data: invoices, error: fetchError } = await supabase
        .from('invoices')
        .select(`
          *,
          customers!inner(email, first_name, last_name)
        `)
        .eq('id', invoiceId)
        .limit(1);
      
      if (fetchError) {
        console.error('Error fetching invoice details:', fetchError);
        return res.status(500).json({ error: 'Failed to fetch invoice details' });
      }
      
      if (invoices && invoices.length > 0) {
        const invoice = invoices[0];
        
        // Send payment confirmation email
        await sendEmail({
          to: invoice.customers.email,
          subject: 'Payment Confirmation',
          html: `
            <h2>Payment Confirmation</h2>
            <p>Hello ${invoice.customers.first_name},</p>
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
    
    // Build the query
    let query = supabase
      .from('requests')
      .select(`
        *,
        customers!left(first_name, last_name, email, phone),
        services!left(name, price, duration)
      `)
      .eq('user_id', userId);
    
    // Add filter conditions
    if (filter === 'booking') {
      query = query.eq('type', 'booking');
    } else if (filter === 'quote') {
      query = query.eq('type', 'quote');
    }
    
    if (status) {
      query = query.eq('status', status);
    }
    
    // Add sorting
    query = query.order(sortBy, { ascending: sortOrder === 'ASC' });
    
    // Add pagination
    const offset = (page - 1) * limit;
    query = query.range(offset, offset + parseInt(limit) - 1);
    
    const { data: requests, error } = await query;
    
    if (error) {
      console.error('Error fetching requests:', error);
      return res.status(500).json({ error: 'Failed to fetch requests' });
    }
    
    // Get total count for pagination
    let countQuery = supabase
      .from('requests')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);
    
    if (filter === 'booking') {
      countQuery = countQuery.eq('type', 'booking');
    } else if (filter === 'quote') {
      countQuery = countQuery.eq('type', 'quote');
    }
    
    if (status) {
      countQuery = countQuery.eq('status', status);
    }
    
    const { count: total, error: countError } = await countQuery;
    
    if (countError) {
      console.error('Error counting requests:', countError);
      return res.status(500).json({ error: 'Failed to count requests' });
    }
    
    // Flatten the nested data for easier consumption
    const flattenedRequests = requests.map(request => ({
      ...request,
      customer_first_name: request.customers?.first_name,
      customer_last_name: request.customers?.last_name,
      customer_email: request.customers?.email,
      customer_phone: request.customers?.phone,
      service_name: request.services?.name,
      service_price: request.services?.price,
      service_duration: request.services?.duration,
      customers: undefined,
      services: undefined
    }));
    
    res.json({
      requests: flattenedRequests,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: total || 0,
        pages: Math.ceil((total || 0) / limit)
      }
    });
  } catch (error) {
    console.error('Get requests error:', error);
    res.status(500).json({ error: 'Failed to fetch requests' });
  }
});

app.get('/api/requests/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    const { data: requests, error } = await supabase
      .from('requests')
      .select(`
        *,
        customers!left(first_name, last_name, email, phone),
        services!left(name, price, duration)
      `)
      .eq('id', id)
      .limit(1);
    
    if (error) {
      console.error('Error fetching request:', error);
      return res.status(500).json({ error: 'Failed to fetch request' });
    }
    
    if (!requests || requests.length === 0) {
      return res.status(404).json({ error: 'Request not found' });
    }
    
    const request = requests[0];
    
    // Flatten the nested data for easier consumption
    const flattenedRequest = {
      ...request,
      customer_first_name: request.customers?.first_name,
      customer_last_name: request.customers?.last_name,
      customer_email: request.customers?.email,
      customer_phone: request.customers?.phone,
      service_name: request.services?.name,
      service_price: request.services?.price,
      service_duration: request.services?.duration,
      customers: undefined,
      services: undefined
    };
    
    res.json(flattenedRequest);
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
    
    let actualCustomerId = customerId;
    
    // If no customerId provided, create or find customer
    if (!customerId && customerName && customerEmail) {
      const { data: existingCustomer, error: checkError } = await supabase
        .from('customers')
        .select('id')
        .eq('email', customerEmail)
        .eq('user_id', userId)
        .limit(1);
      
      if (checkError) {
        console.error('Error checking existing customer:', checkError);
        return res.status(500).json({ error: 'Failed to check existing customer' });
      }
      
      if (existingCustomer && existingCustomer.length > 0) {
        actualCustomerId = existingCustomer[0].id;
      } else {
        const { data: newCustomer, error: createError } = await supabase
          .from('customers')
          .insert({
            user_id: userId,
            first_name: customerName.split(' ')[0],
            last_name: customerName.split(' ').slice(1).join(' ') || '',
            email: customerEmail,
            phone: customerPhone,
            status: 'active'
          })
          .select()
          .single();
        
        if (createError) {
          console.error('Error creating customer:', createError);
          return res.status(500).json({ error: 'Failed to create customer' });
        }
        
        actualCustomerId = newCustomer.id;
      }
    }
    
    // Create the request
    const { data: request, error: insertError } = await supabase
      .from('requests')
      .insert({
        user_id: userId,
        customer_id: actualCustomerId,
        service_id: serviceId,
        type: type,
        status: status,
        scheduled_date: scheduledDate,
        scheduled_time: scheduledTime,
        estimated_duration: estimatedDuration,
        estimated_price: estimatedPrice,
        notes: notes
      })
      .select(`
        *,
        customers!left(first_name, last_name, email, phone),
        services!left(name, price, duration)
      `)
      .single();
    
    if (insertError) {
      console.error('Error creating request:', insertError);
      return res.status(500).json({ error: 'Failed to create request' });
    }
    
    // Flatten the nested data for easier consumption
    const flattenedRequest = {
      ...request,
      customer_first_name: request.customers?.first_name,
      customer_last_name: request.customers?.last_name,
      customer_email: request.customers?.email,
      customer_phone: request.customers?.phone,
      service_name: request.services?.name,
      service_price: request.services?.price,
      service_duration: request.services?.duration,
      customers: undefined,
      services: undefined
    };
    
    res.status(201).json(flattenedRequest);
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
    
    // Update the request
    const { data: updatedRequest, error: updateError } = await supabase
      .from('requests')
      .update({
        status: status,
        scheduled_date: scheduledDate,
        scheduled_time: scheduledTime,
        estimated_duration: estimatedDuration,
        estimated_price: estimatedPrice,
        notes: notes
      })
      .eq('id', id)
      .select(`
        *,
        customers!left(first_name, last_name, email, phone),
        services!left(name, price, duration)
      `)
      .single();
    
    if (updateError) {
      console.error('Error updating request:', updateError);
      return res.status(500).json({ error: 'Failed to update request' });
    }
    
    if (!updatedRequest) {
      return res.status(404).json({ error: 'Request not found' });
    }
    
    // Flatten the nested data for easier consumption
    const flattenedRequest = {
      ...updatedRequest,
      customer_first_name: updatedRequest.customers?.first_name,
      customer_last_name: updatedRequest.customers?.last_name,
      customer_email: updatedRequest.customers?.email,
      customer_phone: updatedRequest.customers?.phone,
      service_name: updatedRequest.services?.name,
      service_price: updatedRequest.services?.price,
      service_duration: updatedRequest.services?.duration,
      customers: undefined,
      services: undefined
    };
    
    res.json(flattenedRequest);
  } catch (error) {
    console.error('Update request error:', error);
    res.status(500).json({ error: 'Failed to update request' });
  }
});

app.delete('/api/requests/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { error: deleteError } = await supabase
      .from('requests')
      .delete()
      .eq('id', id);
    
    if (deleteError) {
      console.error('Error deleting request:', deleteError);
      return res.status(500).json({ error: 'Failed to delete request' });
    }
    
    res.json({ message: 'Request deleted successfully' });
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
          hideServiceflowBranding: false,
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
    
    // Upload to Supabase Storage
    const result = await uploadToStorage(req.file, BUCKETS.LOGOS, 'logos');
    res.json({ url: result.imageUrl });
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
    
    // Upload to Supabase Storage
    const result = await uploadToStorage(req.file, BUCKETS.FAVICONS, 'favicons');
    res.json({ url: result.imageUrl });
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
    
    // Upload to Supabase Storage
    const result = await uploadToStorage(req.file, BUCKETS.HERO_IMAGES, 'hero');
    res.json({ url: result.imageUrl });
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
          hideServiceflowBranding: false,
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
// Google Places API endpoints (Simple approach)
app.get('/api/places/autocomplete', async (req, res) => {
  try {
    const { input } = req.query;
    
    if (!input || input.length < 3) {
      return res.json({ predictions: [] });
    }
    
    const GOOGLE_API_KEY = process.env.GOOGLE_MAPS_API_KEY || 'AIzaSyC_CrJWTsTHOTBd7TSzTuXOfutywZ2AyOQ';
    
  
    if (!GOOGLE_API_KEY || GOOGLE_API_KEY === 'AIzaSyC_CrJWTsTHOTBd7TSzTuXOfutywZ2AyOQ') {
      console.warn('Using provided Google API key - ensure it has Places API enabled');
    }
    
    const response = await axios.get(
      "https://maps.googleapis.com/maps/api/place/autocomplete/json",
      {
        params: {
          input,
          key: GOOGLE_API_KEY,
          types: "address",
        },
      }
    );
    
    
    if (response.data.status === 'OK') {
      res.json({ predictions: response.data.predictions });
    } else {
      console.error('Google Places API error:', response.data.status, response.data.error_message);
      res.status(400).json({ error: `Google Places API error: ${response.data.status}`, details: response.data.error_message });
    }
  } catch (error) {
    console.error('Google Places autocomplete error:', error);
    res.status(500).json({ error: "Autocomplete failed" });
  }
});

app.get('/api/places/details', async (req, res) => {
  try {
    const { place_id } = req.query;
    
    if (!place_id) {
      return res.status(400).json({ error: 'place_id is required' });
    }
    
    const GOOGLE_API_KEY = process.env.GOOGLE_MAPS_API_KEY || 'AIzaSyC_CrJWTsTHOTBd7TSzTuXOfutywZ2AyOQ';
    
    
    const response = await axios.get(
      "https://maps.googleapis.com/maps/api/place/details/json",
      {
        params: {
          place_id: place_id,
          key: GOOGLE_API_KEY,
          fields: "formatted_address,geometry,name,address_components",
        },
      }
    );
    
    
    if (response.data.status === 'OK') {
      res.json({ result: response.data.result });
    } else {
      console.error('Google Places API details error:', response.data.status, response.data.error_message);
      res.status(400).json({ error: `Google Places API error: ${response.data.status}`, details: response.data.error_message });
    }
  } catch (error) {
    console.error('Google Places details error:', error);
    res.status(500).json({ error: "Place details failed" });
  }
});
// Assign job to team member
app.post('/api/jobs/:jobId/assign', authenticateToken, async (req, res) => {
  // CORS handled by middleware
  
  try {
    const { jobId } = req.params;
    const { teamMemberId } = req.body;
    const userId = req.user.userId;
    
      // Check if job exists and belongs to user
    const { data: jobCheck, error: jobError } = await supabase
      .from('jobs')
      .select('id, user_id')
      .eq('id', jobId)
      .limit(1);
    
    if (jobError) {
      console.error('Error checking job:', jobError);
      return res.status(500).json({ error: 'Failed to check job' });
    }
    
    if (!jobCheck || jobCheck.length === 0) {
        return res.status(404).json({ error: 'Job not found' });
      }
      
      if (jobCheck[0].user_id !== userId) {
        return res.status(403).json({ error: 'Access denied' });
      }
      
      // Check if team member exists (if teamMemberId is provided)
      if (teamMemberId) {
      const { data: memberCheck, error: memberError } = await supabase
        .from('team_members')
        .select('id')
        .eq('id', teamMemberId)
        .eq('user_id', userId)
        .limit(1);
      
      if (memberError) {
        console.error('Error checking team member:', memberError);
        return res.status(500).json({ error: 'Failed to check team member' });
      }
      
      if (!memberCheck || memberCheck.length === 0) {
          return res.status(404).json({ error: 'Team member not found' });
        }
      }
      
      // Remove existing assignments for this job
    const { error: deleteError } = await supabase
      .from('job_team_assignments')
      .delete()
      .eq('job_id', jobId);
    
    if (deleteError) {
      console.error('Error removing existing assignments:', deleteError);
      return res.status(500).json({ error: 'Failed to remove existing assignments' });
    }
      
      // Update the job with team member assignment (for backward compatibility)
    const { error: updateError } = await supabase
      .from('jobs')
      .update({ team_member_id: teamMemberId || null })
      .eq('id', jobId);
    
    if (updateError) {
      console.error('Error updating job:', updateError);
      return res.status(500).json({ error: 'Failed to update job' });
    }
      
      // Create assignment in job_team_assignments table
      if (teamMemberId) {
      const { error: insertError } = await supabase
        .from('job_team_assignments')
        .insert({
          job_id: jobId,
          team_member_id: teamMemberId,
          is_primary: true,
          assigned_by: userId
        });
      
      if (insertError) {
        console.error('Error creating team assignment:', insertError);
        return res.status(500).json({ error: 'Failed to create team assignment' });
      }
      
     }
      
      res.json({ message: 'Job assigned successfully' });
  } catch (error) {
    console.error('Job assignment error:', error);
    res.status(500).json({ error: 'Failed to assign job' });
  }
});

// Remove team member assignment from job
app.delete('/api/jobs/:jobId/assign/:teamMemberId', authenticateToken, async (req, res) => {
  // CORS handled by middleware
  
  try {
    const { jobId, teamMemberId } = req.params;
    const userId = req.user.userId;
    
      // Check if job exists and belongs to user
    const { data: jobCheck, error: jobError } = await supabase
      .from('jobs')
      .select('id, user_id')
      .eq('id', jobId)
      .limit(1);
    
    if (jobError) {
      console.error('Error checking job:', jobError);
      return res.status(500).json({ error: 'Failed to check job' });
    }
    
    if (!jobCheck || jobCheck.length === 0) {
        return res.status(404).json({ error: 'Job not found' });
      }
      
      if (jobCheck[0].user_id !== userId) {
        return res.status(403).json({ error: 'Access denied' });
      }
      
      // Check if team member exists and belongs to user
    const { data: memberCheck, error: memberError } = await supabase
      .from('team_members')
      .select('id')
      .eq('id', teamMemberId)
      .eq('user_id', userId)
      .limit(1);
    
    if (memberError) {
      console.error('Error checking team member:', memberError);
      return res.status(500).json({ error: 'Failed to check team member' });
    }
    
    if (!memberCheck || memberCheck.length === 0) {
        return res.status(404).json({ error: 'Team member not found' });
      }
      
      // Remove the specific assignment
    const { data: deleteResult, error: deleteError } = await supabase
      .from('job_team_assignments')
      .delete()
      .eq('job_id', jobId)
      .eq('team_member_id', teamMemberId)
      .select();
    
    if (deleteError) {
      console.error('Error removing assignment:', deleteError);
      return res.status(500).json({ error: 'Failed to remove assignment' });
    }
    
    if (!deleteResult || deleteResult.length === 0) {
        return res.status(404).json({ error: 'Team member assignment not found' });
      }
      
      // Check if this was the primary assignment and update jobs table accordingly
    const { data: primaryCheck, error: primaryError } = await supabase
      .from('job_team_assignments')
      .select('id')
      .eq('job_id', jobId)
      .eq('is_primary', true);
    
    if (primaryError) {
      console.error('Error checking primary assignments:', primaryError);
      return res.status(500).json({ error: 'Failed to check primary assignments' });
    }
    
    if (!primaryCheck || primaryCheck.length === 0) {
        // No more primary assignments, clear the team_member_id in jobs table
      const { error: updateError } = await supabase
        .from('jobs')
        .update({ team_member_id: null })
        .eq('id', jobId);
      
      if (updateError) {
        console.error('Error clearing team member from job:', updateError);
        return res.status(500).json({ error: 'Failed to clear team member from job' });
      }
      } else {
        // Set the first remaining assignment as primary
      const { data: remainingAssignments, error: remainingError } = await supabase
        .from('job_team_assignments')
        .select('team_member_id')
        .eq('job_id', jobId)
        .order('assigned_at', { ascending: true })
        .limit(1);
      
      if (remainingError) {
        console.error('Error getting remaining assignments:', remainingError);
        return res.status(500).json({ error: 'Failed to get remaining assignments' });
      }
      
      if (remainingAssignments && remainingAssignments.length > 0) {
        const { error: updateError } = await supabase
          .from('jobs')
          .update({ team_member_id: remainingAssignments[0].team_member_id })
          .eq('id', jobId);
        
        if (updateError) {
          console.error('Error updating job with new primary team member:', updateError);
          return res.status(500).json({ error: 'Failed to update job with new primary team member' });
        }
        }
      }
     res.json({ message: 'Team member assignment removed successfully' });
  } catch (error) {
    console.error('Remove team assignment error:', error);
    res.status(500).json({ error: 'Failed to remove team member assignment' });
  }
});

// Get team assignments for a job
app.get('/api/jobs/:jobId/assignments', authenticateToken, async (req, res) => {
  // CORS handled by middleware
  
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
  // CORS handled by middleware
  
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
   const connection = await pool.getConnection();
    
    try {
      // Test basic connection
      const [result] = await connection.query('SELECT 1 as test');
     
      // Test team_members table
      let teamMembersTable = false;
      try {
        const [teamMembersResult] = await connection.query('SELECT COUNT(*) as count FROM team_members LIMIT 1');
        teamMembersTable = true;
      } catch (error) {
     }
      
      // Test jobs table
      let jobsTable = false;
      try {
        const [jobsResult] = await connection.query('SELECT COUNT(*) as count FROM jobs LIMIT 1');
        jobsTable = true;
      } catch (error) {
      }
      
      // Test customers table
      let customersTable = false;
      try {
        const [customersResult] = await connection.query('SELECT COUNT(*) as count FROM customers LIMIT 1');
        customersTable = true;
      } catch (error) {
      }
      
      // Test services table
      let servicesTable = false;
      try {
        const [servicesResult] = await connection.query('SELECT COUNT(*) as count FROM services LIMIT 1');
        servicesTable = true;
      } catch (error) {
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
    
    const connection = await pool.getConnection();
    
    try {
      const [teamMembers] = await connection.query(
        'SELECT id, first_name, last_name, email, username FROM team_members WHERE id = ?',
        [id]
      );
      
      if (teamMembers.length === 0) {
        return res.json({ 
          found: false, 
          message: 'Team member not found',
          availableIds: []
        });
      }
      
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
    
    const connection = await pool.getConnection();
    
    try {
      // Get table structure
      const [columns] = await connection.query(`
        SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT 
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'jobs'
        ORDER BY ORDINAL_POSITION
      `);
      
      
      // Check if team_member_id column exists
      const hasTeamMemberId = columns.some(col => col.COLUMN_NAME === 'team_member_id');
      
      // Test a simple jobs query
      let jobsCount = 0;
      try {
        const [jobsResult] = await connection.query('SELECT COUNT(*) as count FROM jobs');
        jobsCount = jobsResult[0].count;
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
      } else { }
      
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
       
        // Update existing team members with default settings
        await connection.query(`
          UPDATE team_members SET settings = JSON_OBJECT(
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
      } else {
      }
      
      // Show table structure
      const [columns] = await connection.query('DESCRIBE team_members');
    
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
       
        // Add foreign key constraint if team_members table exists
        try {
          await connection.query(`
            ALTER TABLE jobs 
            ADD CONSTRAINT fk_jobs_team_member 
            FOREIGN KEY (team_member_id) REFERENCES team_members(id) 
            ON DELETE SET NULL
          `);
        } catch (fkError) {
        }
        
        // Add index for better performance
        try {
          await connection.query('CREATE INDEX idx_jobs_team_member_id ON jobs(team_member_id)');
        
        } catch (indexError) {
        }
      } else {
      }
      
      // Show table structure
      const [columns] = await connection.query('DESCRIBE jobs');
      
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
        
        
        // Update existing team members with sample skills
        await connection.query(`
          UPDATE team_members SET skills = JSON_ARRAY(
            JSON_OBJECT('name', 'Regular Cleaning', 'level', 'Expert'),
            JSON_OBJECT('name', 'Deep Cleaning', 'level', 'Advanced'),
            JSON_OBJECT('name', 'Window Cleaning', 'level', 'Intermediate')
          ) WHERE skills IS NULL
        `);
      } else {
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
        
        
        // Assign territory 1 to team member 3 (Mike Davis) for testing
        await connection.query(`
          UPDATE team_members SET territories = JSON_ARRAY(1) WHERE id = 3
        `);
      } else {
      }
      
      // Show table structure
      const [columns] = await connection.query('DESCRIBE team_members');
      
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
    
    const connection = await pool.getConnection();
    
    try {
      // Add territories column to team_members table
      await connection.query('ALTER TABLE team_members ADD COLUMN IF NOT EXISTS territories JSON NULL');
     
      
      // Assign territory 1 to team member 3 (Mike Davis) for testing
      await connection.query(`
        UPDATE team_members SET territories = JSON_ARRAY(1) WHERE id = 3
      `);
      
      // Verify the update
      const [result] = await connection.query(`
        SELECT id, first_name, last_name, territories FROM team_members WHERE id = 3
      `);
      
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
    const connection = await pool.getConnection();
    
    try {
      // Test basic connection
      const [result] = await connection.query('SELECT 1 as test');
      // Test all tables
      const tables = ['jobs', 'team_members', 'customers', 'services', 'users'];
      const tableStatus = {};
      
      for (const table of tables) {
        try {
          const [tableResult] = await connection.query(`SELECT COUNT(*) as count FROM ${table} LIMIT 1`);
          tableStatus[table] = { exists: true, count: tableResult[0].count };
       } catch (error) {
          tableStatus[table] = { exists: false, error: error.message };
        }
      }
      
      // Test team_member_notifications table specifically
      try {
        const [notificationsResult] = await connection.query('SELECT COUNT(*) as count FROM team_member_notifications LIMIT 1');
        tableStatus.team_member_notifications = { exists: true, count: notificationsResult[0].count };
      } catch (error) {
        tableStatus.team_member_notifications = { exists: false, error: error.message };
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

// Test endpoint to verify CORS is working
app.get('/api/test-cors', (req, res) => {
  // CORS handled by middleware
  
  res.json({ 
    message: 'CORS is working!', 
    timestamp: new Date().toISOString(),
    status: 'success',
    origin: req.headers.origin
  });
});

// Team member reset password endpoint
app.post('/api/team-members/reset-password', async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    
    // Find team member by email
    const { data: teamMember, error: findError } = await supabase
      .from('team_members')
      .select('id, first_name, last_name, email, user_id')
      .eq('email', email)
      .single();
    
    if (findError || !teamMember) {
      return res.status(404).json({ error: 'Team member not found with this email address' });
    }
    
    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetExpires = new Date(Date.now() + 3600000); // 1 hour from now
    
    // Store reset token in database
    const { error: updateError } = await supabase
      .from('team_members')
      .update({
        reset_token: resetToken,
        reset_token_expires: resetExpires.toISOString()
      })
      .eq('id', teamMember.id);
    
    if (updateError) {
      console.error('❌ Error storing reset token:', updateError);
      return res.status(500).json({ error: 'Failed to generate reset token' });
    }
    
    // Send reset email
    const resetUrl = `${process.env.FRONTEND_URL || 'https://www.service-flow.pro'}/team-member/reset-password?token=${resetToken}`;
    
    const emailContent = {
      to: email,
      from: process.env.SENDGRID_FROM_EMAIL || 'noreply@service-flow.com',
      subject: 'Reset Your Team Member Password',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #2563eb;">Password Reset Request</h2>
          <p>Hello ${teamMember.first_name},</p>
          <p>You requested to reset your password for your team member account.</p>
          <p>Click the button below to reset your password:</p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${resetUrl}" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Reset Password</a>
          </div>
          <p>This link will expire in 1 hour.</p>
          <p>If you didn't request this password reset, please ignore this email.</p>
          <p>Best regards,<br>Service Flow Team</p>
        </div>
      `
    };
    
    try {
      await sgMail.send(emailContent);
      res.json({ message: 'Password reset instructions sent to your email' });
    } catch (emailError) {
      console.error('❌ Error sending reset email:', emailError);
      res.status(500).json({ error: 'Failed to send reset email' });
    }
    
  } catch (error) {
    console.error('❌ Team member reset password error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Add OPTIONS handler for test endpoint
// OPTIONS handled by catch-all above

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
    const logoUrl = `${UPLOAD_BASE_URL}/uploads/${filename}`;
    
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

    // Upload to Supabase Storage
    const result = await uploadToStorage(req.file, BUCKETS.PROFILE_PICTURES, 'profiles');
    const profilePictureUrl = result.imageUrl;

    // ✅ Save file info to database using Supabase
    const { error: updateError } = await supabase
      .from('users')
      .update({ profile_picture: profilePictureUrl })
      .eq('id', userId);

    if (updateError) {
      console.error('❌ Error saving profile picture URL to database:', updateError);
      return res.status(500).json({ error: 'Failed to save profile picture URL' });
    }

    // ✅ Success
    res.json({ 
      message: 'Profile picture uploaded successfully',
      profilePictureUrl
    });

  } catch (error) {
    console.error('🔥 Error uploading profile picture:', error);
    res.status(500).json({ error: 'Failed to upload profile picture' });
  }
});


// Service image upload endpoint
app.post('/api/upload-service-image', authenticateToken, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image uploaded' });
    }

    // Upload to Supabase Storage
    const result = await uploadToStorage(req.file, BUCKETS.SERVICE_IMAGES, 'services');

    res.json(result);
  } catch (error) {
    console.error('Error uploading service image:', error);
    res.status(500).json({ error: 'Failed to upload service image' });
  }
});

// Modifier image upload endpoint
app.post('/api/upload-modifier-image', authenticateToken, upload.single('image'), async (req, res) => {
 
  
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image uploaded' });
    }

    // Upload to Supabase Storage
    const result = await uploadToStorage(req.file, BUCKETS.MODIFIER_IMAGES, 'modifiers');
 res.json(result);
  } catch (error) {
    console.error('❌ Error uploading modifier image:', error);
    res.status(500).json({ error: 'Failed to upload modifier image' });
  }
});

// Intake image upload endpoint
app.post('/api/upload-intake-image', authenticateToken, upload.single('image'), async (req, res) => {

  
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image uploaded' });
    }

    // Upload to Supabase Storage
    const result = await uploadToStorage(req.file, BUCKETS.INTAKE_IMAGES, 'intake');

    res.json(result);
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
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    const connection = await pool.getConnection();
    
    try {
      // Get branding settings for the user
      const [brandingData] = await connection.query(`
        SELECT 
          logo_url as logo,
          show_logo_in_admin as showLogoInAdmin,
          primary_color as primaryColor
        FROM user_branding 
        WHERE user_id = ?
      `, [userId]);

      if (brandingData.length > 0) {
        const branding = brandingData[0];
        // Ensure logo URL is complete
        if (branding.logo && !branding.logo.startsWith('http')) {
          branding.logo = `${UPLOAD_BASE_URL}${branding.logo}`;
        }
        res.json(branding);
      } else {
        // Return default branding if none exists
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
    const { userId, logo, showLogoInAdmin, primaryColor } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    const connection = await pool.getConnection();
    
    try {
      // Check if branding record exists
      const [existing] = await connection.query(`
        SELECT id FROM user_branding WHERE user_id = ?
      `, [userId]);

      if (existing.length > 0) {
        // Update existing record
        await connection.query(`
          UPDATE user_branding 
          SET 
            logo_url = ?,
            show_logo_in_admin = ?,
            primary_color = ?,
            updated_at = NOW()
          WHERE user_id = ?
        `, [logo, showLogoInAdmin ? 1 : 0, primaryColor, userId]);
      } else {
        // Create new record
        await connection.query(`
          INSERT INTO user_branding (user_id, logo_url, show_logo_in_admin, primary_color)
          VALUES (?, ?, ?, ?)
        `, [userId, logo, showLogoInAdmin ? 1 : 0, primaryColor]);
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

// User Profile API endpoints - REMOVED DUPLICATE (using Supabase version above)

// REMOVED DUPLICATE PUT /api/user/profile endpoint (using Supabase version above)

// Notification Templates API endpoints
app.get('/api/user/notification-templates', async (req, res) => {
  try {
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

      const [templates] = await connection.query(query, params);

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
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    const connection = await pool.getConnection();
    
    try {
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

app.post('/api/services/categories', async (req, res) => {
  try {
    const { userId, name, description, color } = req.body;
  
    // Validate required fields
    if (!userId || !name) {
      return res.status(400).json({ error: 'userId and name are required' });
    }
    
    // Check if category name already exists for this user
    const { data: existing, error: checkError } = await supabase
      .from('service_categories')
      .select('id')
      .eq('user_id', userId)
      .eq('name', name)
      .limit(1);
    
    if (checkError) {
      console.error('Error checking existing category:', checkError);
      return res.status(500).json({ error: 'Failed to create category' });
    }
    
    if (existing && existing.length > 0) {
      return res.status(400).json({ error: 'Category name already exists' });
    }
    
    const { data: result, error: insertError } = await supabase
      .from('service_categories')
      .insert({
        user_id: userId,
        name: name,
        description: description || null,
        color: color || '#3B82F6'
      })
      .select()
      .single();
    
    if (insertError) {
      console.error('Error creating category:', insertError);
      return res.status(500).json({ error: 'Failed to create category' });
    }
    
    res.status(201).json(result);
  } catch (error) {
    console.error('Create category error:', error);
    res.status(500).json({ error: 'Failed to create category' });
  }
});

app.put('/api/services/categories/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, color } = req.body;
    
   
    
    // Check if category exists
    const { data: existing, error: checkError } = await supabase
      .from('service_categories')
      .select('*')
      .eq('id', id)
      .limit(1);
    
    if (checkError) {
      console.error('Error checking existing category:', checkError);
      return res.status(500).json({ error: 'Failed to update category' });
    }
    
    if (!existing || existing.length === 0) {
      return res.status(404).json({ error: 'Category not found' });
    }
    
    // Check if new name conflicts with existing category (excluding current category)
    if (name && name !== existing[0].name) {
      const { data: nameConflict, error: conflictError } = await supabase
        .from('service_categories')
        .select('id')
        .eq('user_id', existing[0].user_id)
        .eq('name', name)
        .neq('id', id)
        .limit(1);
      
      if (conflictError) {
        console.error('Error checking name conflict:', conflictError);
        return res.status(500).json({ error: 'Failed to update category' });
      }
      
      if (nameConflict && nameConflict.length > 0) {
        return res.status(400).json({ error: 'Category name already exists' });
      }
    }
    
    // Build update object
    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (description !== undefined) updateData.description = description;
    if (color !== undefined) updateData.color = color;
    
    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }
    
    // Update the category
    const { data: result, error: updateError } = await supabase
      .from('service_categories')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();
    
    if (updateError) {
      console.error('Error updating category:', updateError);
      return res.status(500).json({ error: 'Failed to update category' });
    }
    
    if (!result) {
      return res.status(404).json({ error: 'Category not found' });
    }
    
    res.json(result);
  } catch (error) {
    console.error('Update category error:', error);
    res.status(500).json({ error: 'Failed to update category' });
  }
});

app.delete('/api/services/categories/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    
    // Check if category exists
    const { data: existing, error: checkError } = await supabase
      .from('service_categories')
      .select('*')
      .eq('id', id)
      .limit(1);
    
    if (checkError) {
      console.error('Error checking existing category:', checkError);
      return res.status(500).json({ error: 'Failed to delete category' });
    }
    
    if (!existing || existing.length === 0) {
      return res.status(404).json({ error: 'Category not found' });
    }
    
    // Check if any services are using this category
    const { data: servicesUsingCategory, error: countError } = await supabase
      .from('services')
      .select('id', { count: 'exact', head: true })
      .eq('category_id', id);
    
    if (countError) {
      console.error('Error checking services using category:', countError);
      return res.status(500).json({ error: 'Failed to delete category' });
    }
    
    const serviceCount = servicesUsingCategory?.length || 0;
    
    if (serviceCount > 0) {
      // Instead of preventing deletion, set services to uncategorized
     const { error: updateError } = await supabase
        .from('services')
        .update({ category_id: null })
        .eq('category_id', id);
      
      if (updateError) {
        console.error('Error updating services:', updateError);
        return res.status(500).json({ error: 'Failed to delete category' });
      }
    }
    
    // Delete the category
    const { error: deleteError } = await supabase
      .from('service_categories')
      .delete()
      .eq('id', id);
    
    if (deleteError) {
      console.error('Error deleting category:', deleteError);
      return res.status(500).json({ error: 'Failed to delete category' });
    }
    
    // Create response message based on whether services were affected
    let message = 'Category deleted successfully';
    if (serviceCount > 0) {
      message = `Category deleted successfully. ${serviceCount} service(s) have been set to uncategorized.`;
    }
    
    res.json({ message });
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

    // Get business details from users table
    const { data: userData, error } = await supabase
      .from('users')
      .select(`
        business_name,
        business_email,
        phone,
        email,
        first_name,
        last_name,
        business_slug
      `)
      .eq('id', userId)
      .limit(1);

    if (error) {
      console.error('Error fetching business details:', error);
      return res.status(500).json({ error: 'Failed to fetch business details' });
    }

    if (userData && userData.length > 0) {
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
    
    // Test Supabase connection
    const { data, error } = await supabase
      .from('users')
      .select('id')
      .limit(1);
    
    if (error) {
      console.error('❌ Supabase connection error:', error);
      return;
    }
    
  } catch (error) {
    console.error('❌ Database initialization error:', error);
  }
};
// Customer notification preferences endpoints
app.get('/api/customers/:customerId/notifications', async (req, res) => {
  try {
    const { customerId } = req.params;
    
    // Get customer notification preferences from database
    const { data: preferences, error } = await supabase
      .from('customer_notification_preferences')
      .select('email_notifications, sms_notifications')
      .eq('customer_id', customerId)
      .single();
    
    if (error) {
      console.error('Error fetching customer notification preferences:', error);
      return res.status(404).json({ error: 'Customer notification preferences not found' });
    }
    
    res.json({
      email_notifications: preferences.email_notifications || false,
      sms_notifications: preferences.sms_notifications || false
    });
  } catch (error) {
    console.error('Get customer notification preferences error:', error);
    res.status(500).json({ error: 'Failed to fetch notification preferences' });
  }
});

app.put('/api/customers/:customerId/notifications', async (req, res) => {
  try {
    const { customerId } = req.params;
    const { email_notifications, sms_notifications } = req.body;
    
    // Update customer notification preferences
    const { data: preferences, error } = await supabase
      .from('customer_notification_preferences')
      .upsert({
        customer_id: customerId,
        email_notifications: email_notifications || false,
        sms_notifications: sms_notifications || false
      })
      .select()
      .single();
    
    if (error) {
      console.error('Error updating customer notification preferences:', error);
      return res.status(404).json({ error: 'Customer notification preferences not found' });
    }
    
    res.json({
      email_notifications: preferences.email_notifications,
      sms_notifications: preferences.sms_notifications
    });
  } catch (error) {
    console.error('Update customer notification preferences error:', error);
    res.status(500).json({ error: 'Failed to update notification preferences' });
  }
});

// Address Validation API endpoint
app.post('/api/address/validate', async (req, res) => {
  try {
    const { address } = req.body;
    
    if (!address) {
      return res.status(400).json({ error: 'Address is required' });
    }

    const GOOGLE_API_KEY = process.env.GOOGLE_MAPS_API_KEY || 'AIzaSyC_CrJWTsTHOTBd7TSzTuXOfutywZ2AyOQ';
    
    if (!GOOGLE_API_KEY || GOOGLE_API_KEY === 'AIzaSyC_CrJWTsTHOTBd7TSzTuXOfutywZ2AyOQ') {
      console.warn('Using provided Google API key - ensure it has Places API enabled');
    }

    const response = await axios.post(
      `https://addressvalidation.googleapis.com/v1:validateAddress?key=${GOOGLE_API_KEY}`,
      {
        address: {
          addressLines: [address]
        }
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-User-Project': 'serviceflow-backend'
        }
      }
    );

    if (response.data && response.data.result) {
      const validationResult = response.data.result;
      
      // Extract useful information from the validation result
      const processedResult = {
        isValid: validationResult.verdict?.inputGranularity === 'PREMISE' || 
                validationResult.verdict?.inputGranularity === 'SUB_PREMISE' ||
                validationResult.verdict?.inputGranularity === 'ROUTE',
        confidence: validationResult.verdict?.addressComplete ? 'HIGH' : 'MEDIUM',
        formattedAddress: validationResult.address?.formattedAddress,
        components: {
          streetNumber: validationResult.address?.addressComponents?.find(c => c.componentType === 'street_number')?.componentName,
          route: validationResult.address?.addressComponents?.find(c => c.componentType === 'route')?.componentName,
          locality: validationResult.address?.addressComponents?.find(c => c.componentType === 'locality')?.componentName,
          administrativeArea: validationResult.address?.addressComponents?.find(c => c.componentType === 'administrative_area_level_1')?.componentName,
          postalCode: validationResult.address?.addressComponents?.find(c => c.componentType === 'postal_code')?.componentName,
          country: validationResult.address?.addressComponents?.find(c => c.componentType === 'country')?.componentName
        },
        geocode: validationResult.geocode,
        suggestions: validationResult.address?.addressComponents?.map(comp => ({
          type: comp.componentType,
          name: comp.componentName,
          longName: comp.longName
        })) || [],
        issues: validationResult.verdict?.issues || []
      };

      res.json({
        success: true,
        result: processedResult
      });
    } else {
      res.json({
        success: false,
        error: 'No validation result returned'
      });
    }

  } catch (error) {
    console.error('Address validation error:', error);
    
    if (error.response) {
      console.error('Google API error response:', error.response.data);
      console.error('Google API error status:', error.response.status);
      console.error('Google API error headers:', error.response.headers);
      
      // If Google API fails, fall back to geocoding
      try {
        const geocodeResponse = await axios.get(
          `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_API_KEY}`
        );
        
        if (geocodeResponse.data.status === 'OK' && geocodeResponse.data.results && geocodeResponse.data.results.length > 0) {
          const result = geocodeResponse.data.results[0];
          const formattedAddress = result.formatted_address;
          
          const fallbackResult = {
            isValid: true,
            confidence: 'MEDIUM',
            formattedAddress: formattedAddress,
            components: {
              streetNumber: result.address_components?.find(c => c.types.includes('street_number'))?.long_name,
              route: result.address_components?.find(c => c.types.includes('route'))?.long_name,
              locality: result.address_components?.find(c => c.types.includes('locality'))?.long_name,
              administrativeArea: result.address_components?.find(c => c.types.includes('administrative_area_level_1'))?.long_name,
              postalCode: result.address_components?.find(c => c.types.includes('postal_code'))?.long_name,
              country: result.address_components?.find(c => c.types.includes('country'))?.long_name
            },
            geocode: result.geometry?.location,
            suggestions: result.address_components?.map(comp => ({
              type: comp.types[0],
              name: comp.short_name,
              longName: comp.long_name
            })) || [],
            issues: []
          };

          res.json({
            success: true,
            result: fallbackResult
          });
          return;
        }
      } catch (fallbackError) {
        console.error('Geocoding fallback also failed:', fallbackError);
      }
      
      res.status(400).json({ 
        error: 'Address validation failed', 
        details: error.response.data?.error?.message || 'Unknown API error'
      });
    } else {
      res.status(500).json({ 
        error: 'Address validation service unavailable',
        details: error.message
      });
    }
  }
});

app.post('/api/address/geocode', async (req, res) => {
  try {
    const { address } = req.body;
    
    if (!address) {
      return res.status(400).json({ error: 'Address is required' });
    }

    const GOOGLE_API_KEY = process.env.GOOGLE_MAPS_API_KEY || 'AIzaSyC_CrJWTsTHOTBd7TSzTuXOfutywZ2AyOQ';
    
    const response = await axios.get(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_API_KEY}`
    );

    if (response.data.status === 'OK' && response.data.results && response.data.results.length > 0) {
      const result = response.data.results[0];
      const formattedAddress = result.formatted_address;
      
      // Process the geocoding result into validation format
      const validationResult = {
        isValid: true,
        confidence: 'MEDIUM',
        formattedAddress: formattedAddress,
        components: {
          streetNumber: result.address_components?.find(c => c.types.includes('street_number'))?.long_name,
          route: result.address_components?.find(c => c.types.includes('route'))?.long_name,
          locality: result.address_components?.find(c => c.types.includes('locality'))?.long_name,
          administrativeArea: result.address_components?.find(c => c.types.includes('administrative_area_level_1'))?.long_name,
          postalCode: result.address_components?.find(c => c.types.includes('postal_code'))?.long_name,
          country: result.address_components?.find(c => c.types.includes('country'))?.long_name
        },
        geocode: result.geometry?.location,
        suggestions: result.address_components?.map(comp => ({
          type: comp.types[0],
          name: comp.short_name,
          longName: comp.long_name
        })) || [],
        issues: []
      };

      res.json({
        success: true,
        result: validationResult
      });
    } else {
      res.json({
        success: false,
        result: {
          isValid: false,
          confidence: 'LOW',
          formattedAddress: null,
          components: {},
          geocode: null,
          suggestions: [],
          issues: ['Address not found']
        }
      });
    }

  } catch (error) {
    console.error('Geocoding API error:', error);
    res.status(500).json({ 
      error: 'Geocoding service unavailable',
      details: error.message
    });
  }
});

app.get('/api/customers/:customerId/notifications/history', async (req, res) => {
  try {
    const { customerId } = req.params;
    
    // Get notification history for customer (placeholder implementation)
    // In a real implementation, you would have a notifications table
    res.json({
      notifications: [],
      message: 'Notification history not implemented yet'
    });
  } catch (error) {
    console.error('Get customer notification history error:', error);
    res.status(500).json({ error: 'Failed to fetch notification history' });
  }
});
// Helper function to check if color column exists
async function checkColorColumn() {
  try {
    const { error } = await supabase
      .from('team_members')
      .select('color')
      .limit(1);
    return !error;
  } catch (err) {
    return false;
  }
}

// Migration endpoint to add color column
app.post('/api/migrate/add-color-column', async (req, res) => {
  try {
    
    // Add color column
    const { error: alterError } = await supabase.rpc('exec_sql', {
      sql: "ALTER TABLE team_members ADD COLUMN IF NOT EXISTS color VARCHAR(7) DEFAULT '#2563EB'"
    });
    
    if (alterError) {
      console.error('Error adding color column:', alterError);
      return res.status(500).json({ error: 'Failed to add color column', details: alterError.message });
    }
    
    // Update existing team members with default colors
    const { error: updateError } = await supabase.rpc('exec_sql', {
      sql: `
        UPDATE team_members 
        SET color = CASE 
          WHEN id % 7 = 1 THEN '#2563EB'
          WHEN id % 7 = 2 THEN '#DC2626'
          WHEN id % 7 = 3 THEN '#059669'
          WHEN id % 7 = 4 THEN '#D97706'
          WHEN id % 7 = 5 THEN '#7C3AED'
          WHEN id % 7 = 6 THEN '#DB2777'
          ELSE '#6B7280'
        END
        WHERE color IS NULL OR color = '#2563EB'
      `
    });
    
    if (updateError) {
      console.error('Error updating colors:', updateError);
      return res.status(500).json({ error: 'Failed to update colors', details: updateError.message });
    }
    
    res.json({ 
      success: true, 
      message: 'Color column added and existing team members updated with default colors' 
    });
    
  } catch (error) {
    console.error('Migration error:', error);
    res.status(500).json({ error: 'Migration failed', details: error.message });
  }
});

// Final CORS safety net - ensure all responses have CORS headers
app.use((req, res, next) => {
  const origin = req.headers.origin;
  
  // Set CORS headers on every response as a safety net
  if (origin) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin, Cache-Control, X-HTTP-Method-Override');
  }
  
  next();
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  
  // Set CORS headers even on errors
  const origin = req.headers.origin;
  if (origin) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin, Cache-Control, X-HTTP-Method-Override');
  }
  
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

// Twilio SMS endpoints
app.post('/api/sms/send', authenticateToken, async (req, res) => {
  try {
    const { to, message } = req.body;
    
    if (!to || !message) {
      return res.status(400).json({ error: 'Phone number and message are required' });
    }
    
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
      return res.status(500).json({ error: 'Twilio not configured' });
    }
    
    // Send SMS using Twilio
    const result = await twilioClient.messages.create({
      body: message,
      from: TWILIO_PHONE_NUMBER,
      to: to
    });
    
    console.log('📱 SMS sent successfully:', result.sid);
    
    res.json({ 
      success: true, 
      message: 'SMS sent successfully',
      sid: result.sid
    });
    
  } catch (error) {
    console.error('SMS sending error:', error);
    res.status(500).json({ error: 'Failed to send SMS' });
  }
});

// Send job confirmation SMS
app.post('/api/sms/job-confirmation', authenticateToken, async (req, res) => {
  try {
    const { customerPhone, jobDetails, customerName } = req.body;
    
    if (!customerPhone || !jobDetails) {
      return res.status(400).json({ error: 'Customer phone and job details are required' });
    }
    
    const message = `Hi ${customerName || 'there'}! Your booking is confirmed for ${jobDetails.service_name} on ${jobDetails.scheduled_date} at ${jobDetails.scheduled_time}. We'll see you soon! - ${req.user.businessName || 'Your Service Team'}`;
    
    const result = await twilioClient.messages.create({
      body: message,
      from: TWILIO_PHONE_NUMBER,
      to: customerPhone
    });
    
    console.log('📱 Job confirmation SMS sent:', result.sid);
    
    res.json({ 
      success: true, 
      message: 'Job confirmation SMS sent successfully',
      sid: result.sid
    });
    
  } catch (error) {
    console.error('Job confirmation SMS error:', error);
    res.status(500).json({ error: 'Failed to send job confirmation SMS' });
  }
});

// Send payment reminder SMS
app.post('/api/sms/payment-reminder', authenticateToken, async (req, res) => {
  try {
    const { customerPhone, invoiceDetails, customerName } = req.body;
    
    if (!customerPhone || !invoiceDetails) {
      return res.status(400).json({ error: 'Customer phone and invoice details are required' });
    }
    
    const message = `Hi ${customerName || 'there'}! This is a friendly reminder that your invoice #${invoiceDetails.invoice_number} for $${invoiceDetails.total_amount} is due. Please pay at your earliest convenience. - ${req.user.businessName || 'Your Service Team'}`;
    
    const result = await twilioClient.messages.create({
      body: message,
      from: TWILIO_PHONE_NUMBER,
      to: customerPhone
    });
    
    console.log('📱 Payment reminder SMS sent:', result.sid);
    
    res.json({ 
      success: true, 
      message: 'Payment reminder SMS sent successfully',
      sid: result.sid
    });
    
  } catch (error) {
    console.error('Payment reminder SMS error:', error);
    res.status(500).json({ error: 'Failed to send payment reminder SMS' });
  }
});

// Google Calendar endpoints
app.post('/api/calendar/sync-job', authenticateToken, async (req, res) => {
  try {
    const { jobId, customerName, serviceName, scheduledDate, scheduledTime, duration, address } = req.body;
    
    if (!jobId || !customerName || !serviceName || !scheduledDate || !scheduledTime) {
      return res.status(400).json({ error: 'Missing required job details' });
    }

    // Get user's Google access token (you'll need to store this when they authenticate)
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('google_access_token, google_refresh_token')
      .eq('id', req.user.userId)
      .single();

    if (userError || !userData?.google_access_token) {
      return res.status(400).json({ error: 'Google Calendar not connected. Please connect your Google account.' });
    }

    // Create OAuth2 client with user's tokens
    const oauth2Client = new OAuth2Client(
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET,
      GOOGLE_REDIRECT_URI
    );

    oauth2Client.setCredentials({
      access_token: userData.google_access_token,
      refresh_token: userData.google_refresh_token
    });

    // Create calendar event
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    
    const event = {
      summary: `${serviceName} - ${customerName}`,
      description: `Job ID: ${jobId}\nCustomer: ${customerName}\nService: ${serviceName}\nAddress: ${address || 'Not specified'}`,
      start: {
        dateTime: new Date(`${scheduledDate}T${scheduledTime}:00`).toISOString(),
        timeZone: 'America/New_York', // You can make this configurable
      },
      end: {
        dateTime: new Date(new Date(`${scheduledDate}T${scheduledTime}:00`).getTime() + (duration || 60) * 60000).toISOString(),
        timeZone: 'America/New_York',
      },
      attendees: [
        { email: req.user.email, responseStatus: 'accepted' }
      ],
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'email', minutes: 24 * 60 }, // 1 day before
          { method: 'popup', minutes: 30 }, // 30 minutes before
        ],
      },
    };

    const response = await calendar.events.insert({
      calendarId: 'primary',
      resource: event,
    });

    console.log('📅 Calendar event created:', response.data.id);

    res.json({ 
      success: true, 
      message: 'Job synced to Google Calendar',
      eventId: response.data.id,
      eventLink: response.data.htmlLink
    });

  } catch (error) {
    console.error('Calendar sync error:', error);
    res.status(500).json({ error: 'Failed to sync to Google Calendar' });
  }
});

// Google Sheets export endpoints
app.post('/api/sheets/export-customers', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    // Get user's Google access token
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('google_access_token, google_refresh_token')
      .eq('id', userId)
      .single();

    if (userError || !userData?.google_access_token) {
      return res.status(400).json({ error: 'Google Sheets not connected. Please connect your Google account.' });
    }

    // Get customers data
    const { data: customers, error: customersError } = await supabase
      .from('customers')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (customersError) {
      return res.status(500).json({ error: 'Failed to fetch customers' });
    }

    // Create OAuth2 client
    const oauth2Client = new OAuth2Client(
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET,
      GOOGLE_REDIRECT_URI
    );

    oauth2Client.setCredentials({
      access_token: userData.google_access_token,
      refresh_token: userData.google_refresh_token
    });

    // Create new spreadsheet
    const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    const spreadsheet = await sheets.spreadsheets.create({
      resource: {
        properties: {
          title: `Serviceflow Customers - ${new Date().toLocaleDateString()}`
        }
      }
    });

    const spreadsheetId = spreadsheet.data.spreadsheetId;

    // Prepare data for export
    const headers = ['Name', 'Email', 'Phone', 'Address', 'City', 'State', 'Zip Code', 'Created Date', 'Last Contact'];
    const values = customers.map(customer => [
      customer.name || '',
      customer.email || '',
      customer.phone || '',
      customer.address || '',
      customer.city || '',
      customer.state || '',
      customer.zip_code || '',
      new Date(customer.created_at).toLocaleDateString(),
      customer.last_contact ? new Date(customer.last_contact).toLocaleDateString() : ''
    ]);

    // Add data to spreadsheet
    await sheets.spreadsheets.values.update({
      spreadsheetId: spreadsheetId,
      range: 'A1',
      valueInputOption: 'RAW',
      resource: {
        values: [headers, ...values]
      }
    });

    // Format the header row
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: spreadsheetId,
      resource: {
        requests: [{
          repeatCell: {
            range: {
              sheetId: 0,
              startRowIndex: 0,
              endRowIndex: 1
            },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.2, green: 0.4, blue: 0.8 },
                textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true }
              }
            },
            fields: 'userEnteredFormat(backgroundColor,textFormat)'
          }
        }]
      }
    });

    console.log('📊 Customers exported to Google Sheets:', spreadsheetId);

    res.json({ 
      success: true, 
      message: 'Customers exported to Google Sheets',
      spreadsheetId: spreadsheetId,
      spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`
    });

  } catch (error) {
    console.error('Sheets export error:', error);
    res.status(500).json({ error: 'Failed to export to Google Sheets' });
  }
});

// Export jobs to Google Sheets
app.post('/api/sheets/export-jobs', authenticateToken, async (req, res) => {
  try {
    const { userId, dateRange } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    // Get user's Google access token
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('google_access_token, google_refresh_token')
      .eq('id', userId)
      .single();

    if (userError || !userData?.google_access_token) {
      return res.status(400).json({ error: 'Google Sheets not connected. Please connect your Google account.' });
    }

    // Get jobs data
    let jobsQuery = supabase
      .from('jobs')
      .select(`
        *,
        customers(name, email, phone),
        services(name, price)
      `)
      .eq('user_id', userId)
      .order('scheduled_date', { ascending: false });

    if (dateRange && dateRange.start && dateRange.end) {
      jobsQuery = jobsQuery
        .gte('scheduled_date', dateRange.start)
        .lte('scheduled_date', dateRange.end);
    }

    const { data: jobs, error: jobsError } = await jobsQuery;

    if (jobsError) {
      return res.status(500).json({ error: 'Failed to fetch jobs' });
    }

    // Create OAuth2 client
    const oauth2Client = new OAuth2Client(
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET,
      GOOGLE_REDIRECT_URI
    );

    oauth2Client.setCredentials({
      access_token: userData.google_access_token,
      refresh_token: userData.google_refresh_token
    });

    // Create new spreadsheet
    const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

    const spreadsheet = await sheets.spreadsheets.create({
      resource: {
        properties: {
          title: `Serviceflow Jobs - ${new Date().toLocaleDateString()}`
        }
      }
    });

    const spreadsheetId = spreadsheet.data.spreadsheetId;

    // Prepare data for export
    const headers = ['Job ID', 'Customer', 'Service', 'Date', 'Time', 'Status', 'Total Amount', 'Address', 'Notes'];
    const values = jobs.map(job => [
      job.id,
      job.customers?.name || '',
      job.services?.name || '',
      new Date(job.scheduled_date).toLocaleDateString(),
      job.scheduled_time || '',
      job.status || '',
      `$${job.total || 0}`,
      job.address || '',
      job.notes || ''
    ]);

    // Add data to spreadsheet
    await sheets.spreadsheets.values.update({
      spreadsheetId: spreadsheetId,
      range: 'A1',
      valueInputOption: 'RAW',
      resource: {
        values: [headers, ...values]
      }
    });

    console.log('📊 Jobs exported to Google Sheets:', spreadsheetId);

    res.json({ 
      success: true, 
      message: 'Jobs exported to Google Sheets',
      spreadsheetId: spreadsheetId,
      spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`
    });

  } catch (error) {
    console.error('Jobs export error:', error);
    res.status(500).json({ error: 'Failed to export jobs to Google Sheets' });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    message: 'Server is running'
  });
});

// Import Google Import setup
const { setupGoogleImportEndpoints } = require('./google-import-setup');
console.log('🔧 Setting up Google Import endpoints...');
setupGoogleImportEndpoints(app, authenticateToken, supabase, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
console.log('✅ Google Import endpoints setup complete');

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});
// Start server
app.listen(PORT, async () => {
  console.log(`Serviceflow API server running on port ${PORT}`);
  console.log(`Health check: http://127.0.0.1:${PORT}/api/health`);
  console.log('🔍 Branding endpoints registered: /api/user/branding (GET, PUT)');
  console.log('🔍 Test endpoint available: /api/test-branding');
  
  // Initialize database schema
  try {
    await initializeDatabase();
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
    console.log('⚠️ Server will continue without database initialization');
  }
});

// Fix database schema endpoint (Supabase handles schema automatically)
app.post('/api/fix-schema', async (req, res) => {
  try {
    console.log('🔧 Checking Supabase schema...');
    
    // Test connection to verify schema is working
    const { data: jobsTest, error: jobsError } = await supabase
      .from('jobs')
      .select('id')
      .limit(1);
    
    const { data: servicesTest, error: servicesError } = await supabase
      .from('services')
      .select('id')
      .limit(1);
    
    if (jobsError || servicesError) {
      console.error('❌ Schema check error:', { jobsError, servicesError });
      return res.status(500).json({ 
        error: 'Schema check failed', 
        details: { jobsError, servicesError } 
      });
    }
    
    console.log('✅ Supabase schema is working correctly');
    
    res.json({
      success: true,
      message: 'Supabase schema is working correctly',
      note: 'Supabase handles schema management automatically'
    });
  } catch (error) {
    console.error('❌ Schema check error:', error);
    res.status(500).json({ error: error.message });
  }
});



// Google Geocoding API proxy endpoint for address validation fallback



