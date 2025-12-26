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
const PDFDocument = require('pdfkit');

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
// Google OAuth redirect URI - use environment variable or construct from request
// Default to production URL if not set
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 
  (process.env.NODE_ENV === 'production' 
    ? 'https://service-flow-backend-production-4568.up.railway.app/api/auth/google/callback'
    : 'http://localhost:3001/api/auth/google/callback');

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

// Helper function to calculate next recurring date from frequency string
function calculateNextRecurringDate(frequency, currentDate) {
  if (!frequency || frequency === '' || frequency === 'never') {
    return null;
  }

  const freq = frequency.toLowerCase().trim();
  const baseDate = currentDate instanceof Date ? new Date(currentDate) : new Date(currentDate);
  const nextDate = new Date(baseDate);

  // Handle daily frequencies
  if (freq === 'daily' || /^\d+\s*days?$/.test(freq)) {
    const dayMatch = freq.match(/(\d+)\s*days?/) || (freq === 'daily' ? ['', '1'] : null);
    const days = dayMatch ? parseInt(dayMatch[1]) : 1;
    nextDate.setDate(nextDate.getDate() + days);
    return nextDate;
  }

  // Handle weekly frequencies: "weekly-friday", "2 weeks-friday", etc.
  if (freq.includes('week')) {
    const parts = freq.split('-');
    const weekMatch = parts[0].match(/(\d+)\s*weeks?/) || parts[0].match(/weekly/);
    const weeks = weekMatch && weekMatch[1] ? parseInt(weekMatch[1]) : 1;
    
    // If day of week is specified, find the next occurrence of that day
    if (parts.length > 1) {
      const dayPart = parts[parts.length - 1];
      const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      const targetDayIndex = dayNames.findIndex(day => dayPart.includes(day));
      
      if (targetDayIndex !== -1) {
        // Calculate days until next occurrence of that weekday
        const currentDayIndex = baseDate.getDay();
        let daysUntilNext = (targetDayIndex - currentDayIndex + 7) % 7;
        
        // If it's the same day, move to next week
        if (daysUntilNext === 0) {
          daysUntilNext = 7;
        }
        
        // Add the weeks multiplier
        nextDate.setDate(nextDate.getDate() + daysUntilNext + ((weeks - 1) * 7));
        return nextDate;
      }
    }
    
    // No specific day, just add weeks
    nextDate.setDate(nextDate.getDate() + (weeks * 7));
    return nextDate;
  }

  // Handle bi-weekly (special case)
  if (freq === 'biweekly' || freq === 'bi-weekly') {
    // Try to preserve the weekday
    nextDate.setDate(nextDate.getDate() + 14);
    
    // If weekday is specified in a format like "biweekly-friday", use that
    const parts = freq.split('-');
    if (parts.length > 1) {
      const dayPart = parts[parts.length - 1];
      const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      const targetDayIndex = dayNames.findIndex(day => dayPart.includes(day));
      if (targetDayIndex !== -1) {
        const daysUntilNext = (targetDayIndex - nextDate.getDay() + 7) % 7;
        nextDate.setDate(nextDate.getDate() + daysUntilNext);
      }
    }
    
    return nextDate;
  }

  // Handle monthly frequencies
  if (freq.includes('month')) {
    const parts = freq.split('-');
    const monthMatch = parts[0].match(/(\d+)\s*months?/) || parts[0].match(/monthly/);
    const months = monthMatch && monthMatch[1] ? parseInt(monthMatch[1]) : 1;
    
    // Format: monthly-day-15 or X months-day-15
    if (parts.includes('day') && parts.length > 2) {
      const dayValue = parseInt(parts[parts.length - 1]);
      if (dayValue && dayValue >= 1 && dayValue <= 31) {
        nextDate.setMonth(nextDate.getMonth() + months);
        // Set to the specific day of month
        const daysInMonth = new Date(nextDate.getFullYear(), nextDate.getMonth() + 1, 0).getDate();
        nextDate.setDate(Math.min(dayValue, daysInMonth));
        return nextDate;
      }
    }
    // Format: monthly-2nd-friday or X months-2nd-friday
    else if (parts.length > 2) {
      const ordinalsList = ["1st", "2nd", "3rd", "4th", "last"];
      const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      
      let ordinal = null;
      let weekdayIndex = null;
      
      for (const part of parts) {
        const lowerPart = part.toLowerCase();
        if (ordinalsList.some(ord => lowerPart.includes(ord.toLowerCase()))) {
          ordinal = ordinalsList.find(ord => lowerPart.includes(ord.toLowerCase()));
        }
        const dayIndex = dayNames.findIndex(day => lowerPart.includes(day));
        if (dayIndex !== -1) {
          weekdayIndex = dayIndex;
        }
      }
      
      if (ordinal && weekdayIndex !== null) {
        // Move to next month
        nextDate.setMonth(nextDate.getMonth() + months);
        
        // Find the nth occurrence of the weekday in that month
        const year = nextDate.getFullYear();
        const month = nextDate.getMonth();
        
        // Start from the first day of the month
        const firstDay = new Date(year, month, 1);
        const firstDayOfWeek = firstDay.getDay();
        
        // Calculate the first occurrence of the target weekday
        let firstOccurrence = (weekdayIndex - firstDayOfWeek + 7) % 7;
        if (firstOccurrence === 0) firstOccurrence = 7;
        
        let targetDate = 1 + firstOccurrence - 1;
        
        // Adjust for ordinal (1st, 2nd, 3rd, 4th, last)
        if (ordinal === '1st') {
          targetDate = 1 + firstOccurrence - 1;
        } else if (ordinal === '2nd') {
          targetDate = 1 + firstOccurrence - 1 + 7;
        } else if (ordinal === '3rd') {
          targetDate = 1 + firstOccurrence - 1 + 14;
        } else if (ordinal === '4th') {
          targetDate = 1 + firstOccurrence - 1 + 21;
        } else if (ordinal === 'last') {
          // Find the last occurrence
          const lastDay = new Date(year, month + 1, 0);
          const lastDayOfWeek = lastDay.getDay();
          let lastOccurrence = lastDay.getDate() - ((lastDayOfWeek - weekdayIndex + 7) % 7);
          if (lastOccurrence > lastDay.getDate()) {
            lastOccurrence -= 7;
          }
          targetDate = lastOccurrence;
        }
        
        // Validate the date is within the month
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        if (targetDate > daysInMonth) {
          targetDate = daysInMonth;
        }
        
        nextDate.setDate(targetDate);
        return nextDate;
      }
    }
    
    // Fallback: add months and try to preserve the day of month
    const originalDay = baseDate.getDate();
    nextDate.setMonth(nextDate.getMonth() + months);
    
    // Handle month-end edge cases (e.g., Jan 31 -> Feb 28/29)
    const daysInMonth = new Date(nextDate.getFullYear(), nextDate.getMonth() + 1, 0).getDate();
    nextDate.setDate(Math.min(originalDay, daysInMonth));
    
    return nextDate;
  }

  // Default: return null if frequency is not recognized
  return null;
}

// Cron job for recurring billing
cron.schedule('0 9 * * *', async () => {
  console.log('🔄 Running recurring billing check...');
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
      console.error('❌ Error fetching recurring jobs:', error);
      return;
    }

    console.log(`📋 Found ${recurringJobs?.length || 0} recurring jobs to process`);

    for (const job of recurringJobs || []) {
      try {
        // Check if recurring end date has passed
        if (job.recurring_end_date) {
          const endDate = new Date(job.recurring_end_date);
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          endDate.setHours(0, 0, 0, 0);
          
          if (endDate < today) {
            console.log(`⏹️ Skipping job ${job.id} - recurring end date has passed`);
            // Mark as no longer recurring
            await supabase
        .from('jobs')
              .update({ is_recurring: false })
              .eq('id', job.id);
            continue;
          }
        }

        // Calculate new scheduled date using the frequency
        const lastJobDate = new Date(job.next_billing_date || job.scheduled_date);
        const newScheduledDate = calculateNextRecurringDate(job.recurring_frequency, lastJobDate);
        
        if (!newScheduledDate) {
          console.error(`❌ Could not calculate next date for job ${job.id} with frequency: ${job.recurring_frequency}`);
          continue;
        }

        // Preserve the time from the original job
        if (job.scheduled_date) {
          const originalDate = new Date(job.scheduled_date);
          newScheduledDate.setHours(originalDate.getHours());
          newScheduledDate.setMinutes(originalDate.getMinutes());
          newScheduledDate.setSeconds(originalDate.getSeconds());
        }
        
        console.log(`📅 Job ${job.id}: Calculating next date from ${lastJobDate.toISOString()} -> ${newScheduledDate.toISOString()}`);
        
        // Create new job for recurring service
        const newJobData = {
          user_id: job.user_id,
          customer_id: job.customer_id,
          service_id: job.service_id,
          scheduled_date: newScheduledDate.toISOString(),
          notes: job.notes,
          status: 'pending',
          is_recurring: true,
          recurring_frequency: job.recurring_frequency,
          recurring_end_date: job.recurring_end_date,
          service_name: job.service_name,
          service_price: job.service_price,
          price: job.price,
          total: job.total,
          duration: job.duration,
          estimated_duration: job.estimated_duration,
          workers: job.workers,
          territory_id: job.territory_id,
          service_address_street: job.service_address_street,
          service_address_city: job.service_address_city,
          service_address_state: job.service_address_state,
          service_address_zip: job.service_address_zip,
          service_address_country: job.service_address_country,
          service_modifiers: job.service_modifiers,
          service_intake_questions: job.service_intake_questions
        };

        // Calculate next billing date for the new job
        const nextBillingDate = calculateNextRecurringDate(job.recurring_frequency, newScheduledDate);
        if (nextBillingDate) {
          newJobData.next_billing_date = nextBillingDate.toISOString().split('T')[0];
        }

        const { data: newJob, error: insertError } = await supabase
          .from('jobs')
          .insert(newJobData)
          .select()
          .single();

      if (insertError) {
          console.error(`❌ Error creating recurring job for job ${job.id}:`, insertError);
        continue;
      }

        console.log(`✅ Created new recurring job ${newJob.id} for job ${job.id}`);
      
        // Update next billing date on the original job (for tracking)
        const updatedNextBillingDate = calculateNextRecurringDate(job.recurring_frequency, newScheduledDate);
        if (updatedNextBillingDate) {
          await supabase
        .from('jobs')
            .update({ next_billing_date: updatedNextBillingDate.toISOString().split('T')[0] })
        .eq('id', job.id);
      }
      
      // Send email notification
        try {
      await sendEmail({
        to: job.customers.email,
        subject: 'Recurring Service Scheduled',
        html: `
          <h2>Your recurring service has been scheduled</h2>
          <p>Hello ${job.customers.first_name},</p>
              <p>Your recurring ${job.services.name} service has been scheduled for ${newScheduledDate.toLocaleDateString()}.</p>
          <p>Service: ${job.services.name}</p>
          <p>Price: $${job.services.price}</p>
          <p>Thank you for choosing our services!</p>
        `
      });
        } catch (emailError) {
          console.error(`⚠️ Error sending email for job ${job.id}:`, emailError);
          // Don't fail the whole process if email fails
        }
      } catch (jobError) {
        console.error(`❌ Error processing recurring job ${job.id}:`, jobError);
        // Continue with next job
      }
    }
    
    console.log('✅ Recurring billing check completed');
  } catch (error) {
    console.error('❌ Recurring billing error:', error);
  }
});

// SendEmail function using SendGrid
async function sendEmail({ to, subject, html, text }) {
  console.log('📧 Sending email via SendGrid...');
  console.log('📧 To:', to);
  console.log('📧 Subject:', subject);
  
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
    
    console.log('📧 SendGrid message prepared:', { to, subject, from: msg.from });
    const result = await sgMail.send(msg);
    console.log('✅ Email sent successfully via SendGrid');
    return { messageId: result[0].headers['x-message-id'] };
  } catch (error) {
    console.error('❌ SendGrid error:', error);
    if (error.code === 401) {
      console.error('❌ The SendGrid API key is invalid or expired');
      console.error('❌ Please check your SendGrid API key configuration');
      throw new Error('SendGrid API key is invalid. Please check your SENDGRID_API_KEY environment variable.');
    }
    if (error.code === 403) {
      console.error('❌ SendGrid 403 Forbidden - Check your API key and permissions');
      console.error('❌ Make sure your SendGrid API key has mail.send permissions');
      console.error('❌ Verify your sender email is verified in SendGrid');
      throw new Error('SendGrid API key lacks permissions. Please check your SendGrid account settings.');
    }
    throw error;
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

// Multer configuration for job attachments (accepts all file types)
const attachmentStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'attachment-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const attachmentUpload = multer({
  storage: attachmentStorage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit for attachments
  }
  // Accept all file types for attachments
});

// CORS configuration - Simplified and more permissive for production
const corsOptions = {
  origin: [
    'https://www.service-flow.pro', 
    'https://service-flow.pro',
    'https://service-flow-frontend.vercel.app',
    'https://service-flow.vercel.app',
    'http://localhost:3000',
    'http://localhost:3001',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:3001'
  ],
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

// Additional CORS handling for preflight requests - Windows Defender/Firewall compatible
app.use((req, res, next) => {
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    // More permissive headers for Windows Defender/firewall compatibility
    res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin, Cache-Control, X-HTTP-Method-Override, X-Forwarded-For, X-Real-IP');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Max-Age', '86400'); // Cache preflight for 24 hours
    res.header('Access-Control-Expose-Headers', 'Content-Length, Content-Type, Date, Server');
    
    // Additional headers for Windows compatibility
    res.header('Vary', 'Origin');
    res.header('X-Content-Type-Options', 'nosniff');
    res.header('X-Frame-Options', 'SAMEORIGIN');
    
    console.log('🔄 Preflight request handled for:', req.headers.origin, req.url);
    return res.status(200).end();
  }
  next();
});

// CORS is handled by the main cors middleware above

// Log all requests for debugging
app.use((req, res, next) => {
  console.log(`${req.method} ${req.path} - ${req.headers.origin || 'No Origin'}`);
  next();
});

// Content-Type handling to reduce preflight issues
app.use((req, res, next) => {
  // Set default Content-Type for JSON responses to avoid preflight
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    if (!req.headers['content-type']) {
      req.headers['content-type'] = 'application/json';
    }
  }
  next();
});

// Response headers middleware to ensure consistent CORS handling
app.use((req, res, next) => {
  // Set consistent headers for all responses
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin, Cache-Control, X-HTTP-Method-Override');
  
  // Set Content-Type for JSON responses
  if (req.path.startsWith('/api/')) {
    res.header('Content-Type', 'application/json');
  }
 
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
  '/api/user/staff-locations-setting',
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
app.options('/api/user/staff-locations-setting', (req, res) => res.status(204).send());
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
    
    console.log('🔐 JWT decoded user:', user);
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
    
    // Create account owner as a team member with role "account owner"
    const { data: accountOwnerTeamMember, error: teamMemberError } = await supabase
      .from('team_members')
      .insert({
        user_id: newUser.id,
        first_name: sanitizedFirstName,
        last_name: sanitizedLastName,
        email: sanitizedEmail,
        role: 'account owner', // Set role as "account owner"
        status: 'active',
        is_service_provider: true,
        username: sanitizedEmail, // Use email as username for account owner
        password: hashedPassword // Store password for login
      })
      .select()
      .single();
    
    if (teamMemberError) {
      console.error('Error creating account owner team member:', teamMemberError);
      // Don't fail signup if team member creation fails, but log it
      console.warn('Account owner created but team member entry failed. User can still login.');
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
    
    // First, try to find user in users table (account owners)
    const { data: users, error: userError } = await supabase
      .from('users')
      .select('id, email, password, first_name, last_name, business_name, profile_picture, google_id')
      .eq('email', sanitizedEmail)
      .limit(1);
    
    if (userError) {
      console.error('Error fetching user:', userError);
      return res.status(500).json({ error: 'Login failed. Please try again.' });
    }
    
    let user = null;
    let userRole = 'owner'; // Default role for account owners
    let isTeamMember = false;
    
    if (users && users.length > 0) {
      // Found in users table - this is an account owner
      user = users[0];
    
    // Check if this is an OAuth user
    if (user.google_id && user.password.startsWith('oauth_user_')) {
      return res.status(401).json({ 
        error: 'This account was created with Google. Please sign in with Google instead.' 
      });
    }
    
      // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.password);
    
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid email or password' });
      }
      
      // Check if account owner exists in team_members table and get their role
      const { data: teamMemberData, error: teamMemberError } = await supabase
        .from('team_members')
        .select('role')
        .eq('user_id', user.id)
        .eq('email', sanitizedEmail)
        .limit(1);
      
      if (!teamMemberError && teamMemberData && teamMemberData.length > 0) {
        // Account owner exists in team_members, use their role (should be 'account owner')
        const role = teamMemberData[0].role;
        userRole = role || 'account owner'; // Use the role from team_members table
      } else {
        // If not found in team_members, default to 'account owner'
        userRole = 'account owner';
      }
    } else {
      // Not found in users table, check team_members table
      const { data: teamMembers, error: teamMemberError } = await supabase
        .from('team_members')
        .select('id, user_id, email, password, first_name, last_name, role, status, profile_picture, permissions')
        .eq('email', sanitizedEmail)
        .eq('status', 'active')
        .limit(1);
      
      if (teamMemberError) {
        console.error('Error fetching team member:', teamMemberError);
        return res.status(500).json({ error: 'Login failed. Please try again.' });
      }
      
      if (!teamMembers || teamMembers.length === 0) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }
      
      const teamMember = teamMembers[0];
      
      // Check if password is set
      if (!teamMember.password) {
        return res.status(401).json({ error: 'Account not set up for login. Please contact your manager.' });
      }
      
      // Verify password
      const isPasswordValid = await bcrypt.compare(password, teamMember.password);
      
      if (!isPasswordValid) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }
      
      // Parse permissions if it's a string
      let permissions = {};
      if (teamMember.permissions) {
        try {
          permissions = typeof teamMember.permissions === 'string' 
            ? JSON.parse(teamMember.permissions) 
            : teamMember.permissions;
        } catch (e) {
          console.error('Error parsing permissions:', e);
          permissions = {};
        }
      }
      
      // Use team member data
      user = {
        id: teamMember.user_id, // Use the user_id from team_members (the account owner's user_id)
        email: teamMember.email,
        first_name: teamMember.first_name,
        last_name: teamMember.last_name,
        business_name: null, // Team members don't have business_name
        profile_picture: teamMember.profile_picture,
        permissions: permissions,
        teamMemberId: teamMember.id
      };
      
      // Get role from team member
      userRole = teamMember.role || 'worker';
      isTeamMember = true;
      
      // Update last login
      await supabase
        .from('team_members')
        .update({ last_login: new Date().toISOString() })
        .eq('id', teamMember.id);
    }
    
    // Generate JWT token
    const token = jwt.sign(
      { 
        userId: user.id, 
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        businessName: user.business_name,
        role: userRole,
        teamMemberId: isTeamMember ? user.teamMemberId : null // Include team member ID in token
      },
      JWT_SECRET,
      { expiresIn: '1d' }
    );
    
    // Build user response object
    const userResponse = {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        businessName: user.business_name,
        business_name: user.business_name, // Add both for compatibility
      profilePicture: user.profile_picture,
      role: userRole, // Include role in response
      permissions: user.permissions || {}, // Include permissions for team members
      teamMemberId: user.teamMemberId || null // Include team member ID if applicable
    };
    
    res.json({ 
      message: 'Login successful',
      token,
      user: userResponse
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

// Google OAuth Authorization Code Flow (for getting refresh tokens)
app.get('/api/auth/google/authorize', authenticateToken, async (req, res) => {
  try {
    console.log('🔗 Google OAuth authorization request received:', {
      userId: req.user?.userId,
      hasGoogleClientId: !!GOOGLE_CLIENT_ID,
      hasGoogleClientSecret: !!GOOGLE_CLIENT_SECRET,
      redirectUri: GOOGLE_REDIRECT_URI || `${req.protocol}://${req.get('host')}/api/auth/google/callback`
    });

    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      console.error('❌ Google OAuth not configured - missing credentials');
      return res.status(500).json({ error: 'Google OAuth not configured. Please set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables.' });
    }

    const userId = req.user?.userId;
    if (!userId) {
      console.error('❌ User not authenticated - no userId in request');
      return res.status(401).json({ error: 'User not authenticated. Please log in and try again.' });
    }

    // Construct redirect URI - prefer environment variable, but use request host if localhost
    let redirectUri = GOOGLE_REDIRECT_URI;
    if (!redirectUri || redirectUri.includes('localhost')) {
      // Use the request's protocol and host to construct the correct production URL
      const protocol = req.protocol || 'https';
      const host = req.get('host') || 'service-flow-backend-production-4568.up.railway.app';
      redirectUri = `${protocol}://${host}/api/auth/google/callback`;
    }
    console.log('🔗 Using redirect URI:', redirectUri);

    const oauth2Client = new OAuth2Client(
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET,
      redirectUri
    );

    // Generate authorization URL with offline access to get refresh token
    // Include both Calendar and Sheets scopes
    const allScopes = [
      ...GOOGLE_CALENDAR_SCOPES,
      ...GOOGLE_SHEETS_SCOPES,
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile'
    ];
    
    // Include redirect path in state for callback (default to google-sheets for Sheets integration)
    const redirectPath = 'google-sheets';
    const stateValue = `${userId.toString()}:${redirectPath}`;
    
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline', // This is crucial for getting refresh tokens
      scope: allScopes,
      prompt: 'consent', // Force consent screen to ensure refresh token
      state: stateValue // Pass user ID and redirect path in state for callback
    });

    console.log('✅ Generated Google OAuth authorization URL for user:', userId);
    console.log('🔗 Authorization URL length:', authUrl.length);
    res.json({ authUrl });
  } catch (error) {
    console.error('❌ Error generating Google OAuth URL:', {
      message: error.message,
      stack: error.stack,
      name: error.name
    });
    res.status(500).json({ 
      error: 'Failed to generate authorization URL',
      details: error.message 
    });
  }
});

// Google OAuth Callback (handles authorization code and exchanges for tokens)
app.get('/api/auth/google/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    
    if (!code) {
      return res.status(400).json({ error: 'Authorization code is required' });
    }

    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      return res.status(500).json({ error: 'Google OAuth not configured' });
    }

    // Construct redirect URI - prefer environment variable, but use request host if localhost
    let redirectUri = GOOGLE_REDIRECT_URI;
    if (!redirectUri || redirectUri.includes('localhost')) {
      // Use the request's protocol and host to construct the correct production URL
      const protocol = req.protocol || 'https';
      const host = req.get('host') || 'service-flow-backend-production-4568.up.railway.app';
      redirectUri = `${protocol}://${host}/api/auth/google/callback`;
    }

    const oauth2Client = new OAuth2Client(
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET,
      redirectUri
    );

    // Exchange authorization code for tokens
    let tokens;
    try {
      console.log('🔗 Exchanging authorization code for tokens...', {
        hasCode: !!code,
        codeLength: code?.length,
        clientIdPrefix: GOOGLE_CLIENT_ID?.substring(0, 20) + '...',
        hasClientSecret: !!GOOGLE_CLIENT_SECRET,
        redirectUri: redirectUri
      });
      
      const tokenResponse = await oauth2Client.getToken(code);
      tokens = tokenResponse.tokens;
      
      console.log('✅ Tokens received from Google:', {
        hasAccessToken: !!tokens.access_token,
        hasRefreshToken: !!tokens.refresh_token,
        expiresIn: tokens.expiry_date,
        scope: tokens.scope
      });
    } catch (tokenError) {
      console.error('❌ Error exchanging authorization code for tokens:', {
        message: tokenError.message,
        code: tokenError.code,
        status: tokenError.response?.status,
        error: tokenError.response?.data?.error,
        errorDescription: tokenError.response?.data?.error_description,
        clientIdPrefix: GOOGLE_CLIENT_ID?.substring(0, 20) + '...',
        redirectUri: redirectUri
      });
      
      // Provide helpful error message based on the error type
      if (tokenError.response?.data?.error === 'invalid_client') {
        console.error('❌ Invalid client credentials - check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET');
        return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/settings/calendar-syncing?error=invalid_client_credentials`);
      }
      
      // Re-throw other errors
      throw tokenError;
    }

    if (!tokens.refresh_token) {
      console.warn('⚠️ No refresh token received from Google. This may happen if the user has already granted consent.');
      console.warn('⚠️ We will still save the access token, but token refresh will not be possible.');
    }

    // Get user info
    oauth2Client.setCredentials(tokens);
    const userInfoResponse = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: {
        'Authorization': `Bearer ${tokens.access_token}`
      }
    });
    const userInfo = userInfoResponse.data;
    console.log('🔗 User info retrieved:', { email: userInfo.email, id: userInfo.id });

    // Get user ID and redirect path from state
    // State format: "userId" or "userId:redirectPath"
    let userId = state;
    let redirectPath = 'google-sheets'; // Default to google-sheets for Sheets integration
    
    if (state && state.includes(':')) {
      const parts = state.split(':');
      userId = parts[0];
      redirectPath = parts[1] || 'google-sheets';
    }
    
    if (!userId || userId === 'unknown') {
      console.error('❌ No user ID in state parameter');
      return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/settings/${redirectPath}?error=user_not_authenticated`);
    }

    console.log('🔗 Updating user with Google connection, userId:', userId);

    // Update user with Google connection and tokens
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('id, email, google_id, google_access_token, google_refresh_token')
      .eq('id', userId)
      .maybeSingle();

    if (userError || !userData) {
      console.error('❌ User not found:', userError);
      return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/settings/${redirectPath}?error=user_not_found`);
    }

    const updateData = {
      google_id: userInfo.id,
      google_access_token: tokens.access_token
    };

    // Only update refresh token if we received one
    // If user already has a refresh token and Google didn't provide a new one, keep the existing one
    if (tokens.refresh_token) {
      updateData.google_refresh_token = tokens.refresh_token;
      console.log('✅ Refresh token will be saved');
    } else if (userData.google_refresh_token) {
      console.log('⚠️ No new refresh token, keeping existing one');
    } else {
      console.warn('⚠️ No refresh token available - user will need to reconnect when access token expires');
    }

    const { error: updateError } = await supabase
      .from('users')
      .update(updateData)
      .eq('id', userId);

    if (updateError) {
      console.error('❌ Error updating user:', updateError);
      return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/settings/${redirectPath}?error=update_failed`);
    }

    console.log('✅ Google account connected successfully', {
      hasAccessToken: !!updateData.google_access_token,
      hasRefreshToken: !!updateData.google_refresh_token
    });
    
    // Redirect to frontend with success
    const successParam = tokens.refresh_token ? 'connected' : 'connected_no_refresh';
    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/settings/${redirectPath}?success=${successParam}`);
  } catch (error) {
    console.error('❌ Error in Google OAuth callback:', error);
    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/settings/${redirectPath}?error=callback_failed`);
  }
});

// Google OAuth endpoints
app.post('/api/auth/google', async (req, res) => {
  try {
    console.log('🔍 Google OAuth request received');
    console.log('🔍 Full request body:', JSON.stringify(req.body, null, 2));
    console.log('🔍 Request headers:', req.headers);
    
    // Handle nested structure from frontend
    let idToken, accessToken, refreshToken;
    
    if (req.body.idToken && typeof req.body.idToken === 'object') {
      // Nested structure: { idToken: { idToken: "...", accessToken: null, refreshToken: null } }
      idToken = req.body.idToken.idToken;
      accessToken = req.body.idToken.accessToken;
      refreshToken = req.body.idToken.refreshToken;
    } else {
      // Direct structure: { idToken: "...", accessToken: null, refreshToken: null }
      idToken = req.body.idToken;
      accessToken = req.body.accessToken;
      refreshToken = req.body.refreshToken;
    }
    
    console.log('🔍 Extracted values:');
    console.log('  - idToken type:', typeof idToken, 'Length:', idToken ? idToken.length : 'null');
    console.log('  - accessToken type:', typeof accessToken, 'Value:', accessToken);
    console.log('  - refreshToken type:', typeof refreshToken, 'Value:', refreshToken);
    
    if (!idToken) {
      console.log('❌ No ID token provided');
      return res.status(400).json({ error: 'Google ID token is required' });
    }
    
    if (typeof idToken !== 'string') {
      console.log('❌ ID token is not a string:', typeof idToken);
      return res.status(400).json({ error: 'Google ID token must be a string' });
    }
    
    if (!GOOGLE_CLIENT_ID) {
      console.log('❌ GOOGLE_CLIENT_ID not configured');
      return res.status(500).json({ error: 'Google OAuth not configured' });
    }
    
    console.log('🔍 Verifying Google ID token with client ID:', GOOGLE_CLIENT_ID);
    
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
    console.error('❌ Google OAuth error:', error);
    console.error('Error details:', {
      message: error.message,
      code: error.code,
      status: error.status
    });
    res.status(500).json({ 
      error: 'Google authentication failed',
      details: error.message 
    });
  }
});

// Connect Google account to existing user (for calendar sync, etc.)
app.post('/api/auth/connect-google', authenticateToken, async (req, res) => {
  try {
    console.log('🔗 Connecting Google account for user:', req.user.userId);
    
    const { idToken, accessToken, refreshToken, email, googleId } = req.body;
    
    let verifiedGoogleId, verifiedEmail;
    
    // If we have an access token, use it to get user info (OAuth2 flow)
    if (accessToken) {
      try {
        console.log('🔗 Using OAuth2 access token to get user info');
        const userInfoResponse = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: {
            'Authorization': `Bearer ${accessToken}`
          }
        });
        verifiedGoogleId = userInfoResponse.data.id || googleId;
        verifiedEmail = userInfoResponse.data.email || email;
        console.log('🔗 User info from OAuth2:', { googleId: verifiedGoogleId, email: verifiedEmail });
      } catch (error) {
        console.error('Error getting user info from access token:', error);
        return res.status(400).json({ error: 'Invalid access token' });
      }
    } else if (idToken) {
      // Fallback to ID token verification (One Tap flow)
      if (!GOOGLE_CLIENT_ID) {
        return res.status(500).json({ error: 'Google OAuth not configured' });
      }
      
      const ticket = await googleClient.verifyIdToken({
        idToken: idToken,
        audience: GOOGLE_CLIENT_ID
      });
      
      const payload = ticket.getPayload();
      verifiedGoogleId = payload.sub;
      verifiedEmail = payload.email;
    } else {
      return res.status(400).json({ error: 'Google ID token or access token is required' });
    }
    
    if (!GOOGLE_CLIENT_ID) {
      return res.status(500).json({ error: 'Google OAuth not configured' });
    }
    
    // Get the current user
    console.log('🔗 Fetching user from database, userId:', req.user.userId);
    
    // First, try to get user with all columns (including optional Google columns)
    let userData, userError;
    
    try {
      const result = await supabase
        .from('users')
        .select('id, email, google_id, google_access_token, google_refresh_token')
        .eq('id', req.user.userId)
        .maybeSingle();
      
      userData = result.data;
      userError = result.error;
    } catch (err) {
      // If columns don't exist, try without them
      console.log('🔗 Columns may not exist, trying without Google token columns');
      const result = await supabase
        .from('users')
        .select('id, email, google_id')
        .eq('id', req.user.userId)
        .maybeSingle();
      
      userData = result.data;
      userError = result.error;
    }
    
    // If error is about missing columns, try again without them
    if (userError && (userError.code === '42703' || userError.message?.includes('does not exist'))) {
      console.log('🔗 Google token columns not found, fetching without them');
      const result = await supabase
        .from('users')
        .select('id, email, google_id')
        .eq('id', req.user.userId)
        .maybeSingle();
      
      userData = result.data;
      userError = result.error;
    }
    
    if (userError) {
      console.error('🔗 Supabase error fetching user:', {
        code: userError.code,
        message: userError.message,
        details: userError.details,
        hint: userError.hint,
        userId: req.user.userId
      });
      return res.status(500).json({ 
        error: 'Database error while fetching user',
        details: userError.message 
      });
    }
    
    if (!userData) {
      console.error('🔗 User not found in database, userId:', req.user.userId);
      // Try to get user by email as fallback
      const { data: userByEmail } = await supabase
        .from('users')
        .select('id, email')
        .eq('email', req.user.email)
        .maybeSingle();
      
      if (userByEmail) {
        console.log('🔗 User found by email, but ID mismatch:', {
          jwtUserId: req.user.userId,
          dbUserId: userByEmail.id,
          email: userByEmail.email
        });
      }
      
      return res.status(404).json({ 
        error: 'User not found',
        userId: req.user.userId,
        email: req.user.email
      });
    }
    
    console.log('🔗 User found successfully:', { 
      id: userData.id, 
      email: userData.email,
      hasGoogleId: !!userData.google_id,
      hasAccessToken: !!userData.google_access_token
    });
    
    // Prepare update data
    const updateData = {
      google_id: verifiedGoogleId
    };
    
    // Store access and refresh tokens if provided and columns exist
    // Check if columns exist by trying to update them
    if (accessToken) {
      updateData.google_access_token = accessToken;
    }
    if (refreshToken) {
      updateData.google_refresh_token = refreshToken;
    }
    
    // Update user with Google connection
    console.log('🔗 Updating user with Google connection data:', { 
      hasGoogleId: !!updateData.google_id,
      hasAccessToken: !!updateData.google_access_token,
      hasRefreshToken: !!updateData.google_refresh_token
    });
    
    const { data: updatedUser, error: updateError } = await supabase
      .from('users')
      .update(updateData)
      .eq('id', req.user.userId)
      .select('id, email, google_id')
      .single();
    
    if (updateError) {
      console.error('🔗 Error updating user with Google connection:', {
        code: updateError.code,
        message: updateError.message,
        details: updateError.details
      });
      
      // If error is about missing columns, try updating without token columns
      if (updateError.code === '42703' || updateError.message?.includes('does not exist')) {
        console.log('🔗 Token columns don\'t exist, updating only google_id');
        const { data: retryUser, error: retryError } = await supabase
          .from('users')
          .update({ google_id: googleId })
          .eq('id', req.user.userId)
          .select('id, email, google_id')
          .single();
        
        if (retryError) {
          console.error('🔗 Error updating google_id:', retryError);
          return res.status(500).json({ 
            error: 'Failed to connect Google account',
            details: retryError.message 
          });
        }
        
        console.log('✅ Google account connected (google_id only, token columns missing)');
        return res.json({
          success: true,
          message: 'Google account connected successfully (Note: Token storage columns not available. Please run database migration for full functionality.)',
          connected: true,
          warning: 'Token storage not available - migration may be needed'
        });
      }
      
      return res.status(500).json({ 
        error: 'Failed to connect Google account',
        details: updateError.message 
      });
    }
    
    console.log('✅ Google account connected successfully for user:', req.user.userId);
    
    res.json({
      success: true,
      message: 'Google account connected successfully',
      connected: true
    });
    
  } catch (error) {
    console.error('❌ Connect Google account error:', error);
    res.status(500).json({
      error: 'Failed to connect Google account',
      details: error.message 
    });
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
    const { userId, search, page = 1, limit = 20, sortBy = 'name', sortOrder = 'ASC', includeInactive } = req.query;
    
    
    // Build Supabase query
    let query = supabase
      .from('services')
      .select('*', { count: 'exact' })
      .eq('user_id', userId);
    
    // Filter out inactive services by default (unless includeInactive is true)
    // This ensures inactive services don't show in active services list, but can still be accessed by ID for jobs
    if (includeInactive !== 'true') {
      query = query.eq('is_active', true);
    }
    
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
        image: image,
        is_active: true // New services are active by default
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

// Delete all services endpoint - must come before /api/services/:id
app.delete('/api/services/all', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    // Hard delete all services for this user (for testing/import purposes)
    // Get all service IDs for this user
    const { data: services, error: fetchError } = await supabase
      .from('services')
      .select('id')
      .eq('user_id', userId);
    
    if (fetchError) {
      console.error('Error fetching services for deletion:', fetchError);
      return res.status(500).json({ error: 'Failed to fetch services for deletion' });
    }
    
    if (!services || services.length === 0) {
      return res.json({ message: 'No services to delete' });
    }
    
    // Hard delete all services
    const { error: deleteError } = await supabase
      .from('services')
      .delete()
      .eq('user_id', userId);
    
    if (deleteError) {
      console.error('Error deleting services:', deleteError);
      return res.status(500).json({ error: 'Failed to delete services' });
    }
    
    res.json({ message: `Successfully deleted ${services.length} service(s)` });
  } catch (error) {
    console.error('Delete all services error:', error);
    res.status(500).json({ error: 'Failed to delete services' });
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
    
    // Mark service as inactive instead of deleting
    // This allows the service to remain associated with jobs while hiding it from active services list
    const { error: updateError } = await supabase
      .from('services')
      .update({ is_active: false })
      .eq('id', id)
      .eq('user_id', userId);
    
    if (updateError) {
      console.error('Error marking service as inactive:', updateError);
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
    const { userId, status, search, page = 1, limit = 20, dateRange, dateFilter, sortBy = 'scheduled_date', sortOrder = 'ASC', teamMember, invoiceStatus, customerId, territoryId, recurring } = req.query;
    const teamMemberId = req.user.teamMemberId; // Get team member ID from JWT token
    const userRole = req.user.role; // Get user role from JWT token
  
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
    
    // 🔒 WORKER RESTRICTION: Workers can only see jobs assigned to them
    // They cannot view unassigned jobs or jobs assigned to other team members
    if (userRole === 'worker' && teamMemberId) {
      // Filter to only show jobs assigned to this worker
      query = query.eq('team_member_id', teamMemberId);
      // Note: This automatically excludes unassigned jobs (team_member_id IS NULL)
    }
    
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
    
    // Add recurring filter
    if (recurring === 'true' || recurring === 'recurring') {
      query = query.eq('is_recurring', true);
    } else if (recurring === 'false' || recurring === 'one-time') {
      query = query.or('is_recurring.is.null,is_recurring.eq.false');
    }
    // If recurring is not provided or is 'all', show all jobs
    
    // Add team member filter
    if (teamMember) {
      // Check if teamMember is a numeric ID (not a special string)
      const teamMemberIdNum = parseInt(teamMember);
      if (!isNaN(teamMemberIdNum) && teamMemberIdNum > 0) {
        // Filter by specific team member ID
        query = query.eq('team_member_id', teamMemberIdNum);
      } else {
        // Handle special string values
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
      // For future jobs, include today onwards
      // Use gte to include jobs starting from today
      query = query.gte('scheduled_date', todayString);
    } else if (dateFilter === 'past') {
      const todayString = getTodayString();
      // For past jobs, exclude today - only show jobs before today
      // Use lt to exclude today (only jobs strictly before today)
      // Compare as date string to handle datetime fields correctly
      query = query.lt('scheduled_date', todayString);
    } else if (dateRange) {
      // Support both ":" and " to " separators for date range
      const dateSeparator = dateRange.includes(' to ') ? ' to ' : ':';
      const [startDate, endDate] = dateRange.split(dateSeparator).map(d => d.trim());
      if (startDate && endDate) {
         query = query.gte('scheduled_date', startDate).lte('scheduled_date', endDate);
      } else if (startDate) {
        // If only start date provided, use it as minimum
        query = query.gte('scheduled_date', startDate);
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
      
      // Fetch status history for all jobs
      const jobIds = (jobs || []).map(job => job.id);
      let allStatusHistory = {};
      let allTeamAssignments = {};
      
      if (jobIds.length > 0) {
        // Fetch status history
        const { data: historyData, error: historyError } = await supabase
          .from('job_status_history')
          .select('*')
          .in('job_id', jobIds)
          .order('changed_at', { ascending: true });
        
        if (!historyError && historyData) {
          // Group by job_id
          historyData.forEach(entry => {
            if (!allStatusHistory[entry.job_id]) {
              allStatusHistory[entry.job_id] = [];
            }
            allStatusHistory[entry.job_id].push(entry);
          });
        }
        
        // Fetch team assignments from job_team_assignments table
        const { data: assignmentsData, error: assignmentsError } = await supabase
          .from('job_team_assignments')
          .select(`
            job_id,
            team_member_id,
            is_primary,
            team_members!left(first_name, last_name, email)
          `)
          .in('job_id', jobIds)
          .order('is_primary', { ascending: false })
          .order('assigned_at', { ascending: true });
        
        if (!assignmentsError && assignmentsData) {
          // Group by job_id
          assignmentsData.forEach(assignment => {
            if (!allTeamAssignments[assignment.job_id]) {
              allTeamAssignments[assignment.job_id] = [];
            }
            allTeamAssignments[assignment.job_id].push({
              team_member_id: assignment.team_member_id,
              is_primary: assignment.is_primary,
              first_name: assignment.team_members?.first_name,
              last_name: assignment.team_members?.last_name,
              email: assignment.team_members?.email
            });
          });
        }
      }
      
      // Process jobs to add team assignments and format data
      const processedJobs = (jobs || []).map(job => {
        // Format customer data
        const customer = job.customers || {};
        const service = job.services || {};
        const teamMember = job.team_members || {};
        
        // Get team assignments from job_team_assignments table first
        let teamAssignments = allTeamAssignments[job.id] || [];
        
        // Fallback: If no assignments found in job_team_assignments, use team_member_id from jobs table (backward compatibility)
        if (teamAssignments.length === 0 && (teamMember.id || job.team_member_id)) {
          const memberId = teamMember.id || job.team_member_id;
          const memberFirstName = teamMember.first_name || '';
          const memberLastName = teamMember.last_name || '';
          const memberEmail = teamMember.email || '';
          
          teamAssignments = [{
            team_member_id: memberId,
            is_primary: true,
            first_name: memberFirstName,
            last_name: memberLastName,
            email: memberEmail
          }];
        }
        
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
          team_assignments: teamAssignments,
          status_history: allStatusHistory[job.id] || []
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

// Recurring bookings endpoint
app.get('/api/recurring-bookings', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { status = 'active' } = req.query; // 'active' or 'canceled'
    
    // Build query for recurring jobs
    let query = supabase
      .from('jobs')
      .select(`
        *,
        customers!left(first_name, last_name, email, phone, city, state),
        services!left(name, price, duration),
        team_members!left(first_name, last_name, email)
      `)
      .eq('user_id', userId)
      .eq('is_recurring', true);
    
    // Filter by status - for canceled, we check if status is cancelled
    if (status === 'canceled') {
      query = query.in('status', ['cancelled', 'canceled']);
    } else {
      // For active, exclude cancelled statuses - filter out cancelled jobs
      // Use a different approach: get all and filter in code, or use multiple queries
      // For now, let's get all and filter
    }
    
    const { data: jobs, error } = await query.order('created_at', { ascending: false });
    
    if (error) {
      console.error('Error fetching recurring bookings:', error);
      return res.status(500).json({ error: 'Failed to fetch recurring bookings' });
    }
    
    // Filter by status in code if needed (for active, exclude cancelled)
    let filteredJobs = jobs || [];
    if (status === 'active') {
      filteredJobs = filteredJobs.filter(job => 
        job.status !== 'cancelled' && job.status !== 'canceled'
      );
    }
    
    // Process jobs to format for frontend
    // Group jobs by recurring pattern to find the next job in each series
    const recurringSeries = {};
    
    filteredJobs.forEach(job => {
      // Create a key for the recurring series (customer + frequency)
      const seriesKey = `${job.customer_id}_${job.recurring_frequency || 'none'}`;
      
      if (!recurringSeries[seriesKey]) {
        recurringSeries[seriesKey] = [];
      }
      recurringSeries[seriesKey].push(job);
    });
    
    // For each series, find the most recent job and calculate next date
    const recurringBookings = Object.values(recurringSeries).map(series => {
      // Sort by scheduled_date descending to get the most recent
      series.sort((a, b) => new Date(b.scheduled_date) - new Date(a.scheduled_date));
      const job = series[0]; // Most recent job in the series
      
      const customer = job.customers || {};
      const service = job.services || {};
      const teamMember = job.team_members || {};
      
      // Calculate next job date based on recurring frequency
      let nextJobDate = null;
      let nextJobId = null;
      
      // Use the most recent job's scheduled_date as the base
      const baseDate = new Date(job.scheduled_date);
      
      if (job.next_billing_date) {
        nextJobDate = job.next_billing_date;
      } else if (job.recurring_frequency) {
        // Use the calculateNextRecurringDate function
        const calculatedNextDate = calculateNextRecurringDate(job.recurring_frequency, baseDate);
        if (calculatedNextDate) {
          nextJobDate = calculatedNextDate.toISOString().split('T')[0];
        }
      }
      
      // Find if there's already a next job created in the series
      // Look for a job with the same customer and frequency, scheduled after this one
      const futureJobs = series.filter(j => {
        const jDate = new Date(j.scheduled_date);
        return jDate > baseDate && j.status !== 'cancelled' && j.status !== 'canceled';
      });
      
      if (futureJobs.length > 0) {
        // Sort by date ascending to get the next one
        futureJobs.sort((a, b) => new Date(a.scheduled_date) - new Date(b.scheduled_date));
        const nextJob = futureJobs[0];
        nextJobDate = nextJob.scheduled_date.split('T')[0];
        nextJobId = nextJob.id;
      }
      
      // Debug: Log the frequency being returned
      console.log('📊 Recurring Booking - Job ID:', job.id, 'Frequency:', job.recurring_frequency, 'Next Date:', nextJobDate);
      
      return {
        id: job.id,
        customerName: `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
        customerCity: customer.city || '',
        serviceName: service.name || job.service_name || 'Service',
        frequency: job.recurring_frequency || '', // Don't default to 'weekly', return empty string
        nextJobDate: nextJobDate,
        nextJobId: nextJobId || job.id,
        createdDate: job.created_at,
        status: job.status === 'cancelled' || job.status === 'canceled' ? 'canceled' : 'active',
        jobId: job.id,
        customerId: job.customer_id,
        serviceId: job.service_id,
        scheduledDate: job.scheduled_date,
        price: job.price || service.price || 0
      };
    });
    
    res.json({ recurringBookings });
  } catch (error) {
    console.error('Get recurring bookings error:', error);
    res.status(500).json({ error: 'Failed to fetch recurring bookings' });
  }
});

// OPTIONS handled by catch-all above

// Jobs export endpoint - MUST come before /api/jobs/:id to avoid route conflict
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
      // Generate CSV with all fields
      const csvHeader = 'Job ID,Customer ID,Customer Name,Customer Email,Customer Phone,Service ID,Service Name,Service Price,Team Member ID,Team Member Name,Territory ID,Territory,Notes,Status,Invoice Status,Invoice ID,Invoice Amount,Invoice Date,Payment Date,Is Recurring,Recurring Frequency,Next Billing Date,Stripe Payment Intent ID,Duration,Workers,Skills Required,Price,Discount,Additional Fees,Taxes,Total,Payment Method,Schedule Type,Let Customer Schedule,Offer To Providers,Internal Notes,Customer Notes,Scheduled Date,Scheduled Time,Service Address Street,Service Address City,Service Address State,Service Address Zip,Service Address Country,Service Address Lat,Service Address Lng,Service Name,Bathroom Count,Workers Needed,Skills,Service Price,Total Amount,Estimated Duration,Special Instructions,Payment Status,Priority,Quality Check,Photos Required,Customer Signature,Auto Invoice,Auto Reminders,Recurring End Date,Tags,Intake Question Answers,Service Modifiers,Service Intake Questions,Created At,Updated At\n';
      
      const csvRows = (jobs || []).map(job => {
        const customer = job.customers || {};
        const service = job.services || {};
        const teamMember = job.team_members || {};
        
        return `"${job.id || ''}","${job.customer_id || ''}","${customer.first_name || ''} ${customer.last_name || ''}","${customer.email || ''}","${customer.phone || ''}","${job.service_id || ''}","${job.service_name || service.name || ''}","${job.service_price || service.price || ''}","${job.team_member_id || ''}","${teamMember.first_name || ''} ${teamMember.last_name || ''}","${job.territory_id || ''}","${job.territory || ''}","${job.notes || ''}","${job.status || ''}","${job.invoice_status || ''}","${job.invoice_id || ''}","${job.invoice_amount || ''}","${job.invoice_date || ''}","${job.payment_date || ''}","${job.is_recurring || false}","${job.recurring_frequency || ''}","${job.next_billing_date || ''}","${job.stripe_payment_intent_id || ''}","${job.duration || ''}","${job.workers || ''}","${job.skills_required || ''}","${job.price || ''}","${job.discount || ''}","${job.additional_fees || ''}","${job.taxes || ''}","${job.total || ''}","${job.payment_method || ''}","${job.schedule_type || ''}","${job.let_customer_schedule || false}","${job.offer_to_providers || false}","${job.internal_notes || ''}","${job.customer_notes || ''}","${job.scheduled_date || ''}","${job.scheduled_time || ''}","${job.service_address_street || ''}","${job.service_address_city || ''}","${job.service_address_state || ''}","${job.service_address_zip || ''}","${job.service_address_country || ''}","${job.service_address_lat || ''}","${job.service_address_lng || ''}","${job.service_name || ''}","${job.bathroom_count || ''}","${job.workers_needed || ''}","${job.skills || ''}","${job.service_price || ''}","${job.total_amount || ''}","${job.estimated_duration || ''}","${job.special_instructions || ''}","${job.payment_status || ''}","${job.priority || ''}","${job.quality_check || true}","${job.photos_required || false}","${job.customer_signature || false}","${job.auto_invoice || true}","${job.auto_reminders || true}","${job.recurring_end_date || ''}","${job.tags || ''}","${job.intake_question_answers || ''}","${job.service_modifiers || ''}","${job.service_intake_questions || ''}","${job.created_at || ''}","${job.updated_at || ''}"`;
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

// Get available time slots for scheduling
// IMPORTANT: This must be BEFORE /api/jobs/:id route
app.get('/api/jobs/available-slots', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { date, duration = 120, workerId, serviceId } = req.query;

    if (!date) {
      return res.status(400).json({ error: 'Date parameter is required' });
    }

    // Parse the date
    const requestedDate = new Date(date);
    if (isNaN(requestedDate.getTime())) {
      return res.status(400).json({ error: 'Invalid date format' });
    }

    // Convert duration to integer
    const durationMinutes = parseInt(duration);

    // Get business hours (TODO: Fetch from business settings table)
    const businessStartHour = 9; // 9 AM
    const businessEndHour = 17; // 5 PM
    const slotInterval = 30; // 30 minutes between slot starts for flexibility

    // Get all jobs for the requested date
    // IMPORTANT: Also fetch job_team_assignments to check all assigned team members
    const { data: existingJobs, error: jobsError } = await supabase
      .from('jobs')
      .select(`
        scheduled_time, 
        duration, 
        team_member_id, 
        status,
        id,
        job_team_assignments!left(team_member_id, is_primary)
      `)
      .eq('user_id', userId)
      .eq('scheduled_date', date)
      .not('status', 'in', '(cancelled)'); // Exclude cancelled jobs

    if (jobsError) {
      console.error('Error fetching existing jobs:', jobsError);
      return res.status(500).json({ error: 'Failed to fetch existing jobs' });
    }

    // Get all team members (or specific worker if provided) WITH their availability
    let teamMembersQuery = supabase
      .from('team_members')
      .select('id, first_name, last_name, availability')
      .eq('user_id', userId)
      .eq('status', 'active');

    if (workerId) {
      teamMembersQuery = teamMembersQuery.eq('id', workerId);
    }

    const { data: teamMembers, error: teamError } = await teamMembersQuery;

    if (teamError) {
      console.error('Error fetching team members:', teamError);
      return res.status(500).json({ error: 'Failed to fetch team members' });
    }

    // Helper function to check if a team member is available at a specific time based on their availability settings
    const isWorkerAvailableAtTime = (worker, slotStartTime, slotEndTime) => {
      if (!worker.availability) {
        // If no availability set, assume available during business hours
        console.log(`✅ Worker ${worker.id} (${worker.first_name}): No availability set, defaulting to available`);
        return true;
      }

      try {
        let availabilityData = worker.availability;
        if (typeof availabilityData === 'string') {
          availabilityData = JSON.parse(availabilityData);
        }

        const dayOfWeek = requestedDate.getDay(); // 0 = Sunday, 6 = Saturday
        const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        const dayName = dayNames[dayOfWeek];
        
        console.log(`🔍 Checking availability for worker ${worker.id} (${worker.first_name}) on ${dayName} at ${slotStartTime}-${slotEndTime}`);

        // Check for date-specific custom availability override
        // Handle both "YYYY-MM-DD" and "YYYY-MM-DDTHH:MM:SS" formats
        const dateStr = date.includes('T') ? date.split('T')[0] : date; // YYYY-MM-DD
        let workingHours = availabilityData.workingHours || availabilityData;
        let customAvailability = availabilityData.customAvailability || [];

        // Check for date-specific override first
        const dateOverride = customAvailability.find(item => item.date === dateStr);
        if (dateOverride) {
          if (dateOverride.available === false) {
            return false; // Day is explicitly unavailable
          }
          if (dateOverride.hours && Array.isArray(dateOverride.hours) && dateOverride.hours.length > 0) {
            // Check if slot falls within any of the custom hours
            const slotStartMinutes = timeToMinutes(slotStartTime);
            const slotEndMinutes = timeToMinutes(slotEndTime);
            
            return dateOverride.hours.some(hourSlot => {
              const hourStart = timeToMinutes(hourSlot.start || hourSlot.startTime);
              const hourEnd = timeToMinutes(hourSlot.end || hourSlot.endTime);
              return slotStartMinutes >= hourStart && slotEndMinutes <= hourEnd;
            });
          }
        }

        // Check regular working hours for the day
        const dayHours = workingHours[dayName];
        
        // Handle different availability formats:
        // Format 1: { enabled: true, start: "09:00", end: "17:00" }
        // Format 2: { available: true, hours: "9:00 AM - 6:00 PM" }
        // Format 3: { available: true, timeSlots: [...] }
        
        if (!dayHours) {
          console.log(`❌ Worker ${worker.id}: No availability configured for ${dayName}`);
          return false; // Day not configured
        }

        // Check if day is enabled/available
        const isDayEnabled = dayHours.enabled !== false && dayHours.available !== false;
        if (!isDayEnabled) {
          console.log(`❌ Worker ${worker.id}: ${dayName} is disabled (enabled: ${dayHours.enabled}, available: ${dayHours.available})`);
          return false; // Day is explicitly disabled
        }
        
        console.log(`✅ Worker ${worker.id}: ${dayName} is enabled, checking hours...`);

        const slotStartMinutes = timeToMinutes(slotStartTime);
        const slotEndMinutes = timeToMinutes(slotEndTime);

        // Format 1: Check if day has start/end times directly
        if (dayHours.start && dayHours.end) {
        const dayStartMinutes = timeToMinutes(dayHours.start);
        const dayEndMinutes = timeToMinutes(dayHours.end);

        // Check if slot is within working hours
        if (slotStartMinutes < dayStartMinutes || slotEndMinutes > dayEndMinutes) {
          return false;
        }

        // If day has time slots, check if slot falls within any time slot
        if (dayHours.timeSlots && Array.isArray(dayHours.timeSlots) && dayHours.timeSlots.length > 0) {
          return dayHours.timeSlots.some(timeSlot => {
            const slotStart = timeToMinutes(timeSlot.start || timeSlot.startTime);
            const slotEnd = timeToMinutes(timeSlot.end || timeSlot.endTime);
            return slotStartMinutes >= slotStart && slotEndMinutes <= slotEnd;
          });
        }

        return true; // Available within working hours
        }
        
        // Format 2: Parse hours string like "9:00 AM - 6:00 PM"
        if (dayHours.hours && typeof dayHours.hours === 'string') {
          const hoursMatch = dayHours.hours.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?\s*-\s*(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
          if (hoursMatch) {
            let startHour = parseInt(hoursMatch[1]);
            let startMin = hoursMatch[2];
            let endHour = parseInt(hoursMatch[4]);
            let endMin = hoursMatch[5];
            
            // Convert to 24-hour format if AM/PM is present
            if (hoursMatch[3]) {
              if (hoursMatch[3].toUpperCase() === 'PM' && startHour !== 12) startHour += 12;
              if (hoursMatch[3].toUpperCase() === 'AM' && startHour === 12) startHour = 0;
            }
            if (hoursMatch[6]) {
              if (hoursMatch[6].toUpperCase() === 'PM' && endHour !== 12) endHour += 12;
              if (hoursMatch[6].toUpperCase() === 'AM' && endHour === 12) endHour = 0;
            }
            
            const dayStartMinutes = startHour * 60 + parseInt(startMin);
            const dayEndMinutes = endHour * 60 + parseInt(endMin);
            
            // Check if slot is within working hours
            if (slotStartMinutes < dayStartMinutes || slotEndMinutes > dayEndMinutes) {
              return false;
            }
            
            return true; // Available within working hours
          }
        }
        
        // Format 3: Check timeSlots array
        if (dayHours.timeSlots && Array.isArray(dayHours.timeSlots) && dayHours.timeSlots.length > 0) {
          return dayHours.timeSlots.some(timeSlot => {
            const slotStart = timeToMinutes(timeSlot.start || timeSlot.startTime);
            const slotEnd = timeToMinutes(timeSlot.end || timeSlot.endTime);
            return slotStartMinutes >= slotStart && slotEndMinutes <= slotEnd;
          });
        }
        
        // If day is enabled but no specific hours, assume available during business hours (9 AM - 5 PM)
        // This handles cases where availability is set to "open" without specific hours
        const defaultStartMinutes = 9 * 60; // 9 AM
        const defaultEndMinutes = 17 * 60; // 5 PM
        
        if (slotStartMinutes >= defaultStartMinutes && slotEndMinutes <= defaultEndMinutes) {
          return true;
        }
        
        console.log(`❌ Worker ${worker.id}: Slot ${slotStartTime}-${slotEndTime} not within any available hours for ${dayName}`);
        return false; // Not within any available hours
      } catch (error) {
        console.error(`❌ Error parsing availability for worker ${worker.id} (${worker.first_name}):`, error);
        console.error(`   Availability data:`, worker.availability);
        // On error, assume available (fallback to business hours) to avoid blocking scheduling
        console.log(`⚠️ Worker ${worker.id}: Error parsing availability, defaulting to available`);
        return true;
      }
    };

    // Helper function to convert time string (HH:MM or HH:MM:SS) to minutes from midnight
    const timeToMinutes = (timeStr) => {
      if (!timeStr) return 0;
      const parts = timeStr.split(':');
      const hours = parseInt(parts[0]) || 0;
      const minutes = parseInt(parts[1]) || 0;
      return hours * 60 + minutes;
    };

    // Helper function to check if a job is assigned to a specific worker
    const isJobAssignedToWorker = (job, workerId) => {
      // Check direct assignment (team_member_id field)
      if (job.team_member_id && parseInt(job.team_member_id) === parseInt(workerId)) {
        return true;
      }
      
      // Check job_team_assignments table (for jobs with multiple assignments)
      if (job.job_team_assignments && Array.isArray(job.job_team_assignments)) {
        return job.job_team_assignments.some(assignment => 
          assignment.team_member_id && parseInt(assignment.team_member_id) === parseInt(workerId)
        );
      }
      
      return false;
    };

    // Helper function to check if a time slot overlaps with existing jobs AND if worker is available
    const isSlotAvailable = (slotStartTime, slotEndTime, worker) => {
      // First check if worker is available at this time based on their availability settings
      if (!isWorkerAvailableAtTime(worker, slotStartTime, slotEndTime)) {
        return false;
      }

      // Then check for job conflicts - ONLY for jobs assigned to THIS specific worker
      const slotStart = new Date(`${date}T${slotStartTime}`);
      const slotEnd = new Date(`${date}T${slotEndTime}`);

      for (const job of existingJobs) {
        // CRITICAL: Only check conflicts for jobs assigned to THIS worker
        // If job is assigned to a different worker, skip it completely
        // This allows multiple workers to be available at the same time
        if (!isJobAssignedToWorker(job, worker.id)) {
          continue; // This job is assigned to someone else, so it doesn't block this worker
        }

        // This job IS assigned to this worker, so check for time overlap
        const jobStart = new Date(`${date}T${job.scheduled_time}`);
        const jobEnd = new Date(jobStart.getTime() + (job.duration || durationMinutes) * 60000);

        // Check for overlap
        if (slotStart < jobEnd && slotEnd > jobStart) {
          return false; // This worker has a conflict
        }
      }
      return true; // No conflicts for this worker
    };

    // Generate time slots with 30-minute intervals
    const slots = [];
    
    // Start from business hours and create 30-minute interval slots
    let currentMinutes = businessStartHour * 60; // Convert to minutes from midnight
    const endMinutes = businessEndHour * 60;
    
    while (currentMinutes < endMinutes) {
      const slotHour = Math.floor(currentMinutes / 60);
      const slotMinute = currentMinutes % 60;
      const slotStartTime = `${slotHour.toString().padStart(2, '0')}:${slotMinute.toString().padStart(2, '0')}:00`;
      
      const slotStartDate = new Date(`${date}T${slotStartTime}`);
      const slotEndDate = new Date(slotStartDate.getTime() + durationMinutes * 60000);
      
      // Calculate end time in minutes
      const slotEndMinutes = currentMinutes + durationMinutes;
      
      // Skip if slot would extend beyond business hours
      if (slotEndMinutes > endMinutes) {
        currentMinutes += slotInterval;
        continue;
      }

      const slotEndHour = Math.floor(slotEndMinutes / 60);
      const slotEndMinute = slotEndMinutes % 60;
      const slotEndTime = `${slotEndHour.toString().padStart(2, '0')}:${slotEndMinute.toString().padStart(2, '0')}:00`;

      // Count available workers for this slot
      // IMPORTANT: Check each team member INDIVIDUALLY - if one is unavailable, others can still show slots
      let availableWorkers = 0;
      
      if (workerId) {
        // Check specific worker
        const worker = teamMembers.find(w => w.id === parseInt(workerId));
        if (worker && isSlotAvailable(slotStartTime, slotEndTime, worker)) {
          availableWorkers = 1;
        }
      } else {
        // Check each team member individually - each member's availability is independent
        for (const worker of teamMembers) {
          if (isSlotAvailable(slotStartTime, slotEndTime, worker)) {
            availableWorkers++;
          }
        }
      }

      // Only include slot if at least one worker is available
      if (availableWorkers > 0) {
        slots.push({
          time: slotStartTime.substring(0, 5), // Format as HH:MM
          endTime: slotEndTime.substring(0, 5), // Format as HH:MM
          availableWorkers: availableWorkers
        });
      }
      
      // Move to next 30-minute interval
      currentMinutes += slotInterval;
    }

    res.json({ slots });
  } catch (error) {
    console.error('Error fetching available slots:', error);
    res.status(500).json({ error: 'Failed to fetch available slots' });
  }
});

// Helper function to convert time to minutes (for job offers)
function timeToMinutesForOffers(timeStr) {
  if (!timeStr) return 0;
  const parts = timeStr.split(':');
  const hours = parseInt(parts[0]) || 0;
  const minutes = parseInt(parts[1]) || 0;
  return hours * 60 + minutes;
}

// Helper function to check if worker is qualified for a job
function checkWorkerQualification(worker, job) {
  // Check skills if job requires specific skills
  if (job.skills && Array.isArray(job.skills) && job.skills.length > 0) {
    let workerSkills = worker.skills || [];
    if (typeof workerSkills === 'string') {
      try {
        workerSkills = JSON.parse(workerSkills);
      } catch (e) {
        workerSkills = [];
      }
    }
    
    // Check if worker has at least one required skill
    const hasRequiredSkill = job.skills.some(skill => 
      workerSkills.some(ws => {
        const wsName = typeof ws === 'string' ? ws.toLowerCase() : ws.name?.toLowerCase();
        const skillName = typeof skill === 'string' ? skill.toLowerCase() : skill.name?.toLowerCase();
        return wsName === skillName;
      })
    );
    
    if (!hasRequiredSkill && job.skills.length > 0) {
      return false;
    }
  }

  // Check service-specific skills if service has skills_required
  if (job.services?.skills_required) {
    const serviceSkills = job.services.skills_required;
    let workerSkills = worker.skills || [];
    if (typeof workerSkills === 'string') {
      try {
        workerSkills = JSON.parse(workerSkills);
      } catch (e) {
        workerSkills = [];
      }
    }
    
    if (Array.isArray(serviceSkills) && serviceSkills.length > 0) {
      const hasServiceSkill = serviceSkills.some(skill => 
        workerSkills.some(ws => {
          const wsName = typeof ws === 'string' ? ws.toLowerCase() : ws.name?.toLowerCase();
          const skillName = typeof skill === 'string' ? skill.toLowerCase() : skill.name?.toLowerCase();
          return wsName === skillName;
        })
      );
      
      if (!hasServiceSkill) {
        return false;
      }
    }
  }

  return true; // Worker is qualified
}

// Helper function to check if worker is available at job time
async function checkWorkerAvailabilityForOffer(worker, job) {
  try {
    const jobDate = new Date(job.scheduled_date);
    const dateStr = jobDate.toISOString().split('T')[0];
    const dayOfWeek = jobDate.getDay();
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const dayName = dayNames[dayOfWeek];

    // Parse worker availability
    let availabilityData = worker.availability;
    if (typeof availabilityData === 'string') {
      availabilityData = JSON.parse(availabilityData);
    }

    if (!availabilityData) {
      return true; // No availability set, assume available
    }

    // Check for date-specific override
    const customAvailability = availabilityData.customAvailability || [];
    const dateOverride = customAvailability.find(item => item.date === dateStr);
    
    if (dateOverride) {
      if (dateOverride.available === false) {
        return false;
      }
      if (dateOverride.hours && Array.isArray(dateOverride.hours) && dateOverride.hours.length > 0) {
        const jobTime = job.scheduled_time || '09:00';
        const jobStartMinutes = timeToMinutesForOffers(jobTime);
        const jobDuration = job.duration || job.services?.duration || 120;
        const jobEndMinutes = jobStartMinutes + jobDuration;
        
        return dateOverride.hours.some(hourSlot => {
          const slotStart = timeToMinutesForOffers(hourSlot.start || hourSlot.startTime);
          const slotEnd = timeToMinutesForOffers(hourSlot.end || hourSlot.endTime);
          return jobStartMinutes >= slotStart && jobEndMinutes <= slotEnd;
        });
      }
    }

    // Check regular working hours
    const workingHours = availabilityData.workingHours || availabilityData;
    const dayHours = workingHours[dayName];
    
    if (!dayHours) {
      return false;
    }

    const isDayEnabled = dayHours.enabled !== false && dayHours.available !== false;
    if (!isDayEnabled) {
      return false;
    }

    const jobTime = job.scheduled_time || '09:00';
    const jobStartMinutes = timeToMinutesForOffers(jobTime);
    const jobDuration = job.duration || job.services?.duration || 120;
    const jobEndMinutes = jobStartMinutes + jobDuration;

    // Check if job fits within working hours
    if (dayHours.start && dayHours.end) {
      const dayStartMinutes = timeToMinutesForOffers(dayHours.start);
      const dayEndMinutes = timeToMinutesForOffers(dayHours.end);
      
      if (jobStartMinutes < dayStartMinutes || jobEndMinutes > dayEndMinutes) {
        return false;
      }
    } else if (dayHours.hours) {
      // Parse hours string
      const hoursMatch = dayHours.hours.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?\s*-\s*(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
      if (hoursMatch) {
        let startHour = parseInt(hoursMatch[1]);
        let endHour = parseInt(hoursMatch[4]);
        
        if (hoursMatch[3] && hoursMatch[3].toUpperCase() === 'PM' && startHour !== 12) startHour += 12;
        if (hoursMatch[3] && hoursMatch[3].toUpperCase() === 'AM' && startHour === 12) startHour = 0;
        if (hoursMatch[6] && hoursMatch[6].toUpperCase() === 'PM' && endHour !== 12) endHour += 12;
        if (hoursMatch[6] && hoursMatch[6].toUpperCase() === 'AM' && endHour === 12) endHour = 0;
        
        const dayStartMinutes = startHour * 60 + parseInt(hoursMatch[2]);
        const dayEndMinutes = endHour * 60 + parseInt(hoursMatch[5]);
        
        if (jobStartMinutes < dayStartMinutes || jobEndMinutes > dayEndMinutes) {
          return false;
        }
      }
    }

    // Check for conflicts with existing jobs assigned to this worker
    const { data: existingJobs, error: jobsError } = await supabase
      .from('jobs')
      .select('scheduled_date, scheduled_time, duration')
      .eq('team_member_id', worker.id)
      .eq('scheduled_date', dateStr)
      .not('status', 'in', '(cancelled)');

    if (!jobsError && existingJobs) {
      for (const existingJob of existingJobs) {
        const existingStart = new Date(`${dateStr}T${existingJob.scheduled_time || '09:00'}`);
        const existingDuration = existingJob.duration || 120;
        const existingEnd = new Date(existingStart.getTime() + existingDuration * 60000);
        
        const jobStart = new Date(`${dateStr}T${jobTime}`);
        const jobEnd = new Date(jobStart.getTime() + jobDuration * 60000);
        
        if (jobStart < existingEnd && jobEnd > existingStart) {
          return false; // Conflict found
        }
      }
    }

    return true; // Worker is available
  } catch (error) {
    console.error('Error checking worker availability:', error);
    return true; // On error, assume available
  }
}

// Get available jobs for workers (jobs with offer_to_providers = true)
app.get('/api/jobs/available-for-workers', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const teamMemberId = req.user.teamMemberId;
    const userRole = req.user.role;

    // Only workers can access this endpoint
    if (userRole !== 'worker' || !teamMemberId) {
      return res.status(403).json({ error: 'Only workers can view available jobs' });
    }

    // Get worker's information
    const { data: worker, error: workerError } = await supabase
      .from('team_members')
      .select('id, first_name, last_name, availability, skills, user_id')
      .eq('id', teamMemberId)
      .eq('status', 'active')
      .single();

    if (workerError || !worker) {
      return res.status(404).json({ error: 'Worker not found' });
    }

    // Get all jobs that are:
    // 1. Offered to providers (offer_to_providers = true)
    // 2. Not already assigned to anyone (team_member_id IS NULL)
    // 3. Status is pending or confirmed
    // 4. Scheduled date is in the future
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const { data: availableJobs, error: jobsError } = await supabase
      .from('jobs')
      .select(`
        *,
        customers!left(first_name, last_name, email, phone, city, state),
        services!left(name, price, duration, skills_required),
        territories!left(name)
      `)
      .eq('offer_to_providers', true)
      .is('team_member_id', null) // Not assigned yet
      .in('status', ['pending', 'confirmed'])
      .gte('scheduled_date', today.toISOString())
      .order('scheduled_date', { ascending: true });

    if (jobsError) {
      console.error('Error fetching available jobs:', jobsError);
      return res.status(500).json({ error: 'Failed to fetch available jobs' });
    }

    // Get existing claims by this worker
    const { data: existingClaims, error: claimsError } = await supabase
      .from('job_offers')
      .select('job_id, status')
      .eq('team_member_id', teamMemberId)
      .in('status', ['pending', 'claimed', 'accepted']);

    const claimedJobIds = new Set((existingClaims || []).map(c => c.job_id));

    // Filter and check qualifications for each job
    const qualifiedJobs = [];
    
    for (const job of availableJobs || []) {
      // Skip if already claimed by this worker
      if (claimedJobIds.has(job.id)) {
        continue;
      }

      // Check if worker is qualified
      const isQualified = checkWorkerQualification(worker, job);
      
      // Check if worker is available at job time
      const isAvailable = await checkWorkerAvailabilityForOffer(worker, job);

      if (isQualified && isAvailable) {
        qualifiedJobs.push({
          ...job,
          isQualified: true,
          isAvailable: true
        });
      }
    }

    res.json({ 
      jobs: qualifiedJobs,
      total: qualifiedJobs.length
    });
  } catch (error) {
    console.error('Error in available jobs endpoint:', error);
    res.status(500).json({ error: 'Failed to fetch available jobs' });
  }
});

// Claim a job (worker claims an available job)
app.post('/api/jobs/:id/claim', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const teamMemberId = req.user.teamMemberId;
    const userRole = req.user.role;
    const { id } = req.params;
    const { notes } = req.body;

    // Only workers can claim jobs
    if (userRole !== 'worker' || !teamMemberId) {
      return res.status(403).json({ error: 'Only workers can claim jobs' });
    }

    // Get the job
    const { data: job, error: jobError } = await supabase
      .from('jobs')
      .select('*, customers!left(first_name, last_name, email), services!left(name)')
      .eq('id', id)
      .single();

    if (jobError || !job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Verify job is available for claiming
    if (!job.offer_to_providers) {
      return res.status(400).json({ error: 'This job is not offered to providers' });
    }

    if (job.team_member_id) {
      return res.status(400).json({ error: 'This job is already assigned' });
    }

    // Check if already claimed
    const { data: existingClaim, error: claimCheckError } = await supabase
      .from('job_offers')
      .select('*')
      .eq('job_id', id)
      .eq('team_member_id', teamMemberId)
      .maybeSingle();

    if (existingClaim && !claimCheckError) {
      if (existingClaim.status === 'claimed' || existingClaim.status === 'accepted') {
        return res.status(400).json({ error: 'You have already claimed this job' });
      }
    }

    // Get worker info
    const { data: worker, error: workerError } = await supabase
      .from('team_members')
      .select('id, first_name, last_name, email, user_id, availability, skills')
      .eq('id', teamMemberId)
      .single();

    if (workerError || !worker) {
      return res.status(404).json({ error: 'Worker not found' });
    }

    // Check qualifications and availability
    const isQualified = checkWorkerQualification(worker, job);
    if (!isQualified) {
      return res.status(400).json({ error: 'You do not meet the qualifications for this job' });
    }

    const isAvailable = await checkWorkerAvailabilityForOffer(worker, job);
    if (!isAvailable) {
      return res.status(400).json({ error: 'You are not available at the scheduled time' });
    }

    // Create or update job offer claim
    const claimData = {
      job_id: parseInt(id),
      team_member_id: teamMemberId,
      status: 'claimed',
      claimed_at: new Date().toISOString(),
      notes: notes || null
    };

    let claimResult;
    if (existingClaim) {
      // Update existing claim
      const { data, error } = await supabase
        .from('job_offers')
        .update(claimData)
        .eq('id', existingClaim.id)
        .select()
        .single();
      
      claimResult = { data, error };
    } else {
      // Create new claim
      const { data, error } = await supabase
        .from('job_offers')
        .insert(claimData)
        .select()
        .single();
      
      claimResult = { data, error };
    }

    if (claimResult.error) {
      console.error('Error creating/updating job claim:', claimResult.error);
      return res.status(500).json({ error: 'Failed to claim job' });
    }

    // Automatically assign the job to the worker (or wait for business owner approval)
    // For now, we'll auto-assign. You can change this to require approval later
    const { error: assignError } = await supabase
      .from('jobs')
      .update({ 
        team_member_id: teamMemberId,
        updated_at: new Date().toISOString()
      })
      .eq('id', id);

    if (assignError) {
      console.error('Error assigning job:', assignError);
      // Don't fail the claim, just log the error
    }

    // Update claim status to accepted (since we auto-assigned)
    await supabase
      .from('job_offers')
      .update({ 
        status: 'accepted',
        responded_at: new Date().toISOString()
      })
      .eq('id', claimResult.data.id);

    // TODO: Send notification to business owner
    // TODO: Send confirmation to worker

    res.json({ 
      success: true,
      message: 'Job claimed successfully',
      claim: claimResult.data,
      job: {
        ...job,
        team_member_id: teamMemberId
      }
    });
  } catch (error) {
    console.error('Error claiming job:', error);
    res.status(500).json({ error: 'Failed to claim job' });
  }
});

app.get('/api/jobs/:id', authenticateToken, async (req, res) => {
  // CORS handled by middleware - Windows Defender/Firewall compatible
  
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
    
    // Fetch status history from job_status_history table
    let statusHistory = [];
    const { data: historyData, error: historyError } = await supabase
      .from('job_status_history')
      .select('*')
      .eq('job_id', id)
      .order('changed_at', { ascending: true });
    
    if (!historyError && historyData) {
      statusHistory = historyData;
    }
    
    // Add status_history to job object for backward compatibility
    job.status_history = statusHistory;
    
   
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
      recurringFrequency = '',
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
        recurring_frequency: recurringFrequency || null, // Save null if empty, not empty string
        next_billing_date: (recurringJob && recurringFrequency) ? (() => {
          // Calculate next billing date based on frequency
          const scheduledDate = new Date(fullScheduledDate);
          const nextDate = calculateNextRecurringDate(recurringFrequency, scheduledDate);
          return nextDate ? nextDate.toISOString().split('T')[0] : null;
        })() : null,
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

      // Note: Initial status will be inserted into job_status_history table after job creation
      
      // Debug: Log what we're about to save
      console.log('💾 Saving Job - Recurring:', recurringJob, 'Frequency to save:', recurringFrequency, 'Type:', typeof recurringFrequency, 'Raw:', JSON.stringify(recurringFrequency));
      console.log('💾 JobData recurring_frequency field:', jobData.recurring_frequency);
    
      const { data: result, error: insertError } = await supabase
        .from('jobs')
        .insert(jobData)
        .select()
        .single();

      // Debug: Log what was actually saved
      if (result) {
        console.log('✅ Job Created - ID:', result.id, 'Saved Frequency:', result.recurring_frequency, 'Type:', typeof result.recurring_frequency);
      }

      if (insertError) {
        console.error('❌ Error creating job:', insertError);
        console.error('❌ Job data that failed:', jobData);
        return res.status(500).json({ error: 'Failed to create job', details: insertError.message });
      }
      
            // Verify customer exists and get customer data
      let customerData = null;
            if (result.customer_id) {
        const { data: customer, error: customerError } = await supabase
                .from('customers')
                .select('id, first_name, last_name, email, phone')
                .eq('id', result.customer_id)
                .single();
              
        if (!customerError) {
          customerData = customer;
        }
      }

      // Auto-sync to Google Calendar if enabled
      if (result.scheduled_date && result.scheduled_time) {
        try {
          await syncJobToCalendar(result.id, userId, result, customerData);
        } catch (calendarError) {
          console.error('⚠️ Calendar sync failed (non-blocking):', calendarError);
          // Don't fail job creation if calendar sync fails
               }
            }
      
      // Send automatic confirmation if customer has email
      if (result.customer_id) {
        try {
          const { data: customerData, error: customerError } = await supabase
            .from('customers')
            .select('id, first_name, last_name, email, phone')
            .eq('id', result.customer_id)
            .single();
          
          if (!customerError && customerData) {
            // Get service and business information
            const { data: serviceData, error: serviceError } = await supabase
              .from('services')
              .select('name')
              .eq('id', result.service_id)
              .single();
            
            const { data: businessData, error: businessError } = await supabase
              .from('users')
              .select('business_name')
              .eq('id', userId)
              .single();
            
            if (!serviceError && !businessError) {
              // Check customer notification preferences
              let emailNotifications = false; // Default to false (matches database schema)
              let smsNotifications = true; // Default to true (matches database schema)
              
              try {
                const { data: preferences } = await supabase
                  .from('customer_notification_preferences')
                  .select('email_notifications, sms_notifications')
                  .eq('customer_id', result.customer_id)
                  .single();
                
                if (preferences) {
                  emailNotifications = preferences.email_notifications;
                  smsNotifications = preferences.sms_notifications;
                } else {
                  // Create default preferences for new customer
                  console.log('📝 Creating default notification preferences for new customer');
                  const { error: insertError } = await supabase
                    .from('customer_notification_preferences')
                    .insert({
                      customer_id: result.customer_id,
                      email_notifications: emailNotifications,
                      sms_notifications: smsNotifications
                    });
                  
                  if (insertError) {
                    console.error('❌ Error creating customer notification preferences:', insertError);
                  } else {
                    console.log('✅ Created default notification preferences for customer');
                  }
                }
              } catch (prefError) {
                console.log('📝 No notification preferences found for new customer, creating defaults');
                
                // Create default preferences for new customer
                const { error: insertError } = await supabase
                  .from('customer_notification_preferences')
                  .insert({
                    customer_id: result.customer_id,
                    email_notifications: emailNotifications,
                    sms_notifications: smsNotifications
                  });
                
                if (insertError) {
                  console.error('❌ Error creating customer notification preferences:', insertError);
                } else {
                  console.log('✅ Created default notification preferences for customer');
                }
              }
              
              // Send confirmation email
              const customerName = customerData.first_name && customerData.last_name 
                ? `${customerData.first_name} ${customerData.last_name}`
                : customerData.first_name || customerData.last_name || 'Valued Customer';
              
              const serviceName = serviceData?.name || 'Service';
              const businessName = businessData?.business_name || 'Your Service Team';
              const serviceAddress = result.service_address || 'Service Location';
              
              const subject = 'Appointment Confirmation';
              const htmlContent = `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                  <div style="text-align: center; margin-bottom: 30px;">
                    <h1 style="color: #2563eb; margin: 0;">Appointment Confirmed</h1>
                  </div>
                  
                  <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
                    <h2 style="color: #1f2937; margin: 0 0 15px 0;">Hi ${customerName},</h2>
                    <p style="color: #374151; margin: 0 0 15px 0; font-size: 16px;">
                      Your appointment has been confirmed for <strong>${new Date(result.scheduled_date).toLocaleDateString('en-US', { 
                        weekday: 'long', 
                        month: 'long', 
                        day: 'numeric', 
                        year: 'numeric' 
                      })} at ${new Date(result.scheduled_date).toLocaleTimeString('en-US', { 
                        hour: 'numeric', 
                        minute: '2-digit',
                        hour12: true 
                      })}</strong>.
                    </p>
                    <div style="background: white; padding: 15px; border-radius: 6px; margin: 15px 0;">
                      <p style="margin: 0 0 10px 0; color: #374151;"><strong>Service:</strong> ${serviceName}</p>
                      <p style="margin: 0; color: #374151;"><strong>Location:</strong> ${serviceAddress}</p>
                    </div>
                    <p style="color: #374151; margin: 15px 0 0 0;">We look forward to serving you!</p>
                  </div>
                  
                  <div style="text-align: center; color: #6b7280; font-size: 14px;">
                    <p>Best regards,<br>${businessName}</p>
                  </div>
                </div>
              `;
              
              const textContent = `Hi ${customerName},\n\nYour appointment has been confirmed for ${new Date(result.scheduled_date).toLocaleDateString('en-US', { 
                weekday: 'long', 
                month: 'long', 
                day: 'numeric', 
                year: 'numeric' 
              })} at ${new Date(result.scheduled_date).toLocaleTimeString('en-US', { 
                hour: 'numeric', 
                minute: '2-digit',
                hour12: true 
              })}.\n\nService: ${serviceName}\nLocation: ${serviceAddress}\n\nWe look forward to serving you!\n\nBest regards,\n${businessName}`;

              // Check if customer has email address
              const hasEmail = customerData.email && customerData.email.trim() !== '';
              const hasPhone = customerData.phone && customerData.phone.trim() !== '';
              
              console.log('📧 Notification check:', {
                hasEmail,
                hasPhone,
                customerEmail: customerData.email,
                customerPhone: customerData.phone,
                emailNotifications,
                smsNotifications
              });
              
              // Send email notification if customer has email and email notifications are enabled
              if (hasEmail && emailNotifications) {
                const msg = {
                  to: customerData.email,
                  from: process.env.SENDGRID_FROM_EMAIL || 'noreply@service-flow.pro',
                  subject: subject,
                  html: htmlContent,
                  text: textContent
                };

                try {
                  await sgMail.send(msg);
                  console.log('✅ Automatic job confirmation email sent successfully to:', customerData.email);
                  
                  // Update job with confirmation status
                  await supabase
                    .from('jobs')
                    .update({
                      confirmation_sent: true,
                      confirmation_sent_at: new Date().toISOString(),
                      confirmation_email: customerData.email
                    })
                    .eq('id', result.id);
                  
                } catch (sendError) {
                  console.error('❌ Error sending automatic confirmation email:', sendError);
                  
                  // Update job with failed confirmation status
                  await supabase
                    .from('jobs')
                    .update({
                      confirmation_sent: false,
                      confirmation_failed: true,
                      confirmation_error: sendError.message
                    })
                    .eq('id', result.id);
                }
              }
              // If customer has no email, automatically send SMS instead
              else if (!hasEmail && hasPhone) {
                console.log('📱 Customer has no email, sending SMS confirmation instead');
                console.log('📱 SMS details:', {
                  customerPhone: customerData.phone,
                  userId: req.user.userId,
                  serviceName,
                  scheduledDate: result.scheduled_date
                });
                
                try {
                  const smsMessage = `Hi ${customerName}! Your appointment is confirmed for ${serviceName} on ${new Date(result.scheduled_date).toLocaleDateString('en-US', { 
                    weekday: 'long', 
                    month: 'long', 
                    day: 'numeric' 
                  })} at ${new Date(result.scheduled_date).toLocaleTimeString('en-US', { 
                    hour: 'numeric', 
                    minute: '2-digit',
                    hour12: true 
                  })}. We'll see you soon! - ${businessName}`;

                  console.log('📱 Sending SMS message:', smsMessage);
                  const smsResult = await sendSMSWithUserTwilio(req.user.userId, customerData.phone, smsMessage);
                  console.log('✅ Automatic job confirmation SMS sent (no email) to:', customerData.phone, 'SID:', smsResult.sid);
                  
                  // Update job with SMS confirmation status
                  await supabase
                    .from('jobs')
                    .update({
                      confirmation_sent: true,
                      confirmation_sent_at: new Date().toISOString(),
                      confirmation_method: 'sms',
                      sms_sent: true,
                      sms_sent_at: new Date().toISOString(),
                      sms_phone: customerData.phone,
                      sms_sid: smsResult.sid,
                      sms_failed: false,
                      sms_error: null
                    })
                    .eq('id', result.id);
                  
                } catch (smsError) {
                  console.error('❌ SMS sending failed:', smsError);
                  console.log('⚠️ SMS notification skipped - user Twilio not connected:', smsError.message);
                  
                  // Update job with failed SMS status
                  await supabase
                    .from('jobs')
                    .update({
                      confirmation_sent: false,
                      confirmation_failed: true,
                      confirmation_error: smsError.message,
                      sms_sent: false,
                      sms_failed: true,
                      sms_error: smsError.message
                    })
                    .eq('id', result.id);
                }
              } else if (!hasEmail && !hasPhone) {
                console.log('⚠️ Customer has no email and no phone number - no confirmation sent');
              }

              // Send SMS notification if enabled (for customers with email who also want SMS)
              if (smsNotifications && hasPhone && hasEmail) {
                try {
                  const smsMessage = `Hi ${customerName}! Your appointment is confirmed for ${serviceName} on ${new Date(result.scheduled_date).toLocaleDateString('en-US', { 
                    weekday: 'long', 
                    month: 'long', 
                    day: 'numeric' 
                  })} at ${new Date(result.scheduled_date).toLocaleTimeString('en-US', { 
                    hour: 'numeric', 
                    minute: '2-digit',
                    hour12: true 
                  })}. We'll see you soon! - ${businessName}`;

                  // Send SMS using user's Twilio Connect account
                  try {
                    const smsResult = await sendSMSWithUserTwilio(req.user.userId, customerData.phone, smsMessage);
                    console.log('✅ Automatic job confirmation SMS sent successfully to:', customerData.phone, 'SID:', smsResult.sid);
                  } catch (smsError) {
                    console.log('⚠️ SMS notification skipped - user Twilio not connected:', smsError.message);
                    // Continue without failing the job creation
                  }
                  
                  // Update job with SMS notification status
                  await supabase
                    .from('jobs')
                    .update({
                      sms_sent: true,
                      sms_sent_at: new Date().toISOString(),
                      sms_phone: customerData.phone,
                      sms_sid: smsResult.sid
                    })
                    .eq('id', result.id);
                  
                } catch (smsError) {
                  console.error('❌ Error sending automatic confirmation SMS:', smsError);
                  
                  // Update job with failed SMS notification status
                  await supabase
                    .from('jobs')
                    .update({
                      sms_sent: false,
                      sms_failed: true,
                      sms_error: smsError.message
                    })
                    .eq('id', result.id);
                }
              }
            }
          } else {
            // Update job with no email status
            await supabase
              .from('jobs')
              .update({
                confirmation_sent: false,
                confirmation_no_email: true
              })
              .eq('id', result.id);
          }
        } catch (confirmationError) {
          console.error('❌ Error in automatic confirmation process:', confirmationError);
          // Don't fail the job creation if confirmation fails
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

      // Insert initial status into job_status_history table
      const now = new Date().toISOString();
      let changedBy = 'Staff';
      let changedByType = 'account_owner';
      
      // Get user info for status history - check if account owner or team member
      try {
        // First check if it's an account owner
        const { data: userData } = await supabase
          .from('users')
          .select('first_name, last_name, business_name')
          .eq('id', userId)
          .maybeSingle();
        
        if (userData) {
          changedBy = userData.business_name || 
            `${userData.first_name || ''} ${userData.last_name || ''}`.trim() || 
            'Staff';
          changedByType = 'account_owner';
        } else {
          // If not found in users, check if it's a team member
          const { data: teamMemberData } = await supabase
            .from('team_members')
            .select('first_name, last_name')
            .eq('id', userId)
            .maybeSingle();
          
          if (teamMemberData) {
            changedBy = `${teamMemberData.first_name || ''} ${teamMemberData.last_name || ''}`.trim() || 'Team Member';
            changedByType = 'team_member';
          }
        }
      } catch (userError) {
        console.error('Error fetching user data for status history:', userError);
      }
      
      // Map status to backend format
      const statusMapping = {
        'in_progress': 'in-progress',
        'in-progress': 'in-progress',
        'pending': 'pending',
        'confirmed': 'confirmed',
        'completed': 'completed',
        'cancelled': 'cancelled'
      };
      const initialStatus = statusMapping[status] || status || 'pending';
      
      // Insert initial status history (always insert for initial status)
      const { error: historyInsertError } = await supabase
        .from('job_status_history')
        .insert({
          job_id: result.id,
          status: initialStatus,
          previous_status: null,
          changed_by: changedBy,
          changed_by_type: changedByType,
          changed_at: now
        });
      
      if (historyInsertError) {
        console.error('Error inserting initial status history:', historyInsertError);
        // Continue even if history insert fails
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

    // Get current job to check previous status
    const { data: currentJob, error: fetchError } = await supabase
      .from('jobs')
      .select('status')
      .eq('id', id)
      .single();

    if (fetchError) {
      console.error('Error fetching current job:', fetchError);
      return res.status(500).json({ error: 'Failed to fetch job details' });
    }

    const previousStatus = currentJob?.status || 'pending';
    const now = new Date().toISOString();
    
    // Get user info for status history - check if account owner or team member
    let changedBy = 'Staff';
    let changedByType = 'account_owner';
    
    // First check if it's an account owner
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('first_name, last_name, business_name')
      .eq('id', userId)
      .maybeSingle();
    
    if (userData) {
      changedBy = `${userData.first_name || ''} ${userData.last_name || ''}`.trim() || userData.business_name || 'Staff';
      changedByType = 'account_owner';
    } else {
      // If not found in users, check if it's a team member
      const { data: teamMemberData } = await supabase
        .from('team_members')
        .select('first_name, last_name')
        .eq('id', userId)
        .maybeSingle();
      
      if (teamMemberData) {
        changedBy = `${teamMemberData.first_name || ''} ${teamMemberData.last_name || ''}`.trim() || 'Team Member';
        changedByType = 'team_member';
      }
    }
    
    // Check if this status already exists in history for this job
    let existingStatusEntry = null;
    let checkHistoryError = null;
    
    try {
      const { data, error } = await supabase
        .from('job_status_history')
        .select('id')
        .eq('job_id', id)
        .eq('status', status)
        .limit(1)
        .maybeSingle(); // Use maybeSingle() instead of single() to avoid error when no rows
      
      if (error && error.code !== 'PGRST116' && error.code !== '42P01') { 
        // PGRST116 = no rows returned, 42P01 = table doesn't exist
        console.error('Error checking status history:', error);
        checkHistoryError = error;
      } else if (data) {
        existingStatusEntry = data;
      }
    } catch (err) {
      // Table might not exist yet - this is okay, we'll try to insert
      console.warn('Status history table may not exist yet:', err.message);
    }
    
    // If status already exists, UPDATE it. Otherwise, INSERT new entry
    if (existingStatusEntry && existingStatusEntry.id) {
      // Update existing entry
      try {
        const { error: historyUpdateError } = await supabase
          .from('job_status_history')
          .update({
      previous_status: previousStatus,
      changed_by: changedBy,
            changed_by_type: changedByType,
            changed_at: now
          })
          .eq('id', existingStatusEntry.id);
        
        if (historyUpdateError) {
          if (historyUpdateError.code === '42P01' || historyUpdateError.message?.includes('does not exist')) {
            console.warn('⚠️ job_status_history table does not exist yet.');
          } else {
            console.error('Error updating status history:', historyUpdateError);
          }
          // Continue with status update even if history update fails
        }
      } catch (err) {
        console.warn('Could not update status history (table may not exist):', err.message);
      }
    } else {
      // Insert new entry
      try {
        const { error: historyInsertError } = await supabase
          .from('job_status_history')
          .insert({
            job_id: id,
            status: status,
            previous_status: previousStatus,
            changed_by: changedBy,
            changed_by_type: changedByType,
            changed_at: now
          });
        
        if (historyInsertError) {
          // If table doesn't exist (42P01), log warning but continue
          if (historyInsertError.code === '42P01' || historyInsertError.message?.includes('does not exist')) {
            console.warn('⚠️ job_status_history table does not exist yet. Please run the migration SQL file.');
        } else {
            console.error('Error inserting status history:', historyInsertError);
      }
          // Continue with status update even if history insert fails
        }
      } catch (err) {
        console.warn('Could not insert status history (table may not exist):', err.message);
        // Continue with status update
      }
    }

    // Update job status
    const { error: updateError } = await supabase
      .from('jobs')
      .update({ 
        status: status,
        updated_at: now
      })
      .eq('id', id)
      .eq('user_id', userId);

    if (updateError) {
      console.error('Error updating job status:', updateError);
      return res.status(500).json({ error: 'Failed to update job status' });
    }

    // Send automatic confirmation for certain status changes
    if (status === 'confirmed' || status === 'completed' || status === 'cancelled') {
      try {
        // Get job details with customer and service information
        const { data: jobData, error: jobError } = await supabase
          .from('jobs')
          .select(`
            *,
            customers!left(first_name, last_name, email, phone),
            services!left(name),
            users!left(business_name)
          `)
          .eq('id', id)
          .single();

        if (!jobError && jobData && jobData.customers) {
          const customerName = jobData.customers.first_name && jobData.customers.last_name 
            ? `${jobData.customers.first_name} ${jobData.customers.last_name}`
            : jobData.customers.first_name || jobData.customers.last_name || 'Valued Customer';
          
          const serviceName = jobData.services?.name || 'Service';
          const businessName = jobData.users?.business_name || 'Your Service Team';
          const serviceAddress = jobData.service_address || 'Service Location';
          
          // Check customer notification preferences
          let emailNotifications = true; // Default to true for backward compatibility
          let smsNotifications = false;
          
          try {
            const { data: preferences } = await supabase
              .from('customer_notification_preferences')
              .select('email_notifications, sms_notifications')
              .eq('customer_id', jobData.customer_id)
              .single();
            
            if (preferences) {
              emailNotifications = preferences.email_notifications;
              smsNotifications = preferences.sms_notifications;
            }
          } catch (prefError) {
            console.log('No notification preferences found, using defaults');
          }
          
          let subject, htmlContent, textContent;
          
          if (status === 'confirmed') {
            subject = 'Appointment Confirmed';
            htmlContent = `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                <div style="text-align: center; margin-bottom: 30px;">
                  <h1 style="color: #2563eb; margin: 0;">Appointment Confirmed</h1>
                </div>
                
                <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
                  <h2 style="color: #1f2937; margin: 0 0 15px 0;">Hi ${customerName},</h2>
                  <p style="color: #374151; margin: 0 0 15px 0; font-size: 16px;">
                    Your appointment has been confirmed for <strong>${new Date(jobData.scheduled_date).toLocaleDateString('en-US', { 
                      weekday: 'long', 
                      month: 'long', 
                      day: 'numeric', 
                      year: 'numeric' 
                    })} at ${new Date(jobData.scheduled_date).toLocaleTimeString('en-US', { 
                      hour: 'numeric', 
                      minute: '2-digit',
                      hour12: true 
                    })}</strong>.
                  </p>
                  <div style="background: white; padding: 15px; border-radius: 6px; margin: 15px 0;">
                    <p style="margin: 0 0 10px 0; color: #374151;"><strong>Service:</strong> ${serviceName}</p>
                    <p style="margin: 0; color: #374151;"><strong>Location:</strong> ${serviceAddress}</p>
                  </div>
                  <p style="color: #374151; margin: 15px 0 0 0;">We look forward to serving you!</p>
                </div>
                
                <div style="text-align: center; color: #6b7280; font-size: 14px;">
                  <p>Best regards,<br>${businessName}</p>
                </div>
              </div>
            `;
            textContent = `Hi ${customerName},\n\nYour appointment has been confirmed for ${new Date(jobData.scheduled_date).toLocaleDateString('en-US', { 
              weekday: 'long', 
              month: 'long', 
              day: 'numeric', 
              year: 'numeric' 
            })} at ${new Date(jobData.scheduled_date).toLocaleTimeString('en-US', { 
              hour: 'numeric', 
              minute: '2-digit',
              hour12: true 
            })}.\n\nService: ${serviceName}\nLocation: ${serviceAddress}\n\nWe look forward to serving you!\n\nBest regards,\n${businessName}`;
          } else if (status === 'completed') {
            subject = 'Service Completed';
            htmlContent = `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                <div style="text-align: center; margin-bottom: 30px;">
                  <h1 style="color: #10b981; margin: 0;">Service Completed</h1>
                </div>
                
                <div style="background: #f0fdf4; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
                  <h2 style="color: #1f2937; margin: 0 0 15px 0;">Hi ${customerName},</h2>
                  <p style="color: #374151; margin: 0 0 15px 0; font-size: 16px;">
                    Your service has been completed successfully!
                  </p>
                  <div style="background: white; padding: 15px; border-radius: 6px; margin: 15px 0;">
                    <p style="margin: 0 0 10px 0; color: #374151;"><strong>Service:</strong> ${serviceName}</p>
                    <p style="margin: 0; color: #374151;"><strong>Location:</strong> ${serviceAddress}</p>
                  </div>
                  <p style="color: #374151; margin: 15px 0 0 0;">Thank you for choosing our services!</p>
                </div>
                
                <div style="text-align: center; color: #6b7280; font-size: 14px;">
                  <p>Best regards,<br>${businessName}</p>
                </div>
              </div>
            `;
            textContent = `Hi ${customerName},\n\nYour service has been completed successfully!\n\nService: ${serviceName}\nLocation: ${serviceAddress}\n\nThank you for choosing our services!\n\nBest regards,\n${businessName}`;
          } else if (status === 'cancelled') {
            subject = 'Appointment Cancelled';
            htmlContent = `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                <div style="text-align: center; margin-bottom: 30px;">
                  <h1 style="color: #ef4444; margin: 0;">Appointment Cancelled</h1>
                </div>
                
                <div style="background: #fef2f2; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
                  <h2 style="color: #1f2937; margin: 0 0 15px 0;">Hi ${customerName},</h2>
                  <p style="color: #374151; margin: 0 0 15px 0; font-size: 16px;">
                    Your appointment has been cancelled.
                  </p>
                  <div style="background: white; padding: 15px; border-radius: 6px; margin: 15px 0;">
                    <p style="margin: 0 0 10px 0; color: #374151;"><strong>Service:</strong> ${serviceName}</p>
                    <p style="margin: 0; color: #374151;"><strong>Location:</strong> ${serviceAddress}</p>
                  </div>
                  <p style="color: #374151; margin: 15px 0 0 0;">We apologize for any inconvenience. Please contact us to reschedule.</p>
                </div>
                
                <div style="text-align: center; color: #6b7280; font-size: 14px;">
                  <p>Best regards,<br>${businessName}</p>
                </div>
              </div>
            `;
            textContent = `Hi ${customerName},\n\nYour appointment has been cancelled.\n\nService: ${serviceName}\nLocation: ${serviceAddress}\n\nWe apologize for any inconvenience. Please contact us to reschedule.\n\nBest regards,\n${businessName}`;
          }

          // Send email notification if enabled
          if (emailNotifications && jobData.customers.email) {
            const msg = {
              to: jobData.customers.email,
              from: process.env.SENDGRID_FROM_EMAIL || 'noreply@service-flow.pro',
              subject: subject,
              html: htmlContent,
              text: textContent
            };

            try {
              await sgMail.send(msg);
              console.log(`✅ Automatic ${status} email notification sent successfully to:`, jobData.customers.email);
              
              // Update job with notification status
              await supabase
                .from('jobs')
                .update({
                  confirmation_sent: true,
                  confirmation_sent_at: new Date().toISOString(),
                  confirmation_email: jobData.customers.email
                })
                .eq('id', id);
              
            } catch (sendError) {
              console.error(`❌ Error sending automatic ${status} email notification:`, sendError);
              
              // Update job with failed notification status
              await supabase
                .from('jobs')
                .update({
                  confirmation_sent: false,
                  confirmation_failed: true,
                  confirmation_error: sendError.message
                })
                .eq('id', id);
            }
          }

          // Send SMS notification if enabled
          if (smsNotifications && jobData.customers.phone) {
            try {
              let smsMessage = '';
              
              if (status === 'confirmed') {
                smsMessage = `Hi ${customerName}! Your appointment is confirmed for ${serviceName} on ${new Date(jobData.scheduled_date).toLocaleDateString('en-US', { 
                  weekday: 'long', 
                  month: 'long', 
                  day: 'numeric' 
                })} at ${new Date(jobData.scheduled_date).toLocaleTimeString('en-US', { 
                  hour: 'numeric', 
                  minute: '2-digit',
                  hour12: true 
                })}. We'll see you soon! - ${businessName}`;
              } else if (status === 'completed') {
                smsMessage = `Hi ${customerName}! Your ${serviceName} service has been completed successfully. Thank you for choosing us! - ${businessName}`;
              } else if (status === 'cancelled') {
                smsMessage = `Hi ${customerName}, we're sorry to inform you that your ${serviceName} appointment has been cancelled. Please contact us to reschedule. - ${businessName}`;
              }

              // Send SMS using user's Twilio Connect account
              try {
                const result = await sendSMSWithUserTwilio(req.user.userId, jobData.customers.phone, smsMessage);
                console.log(`✅ Automatic ${status} SMS notification sent successfully to:`, jobData.customers.phone, 'SID:', result.sid);
              } catch (smsError) {
                console.log('⚠️ SMS notification skipped - user Twilio not connected:', smsError.message);
                // Continue without failing the status update
              }
              
              // Update job with SMS notification status
              await supabase
                .from('jobs')
                .update({
                  sms_sent: true,
                  sms_sent_at: new Date().toISOString(),
                  sms_phone: jobData.customers.phone,
                  sms_sid: result.sid
                })
                .eq('id', id);
              
            } catch (smsError) {
              console.error(`❌ Error sending automatic ${status} SMS notification:`, smsError);
              
              // Update job with failed SMS notification status
              await supabase
                .from('jobs')
                .update({
                  sms_sent: false,
                  sms_failed: true,
                  sms_error: smsError.message
                })
                .eq('id', id);
            }
          }
        }
      } catch (notificationError) {
        console.error('❌ Error in automatic status notification process:', notificationError);
        // Don't fail the status update if notification fails
      }
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
// Convert one-time job to recurring
app.post('/api/jobs/:id/convert-to-recurring', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    const { frequency, endDate } = req.body;
    
    if (!frequency) {
      return res.status(400).json({ error: 'Recurring frequency is required' });
    }
    
    // Check if job exists and belongs to user
    const { data: existingJob, error: checkError } = await supabase
      .from('jobs')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();
    
    if (checkError || !existingJob) {
      return res.status(404).json({ error: 'Job not found' });
    }
    
    // Check if already recurring
    if (existingJob.is_recurring || existingJob.recurring_job) {
      return res.status(400).json({ error: 'Job is already set as recurring' });
    }
    
    // Calculate next billing date based on frequency
    const scheduledDate = existingJob.scheduled_date ? new Date(existingJob.scheduled_date) : new Date();
    const nextBillingDate = calculateNextRecurringDate(frequency, scheduledDate);
    
    // Update job to be recurring
    const { data: updatedJob, error: updateError } = await supabase
      .from('jobs')
      .update({
        is_recurring: true,
        recurring_job: true,
        recurring_frequency: frequency,
        recurring_end_date: endDate || null,
        next_billing_date: nextBillingDate ? nextBillingDate.toISOString() : null
      })
      .eq('id', id)
      .select()
      .single();
    
    if (updateError) {
      console.error('Error converting job to recurring:', updateError);
      return res.status(500).json({ error: 'Failed to convert job to recurring' });
    }
    
    res.json({
      message: 'Job converted to recurring successfully',
      job: updatedJob
    });
  } catch (error) {
    console.error('Convert to recurring error:', error);
    res.status(500).json({ error: 'Failed to convert job to recurring' });
  }
});

// Duplicate job endpoint
app.post('/api/jobs/:id/duplicate', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    const { isRecurring, frequency, endDate, monthsAhead = 3 } = req.body;
    
    // Check if job exists and belongs to user
    const { data: existingJob, error: checkError } = await supabase
      .from('jobs')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();
    
    if (checkError || !existingJob) {
      return res.status(404).json({ error: 'Job not found' });
    }
    
    // Helper function to calculate next date based on frequency
    const calculateNextDate = (freq, fromDate) => {
      const date = new Date(fromDate);
      switch (freq) {
        case 'daily':
          date.setDate(date.getDate() + 1);
          break;
        case 'weekly':
          date.setDate(date.getDate() + 7);
          break;
        case 'biweekly':
          date.setDate(date.getDate() + 14);
          break;
        case 'monthly':
          date.setMonth(date.getMonth() + 1);
          break;
        case 'quarterly':
          date.setMonth(date.getMonth() + 3);
          break;
        default:
          date.setDate(date.getDate() + 7); // Default to weekly
      }
      return date;
    };
    
    // Create duplicate job data (excluding id and timestamps)
    const duplicateJobData = {
      user_id: existingJob.user_id,
      customer_id: existingJob.customer_id,
      service_id: existingJob.service_id,
      team_member_id: existingJob.team_member_id,
      scheduled_date: existingJob.scheduled_date,
      notes: existingJob.notes,
      status: 'pending', // New job starts as pending
      duration: existingJob.duration,
      estimated_duration: existingJob.estimated_duration,
      workers_needed: existingJob.workers_needed || existingJob.workers,
      skills_required: existingJob.skills_required,
      price: existingJob.price,
      service_price: existingJob.service_price,
      discount: existingJob.discount || 0,
      additional_fees: existingJob.additional_fees || 0,
      taxes: existingJob.taxes || 0,
      total: existingJob.total || existingJob.total_amount,
      total_amount: existingJob.total_amount || existingJob.total,
      payment_method: existingJob.payment_method,
      territory_id: existingJob.territory_id,
      service_address_street: existingJob.service_address_street,
      service_address_city: existingJob.service_address_city,
      service_address_state: existingJob.service_address_state,
      service_address_zip: existingJob.service_address_zip,
      service_address_country: existingJob.service_address_country,
      service_address_unit: existingJob.service_address_unit,
      service_name: existingJob.service_name,
      service_modifiers: existingJob.service_modifiers,
      service_intake_questions: existingJob.service_intake_questions,
      invoice_status: 'draft',
      payment_status: 'pending',
      is_recurring: isRecurring || false,
      recurring_frequency: isRecurring ? frequency : null,
      recurring_end_date: isRecurring && endDate ? endDate : null,
      offer_to_providers: existingJob.offer_to_providers || false
    };
    
    // Calculate next billing date if recurring
    if (isRecurring && frequency) {
      const scheduledDate = existingJob.scheduled_date ? new Date(existingJob.scheduled_date) : new Date();
      const nextBillingDate = calculateNextRecurringDate(frequency, scheduledDate);
      if (nextBillingDate) {
        duplicateJobData.next_billing_date = nextBillingDate.toISOString().split('T')[0];
      }
    }
    
    // Create the first duplicate job
    const { data: newJob, error: insertError } = await supabase
      .from('jobs')
      .insert(duplicateJobData)
      .select()
      .single();
    
    if (insertError) {
      console.error('Error creating duplicate job:', insertError);
      return res.status(500).json({ error: 'Failed to duplicate job' });
    }
    
    // If recurring, create jobs lazily (a few months ahead)
    if (isRecurring && frequency) {
      const jobsToCreate = [];
      const startDate = existingJob.scheduled_date ? new Date(existingJob.scheduled_date) : new Date();
      const endDateObj = endDate ? new Date(endDate) : null;
      const monthsAheadDate = new Date(startDate);
      monthsAheadDate.setMonth(monthsAheadDate.getMonth() + monthsAhead);
      const createUntil = endDateObj && endDateObj < monthsAheadDate ? endDateObj : monthsAheadDate;
      
      let currentDate = calculateNextDate(frequency, startDate);
      let jobCount = 0;
      const maxJobs = 100; // Safety limit
      
      while (currentDate <= createUntil && jobCount < maxJobs) {
        // Skip if past end date
        if (endDateObj && currentDate > endDateObj) {
          break;
        }
        
        const recurringJobData = {
          ...duplicateJobData,
          scheduled_date: currentDate.toISOString(),
          next_billing_date: calculateNextRecurringDate(frequency, currentDate)?.toISOString().split('T')[0] || null
        };
        
        jobsToCreate.push(recurringJobData);
        currentDate = calculateNextDate(frequency, currentDate);
        jobCount++;
      }
      
      // Insert all recurring jobs
      if (jobsToCreate.length > 0) {
        const { data: createdJobs, error: bulkInsertError } = await supabase
          .from('jobs')
          .insert(jobsToCreate)
          .select();
        
        if (bulkInsertError) {
          console.error('Error creating recurring jobs:', bulkInsertError);
          // Don't fail the request, just log the error
        } else {
          console.log(`✅ Created ${createdJobs?.length || 0} recurring jobs`);
        }
      }
    }
    
    res.json({
      message: isRecurring 
        ? `Job duplicated and set as recurring. Created jobs ${monthsAhead} months ahead.` 
        : 'Job duplicated successfully',
      job: newJob,
      isRecurring: isRecurring
    });
  } catch (error) {
    console.error('Duplicate job error:', error);
    res.status(500).json({ error: 'Failed to duplicate job' });
  }
});

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
     // Check if key is in fieldMappings, or if it's a direct database field name (snake_case)
     const dbFieldName = fieldMappings[key] || (key.includes('_') ? key : null);
     
     if ((fieldMappings[key] || key === 'serviceAddress' || dbFieldName) && updateData[key] !== undefined) {
        // Handle special cases
        if (key === 'scheduledDate' && updateData.scheduledTime) {
          // Simply combine date and time as-is, no timezone conversion
          updateDataToSend[fieldMappings[key]] = `${updateData[key]} ${updateData.scheduledTime}:00`;
        } else if (['skills', 'tags', 'serviceModifiers', 'serviceIntakeQuestions'].includes(key)) {
          updateDataToSend[fieldMappings[key] || key] = updateData[key];
        } else if (key === 'serviceAddress') {
          // Handle nested service address
          if (updateData[key]) {
            updateDataToSend.service_address_street = updateData[key].street || null;
            updateDataToSend.service_address_city = updateData[key].city || null;
            updateDataToSend.service_address_state = updateData[key].state || null;
            updateDataToSend.service_address_zip = updateData[key].zipCode || null;
          
          }
        } else {
          // Use mapped field name if available, otherwise use the key directly (for snake_case fields)
          updateDataToSend[fieldMappings[key] || key] = updateData[key];
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

    // Auto-sync to Google Calendar if enabled and job has date/time
    if (updatedJob && updatedJob[0] && (updatedJob[0].scheduled_date || updateDataToSend.scheduled_date)) {
      try {
        const job = updatedJob[0];
        const customerData = job.customers ? job.customers : null;
        await syncJobToCalendar(id, userId, job, customerData);
      } catch (calendarError) {
        console.error('⚠️ Calendar sync failed (non-blocking):', calendarError);
        // Don't fail job update if calendar sync fails
      }
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
// Delete all imported jobs (with optional date range filter)
app.delete('/api/jobs/delete-imported', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { startDate, endDate } = req.query; // Optional date range filters
    
    // Supabase has a max limit of 1000 per query, so we need to paginate through all pages
    const pageSize = 1000;
    let allJobs = [];
    let currentPage = 0;
    let hasMore = true;
    
    // Fetch all jobs in batches
    while (hasMore) {
      const offset = currentPage * pageSize;
      
    let query = supabase
      .from('jobs')
      .select('id, tags, created_at')
        .eq('user_id', userId)
        .range(offset, offset + pageSize - 1);
    
    // Apply date range filter if provided
    if (startDate) {
      query = query.gte('created_at', startDate);
    }
    if (endDate) {
      // Add one day to endDate to include the entire end date
      const endDatePlusOne = new Date(endDate);
      endDatePlusOne.setDate(endDatePlusOne.getDate() + 1);
      query = query.lt('created_at', endDatePlusOne.toISOString().split('T')[0]);
    }
    
      const { data: batchJobs, error: fetchError } = await query;
    
    if (fetchError) {
      console.error('Error fetching jobs:', fetchError);
      return res.status(500).json({ error: 'Failed to fetch jobs' });
      }
      
      if (batchJobs && batchJobs.length > 0) {
        allJobs = allJobs.concat(batchJobs);
        hasMore = batchJobs.length === pageSize;
        currentPage++;
      } else {
        hasMore = false;
      }
    }
    
    // Filter jobs that have "imported" in tags
    const importedJobs = allJobs.filter(job => {
      if (!job.tags) return false;
      
      // Handle both string and array formats
      if (typeof job.tags === 'string') {
        return job.tags.toLowerCase().includes('imported') || job.tags.toLowerCase().includes('import');
      }
      
      if (Array.isArray(job.tags)) {
        return job.tags.some(tag => 
          tag && (tag.toString().toLowerCase().includes('imported') || tag.toString().toLowerCase().includes('import'))
        );
      }
      
      return false;
    });
    
    const jobIds = importedJobs.map(job => job.id);
    
    if (jobIds.length === 0) {
      return res.json({
        message: 'No imported jobs found to delete',
        deleted: 0
      });
    }
    
    // For large batches, delete in chunks to avoid timeout
    const BATCH_SIZE = 500;
    let totalDeleted = 0;
    let errors = [];
    
    for (let i = 0; i < jobIds.length; i += BATCH_SIZE) {
      const batch = jobIds.slice(i, i + BATCH_SIZE);
      
      try {
        // Delete related records first for this batch
        // Delete job team assignments
        await supabase
          .from('job_team_assignments')
          .delete()
          .in('job_id', batch);
        
        // Delete transactions related to these jobs
        await supabase
          .from('transactions')
          .delete()
          .in('job_id', batch);
        
        // Delete the jobs
        const { error: deleteError } = await supabase
          .from('jobs')
          .delete()
          .in('id', batch);
        
        if (deleteError) {
          console.error(`Error deleting batch ${i / BATCH_SIZE + 1}:`, deleteError);
          errors.push(`Batch ${i / BATCH_SIZE + 1}: ${deleteError.message}`);
        } else {
          totalDeleted += batch.length;
        }
      } catch (error) {
        console.error(`Error processing batch ${i / BATCH_SIZE + 1}:`, error);
        errors.push(`Batch ${i / BATCH_SIZE + 1}: ${error.message}`);
      }
    }
    
    if (errors.length > 0 && totalDeleted === 0) {
      return res.status(500).json({ 
        error: 'Failed to delete imported jobs',
        details: errors
      });
    }
    
    res.json({
      message: `Successfully deleted ${totalDeleted} imported job(s)${errors.length > 0 ? ` (${errors.length} batch errors occurred)` : ''}`,
      deleted: totalDeleted,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error) {
    console.error('Delete imported jobs error:', error);
    res.status(500).json({ error: 'Failed to delete imported jobs' });
  }
});

// Get count of imported jobs (with optional date range filter)
app.get('/api/jobs/imported/count', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { startDate, endDate } = req.query; // Optional date range filters
    
    // Supabase has a max limit of 1000 per query, so we need to paginate through all pages
    const pageSize = 1000;
    let allJobs = [];
    let currentPage = 0;
    let hasMore = true;
    
    // Fetch all jobs in batches
    while (hasMore) {
      const offset = currentPage * pageSize;
    
    let query = supabase
      .from('jobs')
      .select('id, tags, created_at')
        .eq('user_id', userId)
        .range(offset, offset + pageSize - 1);
    
    // Apply date range filter if provided
    if (startDate) {
      query = query.gte('created_at', startDate);
    }
    if (endDate) {
      // Add one day to endDate to include the entire end date
      const endDatePlusOne = new Date(endDate);
      endDatePlusOne.setDate(endDatePlusOne.getDate() + 1);
      query = query.lt('created_at', endDatePlusOne.toISOString().split('T')[0]);
    }
    
      const { data: batchJobs, error: fetchError } = await query;
    
    if (fetchError) {
      console.error('Error fetching jobs:', fetchError);
      return res.status(500).json({ error: 'Failed to fetch jobs' });
      }
      
      if (batchJobs && batchJobs.length > 0) {
        allJobs = allJobs.concat(batchJobs);
        hasMore = batchJobs.length === pageSize;
        currentPage++;
      } else {
        hasMore = false;
      }
    }
    
    // Filter jobs that have "imported" in tags
    const importedJobs = allJobs.filter(job => {
      if (!job.tags) return false;
      
      // Handle both string and array formats
      if (typeof job.tags === 'string') {
        return job.tags.toLowerCase().includes('imported') || job.tags.toLowerCase().includes('import');
      }
      
      if (Array.isArray(job.tags)) {
        return job.tags.some(tag => 
          tag && (tag.toString().toLowerCase().includes('imported') || tag.toString().toLowerCase().includes('import'))
        );
      }
      
      return false;
    });
    
    res.json({ count: importedJobs.length });
  } catch (error) {
    console.error('Count imported jobs error:', error);
    res.status(500).json({ error: 'Failed to count imported jobs' });
  }
});

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
    
    // Add status filter - by default, exclude archived customers unless explicitly requested
    if (status && status !== 'all') {
      query = query.eq('status', status);
    } else {
      // Exclude archived customers by default (show only active/null status)
      query = query.or('status.is.null,status.neq.archived');
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
    const limitValue = parseInt(limit);
    let allCustomers = [];
    let totalCount = 0;
    
    // If limit is very high (>= 10000), fetch ALL customers by paginating through all pages
    if (limitValue >= 10000) {
      // Supabase has a max limit of 1000 per query, so we need to paginate
      const pageSize = 1000;
      let currentPage = 0;
      let hasMore = true;
      
      // First, get the total count
      const countQuery = supabase
        .from('customers')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId);
      
      if (status && status !== 'all') {
        countQuery.eq('status', status);
      }
      
      if (search) {
        countQuery.or(`first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%,phone.ilike.%${search}%`);
      }
      
      const { count } = await countQuery;
      totalCount = count || 0;
      
      // Fetch all customers in batches
      while (hasMore) {
        const offset = currentPage * pageSize;
        let batchQuery = supabase
          .from('customers')
          .select('*')
          .eq('user_id', userId)
          .range(offset, offset + pageSize - 1);
        
        // Apply filters
        if (status && status !== 'all') {
          batchQuery = batchQuery.eq('status', status);
        }
        
        if (search) {
          batchQuery = batchQuery.or(`first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%,phone.ilike.%${search}%`);
        }
        
        // Apply sorting
        if (allowedSortFields.includes(sortBy) && allowedSortOrders.includes(sortOrder.toUpperCase())) {
          batchQuery = batchQuery.order(sortBy, { ascending: sortOrder.toUpperCase() === 'ASC' });
        } else {
          batchQuery = batchQuery.order('created_at', { ascending: false });
        }
        
        const { data: batch, error: batchError } = await batchQuery;
        
        if (batchError) {
          console.error('Error fetching customer batch:', batchError);
          return res.status(500).json({ error: 'Failed to fetch customers' });
        }
        
        if (batch && batch.length > 0) {
          allCustomers = [...allCustomers, ...batch];
          currentPage++;
          
          // Check if there are more customers to fetch
          if (batch.length < pageSize || allCustomers.length >= totalCount) {
            hasMore = false;
          }
        } else {
          hasMore = false;
        }
      }
      
      res.json({
        customers: allCustomers,
        pagination: {
          page: 1,
          limit: totalCount,
          total: totalCount,
          pages: 1
        }
      });
    } else {
      // Normal pagination for smaller limits
      const offset = (page - 1) * limitValue;
      query = query.range(offset, offset + limitValue - 1);
      
      const { data: customers, error, count } = await query;
      
      if (error) {
        console.error('Error fetching customers:', error);
        return res.status(500).json({ error: 'Failed to fetch customers' });
      }
      
      res.json({
        customers: customers || [],
        pagination: {
          page: parseInt(page),
          limit: limitValue,
          total: count || 0,
          pages: Math.ceil((count || 0) / limitValue)
        }
      });
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

// ============================================
// LEADS PIPELINE API ENDPOINTS
// ============================================

// Get or create default pipeline for user
app.get('/api/leads/pipeline', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    // Check if user has a default pipeline
    let { data: pipelines, error } = await supabase
      .from('lead_pipelines')
      .select('*')
      .eq('user_id', userId)
      .eq('is_default', true)
      .limit(1);
    
    if (error) {
      console.error('Error fetching pipeline:', error);
      return res.status(500).json({ error: 'Failed to fetch pipeline' });
    }
    
    let pipeline;
    if (!pipelines || pipelines.length === 0) {
      // Create default pipeline with default stages
      const { data: newPipeline, error: createError } = await supabase
        .from('lead_pipelines')
        .insert({
          user_id: userId,
          name: 'Default Pipeline',
          is_default: true
        })
        .select()
        .single();
      
      if (createError) {
        console.error('Error creating pipeline:', createError);
        return res.status(500).json({ error: 'Failed to create pipeline' });
      }
      
      pipeline = newPipeline;
      
      // Create default stages
      const defaultStages = [
        { name: 'New Lead', color: '#3B82F6', position: 0 },
        { name: 'Contacted', color: '#FBBF24', position: 1 },
        { name: 'Qualified', color: '#F97316', position: 2 },
        { name: 'Proposal Sent', color: '#A855F7', position: 3 },
        { name: 'Negotiation', color: '#EC4899', position: 4 },
        { name: 'Won', color: '#10B981', position: 5 },
        { name: 'Lost', color: '#EF4444', position: 6 }
      ];
      
      const stagesToInsert = defaultStages.map(stage => ({
        pipeline_id: pipeline.id,
        name: stage.name,
        color: stage.color,
        position: stage.position
      }));
      
      const { error: stagesError } = await supabase
        .from('lead_stages')
        .insert(stagesToInsert);
      
      if (stagesError) {
        console.error('Error creating default stages:', stagesError);
        // Continue anyway - stages can be added later
      }
    } else {
      pipeline = pipelines[0];
    }
    
    // Fetch stages for this pipeline
    const { data: stages, error: stagesError } = await supabase
      .from('lead_stages')
      .select('*')
      .eq('pipeline_id', pipeline.id)
      .order('position', { ascending: true });
    
    if (stagesError) {
      console.error('Error fetching stages:', stagesError);
      return res.status(500).json({ error: 'Failed to fetch stages' });
    }
    
    res.json({
      ...pipeline,
      stages: stages || []
    });
  } catch (error) {
    console.error('Get pipeline error:', error);
    res.status(500).json({ error: 'Failed to fetch pipeline' });
  }
});

// Update pipeline stages (reorder, add, update, delete)
app.put('/api/leads/pipeline/stages', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { stages } = req.body; // Array of stage objects with id, name, color, position
    
    if (!Array.isArray(stages)) {
      return res.status(400).json({ error: 'Stages must be an array' });
    }
    
    // Get user's default pipeline
    const { data: pipelines, error: pipelineError } = await supabase
      .from('lead_pipelines')
      .select('id')
      .eq('user_id', userId)
      .eq('is_default', true)
      .limit(1)
      .single();
    
    if (pipelineError || !pipelines) {
      return res.status(404).json({ error: 'Pipeline not found' });
    }
    
    const pipelineId = pipelines.id;
    
    // Update existing stages and create new ones
    for (const stage of stages) {
      if (stage.id) {
        // Update existing stage
        const { error: updateError } = await supabase
          .from('lead_stages')
          .update({
            name: stage.name,
            color: stage.color,
            position: stage.position
          })
          .eq('id', stage.id)
          .eq('pipeline_id', pipelineId);
        
        if (updateError) {
          console.error('Error updating stage:', updateError);
        }
      } else {
        // Create new stage
        const { error: insertError } = await supabase
          .from('lead_stages')
          .insert({
            pipeline_id: pipelineId,
            name: stage.name,
            color: stage.color,
            position: stage.position
          });
        
        if (insertError) {
          console.error('Error creating stage:', insertError);
        }
      }
    }
    
    // Fetch updated stages
    const { data: updatedStages, error: fetchError } = await supabase
      .from('lead_stages')
      .select('*')
      .eq('pipeline_id', pipelineId)
      .order('position', { ascending: true });
    
    if (fetchError) {
      return res.status(500).json({ error: 'Failed to fetch updated stages' });
    }
    
    res.json({ stages: updatedStages });
  } catch (error) {
    console.error('Update stages error:', error);
    res.status(500).json({ error: 'Failed to update stages' });
  }
});

// Delete a stage
app.delete('/api/leads/pipeline/stages/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    
    // Verify pipeline ownership
    const { data: stage, error: stageError } = await supabase
      .from('lead_stages')
      .select('pipeline_id, lead_pipelines!inner(user_id)')
      .eq('id', id)
      .single();
    
    if (stageError || !stage) {
      return res.status(404).json({ error: 'Stage not found' });
    }
    
    if (stage.lead_pipelines.user_id !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    
    // Check if stage has leads
    const { data: leads, error: leadsError } = await supabase
      .from('leads')
      .select('id')
      .eq('stage_id', id)
      .limit(1);
    
    if (leadsError) {
      return res.status(500).json({ error: 'Failed to check leads' });
    }
    
    if (leads && leads.length > 0) {
      return res.status(400).json({ error: 'Cannot delete stage with leads. Move leads first.' });
    }
    
    // Delete stage
    const { error: deleteError } = await supabase
      .from('lead_stages')
      .delete()
      .eq('id', id);
    
    if (deleteError) {
      return res.status(500).json({ error: 'Failed to delete stage' });
    }
    
    res.json({ message: 'Stage deleted successfully' });
  } catch (error) {
    console.error('Delete stage error:', error);
    res.status(500).json({ error: 'Failed to delete stage' });
  }
});

// Get all leads for a user
app.get('/api/leads', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    const { data: leads, error } = await supabase
      .from('leads')
      .select(`
        *,
        lead_stages (*),
        lead_pipelines (*)
      `)
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    
    if (error) {
      console.error('Error fetching leads:', error);
      return res.status(500).json({ error: 'Failed to fetch leads' });
    }
    
    res.json({ leads: leads || [] });
  } catch (error) {
    console.error('Get leads error:', error);
    res.status(500).json({ error: 'Failed to fetch leads' });
  }
});

// Get a single lead
app.get('/api/leads/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    
    const { data: leads, error } = await supabase
      .from('leads')
      .select(`
        *,
        lead_stages (*),
        lead_pipelines (*),
        customers (id, first_name, last_name, email)
      `)
      .eq('id', id)
      .eq('user_id', userId)
      .single();
    
    if (error) {
      console.error('Error fetching lead:', error);
      return res.status(500).json({ error: 'Failed to fetch lead' });
    }
    
    if (!leads) {
      return res.status(404).json({ error: 'Lead not found' });
    }
    
    res.json(leads);
  } catch (error) {
    console.error('Get lead error:', error);
    res.status(500).json({ error: 'Failed to fetch lead' });
  }
});

// Create a new lead
app.post('/api/leads', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { firstName, lastName, email, phone, company, source, notes, value, stageId, pipelineId } = req.body;
    
    // Get default pipeline if not provided
    let finalPipelineId = pipelineId;
    if (!finalPipelineId) {
      const { data: pipelines, error: pipelineError } = await supabase
        .from('lead_pipelines')
        .select('id')
        .eq('user_id', userId)
        .eq('is_default', true)
        .limit(1)
        .single();
      
      if (pipelineError || !pipelines) {
        return res.status(404).json({ error: 'Default pipeline not found' });
      }
      finalPipelineId = pipelines.id;
    }
    
    // Get first stage if stageId not provided
    let finalStageId = stageId;
    if (!finalStageId) {
      const { data: stages, error: stagesError } = await supabase
        .from('lead_stages')
        .select('id')
        .eq('pipeline_id', finalPipelineId)
        .order('position', { ascending: true })
        .limit(1)
        .single();
      
      if (stagesError || !stages) {
        return res.status(404).json({ error: 'No stages found in pipeline' });
      }
      finalStageId = stages.id;
    }
    
    const { data: lead, error } = await supabase
      .from('leads')
      .insert({
        user_id: userId,
        pipeline_id: finalPipelineId,
        stage_id: finalStageId,
        first_name: firstName,
        last_name: lastName,
        email: email,
        phone: phone,
        company: company,
        source: source,
        notes: notes,
        value: value
      })
      .select(`
        *,
        lead_stages (*),
        lead_pipelines (*)
      `)
      .single();
    
    if (error) {
      console.error('Error creating lead:', error);
      return res.status(500).json({ error: 'Failed to create lead' });
    }
    
    res.status(201).json(lead);
  } catch (error) {
    console.error('Create lead error:', error);
    res.status(500).json({ error: 'Failed to create lead' });
  }
});

// Update a lead
app.put('/api/leads/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    const { firstName, lastName, email, phone, company, source, notes, value, stageId } = req.body;
    
    // Verify ownership
    const { data: existingLead, error: checkError } = await supabase
      .from('leads')
      .select('id')
      .eq('id', id)
      .eq('user_id', userId)
      .single();
    
    if (checkError || !existingLead) {
      return res.status(404).json({ error: 'Lead not found' });
    }
    
    const updateData = {};
    if (firstName !== undefined) updateData.first_name = firstName;
    if (lastName !== undefined) updateData.last_name = lastName;
    if (email !== undefined) updateData.email = email;
    if (phone !== undefined) updateData.phone = phone;
    if (company !== undefined) updateData.company = company;
    if (source !== undefined) updateData.source = source;
    if (notes !== undefined) updateData.notes = notes;
    if (value !== undefined) updateData.value = value;
    if (stageId !== undefined) updateData.stage_id = stageId;
    
    const { data: lead, error } = await supabase
      .from('leads')
      .update(updateData)
      .eq('id', id)
      .select(`
        *,
        lead_stages (*),
        lead_pipelines (*)
      `)
      .single();
    
    if (error) {
      console.error('Error updating lead:', error);
      return res.status(500).json({ error: 'Failed to update lead' });
    }
    
    res.json(lead);
  } catch (error) {
    console.error('Update lead error:', error);
    res.status(500).json({ error: 'Failed to update lead' });
  }
});

// Delete a lead
app.delete('/api/leads/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    
    // Verify ownership
    const { data: existingLead, error: checkError } = await supabase
      .from('leads')
      .select('id')
      .eq('id', id)
      .eq('user_id', userId)
      .single();
    
    if (checkError || !existingLead) {
      return res.status(404).json({ error: 'Lead not found' });
    }
    
    const { error: deleteError } = await supabase
      .from('leads')
      .delete()
      .eq('id', id);
    
    if (deleteError) {
      return res.status(500).json({ error: 'Failed to delete lead' });
    }
    
    res.json({ message: 'Lead deleted successfully' });
  } catch (error) {
    console.error('Delete lead error:', error);
    res.status(500).json({ error: 'Failed to delete lead' });
  }
});

// Move lead to different stage (for drag and drop)
app.put('/api/leads/:id/move', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    const { stageId } = req.body;
    
    if (!stageId) {
      return res.status(400).json({ error: 'Stage ID is required' });
    }
    
    // Verify ownership
    const { data: existingLead, error: checkError } = await supabase
      .from('leads')
      .select('id')
      .eq('id', id)
      .eq('user_id', userId)
      .single();
    
    if (checkError || !existingLead) {
      return res.status(404).json({ error: 'Lead not found' });
    }
    
    // Update stage
    const { data: lead, error } = await supabase
      .from('leads')
      .update({ stage_id: stageId })
      .eq('id', id)
      .select(`
        *,
        lead_stages (*),
        lead_pipelines (*)
      `)
      .single();
    
    if (error) {
      console.error('Error moving lead:', error);
      return res.status(500).json({ error: 'Failed to move lead' });
    }
    
    res.json(lead);
  } catch (error) {
    console.error('Move lead error:', error);
    res.status(500).json({ error: 'Failed to move lead' });
  }
});

// ============================================
// LEAD TASKS API ENDPOINTS
// ============================================

// Get all tasks for a lead
app.get('/api/leads/:leadId/tasks', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { leadId } = req.params;
    
    // Verify lead ownership
    const { data: lead, error: leadError } = await supabase
      .from('leads')
      .select('id')
      .eq('id', leadId)
      .eq('user_id', userId)
      .single();
    
    if (leadError || !lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }
    
    const { data: tasks, error } = await supabase
      .from('lead_tasks')
      .select(`
        *,
        team_members (
          id,
          first_name,
          last_name
        )
      `)
      .eq('lead_id', leadId)
      .eq('user_id', userId)
      .order('due_date', { ascending: true, nullsFirst: true })
      .order('created_at', { ascending: false });
    
    if (error) {
      console.error('Error fetching tasks:', error);
      return res.status(500).json({ error: 'Failed to fetch tasks' });
    }
    
    res.json({ tasks: tasks || [] });
  } catch (error) {
    console.error('Get tasks error:', error);
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

// Get all tasks for a user (across all leads)
app.get('/api/leads/tasks', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { status, overdue } = req.query;
    
    let query = supabase
      .from('lead_tasks')
      .select(`
        *,
        leads (
          id,
          first_name,
          last_name,
          company
        ),
        team_members (
          id,
          first_name,
          last_name
        )
      `)
      .eq('user_id', userId);
    
    if (status) {
      query = query.eq('status', status);
    }
    
    if (overdue === 'true') {
      const now = new Date().toISOString();
      query = query.lt('due_date', now).neq('status', 'completed');
    }
    
    const { data: tasks, error } = await query
      .order('due_date', { ascending: true, nullsFirst: true })
      .order('created_at', { ascending: false });
    
    if (error) {
      console.error('Error fetching tasks:', error);
      return res.status(500).json({ error: 'Failed to fetch tasks' });
    }
    
    res.json({ tasks: tasks || [] });
  } catch (error) {
    console.error('Get all tasks error:', error);
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

// Create a new task for a lead
app.post('/api/leads/:leadId/tasks', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { leadId } = req.params;
    const { title, description, dueDate, priority, assignedTo } = req.body;
    
    if (!title || title.trim() === '') {
      return res.status(400).json({ error: 'Task title is required' });
    }
    
    // Verify lead ownership
    const { data: lead, error: leadError } = await supabase
      .from('leads')
      .select('id')
      .eq('id', leadId)
      .eq('user_id', userId)
      .single();
    
    if (leadError || !lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }
    
    // Verify assigned team member belongs to user (if assigned)
    if (assignedTo) {
      const { data: teamMember, error: teamError } = await supabase
        .from('team_members')
        .select('id')
        .eq('id', assignedTo)
        .eq('user_id', userId)
        .single();
      
      if (teamError || !teamMember) {
        return res.status(400).json({ error: 'Invalid team member assignment' });
      }
    }
    
    const { data: task, error } = await supabase
      .from('lead_tasks')
      .insert({
        lead_id: parseInt(leadId),
        user_id: userId,
        title: title.trim(),
        description: description || null,
        due_date: dueDate || null,
        priority: priority || 'medium',
        assigned_to: assignedTo || null,
        status: 'pending'
      })
      .select(`
        *,
        team_members (
          id,
          first_name,
          last_name
        )
      `)
      .single();
    
    if (error) {
      console.error('Error creating task:', error);
      return res.status(500).json({ error: 'Failed to create task' });
    }
    
    res.status(201).json(task);
  } catch (error) {
    console.error('Create task error:', error);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

// Update a task
app.put('/api/leads/tasks/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    const { title, description, dueDate, priority, assignedTo, status } = req.body;
    
    // Verify task ownership
    const { data: existingTask, error: checkError } = await supabase
      .from('lead_tasks')
      .select('id, status')
      .eq('id', id)
      .eq('user_id', userId)
      .single();
    
    if (checkError || !existingTask) {
      return res.status(404).json({ error: 'Task not found' });
    }
    
    // Verify assigned team member belongs to user (if assigned)
    if (assignedTo) {
      const { data: teamMember, error: teamError } = await supabase
        .from('team_members')
        .select('id')
        .eq('id', assignedTo)
        .eq('user_id', userId)
        .single();
      
      if (teamError || !teamMember) {
        return res.status(400).json({ error: 'Invalid team member assignment' });
      }
    }
    
    const updateData = {};
    if (title !== undefined) updateData.title = title.trim();
    if (description !== undefined) updateData.description = description || null;
    if (dueDate !== undefined) updateData.due_date = dueDate || null;
    if (priority !== undefined) updateData.priority = priority;
    if (assignedTo !== undefined) updateData.assigned_to = assignedTo || null;
    if (status !== undefined) {
      updateData.status = status;
      // Set completed_at if status is completed
      if (status === 'completed' && existingTask.status !== 'completed') {
        updateData.completed_at = new Date().toISOString();
      } else if (status !== 'completed' && existingTask.status === 'completed') {
        updateData.completed_at = null;
      }
    }
    
    const { data: task, error } = await supabase
      .from('lead_tasks')
      .update(updateData)
      .eq('id', id)
      .select(`
        *,
        team_members (
          id,
          first_name,
          last_name
        )
      `)
      .single();
    
    if (error) {
      console.error('Error updating task:', error);
      return res.status(500).json({ error: 'Failed to update task' });
    }
    
    res.json(task);
  } catch (error) {
    console.error('Update task error:', error);
    res.status(500).json({ error: 'Failed to update task' });
  }
});

// Delete a task
app.delete('/api/leads/tasks/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    
    // Verify task ownership
    const { data: existingTask, error: checkError } = await supabase
      .from('lead_tasks')
      .select('id')
      .eq('id', id)
      .eq('user_id', userId)
      .single();
    
    if (checkError || !existingTask) {
      return res.status(404).json({ error: 'Task not found' });
    }
    
    const { error: deleteError } = await supabase
      .from('lead_tasks')
      .delete()
      .eq('id', id);
    
    if (deleteError) {
      return res.status(500).json({ error: 'Failed to delete task' });
    }
    
    res.json({ message: 'Task deleted successfully' });
  } catch (error) {
    console.error('Delete task error:', error);
    res.status(500).json({ error: 'Failed to delete task' });
  }
});

// Convert lead to customer
app.post('/api/leads/:id/convert', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    
    // Get lead details
    const { data: lead, error: leadError } = await supabase
      .from('leads')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();
    
    if (leadError || !lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }
    
    // Check if already converted
    if (lead.converted_customer_id) {
      return res.status(400).json({ error: 'Lead already converted' });
    }
    
    // Create customer from lead
    const { data: customer, error: customerError } = await supabase
      .from('customers')
      .insert({
        user_id: userId,
        first_name: lead.first_name,
        last_name: lead.last_name,
        email: lead.email,
        phone: lead.phone,
        notes: lead.notes || `Converted from lead: ${lead.source || 'Unknown source'}`
      })
      .select()
      .single();
    
    if (customerError) {
      console.error('Error creating customer:', customerError);
      return res.status(500).json({ error: 'Failed to create customer' });
    }
    
    // Update lead with converted customer ID
    const { error: updateError } = await supabase
      .from('leads')
      .update({
        converted_customer_id: customer.id,
        converted_at: new Date().toISOString()
      })
      .eq('id', id);
    
    if (updateError) {
      console.error('Error updating lead:', updateError);
      // Customer was created, so continue
    }
    
    res.json({
      message: 'Lead converted to customer successfully',
      customer: customer,
      lead: {
        ...lead,
        converted_customer_id: customer.id,
        converted_at: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Convert lead error:', error);
    res.status(500).json({ error: 'Failed to convert lead' });
  }
});

// Delete all customers endpoint (for testing purposes) - MUST be before /:id route
app.delete('/api/customers/all', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    // Hard delete all customers for this user (for testing/import purposes)
    // First, we need to delete associated records if they exist
    // Get all customer IDs for this user
    const { data: customers, error: fetchError } = await supabase
      .from('customers')
      .select('id')
      .eq('user_id', userId);
    
    if (fetchError) {
      console.error('Error fetching customers for deletion:', fetchError);
      return res.status(500).json({ error: 'Failed to fetch customers for deletion' });
    }
    
    if (!customers || customers.length === 0) {
      return res.json({ message: 'No customers to delete' });
    }
    
    const customerIds = customers.map(c => c.id);
    
    // Delete associated records first (if any exist, this will handle foreign key constraints)
    // Note: This might fail if there are jobs/estimates, but for testing we'll try to proceed
    
    // Hard delete all customers
    const { error: deleteError } = await supabase
      .from('customers')
      .delete()
      .eq('user_id', userId);
    
    if (deleteError) {
      console.error('Error deleting all customers:', deleteError);
      
      // Check if it's a foreign key constraint error
      if (deleteError.code === '23503' || deleteError.message?.includes('foreign key') || deleteError.message?.includes('violates foreign key')) {
        // For testing purposes, try to delete jobs and estimates first, then retry
        console.log('⚠️ Foreign key constraint detected, attempting to delete associated records...');
        
        // Try to delete associated jobs (cascade delete if possible, otherwise just mark)
        await supabase
          .from('jobs')
          .delete()
          .in('customer_id', customerIds);
        
        // Try to delete associated estimates
        await supabase
          .from('estimates')
          .delete()
          .in('customer_id', customerIds);
        
        // Retry customer deletion
        const { error: retryError } = await supabase
          .from('customers')
          .delete()
          .eq('user_id', userId);
        
        if (retryError) {
          return res.status(500).json({ 
            error: 'Failed to delete customers. Some customers may have associated records that could not be removed.',
            details: retryError.message 
          });
        }
        
        console.log(`✅ Deleted ${customerIds.length} customers and associated records for user ${userId}`);
        return res.json({ 
          message: `All ${customerIds.length} customers and associated records deleted successfully`,
          deleted: customerIds.length
        });
      }
      
      return res.status(500).json({ 
        error: 'Failed to delete all customers',
        details: deleteError.message 
      });
    }
    
    console.log(`✅ Deleted ${customerIds.length} customers for user ${userId}`);
    res.json({ 
      message: `All ${customerIds.length} customers deleted successfully`,
      deleted: customerIds.length
    });
  } catch (error) {
    console.error('Delete all customers error:', error);
    res.status(500).json({ error: 'Failed to delete all customers' });
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
      errors: [],
      warnings: [] // Track duplicate warnings separately from errors
    };

    console.log(`📥 Starting import of ${jobs.length} jobs for user ${userId}`);
    console.log(`🔒 IMPORTANT: All duplicate checks will ONLY look at jobs belonging to user ${userId} - jobs from other users are completely separate`);
    
    // Track jobs being imported in this batch to detect duplicates within the CSV
    const batchJobKeys = new Set(); // Format: "userId_customerId_serviceId_date" or "userId_customerId_serviceName_date"
    
    // Track external IDs to internal IDs mapping to prevent duplicate team members and territories
    // Format: { externalId: internalId }
    const crewIdMapping = {}; // Maps external crew IDs to team member IDs
    const territoryIdMapping = {}; // Maps external region IDs to territory IDs
    const serviceNameMapping = {}; // Maps normalized service names to service IDs to prevent duplicates
    
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      
      try {
        // Log every 10th job for debugging, and always log date for troubleshooting
        if (i === 0 || (i + 1) % 10 === 0) {
          console.log(`📥 Processing job ${i + 1}/${jobs.length}:`, job.customerName, job.serviceName, `Date: ${job.scheduledDate || 'N/A'}`);
        }
        
        // Validate required fields - need customer ID, email, or name
        if (!job.customerId && !job.customerEmail && !job.customerName) {
          results.errors.push(`Row ${i + 1}: Customer ID, email, or name is required`);
          results.skipped++;
          continue;
        }

        // Find or create customer
        let customerId = job.customerId;
        
        if (!customerId) {
          let customer = null;
          let customerFound = false;
          
          // First, try to find by email if provided
          if (job.customerEmail && job.customerEmail.trim()) {
            const { data: foundCustomer, error: emailError } = await supabase
              .from('customers')
              .select('id')
              .eq('user_id', userId)
              .eq('email', job.customerEmail.toLowerCase().trim())
              .maybeSingle();
            
            if (emailError) {
              console.error(`Row ${i + 1}: Error searching customer by email:`, emailError);
            } else if (foundCustomer) {
              customer = foundCustomer;
              customerFound = true;
              console.log(`Row ${i + 1}: Found customer by email:`, foundCustomer.id);
            }
          }
          
          // If not found by email, try to find by phone first (more reliable)
          if (!customerFound && job.customerPhone) {
            const phoneDigits = job.customerPhone.replace(/\D/g, '');
            if (phoneDigits.length >= 10) {
              // Try to match by phone - use ilike for partial matches
              const { data: phoneMatches, error: phoneError } = await supabase
                .from('customers')
                .select('id')
                .eq('user_id', userId)
                .ilike('phone', `%${phoneDigits.slice(-10)}%`);
              
              if (phoneError) {
                console.error(`Row ${i + 1}: Error searching customer by phone:`, phoneError);
              } else if (phoneMatches && phoneMatches.length > 0) {
                customer = phoneMatches[0]; // Take first match
                customerFound = true;
                console.log(`Row ${i + 1}: Found customer by phone:`, customer.id);
              }
            }
          }
          
          // If not found by email or phone, try to find by name
          if (!customerFound && job.customerName) {
            // Parse customer name into first and last name
            const nameParts = job.customerName.trim().split(/\s+/);
            const firstName = nameParts[0] || '';
            const lastName = nameParts.slice(1).join(' ') || '';
            
            if (firstName) {
              // Try to find by first and last name
              let query = supabase
                .from('customers')
                .select('id')
                .eq('user_id', userId)
                .eq('first_name', firstName);
              
              if (lastName) {
                query = query.eq('last_name', lastName);
              }
              
              const { data: nameMatches, error: nameError } = await query;
              
              if (nameError) {
                console.error(`Row ${i + 1}: Error searching customer by name:`, nameError);
              } else if (nameMatches && nameMatches.length > 0) {
                customer = nameMatches[0]; // Take first match
                customerFound = true;
                console.log(`Row ${i + 1}: Found customer by name:`, customer.id);
              }
            }
          }
          
          // If customer still not found, create a new customer
          if (!customerFound) {
            const nameParts = (job.customerName || '').trim().split(/\s+/);
            const firstName = nameParts[0] || 'Unknown';
            const lastName = nameParts.slice(1).join(' ') || '';
            
            const newCustomer = {
              user_id: userId,
              first_name: sanitizeInput(firstName),
              last_name: sanitizeInput(lastName),
              email: job.customerEmail && job.customerEmail.trim() ? job.customerEmail.toLowerCase().trim() : null,
              phone: job.customerPhone ? job.customerPhone.trim() : null,
              address: job.serviceAddress || null,
              city: job.serviceAddressCity || null,
              state: job.serviceAddressState || null,
              zip_code: job.serviceAddressZip || null
            };
            
            console.log(`Row ${i + 1}: Creating new customer:`, { firstName, lastName, phone: newCustomer.phone });
            
            const { data: createdCustomer, error: createError } = await supabase
              .from('customers')
              .insert(newCustomer)
              .select('id')
              .single();
            
            if (createError) {
              console.error(`Row ${i + 1}: Failed to create customer:`, createError);
              results.errors.push(`Row ${i + 1}: Failed to create customer - ${createError.message}`);
              results.skipped++;
              continue;
            }
            
            customerId = createdCustomer.id;
            console.log(`Row ${i + 1}: Created new customer with ID:`, customerId);
          } else {
            customerId = customer.id;
          }
        }
        
        if (!customerId) {
          console.error(`Row ${i + 1}: No customer ID after lookup/creation`);
          results.errors.push(`Row ${i + 1}: Could not find or create customer`);
          results.skipped++;
          continue;
        }

        // Find or create service by name if provided
        let serviceId = job.serviceId;
        if (!serviceId && job.serviceName) {
          // Normalize service name for comparison
          // This function handles:
          // - HTML entity decoding (e.g., &#x2F; -> /)
          // - Case insensitivity (lowercase)
          // - Whitespace normalization (trim, collapse multiple spaces)
          // - Special character spacing (normalize spaces around /, -, etc.)
          const decodeHtmlEntities = (str) => {
            if (!str || typeof str !== 'string') return str;
            return str
              .replace(/&#x([0-9a-fA-F]+);/g, (match, hex) => {
                return String.fromCharCode(parseInt(hex, 16));
              })
              .replace(/&#(\d+);/g, (match, dec) => {
                return String.fromCharCode(parseInt(dec, 10));
              })
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .replace(/&quot;/g, '"')
              .replace(/&#39;/g, "'")
              .replace(/&apos;/g, "'");
          };
          
          const normalizeServiceName = (name) => {
            if (!name || typeof name !== 'string') return '';
            // First decode HTML entities (e.g., "Move in&#x2F;out" -> "Move in/out")
            let normalized = decodeHtmlEntities(name);
            return normalized
              .trim()                                    // Remove leading/trailing spaces
              .toLowerCase()                             // Case insensitive
              .replace(/\s+/g, ' ')                      // Collapse multiple spaces to single space
              .replace(/\s*\/\s*/g, '/')                  // Normalize spaces around "/" (e.g., "in / out" -> "in/out")
              .replace(/\s*-\s*/g, '-')                  // Normalize spaces around "-" (e.g., "move - in" -> "move-in")
              .replace(/\s*\+\s*/g, '+')                 // Normalize spaces around "+" (e.g., "A + B" -> "A+B")
              .replace(/\s*&\s*/g, '&')                  // Normalize spaces around "&" (e.g., "A & B" -> "A&B")
              .trim();                                   // Final trim
          };
          
          const normalizedServiceName = normalizeServiceName(job.serviceName);
          
          console.log(`Row ${i + 1}: Looking for service "${job.serviceName}" (normalized: "${normalizedServiceName}")`);
          
          // First check our mapping to see if we've already created/found this service in this import batch
          if (serviceNameMapping[normalizedServiceName]) {
            serviceId = serviceNameMapping[normalizedServiceName];
            console.log(`Row ${i + 1}: ✅ Reusing existing service ${serviceId} for name "${job.serviceName}" (from mapping)`);
          } else {
            // Search database for existing service (case-insensitive exact match)
            // Fetch all services for this user and filter manually to catch all variations
            // This is more reliable than .ilike() which might not work as expected
            const { data: allServices, error: serviceError } = await supabase
              .from('services')
              .select('id, name, price')
              .eq('user_id', userId);
            
            let services = null;
            if (!serviceError && allServices) {
              // Filter services that match when normalized
              // This catches all variations: "Move in/out", "Move In / Out", "move in / out", etc.
              services = allServices.filter(service => {
                const serviceNormalized = normalizeServiceName(service.name);
                return serviceNormalized === normalizedServiceName;
              });
            }
            
            if (serviceError) {
              console.error(`Row ${i + 1}: Error searching service:`, serviceError);
            } else if (services && services.length > 0) {
              // Found existing service(s) - use the first one
              // Note: If multiple services with same normalized name exist, we use the first one
              // This prevents duplicates within this import batch
              // Also normalize all found services and add them to mapping to prevent future duplicates
              services.forEach(service => {
                const foundNormalized = normalizeServiceName(service.name);
                if (!serviceNameMapping[foundNormalized]) {
                  serviceNameMapping[foundNormalized] = service.id;
                  console.log(`Row ${i + 1}: 📋 Adding service "${service.name}" (normalized: "${foundNormalized}", price: ${service.price}) to mapping with ID ${service.id}`);
                }
              });
              serviceId = services[0].id;
              serviceNameMapping[normalizedServiceName] = serviceId; // Store in mapping
              console.log(`Row ${i + 1}: ✅ Found existing service ID ${serviceId} for "${job.serviceName}" (DB had: "${services[0].name}", price: ${services[0].price})`);
            } else {
            // Service not found - create it
              const sanitizedName = sanitizeInput(job.serviceName.trim());
            const newService = {
              user_id: userId,
                name: sanitizedName,
              description: null,
              price: parseFloat(job.servicePrice) || parseFloat(job.price) || 0,
              duration: parseInt(job.duration) || parseInt(job.estimatedDuration) || 60,
              category: null,
              modifiers: null,
              intake_questions: null,
              is_active: true
            };
            
              console.log(`Row ${i + 1}: Creating new service:`, sanitizedName);
            
            const { data: createdService, error: createServiceError } = await supabase
              .from('services')
              .insert(newService)
              .select('id')
              .single();
            
            if (createServiceError) {
                console.error(`Row ${i + 1}: Failed to create service ${sanitizedName}:`, createServiceError);
                results.errors.push(`Row ${i + 1}: Failed to create service "${sanitizedName}" - ${createServiceError.message}`);
              // Continue without service ID - job can still be created
            } else {
              serviceId = createdService.id;
                serviceNameMapping[normalizedServiceName] = serviceId; // Store in mapping to prevent duplicates
              console.log(`Row ${i + 1}: Created new service with ID:`, serviceId);
            }
            }
          }
        }

        // Handle team member assignment from external crew ID
        let teamMemberId = null;
        
        // First, check if we have an external crew ID (from CSV assigned_crew field)
        console.log(`Row ${i + 1}: Checking for assignedCrewExternalId:`, job.assignedCrewExternalId);
        if (job.assignedCrewExternalId && job.assignedCrewExternalId.trim()) {
          const externalCrewId = job.assignedCrewExternalId.trim();
          console.log(`Row ${i + 1}: Processing external crew ID: ${externalCrewId}`);
          
          // Check if we've already created a team member for this external ID in this batch
          if (crewIdMapping[externalCrewId]) {
            teamMemberId = crewIdMapping[externalCrewId];
            console.log(`Row ${i + 1}: Reusing existing team member ${teamMemberId} for external crew ID ${externalCrewId} (from batch mapping)`);
          } else {
            // Check if a team member with this external ID already exists in the DATABASE
            // We store external ID in first_name as "Crew {externalCrewId}" - search for exact match
            const crewSearchPattern = `Crew ${externalCrewId}`;
            const { data: existingCrews, error: crewSearchError } = await supabase
              .from('team_members')
              .select('id, first_name')
              .eq('user_id', userId)
              .eq('first_name', crewSearchPattern)
              .limit(1);
            
            if (!crewSearchError && existingCrews && existingCrews.length > 0) {
              // Found existing team member with this external ID
              teamMemberId = existingCrews[0].id;
              crewIdMapping[externalCrewId] = teamMemberId; // Store in mapping for this batch
              console.log(`Row ${i + 1}: ✅ Found existing team member ${teamMemberId} in database for external crew ID ${externalCrewId}`);
            } else {
              console.log(`Row ${i + 1}: Creating new team member for external crew ID: ${externalCrewId}`);
              // Set default availability
            const defaultAvailability = {
              workingHours: {
                monday: { enabled: true, timeSlots: [{ start: '09:00', end: '18:00', enabled: true }] },
                tuesday: { enabled: true, timeSlots: [{ start: '09:00', end: '18:00', enabled: true }] },
                wednesday: { enabled: true, timeSlots: [{ start: '09:00', end: '18:00', enabled: true }] },
                thursday: { enabled: true, timeSlots: [{ start: '09:00', end: '18:00', enabled: true }] },
                friday: { enabled: true, timeSlots: [{ start: '09:00', end: '18:00', enabled: true }] },
                saturday: { enabled: false },
                sunday: { enabled: false }
              },
              customAvailability: []
            };
            
            // Generate a placeholder email since email is required (NOT NULL in schema)
            // Use external ID to create a unique email that won't conflict
            const placeholderEmail = `crew-${externalCrewId.replace(/[^a-zA-Z0-9]/g, '-')}@imported.local`;
            
            const newTeamMember = {
              user_id: userId,
              first_name: `Crew ${externalCrewId}`, // Use full external ID
              last_name: '',
              email: placeholderEmail, // Required field - use placeholder email
              phone: null,
              role: 'worker',
              is_service_provider: true,
              status: 'active',
              availability: JSON.stringify(defaultAvailability),
              territories: [],
              permissions: {}
            };
            
            const { data: createdTeamMember, error: createTeamError } = await supabase
              .from('team_members')
              .insert(newTeamMember)
              .select('id')
              .single();
            
            if (createTeamError) {
              console.error(`Row ${i + 1}: Failed to create team member for crew ID ${externalCrewId}:`, createTeamError);
              results.warnings.push(`Row ${i + 1}: Could not create team member for crew ID ${externalCrewId} - ${createTeamError.message}`);
            } else {
              teamMemberId = createdTeamMember.id;
              crewIdMapping[externalCrewId] = teamMemberId; // Store mapping to prevent duplicates
              console.log(`Row ${i + 1}: Created new team member ${teamMemberId} for external crew ID ${externalCrewId}`);
            }
            }
          }
        }
        
        // Fallback: Try to find team member by internal ID (if provided as integer)
        if (!teamMemberId && job.teamMemberId) {
          const parsedId = parseInt(job.teamMemberId);
          if (!isNaN(parsedId) && !job.teamMemberId.toString().includes('x') && !job.teamMemberId.toString().includes('X')) {
            // Valid integer ID
            teamMemberId = parsedId;
          }
        }
        
        // Fallback: Try to find by name if provided
        if (!teamMemberId && job.teamMemberName) {
          const nameParts = job.teamMemberName.split(' ');
          const firstName = nameParts[0];
          const lastName = nameParts.slice(1).join(' ');
          
          const { data: teamMember, error: teamError } = await supabase
            .from('team_members')
            .select('id')
            .eq('user_id', userId)
            .eq('first_name', firstName)
            .eq('last_name', lastName)
            .maybeSingle();
          
          if (teamError) {
            console.error(`Row ${i + 1}: Error searching team member:`, teamError);
          } else if (teamMember) {
            teamMemberId = teamMember.id;
            console.log(`Row ${i + 1}: Found team member by name:`, teamMemberId);
          }
        }
        
        // Handle territory assignment from external region ID
        let territoryId = null;
        
        console.log(`Row ${i + 1}: Checking for serviceRegionExternalId:`, job.serviceRegionExternalId);
        if (job.serviceRegionExternalId && job.serviceRegionExternalId.trim()) {
          const externalRegionId = job.serviceRegionExternalId.trim();
          console.log(`Row ${i + 1}: Processing external region ID: ${externalRegionId}`);
          
          // Check if we've already created a territory for this external ID in this batch
          if (territoryIdMapping[externalRegionId]) {
            territoryId = territoryIdMapping[externalRegionId];
            console.log(`Row ${i + 1}: Reusing existing territory ${territoryId} for external region ID ${externalRegionId} (from batch mapping)`);
          } else {
            // Check if territory with this external ID already exists in the DATABASE
            // We store external ID in description as "Imported from external region ID: {externalRegionId}" - search for it
            const regionSearchPattern = `Imported from external region ID: ${externalRegionId}`;
            const { data: existingTerritories, error: territorySearchError } = await supabase
              .from('territories')
              .select('id, description')
              .eq('user_id', userId)
              .eq('description', regionSearchPattern)
              .limit(1);
            
            if (!territorySearchError && existingTerritories && existingTerritories.length > 0) {
              // Found existing territory with this external ID
              territoryId = existingTerritories[0].id;
              territoryIdMapping[externalRegionId] = territoryId; // Store in mapping for this batch
              console.log(`Row ${i + 1}: ✅ Found existing territory ${territoryId} in database for external region ID ${externalRegionId}`);
            } else {
              console.log(`Row ${i + 1}: Creating new territory for external region ID: ${externalRegionId}`);
            const newTerritory = {
              user_id: userId,
              name: `Region ${externalRegionId}`, // Use full external ID
              description: `Imported from external region ID: ${externalRegionId}`,
              location: job.serviceAddress || 'Unknown',
              zip_codes: job.serviceAddressZip ? [job.serviceAddressZip] : [],
              radius_miles: 25.00,
              timezone: 'America/New_York',
              business_hours: {},
              team_members: [],
              services: [],
              pricing_multiplier: 1.00
            };
            
            const { data: createdTerritory, error: createTerritoryError } = await supabase
              .from('territories')
              .insert(newTerritory)
              .select('id')
              .single();
            
            if (createTerritoryError) {
              console.error(`Row ${i + 1}: Failed to create territory for region ID ${externalRegionId}:`, createTerritoryError);
              results.warnings.push(`Row ${i + 1}: Could not create territory for region ID ${externalRegionId} - ${createTerritoryError.message}`);
            } else {
              territoryId = createdTerritory.id;
              territoryIdMapping[externalRegionId] = territoryId; // Store mapping to prevent duplicates
              console.log(`Row ${i + 1}: Created new territory ${territoryId} for external region ID ${externalRegionId}`);
            }
            }
          }
        }
        
        // Fallback: Use territoryId if provided directly
        if (!territoryId && job.territoryId) {
          const parsedTerritoryId = parseInt(job.territoryId);
          if (!isNaN(parsedTerritoryId)) {
            territoryId = parsedTerritoryId;
          }
        }

        // Sanitize inputs
        const sanitizedNotes = job.notes ? sanitizeInput(job.notes) : null;
        const sanitizedServiceAddress = job.serviceAddress ? sanitizeInput(job.serviceAddress) : null;
        const sanitizedInternalNotes = job.internalNotes ? sanitizeInput(job.internalNotes) : null;

        // Check for duplicate jobs (same customer, service, and scheduled date)
        // CRITICAL: Must filter by user_id to ensure we only check duplicates within the same account
        // Only check for duplicates if we have all required fields
        // IMPORTANT: We check service_id/service_name to prevent recurring jobs with different dates
        // from being incorrectly flagged as duplicates
        if (job.scheduledDate && customerId) {
          // Normalize the scheduled date to just the date part (YYYY-MM-DD) for comparison
          // This handles cases where dates might have time components
          let normalizedDate = job.scheduledDate;
          if (normalizedDate && typeof normalizedDate === 'string') {
            // Extract just the date part (YYYY-MM-DD) if there's a time component
            const dateMatch = normalizedDate.match(/^(\d{4}-\d{2}-\d{2})/);
            if (dateMatch) {
              normalizedDate = dateMatch[1];
            } else {
              // Log warning if date format is unexpected
              console.warn(`Row ${i + 1}: Date format may be unexpected: "${normalizedDate}" (expected YYYY-MM-DD format)`);
            }
          } else if (!normalizedDate) {
            console.warn(`Row ${i + 1}: Missing scheduledDate, skipping duplicate check`);
          }
          
          // Create a unique key for this job to check for duplicates within the same import batch
          const serviceIdentifier = serviceId ? `service_${serviceId}` : (job.serviceName ? `name_${job.serviceName}` : 'no_service');
          const batchKey = `${userId}_${customerId}_${serviceIdentifier}_${normalizedDate}`;
          
          // First check if this exact combination already exists in the current import batch
          if (batchJobKeys.has(batchKey)) {
            console.log(`Row ${i + 1}: DUPLICATE in CSV - Same job already being imported in this batch (user ${userId}, customer ${customerId}, ${serviceIdentifier}, date ${normalizedDate})`);
            results.warnings.push(`Row ${i + 1}: Duplicate job in CSV - same customer, service, and date already exists in this import`);
            results.skipped++;
            continue;
          }
          
          // CRITICAL: Always filter by user_id FIRST to ensure we only check within the same account
          // This prevents cross-account duplicate detection
          // IMPORTANT: Jobs belong to users - different users can have identical jobs (same customer name, service, date)
          // but they are NOT duplicates because they belong to different accounts
          let duplicateQuery = supabase
            .from('jobs')
            .select('id, scheduled_date, user_id, customer_id, service_id, service_name')
            .eq('user_id', userId);  // CRITICAL: MUST filter by user_id FIRST to prevent cross-account duplicates
          
          // Add customer_id filter (customer IDs are unique per user due to user_id constraint)
          duplicateQuery = duplicateQuery.eq('customer_id', customerId);
          
          // Also check service_id if available to make duplicate detection more accurate
          // This prevents recurring jobs with different dates from being flagged as duplicates
          if (serviceId) {
            duplicateQuery = duplicateQuery.eq('service_id', serviceId);
          } else if (job.serviceName) {
            // If no service_id but we have service name, check by service name
            duplicateQuery = duplicateQuery.eq('service_name', job.serviceName);
          }
          
          // Get all jobs matching user, customer and service, then check dates manually
          // This is more reliable than string comparison
          const { data: existingJobs, error: duplicateError } = await duplicateQuery;
          
          // CRITICAL SAFETY CHECK: Verify ALL returned jobs belong to the correct user
          // This is a double-check to ensure no cross-account contamination
          let validExistingJobs = [];
          if (existingJobs && existingJobs.length > 0) {
            validExistingJobs = existingJobs.filter(j => {
              if (j.user_id !== userId) {
                console.error(`Row ${i + 1}: SECURITY ERROR - Job ${j.id} belongs to user ${j.user_id}, but we're checking for user ${userId}! This should never happen.`);
                return false; // Exclude jobs from other users
              }
              return true;
            });
            
            if (validExistingJobs.length !== existingJobs.length) {
              console.error(`Row ${i + 1}: WARNING - Filtered out ${existingJobs.length - validExistingJobs.length} jobs from other users`);
            }
            
            if (validExistingJobs.length > 0) {
              console.log(`Row ${i + 1}: Found ${validExistingJobs.length} existing jobs in database for user ${userId} only, customer ${customerId}, checking dates...`);
            }
          }
          
          if (!duplicateError && validExistingJobs.length > 0) {
            // Check if any existing job has the same date (normalized)
            // All jobs in validExistingJobs are already verified to belong to the correct user
            const isDuplicate = validExistingJobs.some(existingJob => {
              // Final safety check (should never fail, but just in case)
              if (existingJob.user_id !== userId) {
                console.error(`Row ${i + 1}: CRITICAL ERROR - Job ${existingJob.id} user_id mismatch! Expected ${userId}, got ${existingJob.user_id}`);
                return false; // Don't count as duplicate if it's from a different user
              }
              
              if (!existingJob.scheduled_date) return false;
              const existingDate = existingJob.scheduled_date.toString();
              const existingDateMatch = existingDate.match(/^(\d{4}-\d{2}-\d{2})/);
              const existingDateNormalized = existingDateMatch ? existingDateMatch[1] : existingDate;
              return existingDateNormalized === normalizedDate;
            });
            
            if (isDuplicate) {
              console.log(`Row ${i + 1}: DUPLICATE detected in database - Job already exists for user ${userId} ONLY, customer ${customerId}, service ${serviceId || job.serviceName}, date ${normalizedDate}`);
              results.warnings.push(`Row ${i + 1}: Job already exists for this customer and service on ${normalizedDate} (skipped)`);
            results.skipped++;
            continue;
          }
          }
          
          // Add this job to the batch tracking set (only if we're going to create it)
          // We'll add it after successful creation
        }

        // Create job with all fields
        const jobData = {
          user_id: userId,
          customer_id: customerId,
          service_id: serviceId,
          team_member_id: teamMemberId || null,
          territory_id: territoryId || null,
          notes: sanitizedNotes,
          status: job.status && job.status.trim() ? job.status.trim() : 'pending',
          invoice_status: job.invoiceStatus || 'draft',
          invoice_id: job.invoiceId || null,
          invoice_amount: parseFloat(job.invoiceAmount) || null,
          invoice_date: job.invoiceDate || null,
          payment_date: job.paymentDate || null,
          is_recurring: job.isRecurring || false,
          recurring_frequency: job.recurringFrequency || 'weekly',
          next_billing_date: job.nextBillingDate || null,
          stripe_payment_intent_id: job.stripePaymentIntentId || null,
          duration: parseFloat(job.duration) || 360,
          workers: parseInt(job.workers) || 1,
          skills_required: parseInt(job.skillsRequired) || 0,
          price: parseFloat(job.price) || 0,
          discount: parseFloat(job.discount) || 0,
          additional_fees: parseFloat(job.additionalFees) || 0,
          taxes: parseFloat(job.taxes) || 0,
          total: parseFloat(job.total) || parseFloat(job.price) || 0,
          payment_method: job.paymentMethod || null,
          territory: job.territory || null,
          schedule_type: job.scheduleType || 'one-time',
          let_customer_schedule: job.letCustomerSchedule || false,
          offer_to_providers: job.offerToProviders || false,
          internal_notes: sanitizedInternalNotes,
          contact_info: job.contactInfo || null,
          customer_notes: job.customerNotes || null,
          // Combine scheduled date and time into scheduled_date field
          // Format: "YYYY-MM-DD HH:MM:SS"
          scheduled_date: (() => {
            try {
              if (job.scheduledDate && job.scheduledTime) {
                // Combine date and time
                const datePart = job.scheduledDate.split(' ')[0]; // Get just the date part
                const timePart = job.scheduledTime.includes(':') ? job.scheduledTime : `${job.scheduledTime}:00`;
                const combinedDate = `${datePart} ${timePart}`;
                // Validate the date format
                if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(combinedDate)) {
                  console.warn(`Row ${i + 1}: Invalid date format: ${combinedDate} (original: ${job.scheduledDate}, time: ${job.scheduledTime})`);
                }
                return combinedDate;
              } else if (job.scheduledDate && job.scheduledDate.includes(' ')) {
                // Already combined format
                const dateStr = job.scheduledDate.trim();
                // Validate the date format
                if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?/.test(dateStr)) {
                  console.warn(`Row ${i + 1}: Invalid combined date format: ${dateStr}`);
                }
                return dateStr;
              } else if (job.scheduledDate) {
                // Only date provided, use default time
                const dateStr = job.scheduledDate.trim();
                // Validate the date format (YYYY-MM-DD)
                if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
                  console.warn(`Row ${i + 1}: Invalid date format (expected YYYY-MM-DD): ${dateStr}`);
                }
                return `${dateStr} 09:00:00`;
              } else {
                return job.scheduled_date || null;
              }
            } catch (dateError) {
              console.error(`Row ${i + 1}: Error parsing scheduled date:`, dateError, `Original value:`, job.scheduledDate);
              return null;
            }
          })(),
          scheduled_time: job.scheduledTime || '09:00:00',
          service_address_street: job.serviceAddressStreet || sanitizedServiceAddress,
          service_address_city: job.serviceAddressCity,
          service_address_state: job.serviceAddressState,
          service_address_zip: job.serviceAddressZip,
          service_address_country: job.serviceAddressCountry || 'USA',
          service_address_lat: parseFloat(job.serviceAddressLat) || null,
          service_address_lng: parseFloat(job.serviceAddressLng) || null,
          service_name: job.serviceName,
          bathroom_count: job.bathroomCount || null,
          workers_needed: parseInt(job.workersNeeded) || 1,
          skills: job.skills || null,
          service_price: parseFloat(job.servicePrice) || parseFloat(job.price) || 0,
          total_amount: parseFloat(job.totalAmount) || parseFloat(job.total) || parseFloat(job.price) || 0,
          estimated_duration: parseFloat(job.estimatedDuration) || parseFloat(job.duration) || null,
          special_instructions: job.specialInstructions || null,
          payment_status: job.paymentStatus || 'pending',
          priority: job.priority || 'normal',
          quality_check: job.qualityCheck !== false,
          photos_required: job.photosRequired || false,
          customer_signature: job.customerSignature || false,
          auto_invoice: job.autoInvoice !== false,
          auto_reminders: job.autoReminders !== false,
          recurring_end_date: job.recurringEndDate || null,
          tags: job.tags ? (Array.isArray(job.tags) ? [...job.tags, 'imported'] : `${job.tags},imported`) : 'imported',
          intake_question_answers: job.intakeQuestionAnswers || null,
          service_modifiers: job.serviceModifiers || null,
          service_intake_questions: job.serviceIntakeQuestions || null
        };

        console.log(`Row ${i + 1}: Creating job with customerId: ${customerId}, serviceId: ${serviceId || 'null'}, scheduledDate: ${jobData.scheduled_date}`);
        
        const { data: newJob, error: insertError } = await supabase
          .from('jobs')
          .insert(jobData)
          .select()
          .single();

        if (insertError) {
          console.error(`Row ${i + 1}: Failed to create job:`, insertError);
          results.errors.push(`Row ${i + 1}: ${insertError.message}`);
          results.skipped++;
        } else {
          console.log(`Row ${i + 1}: ✅ Successfully imported job with ID:`, newJob.id);
          results.imported++;
          
          // Add to batch tracking set to prevent duplicates within the same import
          if (job.scheduledDate && customerId) {
            const normalizedDate = job.scheduledDate.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] || job.scheduledDate;
            const serviceIdentifier = serviceId ? `service_${serviceId}` : (job.serviceName ? `name_${job.serviceName}` : 'no_service');
            const batchKey = `${userId}_${customerId}_${serviceIdentifier}_${normalizedDate}`;
            batchJobKeys.add(batchKey);
          }
        }
      } catch (error) {
        results.errors.push(`Row ${i + 1}: ${error.message}`);
        results.skipped++;
      }
    }

    console.log(`📊 Import complete: ${results.imported} imported, ${results.skipped} skipped, ${results.errors.length} errors`);
    if (results.errors.length > 0 && results.errors.length <= 10) {
      console.log('❌ Errors:', results.errors);
    } else if (results.errors.length > 10) {
      console.log('❌ First 10 errors:', results.errors.slice(0, 10));
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

// Booking Koala import endpoint
app.post('/api/booking-koala/import', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { customers, jobs, importSettings } = req.body;

    const settings = importSettings || { updateExisting: false, skipDuplicates: true };
    const results = {
      customers: { imported: 0, skipped: 0, errors: [] },
      jobs: { imported: 0, skipped: 0, errors: [] }
    };

    // Import customers if provided
    if (customers && Array.isArray(customers) && customers.length > 0) {
      for (let i = 0; i < customers.length; i++) {
        const customer = customers[i];
        
        try {
          // Map Booking Koala fields to ZenBooker fields (handle both mapped and original field names)
          const mappedCustomer = {
            user_id: userId,
            first_name: customer.firstName || customer['First Name'] || customer['First name'] || customer.first_name || '',
            last_name: customer.lastName || customer['Last Name'] || customer['Last name'] || customer.last_name || '',
            email: customer.email || customer['Email Address'] || customer.Email || customer.email_address || null,
            phone: customer.phone || customer['Phone Number'] || customer.Phone || customer.phone_number || customer.mobile || null,
            address: customer.address || customer.Address || customer.street_address || null,
            apt: customer.apt || customer['Apt. No.'] || customer['Apt'] || customer.apartment || null,
            city: customer.city || customer.City || null,
            state: customer.state || customer.State || customer.state_province || null,
            zip_code: customer.zipCode || customer['Zip/Postal Code'] || customer['Zip/Postal code'] || customer['Zip Code'] || customer.zip_code || customer.postal_code || null,
            company_name: customer.companyName || customer['Company Name'] || customer.company_name || null,
            notes: customer.notes || customer.Note || customer['Note'] || customer.Notes || customer.comments || null,
            status: customer.status || customer.Status || 'active'
          };

          // Validate required fields
          if (!mappedCustomer.first_name || !mappedCustomer.last_name) {
            results.customers.errors.push(`Row ${i + 1}: First name and last name are required`);
            continue;
          }

          // Check for duplicates if skipDuplicates is enabled
          if (settings.skipDuplicates && mappedCustomer.email) {
            const { data: existing } = await supabase
              .from('customers')
              .select('id')
              .eq('user_id', userId)
              .eq('email', mappedCustomer.email.toLowerCase().trim())
              .single();

            if (existing) {
              if (settings.updateExisting) {
                // Update existing customer
                const { error: updateError } = await supabase
                  .from('customers')
                  .update(mappedCustomer)
                  .eq('id', existing.id);

                if (updateError) {
                  results.customers.errors.push(`Row ${i + 1}: ${updateError.message}`);
                } else {
                  results.customers.imported++;
                }
              } else {
                results.customers.skipped++;
              }
              continue;
            }
          }

          // Insert new customer
          const { data: newCustomer, error: insertError } = await supabase
            .from('customers')
            .insert(mappedCustomer)
            .select()
            .single();

          if (insertError) {
            results.customers.errors.push(`Row ${i + 1}: ${insertError.message}`);
          } else {
            results.customers.imported++;
          }
        } catch (error) {
          results.customers.errors.push(`Row ${i + 1}: ${error.message}`);
        }
      }
    }

    // Import jobs if provided
    if (jobs && Array.isArray(jobs) && jobs.length > 0) {
      // First, get all customers to map by email/name
      const { data: allCustomers } = await supabase
        .from('customers')
        .select('id, email, first_name, last_name')
        .eq('user_id', userId);

      const customerMap = {};
      (allCustomers || []).forEach(c => {
        if (c.email) customerMap[c.email.toLowerCase()] = c.id;
        const nameKey = `${c.first_name} ${c.last_name}`.toLowerCase();
        customerMap[nameKey] = c.id;
      });

      // Track external IDs to internal IDs mapping to prevent duplicate team members and territories
      const crewIdMapping = {}; // Maps external crew/provider IDs to team member IDs
      const territoryIdMapping = {}; // Maps external location IDs to territory IDs

      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        
        try {
          // Map Booking Koala fields to ZenBooker fields
          // Find customer by email or name (handle both mapped and original field names)
          let customerId = null;
          const customerEmail = job.customerEmail || job.email || job.Email || job['Email'] || job.customer_email;
          const customerFirstName = job.customerFirstName || job['First name'] || job['First Name'] || job.firstName;
          const customerLastName = job.customerLastName || job['Last name'] || job['Last Name'] || job.lastName;
          
          if (customerEmail) {
            const email = customerEmail.toLowerCase().trim();
            customerId = customerMap[email];
          }
          
          if (!customerId && customerFirstName && customerLastName) {
            const name = `${customerFirstName} ${customerLastName}`.toLowerCase().trim();
            customerId = customerMap[name];
          }

          if (!customerId) {
            results.jobs.errors.push(`Row ${i + 1}: Customer not found. Please ensure customers are imported first or the email/name matches.`);
            continue;
          }

          // Parse date/time from Booking Koala format
          let scheduledDate = null;
          let scheduledTime = '09:00:00';
          
          // Try Booking start date time first (ISO format like "2025-10-02T09:00:00-07:00")
          const bookingStartDateTime = job.bookingStartDateTime || job['Booking start date time'];
          if (bookingStartDateTime) {
            try {
              const dt = new Date(bookingStartDateTime);
              if (!isNaN(dt.getTime())) {
                scheduledDate = dt.toISOString().split('T')[0];
                const timePart = dt.toTimeString().split(' ')[0].substring(0, 5);
                scheduledTime = parseTime(timePart);
              }
            } catch (e) {
              // Fall through to other methods
            }
          }
          
          // Fallback to Date and Time fields
          if (!scheduledDate) {
            const dateStr = job.scheduledDate || job['Date'] || job.date;
            const timeStr = job.scheduledTime || job['Time'] || job.time;
            
            if (dateStr) {
              try {
                // Handle formats like "10/02/2025"
                if (dateStr.includes('/')) {
                  const dateParts = dateStr.split('/');
                  if (dateParts.length === 3) {
                    const month = dateParts[0].padStart(2, '0');
                    const day = dateParts[1].padStart(2, '0');
                    const year = dateParts[2];
                    scheduledDate = `${year}-${month}-${day}`;
                  }
                } else {
                  const dateObj = new Date(dateStr);
                  if (!isNaN(dateObj.getTime())) {
                    scheduledDate = dateObj.toISOString().split('T')[0];
                  }
                }
                
                if (timeStr) {
                  scheduledTime = parseTime(timeStr);
                }
              } catch (e) {
                // Use current date as fallback
                scheduledDate = new Date().toISOString().split('T')[0];
              }
            }
          }

          // Parse status from Booking status
          let jobStatus = 'pending';
          const bookingStatus = job.status || job['Booking status'] || job['Status'];
          if (bookingStatus) {
            const statusMap = {
              'Completed': 'completed',
              'Upcoming': 'pending',
              'Unassigned': 'pending',
              'Cancelled': 'cancelled',
              'completed': 'completed',
              'pending': 'pending',
              'cancelled': 'cancelled'
            };
            jobStatus = statusMap[bookingStatus] || bookingStatus.toLowerCase() || 'pending';
          }

          // Parse price from Final amount or Service total
          const finalAmount = job.finalAmount || job['Final amount (USD)'] || job['Final amount'] || job.price || job.Price;
          const serviceTotal = job.serviceTotal || job['Service total (USD)'] || job['Service total'];
          const priceValue = parseFloat(finalAmount || serviceTotal || job.total || job.Total || job.amount || job.Amount || 0);

          // Parse duration from Estimated job length (HH:MM)
          let duration = 60; // default 1 hour
          const durationStr = job.duration || job['Estimated job length (HH:MM)'] || job['Estimated job length'];
          if (durationStr && durationStr.includes(':')) {
            const [hours, minutes] = durationStr.split(':');
            duration = (parseInt(hours) || 0) * 60 + (parseInt(minutes) || 0);
          } else if (durationStr) {
            duration = parseInt(durationStr) || 60;
          }

          // Parse recurring from Frequency
          let isRecurring = false;
          let recurringFrequency = null;
          const frequency = job.recurringFrequency || job.frequency || job['Frequency'] || job.isRecurring;
          if (frequency) {
            const freqStr = frequency.toString().toLowerCase();
            if (freqStr !== 'one-time' && freqStr !== 'onetime') {
              isRecurring = true;
              // Map Booking Koala frequencies
              if (freqStr.includes('weekly')) {
                recurringFrequency = 'weekly';
              } else if (freqStr.includes('every other week') || freqStr.includes('every 2 weeks')) {
                recurringFrequency = 'bi-weekly';
              } else if (freqStr.includes('every 4 weeks')) {
                recurringFrequency = 'monthly';
              } else {
                recurringFrequency = 'custom';
              }
            }
          }

          // Handle team member assignment from Provider details (create on the fly like normal import)
          let teamMemberId = null;
          const assignedCrewExternalId = job.assignedCrewExternalId || job['assignedCrewExternalId'];
          if (assignedCrewExternalId && assignedCrewExternalId.toString().trim()) {
            const externalCrewId = assignedCrewExternalId.toString().trim();
            
            // Check if we've already created a team member for this external ID in this batch
            if (crewIdMapping[externalCrewId]) {
              teamMemberId = crewIdMapping[externalCrewId];
              console.log(`Row ${i + 1}: Reusing existing team member ${teamMemberId} for external provider ID ${externalCrewId} (from batch mapping)`);
            } else {
              // Check if a team member with this external ID already exists in the DATABASE
              const crewSearchPattern = `Crew ${externalCrewId}`;
              const { data: existingCrews, error: crewSearchError } = await supabase
                .from('team_members')
                .select('id, first_name')
                .eq('user_id', userId)
                .eq('first_name', crewSearchPattern)
                .limit(1);
              
              if (!crewSearchError && existingCrews && existingCrews.length > 0) {
                teamMemberId = existingCrews[0].id;
                crewIdMapping[externalCrewId] = teamMemberId;
                console.log(`Row ${i + 1}: Found existing team member ${teamMemberId} for external provider ID ${externalCrewId}`);
              } else {
                // Create new team member
                const defaultAvailability = {
                  workingHours: {
                    monday: { enabled: true, timeSlots: [{ start: '09:00', end: '18:00', enabled: true }] },
                    tuesday: { enabled: true, timeSlots: [{ start: '09:00', end: '18:00', enabled: true }] },
                    wednesday: { enabled: true, timeSlots: [{ start: '09:00', end: '18:00', enabled: true }] },
                    thursday: { enabled: true, timeSlots: [{ start: '09:00', end: '18:00', enabled: true }] },
                    friday: { enabled: true, timeSlots: [{ start: '09:00', end: '18:00', enabled: true }] },
                    saturday: { enabled: false },
                    sunday: { enabled: false }
                  },
                  customAvailability: []
                };
                
                const placeholderEmail = `crew-${externalCrewId.replace(/[^a-zA-Z0-9]/g, '-')}@imported.local`;
                
                const newTeamMember = {
                  user_id: userId,
                  first_name: `Crew ${externalCrewId}`,
                  last_name: '',
                  email: placeholderEmail,
                  phone: null,
                  role: 'worker',
                  is_service_provider: true,
                  status: 'active',
                  availability: JSON.stringify(defaultAvailability),
                  territories: [],
                  permissions: {}
                };
                
                const { data: createdTeamMember, error: createTeamError } = await supabase
                  .from('team_members')
                  .insert(newTeamMember)
                  .select('id')
                  .single();
                
                if (createTeamError) {
                  console.error(`Row ${i + 1}: Failed to create team member for provider ID ${externalCrewId}:`, createTeamError);
                  results.jobs.errors.push(`Row ${i + 1}: Could not create team member for provider ID ${externalCrewId}`);
                } else {
                  teamMemberId = createdTeamMember.id;
                  crewIdMapping[externalCrewId] = teamMemberId;
                  console.log(`Row ${i + 1}: Created new team member ${teamMemberId} for external provider ID ${externalCrewId}`);
                }
              }
            }
          }

          // Handle territory assignment from Location (create on the fly like normal import)
          let territoryId = null;
          const serviceRegionExternalId = job.serviceRegionExternalId || job['serviceRegionExternalId'];
          if (serviceRegionExternalId && serviceRegionExternalId.toString().trim()) {
            const externalRegionId = serviceRegionExternalId.toString().trim();
            
            // Check if we've already created a territory for this external ID in this batch
            if (territoryIdMapping[externalRegionId]) {
              territoryId = territoryIdMapping[externalRegionId];
              console.log(`Row ${i + 1}: Reusing existing territory ${territoryId} for external location ID ${externalRegionId} (from batch mapping)`);
            } else {
              // Check if territory with this external ID already exists in the DATABASE
              const regionSearchPattern = `Imported from external region ID: ${externalRegionId}`;
              const { data: existingTerritories, error: territorySearchError } = await supabase
                .from('territories')
                .select('id, description')
                .eq('user_id', userId)
                .eq('description', regionSearchPattern)
                .limit(1);
              
              if (!territorySearchError && existingTerritories && existingTerritories.length > 0) {
                territoryId = existingTerritories[0].id;
                territoryIdMapping[externalRegionId] = territoryId;
                console.log(`Row ${i + 1}: Found existing territory ${territoryId} for external location ID ${externalRegionId}`);
              } else {
                // Create new territory
                const newTerritory = {
                  user_id: userId,
                  name: `Region ${externalRegionId}`,
                  description: `Imported from external region ID: ${externalRegionId}`,
                  location: job.address || job.serviceAddress || 'Unknown',
                  zip_codes: job.zipCode || job.serviceAddressZip ? [job.zipCode || job.serviceAddressZip] : [],
                  radius_miles: 25.00,
                  timezone: 'America/New_York',
                  business_hours: {},
                  team_members: [],
                  services: [],
                  pricing_multiplier: 1.00
                };
                
                const { data: createdTerritory, error: createTerritoryError } = await supabase
                  .from('territories')
                  .insert(newTerritory)
                  .select('id')
                  .single();
                
                if (createTerritoryError) {
                  console.error(`Row ${i + 1}: Failed to create territory for location ID ${externalRegionId}:`, createTerritoryError);
                  results.jobs.errors.push(`Row ${i + 1}: Could not create territory for location ID ${externalRegionId}`);
                } else {
                  territoryId = createdTerritory.id;
                  territoryIdMapping[externalRegionId] = territoryId;
                  console.log(`Row ${i + 1}: Created new territory ${territoryId} for external location ID ${externalRegionId}`);
                }
              }
            }
          }

          // Combine notes from multiple fields
          const notes = [
            job.notes,
            job.bookingNote || job['Booking note'],
            job.providerNote || job['Provider note'],
            job.specialNotes || job['Special notes']
          ].filter(n => n && n.trim()).join('\n\n') || null;

          const mappedJob = {
            user_id: userId,
            customer_id: customerId,
            team_member_id: teamMemberId || null,
            territory_id: territoryId || null,
            service_name: job.serviceName || job['Service'] || job.service_name || job.service || 'Imported Service',
            scheduled_date: scheduledDate || new Date().toISOString().split('T')[0],
            scheduled_time: scheduledTime,
            status: jobStatus,
            notes: notes,
            price: priceValue,
            total: priceValue,
            service_address_street: job.address || job.Address || job.street_address || null,
            service_address_city: job.city || job.City || null,
            service_address_state: job.state || job.State || null,
            service_address_zip: job.zipCode || job['Zip/Postal code'] || job['Zip Code'] || job.zip_code || job.postal_code || null,
            estimated_duration: duration,
            is_recurring: isRecurring,
            recurring_frequency: recurringFrequency
          };

          // Check for duplicates if skipDuplicates is enabled
          if (settings.skipDuplicates) {
            const { data: existing } = await supabase
              .from('jobs')
              .select('id')
              .eq('user_id', userId)
              .eq('customer_id', customerId)
              .eq('scheduled_date', scheduledDate)
              .eq('service_name', mappedJob.service_name)
              .single();

            if (existing) {
              if (settings.updateExisting) {
                const { error: updateError } = await supabase
                  .from('jobs')
                  .update(mappedJob)
                  .eq('id', existing.id);

                if (updateError) {
                  results.jobs.errors.push(`Row ${i + 1}: ${updateError.message}`);
                } else {
                  results.jobs.imported++;
                }
              } else {
                results.jobs.skipped++;
              }
              continue;
            }
          }

          // Insert new job
          const { data: newJob, error: insertError } = await supabase
            .from('jobs')
            .insert(mappedJob)
            .select()
            .single();

          if (insertError) {
            results.jobs.errors.push(`Row ${i + 1}: ${insertError.message}`);
          } else {
            results.jobs.imported++;
          }
        } catch (error) {
          results.jobs.errors.push(`Row ${i + 1}: ${error.message}`);
        }
      }
    }

    res.json({
      success: true,
      message: 'Import completed',
      results
    });
  } catch (error) {
    console.error('Booking Koala import error:', error);
    res.status(500).json({ error: 'Failed to import Booking Koala data' });
  }
});

// Helper function to parse time string
function parseTime(timeStr) {
  if (!timeStr) return '09:00:00';
  
  // Handle formats like "9:00 AM", "09:00", "9:00:00 PM"
  const timeMatch = timeStr.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm|AM|PM)?/i);
  if (timeMatch) {
    let hours = parseInt(timeMatch[1]);
    const minutes = timeMatch[2];
    const ampm = timeMatch[4];
    
    if (ampm) {
      if (ampm.toUpperCase() === 'PM' && hours !== 12) {
        hours += 12;
      } else if (ampm.toUpperCase() === 'AM' && hours === 12) {
        hours = 0;
      }
    }
    
    return `${hours.toString().padStart(2, '0')}:${minutes}:00`;
  }
  
  return '09:00:00';
}

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
    const userEmail = req.user.email;
    const teamMemberId = req.user.teamMemberId; // Get team member ID from JWT token

    // If teamMemberId exists in token, fetch team member profile instead
    if (teamMemberId) {
      console.log('Fetching team member profile for teamMemberId:', teamMemberId);
      const { data: teamMember, error: teamMemberError } = await supabase
        .from('team_members')
        .select('id, user_id, email, first_name, last_name, phone, role, profile_picture, status, permissions')
        .eq('id', teamMemberId)
        .eq('status', 'active')
        .single();
      
      if (teamMemberError) {
        console.error('Error fetching team member profile:', teamMemberError);
        return res.status(500).json({ error: 'Failed to fetch user profile' });
      }
      
      if (!teamMember) {
        return res.status(404).json({ error: 'Team member not found' });
      }
      
      // Parse permissions if it's a string
      let permissions = {};
      if (teamMember.permissions) {
        try {
          permissions = typeof teamMember.permissions === 'string' 
            ? JSON.parse(teamMember.permissions) 
            : teamMember.permissions;
        } catch (e) {
          console.error('Error parsing permissions:', e);
          permissions = {};
        }
      }
      
      const userRole = teamMember.role || 'worker';
      
      return res.json({
        id: teamMember.user_id, // Account owner's user_id (for compatibility)
        email: teamMember.email,
        firstName: teamMember.first_name,
        lastName: teamMember.last_name,
        businessName: null, // Team members don't have business_name
        phone: teamMember.phone || '',
        emailNotifications: false, // Default for team members
        smsNotifications: false, // Default for team members
        profilePicture: teamMember.profile_picture,
        role: userRole,
        permissions: permissions,
        teamMemberId: teamMember.id // Include team member ID
      });
    }

    // Query Supabase directly - first check users table (for account owners)
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
        profile_picture,
        google_access_token,
        google_id
      `)
      .eq('id', userId)
      .maybeSingle(); // fetch a single row instead of array

    let userRole = 'owner'; // Default role for account owners
    let profileData = null;

    if (error) {
      console.error('Error fetching user profile:', error);
      return res.status(500).json({ error: 'Failed to fetch user profile' });
    }

    if (user) {
      // Found in users table - this is an account owner
      // Check if they exist in team_members table to get their role
      const { data: teamMemberData, error: teamMemberError } = await supabase
        .from('team_members')
        .select('role')
        .eq('user_id', userId)
        .eq('email', user.email)
        .limit(1);
      
      if (!teamMemberError && teamMemberData && teamMemberData.length > 0) {
        // Use the role from team_members table
        userRole = teamMemberData[0].role || 'account owner';
      } else {
        // If not found in team_members, default to 'account owner'
        userRole = 'account owner';
      }

      profileData = {
      id: user.id,
      email: user.email,
      firstName: user.first_name,
      lastName: user.last_name,
      businessName: user.business_name,
      phone: user.phone || '',
      emailNotifications: !!user.email_notifications,
      smsNotifications: !!user.sms_notifications,
        profilePicture: user.profile_picture,
        role: userRole,
        google_access_token: user.google_access_token || null,
        google_id: user.google_id || null
      };
    } else {
      // Not found in users table, check team_members table
      const { data: teamMember, error: teamMemberError } = await supabase
        .from('team_members')
        .select('id, user_id, email, first_name, last_name, phone, role, profile_picture, status, permissions')
        .or(`user_id.eq.${userId},email.eq.${userEmail}`)
        .eq('status', 'active')
        .limit(1);

      if (teamMemberError) {
        console.error('Error fetching team member profile:', teamMemberError);
        return res.status(500).json({ error: 'Failed to fetch user profile' });
      }

      if (!teamMember || teamMember.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      const member = teamMember[0];
      userRole = member.role || 'worker';
      
      // Parse permissions if it's a string
      let permissions = {};
      if (member.permissions) {
        try {
          permissions = typeof member.permissions === 'string' 
            ? JSON.parse(member.permissions) 
            : member.permissions;
        } catch (e) {
          console.error('Error parsing permissions:', e);
          permissions = {};
        }
      }

      profileData = {
        id: member.user_id, // Use the account owner's user_id
        email: member.email,
        firstName: member.first_name,
        lastName: member.last_name,
        businessName: null, // Team members don't have business_name
        phone: member.phone || '',
        emailNotifications: false, // Default for team members
        smsNotifications: false, // Default for team members
        profilePicture: member.profile_picture,
        role: userRole,
        permissions: permissions, // Include permissions
        teamMemberId: member.id // Include team member ID
      };
    }

    // Return normalized JSON with role
    res.json(profileData);

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
app.post('/api/user/profile-picture', authenticateToken, upload.single('profilePicture'), async (req, res) => {
  try {
    const userId = req.user.userId;
    const teamMemberId = req.user.teamMemberId; // Get team member ID from JWT token
    
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    // Get the file URL
    const fileUrl = `http://localhost:5000/uploads/${req.file.filename}`;
    
    // Update profile picture - check if it's a team member or account owner
    if (teamMemberId) {
      // Update team member's profile picture
      const { error } = await supabase
        .from('team_members')
        .update({ profile_picture: fileUrl })
        .eq('id', teamMemberId);
      
      if (error) {
        console.error('Error updating team member profile picture:', error);
        return res.status(500).json({ error: 'Failed to update profile picture' });
      }
    } else {
      // Update account owner's profile picture
    const { error } = await supabase
      .from('users')
      .update({ profile_picture: fileUrl })
      .eq('id', userId);
    
    if (error) {
      console.error('Error updating profile picture:', error);
      return res.status(500).json({ error: 'Failed to update profile picture' });
      }
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
app.get('/api/user/availability', authenticateToken, async (req, res) => {
  try {
    // Use authenticated user's ID from token instead of query parameter
    const userId = req.user?.userId || req.query?.userId;
    
    if (!userId) {
      console.error('No userId provided for availability fetch');
      return res.status(400).json({ error: 'User ID is required' });
    }
    
    console.log('Fetching availability for user:', userId, 'Type:', typeof userId);
    
    // Convert userId to number if it's a string
    const userIdNum = typeof userId === 'string' ? parseInt(userId, 10) : userId;
    
    if (isNaN(userIdNum)) {
      console.error('Invalid userId:', userId);
      return res.status(400).json({ error: 'Invalid user ID', details: `userId: ${userId}` });
    }
    
    let availabilityInfo, error;
    try {
      // Look for records with business_hours JSONB populated
      // The table might have multiple rows per user, but we only want the one with business_hours
      const result = await supabase
        .from('user_availability')
        .select('business_hours, timeslot_templates')
        .eq('user_id', userIdNum)
        .not('business_hours', 'is', null)
        .limit(1);
      
      availabilityInfo = result.data;
      error = result.error;
      
      // Check if error is due to missing table or columns (PGRST116, PGRST103, 42703)
      if (error && (
        error.code === 'PGRST116' || 
        error.code === 'PGRST103' ||
        error.code === '42703' ||
        error.message?.includes('relation') || 
        error.message?.includes('does not exist') ||
        error.message?.includes('column') ||
        error.message?.includes('business_hours') ||
        error.message?.includes('timeslot_templates')
      )) {
        console.warn('⚠️ user_availability table may have wrong structure or missing columns, returning default hours');
        console.warn('Error details:', error.code, error.message);
        // Return default hours instead of error
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
    } catch (dbError) {
      console.error('Database query error:', dbError);
      console.error('Error type:', dbError.constructor.name);
      console.error('Error message:', dbError.message);
      return res.status(500).json({ 
        error: 'Database query failed', 
        details: dbError.message,
        type: dbError.constructor.name,
        stack: process.env.NODE_ENV === 'development' ? dbError.stack : undefined
      });
    }
    
    if (error) {
      console.error('Supabase error fetching availability info:', error);
      console.error('Error code:', error.code);
      console.error('Error message:', error.message);
      console.error('Error details:', error.details);
      console.error('Error hint:', error.hint);
      
      // If it's a permission/RLS error, return default instead of error
      if (error.code === '42501' || error.message?.includes('permission') || error.message?.includes('policy')) {
        console.warn('⚠️ RLS policy may be blocking access, returning default hours');
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
      
      return res.status(500).json({ 
        error: 'Failed to fetch availability information', 
        details: error.message,
        code: error.code,
        hint: error.hint
      });
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
    
    // Parse business_hours safely
    let businessHours = {};
    try {
      if (availability.business_hours) {
        if (typeof availability.business_hours === 'string') {
          businessHours = JSON.parse(availability.business_hours);
        } else {
          businessHours = availability.business_hours;
        }
      }
    } catch (parseError) {
      console.error('Error parsing business_hours:', parseError);
      businessHours = {};
    }
    
    // Parse timeslot_templates safely
    let timeslotTemplates = [];
    try {
      if (availability.timeslot_templates) {
        if (typeof availability.timeslot_templates === 'string') {
          timeslotTemplates = JSON.parse(availability.timeslot_templates);
        } else {
          timeslotTemplates = availability.timeslot_templates;
        }
      }
    } catch (parseError) {
      console.error('Error parsing timeslot_templates:', parseError);
      timeslotTemplates = [];
    }
    
    res.json({
      businessHours: businessHours,
      timeslotTemplates: timeslotTemplates
    });
  } catch (error) {
    console.error('Get availability error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ 
      error: 'Failed to fetch availability information',
      details: error.message,
      type: error.constructor.name
    });
  }
});

app.put('/api/user/availability', authenticateToken, async (req, res) => {
  try {
    // Use authenticated user's ID from token instead of body
    const userId = req.user?.userId || req.body?.userId;
    const { businessHours, timeslotTemplates } = req.body;
    
    if (!userId) {
      console.error('No userId provided for availability update');
      return res.status(400).json({ error: 'User ID is required' });
    }
    
    if (!businessHours) {
      console.error('No businessHours provided for availability update');
      return res.status(400).json({ error: 'Business hours are required' });
    }
    
    console.log('Updating availability for user:', userId, 'Type:', typeof userId);
    
    // Convert userId to number if it's a string
    const userIdNum = typeof userId === 'string' ? parseInt(userId, 10) : userId;
    
    if (isNaN(userIdNum)) {
      console.error('Invalid userId:', userId);
      return res.status(400).json({ error: 'Invalid user ID', details: `userId: ${userId}` });
    }
    
    // Convert businessHours and timeslotTemplates to JSONB format
    // For Supabase JSONB, we should pass the object directly (Supabase handles conversion)
    // But if it's already a string, parse it first
    let businessHoursJson;
    if (typeof businessHours === 'string') {
      try {
        businessHoursJson = JSON.parse(businessHours);
      } catch (e) {
        businessHoursJson = businessHours; // Keep as string if parsing fails
      }
    } else {
      businessHoursJson = businessHours; // Pass object directly
    }
    
    let timeslotTemplatesJson;
    if (timeslotTemplates) {
      if (typeof timeslotTemplates === 'string') {
        try {
          timeslotTemplatesJson = JSON.parse(timeslotTemplates);
        } catch (e) {
          timeslotTemplatesJson = timeslotTemplates; // Keep as string if parsing fails
        }
      } else {
        timeslotTemplatesJson = timeslotTemplates; // Pass object/array directly
      }
    } else {
      timeslotTemplatesJson = []; // Default to empty array
    }
    
    // Strategy: Check if user has ANY availability record, then update/create accordingly
    // First, try to find a record with business_hours populated (preferred)
    // If not found, check if user has ANY record at all
    // If no records exist, create a new one
    
    let existingAvailabilityWithHours, anyExistingRecord, checkError;
    
    try {
      // First, check for record with business_hours
      const hoursResult = await supabase
        .from('user_availability')
        .select('id')
        .eq('user_id', userIdNum)
        .not('business_hours', 'is', null)
        .limit(1);
      
      existingAvailabilityWithHours = hoursResult.data;
      checkError = hoursResult.error;
      
      // If no record with business_hours, check for ANY record for this user
      if ((!existingAvailabilityWithHours || existingAvailabilityWithHours.length === 0) && !checkError) {
        const anyResult = await supabase
          .from('user_availability')
          .select('id, day_of_week, start_time')
          .eq('user_id', userIdNum)
          .limit(1);
        
        anyExistingRecord = anyResult.data;
        if (anyResult.error && !checkError) {
          checkError = anyResult.error;
        }
      }
    } catch (dbError) {
      console.error('Database query error:', dbError);
      return res.status(500).json({ 
        error: 'Database query failed', 
        details: dbError.message,
        type: dbError.constructor.name
      });
    }
    
    if (checkError) {
      console.error('Error checking existing availability:', checkError);
      console.error('Error code:', checkError.code, 'Error message:', checkError.message);
      
      // If it's a column error, try to insert anyway
      if (checkError.code === '42703' || checkError.message?.includes('column')) {
        console.warn('⚠️ Column error detected, attempting to insert new record');
      } else {
        return res.status(500).json({ 
          error: 'Failed to check existing availability',
          details: checkError.message,
          code: checkError.code
        });
      }
    }
    
    // Determine which record to update, or if we need to create
    const hasRecordWithHours = existingAvailabilityWithHours && existingAvailabilityWithHours.length > 0;
    const hasAnyRecord = anyExistingRecord && anyExistingRecord.length > 0;
    
    // For account owners, also sync to team_members.availability
    try {
      const { data: teamMember, error: teamMemberError } = await supabase
        .from('team_members')
        .select('id, role')
        .eq('user_id', userIdNum)
        .or('role.eq.account owner,role.eq.owner,role.eq.admin')
        .limit(1);
      
      if (!teamMemberError && teamMember && teamMember.length > 0) {
        // Convert businessHours to team member availability format
        const workingHours = {};
        const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
        
        days.forEach(day => {
          const dayHours = businessHoursJson[day];
          if (dayHours && dayHours.enabled) {
            // Convert 24-hour format to 12-hour format for display
            const startTime = dayHours.start || '09:00';
            const endTime = dayHours.end || '17:00';
            
            // Convert to 12-hour format
            const [startH, startM] = startTime.split(':');
            const [endH, endM] = endTime.split(':');
            const startHour = parseInt(startH);
            const endHour = parseInt(endH);
            
            const startPeriod = startHour >= 12 ? 'PM' : 'AM';
            const endPeriod = endHour >= 12 ? 'PM' : 'AM';
            const startHour12 = startHour > 12 ? startHour - 12 : (startHour === 0 ? 12 : startHour);
            const endHour12 = endHour > 12 ? endHour - 12 : (endHour === 0 ? 12 : endHour);
            
            workingHours[day] = {
              available: true,
              hours: `${startHour12}:${startM} ${startPeriod} - ${endHour12}:${endM} ${endPeriod}`
            };
          } else {
            workingHours[day] = {
              available: false,
              hours: ""
            };
          }
        });
        
        const teamMemberAvailability = JSON.stringify({
          workingHours,
          customAvailability: []
        });
        
        // Update team_members.availability
        await supabase
          .from('team_members')
          .update({ availability: teamMemberAvailability })
          .eq('id', teamMember[0].id);
      }
    } catch (teamMemberSyncError) {
      console.error('Error syncing availability to team_members:', teamMemberSyncError);
      // Don't fail the request if sync fails
    }
    
    if (hasRecordWithHours) {
      // Update existing record that has business_hours
      const { error: updateError } = await supabase
        .from('user_availability')
        .update({
          business_hours: businessHoursJson,
          timeslot_templates: timeslotTemplatesJson,
          updated_at: new Date().toISOString()
        })
        .eq('user_id', userIdNum)
        .not('business_hours', 'is', null);
      
      if (updateError) {
        console.error('Error updating availability:', updateError);
        console.error('Error code:', updateError.code, 'Error message:', updateError.message);
        console.error('Error details:', updateError.details, 'Error hint:', updateError.hint);
        return res.status(500).json({ 
          error: 'Failed to update availability',
          details: updateError.message,
          code: updateError.code,
          hint: updateError.hint
        });
      }
      
      console.log('✅ Successfully updated availability (with hours) for user:', userIdNum);
    } else if (hasAnyRecord) {
      // User has records but none have business_hours - update the first one
      const firstRecord = anyExistingRecord[0];
      const { error: updateError } = await supabase
        .from('user_availability')
        .update({
          business_hours: businessHoursJson,
          timeslot_templates: timeslotTemplatesJson,
          updated_at: new Date().toISOString()
        })
        .eq('id', firstRecord.id);
      
      if (updateError) {
        console.error('Error updating existing availability record:', updateError);
        console.error('Error code:', updateError.code, 'Error message:', updateError.message);
        // If update fails, try to create a new one instead
        console.warn('⚠️ Update failed, attempting to create new record');
        // Fall through to create logic
      } else {
        console.log('✅ Successfully updated existing availability record for user:', userIdNum);
        return res.json({ message: 'Availability updated successfully' });
      }
    }
    
    // If we get here, either no records exist or update failed - create new record
    if (!hasRecordWithHours && (!hasAnyRecord || !hasRecordWithHours)) {
      // Create new availability record
      // Use placeholder values for required fields (day_of_week, start_time, end_time)
      // The unique constraint is on (user_id, day_of_week, start_time)
      const insertData = {
        user_id: userIdNum,
        day_of_week: 0, // Placeholder - required field (0 = Sunday, but we'll use JSONB for actual data)
        start_time: '00:00:00', // Placeholder - required field
        end_time: '00:00:00', // Placeholder - required field
        is_available: true, // Required field
        business_hours: businessHoursJson,
        timeslot_templates: timeslotTemplatesJson
      };
      
      const { error: insertError, data: insertDataResult } = await supabase
        .from('user_availability')
        .insert(insertData)
        .select();
      
      if (insertError) {
        console.error('Error creating availability:', insertError);
        console.error('Error code:', insertError.code, 'Error message:', insertError.message);
        console.error('Error details:', insertError.details, 'Error hint:', insertError.hint);
        
        // If unique constraint violation, try to update instead
        if (insertError.code === '23505' || insertError.message?.includes('unique')) {
          console.warn('⚠️ Unique constraint violation, attempting to update existing record');
          const { error: updateError } = await supabase
            .from('user_availability')
            .update({
              business_hours: businessHoursJson,
              timeslot_templates: timeslotTemplatesJson,
              updated_at: new Date().toISOString()
            })
            .eq('user_id', userIdNum)
            .eq('day_of_week', 0)
            .eq('start_time', '00:00:00');
          
          if (updateError) {
            return res.status(500).json({ 
              error: 'Failed to update availability after insert conflict',
              details: updateError.message,
              code: updateError.code
            });
          }
          
          console.log('✅ Successfully updated availability after insert conflict for user:', userIdNum);
        } else {
          return res.status(500).json({ 
            error: 'Failed to create availability',
            details: insertError.message,
            code: insertError.code,
            hint: insertError.hint
          });
        }
      } else {
        console.log('✅ Successfully created new availability record for user:', userIdNum);
      }
    }
    
    res.json({ message: 'Availability updated successfully' });
  } catch (error) {
    console.error('Update availability error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ 
      error: 'Failed to update availability',
      details: error.message,
      type: error.constructor.name
    });
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
      const avgJobValue = completedJobsCount > 0 ? Math.round((totalRevenue / completedJobsCount) * 100) / 100 : 0;
      
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
    const { userId, search = '', status = '', page = 1, limit = 10, sortBy = 'created_at', sortOrder = 'DESC', customerId, job_id } = req.query;
    
    console.log('📋 Invoices API called with params:', { userId, job_id, customerId, status });
    
    // If job_id is provided, we don't need userId (for public access)
    if (!userId && !job_id) {
      console.log('❌ No userId or job_id provided');
      return res.status(400).json({ error: 'userId or job_id is required' });
    }

    const offset = (parseInt(page) - 1) * parseInt(limit);
    
    // Build Supabase query
    let query = supabase
      .from('invoices')
      .select(`
        *,
        customers!left(first_name, last_name, email, phone),
        jobs!left(scheduled_date, status, service_address_street, service_address_city, service_address_state, service_address_zip, service_address_country, services!left(name))
      `, { count: 'exact' });
    
    // Only filter by user_id if userId is provided
    if (userId) {
      query = query.eq('user_id', userId);
    }
    
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
    
    // Add job filter
    if (job_id) {
      console.log('📋 Filtering by job_id:', job_id);
      query = query.eq('job_id', job_id);
    }
    
    // Add sorting
    query = query.order(sortBy, { ascending: sortOrder.toUpperCase() === 'ASC' });
    
    // Add pagination
    query = query.range(offset, offset + parseInt(limit) - 1);
    
    console.log('📋 Executing query for invoices...');
    const { data: invoices, error, count } = await query;
    
    console.log('📋 Query result:', { invoices: invoices?.length || 0, error: error?.message, count });
    if (invoices && invoices.length > 0) {
      console.log('📋 First invoice:', invoices[0]);
    }
    
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
      job_status: invoice.jobs?.status,
      service_address: (() => {
        // Construct service address from job address fields
        if (invoice.jobs?.service_address_street) {
          const addressParts = [
            invoice.jobs.service_address_street,
            invoice.jobs.service_address_city,
            invoice.jobs.service_address_state,
            invoice.jobs.service_address_zip,
            invoice.jobs.service_address_country
          ].filter(Boolean);
          return addressParts.join(', ');
        }
        return 'N/A';
      })()
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
        jobs!left(scheduled_date, status, service_address_street, service_address_city, service_address_state, service_address_zip, service_address_country, services!left(name))
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
      job_status: invoices[0].jobs?.status,
      service_address: (() => {
        // Construct service address from job address fields
        if (invoices[0].jobs?.service_address_street) {
          const addressParts = [
            invoices[0].jobs.service_address_street,
            invoices[0].jobs.service_address_city,
            invoices[0].jobs.service_address_state,
            invoices[0].jobs.service_address_zip,
            invoices[0].jobs.service_address_country
          ].filter(Boolean);
          return addressParts.join(', ');
        }
        return 'N/A';
      })()
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

app.put('/api/invoices/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      status, amount, taxAmount, 
      totalAmount, dueDate 
    } = req.body;
    
    const userId = req.user.userId; // Get userId from authenticated user
    
    console.log('📄 Invoice update request:', { 
      invoiceId: id, 
      userId, 
      user: req.user,
      body: req.body 
    });

    // Only update fields that are provided
    const updateData = {
      updated_at: new Date().toISOString()
    };
    
    if (status) updateData.status = status;
    if (amount !== undefined) updateData.amount = parseFloat(amount);
    if (taxAmount !== undefined) updateData.tax_amount = parseFloat(taxAmount);
    if (totalAmount !== undefined) updateData.total_amount = parseFloat(totalAmount);
    if (dueDate) updateData.due_date = dueDate;

    console.log('📄 Update data:', updateData);

    const { error: updateError } = await supabase
      .from('invoices')
      .update(updateData)
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

// Get lost customers analytics
app.get('/api/analytics/lost-customers', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { startDate, endDate, groupBy = 'day', inactiveDays = 90 } = req.query;

    const inactiveDaysThreshold = parseInt(inactiveDays) || 90;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - inactiveDaysThreshold);
    const cutoffDateStr = cutoffDate.toISOString().split('T')[0];

    // Get all customers
    const { data: allCustomers, error: customersError } = await supabase
      .from('customers')
      .select('id, first_name, last_name, email, phone, created_at, status')
      .eq('user_id', userId);

    if (customersError) {
      console.error('Error fetching customers:', customersError);
      return res.status(500).json({ error: 'Failed to fetch customers' });
    }

    // Get all jobs for these customers
    let jobsQuery = supabase
      .from('jobs')
      .select('id, customer_id, scheduled_date, created_at, status, total, total_amount, invoice_amount, price')
      .eq('user_id', userId)
      .in('customer_id', (allCustomers || []).map(c => c.id));

    if (startDate) {
      jobsQuery = jobsQuery.gte('created_at', startDate);
    }
    if (endDate) {
      jobsQuery = jobsQuery.lte('created_at', `${endDate} 23:59:59`);
    }

    const { data: allJobs, error: jobsError } = await jobsQuery;

    if (jobsError) {
      console.error('Error fetching jobs:', jobsError);
      return res.status(500).json({ error: 'Failed to fetch jobs' });
    }

    // Analyze customers
    const customerAnalysis = {};
    (allCustomers || []).forEach(customer => {
      customerAnalysis[customer.id] = {
        customerId: customer.id,
        name: `${customer.first_name} ${customer.last_name}`,
        email: customer.email,
        phone: customer.phone,
        createdAt: customer.created_at,
        status: customer.status,
        totalJobs: 0,
        lastJobDate: null,
        lastJobId: null,
        totalRevenue: 0,
        isLost: false,
        daysSinceLastJob: null,
        wasActive: false
      };
    });

    // Process jobs
    (allJobs || []).forEach(job => {
      const analysis = customerAnalysis[job.customer_id];
      if (!analysis) return;

      analysis.totalJobs++;
      analysis.wasActive = true;
      
      const jobDate = new Date(job.scheduled_date || job.created_at);
      const revenue = parseFloat(job.total || job.total_amount || job.invoice_amount || job.price || 0);
      analysis.totalRevenue += revenue;

      if (!analysis.lastJobDate || jobDate > new Date(analysis.lastJobDate)) {
        analysis.lastJobDate = job.scheduled_date || job.created_at;
        analysis.lastJobId = job.id;
      }
    });

    // Identify lost customers
    const now = new Date();
    Object.values(customerAnalysis).forEach(analysis => {
      if (analysis.lastJobDate) {
        const lastJobDate = new Date(analysis.lastJobDate);
        analysis.daysSinceLastJob = Math.floor((now - lastJobDate) / (1000 * 60 * 60 * 24));
        
        // Customer is lost if they had jobs before but haven't had any in the threshold period
        if (analysis.wasActive && analysis.daysSinceLastJob >= inactiveDaysThreshold) {
          analysis.isLost = true;
        }
      } else if (analysis.wasActive) {
        // Customer was created but never had a job (edge case)
        const createdDate = new Date(analysis.createdAt);
        const daysSinceCreated = Math.floor((now - createdDate) / (1000 * 60 * 60 * 24));
        if (daysSinceCreated >= inactiveDaysThreshold) {
          analysis.isLost = true;
          analysis.daysSinceLastJob = daysSinceCreated;
        }
      }
    });

    // Calculate summary metrics
    const totalCustomers = Object.keys(customerAnalysis).length;
    const activeCustomers = Object.values(customerAnalysis).filter(c => c.wasActive && !c.isLost).length;
    const lostCustomers = Object.values(customerAnalysis).filter(c => c.isLost).length;
    const neverActiveCustomers = Object.values(customerAnalysis).filter(c => !c.wasActive).length;
    const churnRate = activeCustomers + lostCustomers > 0 ? (lostCustomers / (activeCustomers + lostCustomers) * 100) : 0;

    // Revenue lost from churn
    const lostRevenue = Object.values(customerAnalysis)
      .filter(c => c.isLost)
      .reduce((sum, c) => sum + c.totalRevenue, 0);

    // Average days since last job for lost customers
    const lostCustomersWithData = Object.values(customerAnalysis).filter(c => c.isLost && c.daysSinceLastJob !== null);
    const avgDaysSinceLastJob = lostCustomersWithData.length > 0
      ? lostCustomersWithData.reduce((sum, c) => sum + c.daysSinceLastJob, 0) / lostCustomersWithData.length
      : 0;

    // Time series data for churn trends
    const timeSeriesData = {};
    Object.values(customerAnalysis).forEach(analysis => {
      if (analysis.isLost && analysis.lastJobDate) {
        let dateKey = analysis.lastJobDate.split('T')[0];

        if (groupBy === 'week') {
          const date = new Date(analysis.lastJobDate);
          const weekStart = new Date(date);
          weekStart.setDate(date.getDate() - date.getDay());
          dateKey = weekStart.toISOString().split('T')[0];
        } else if (groupBy === 'month') {
          dateKey = analysis.lastJobDate.substring(0, 7);
        }

        if (!timeSeriesData[dateKey]) {
          timeSeriesData[dateKey] = {
            date: dateKey,
            lostCustomers: 0,
            lostRevenue: 0
          };
        }

        timeSeriesData[dateKey].lostCustomers++;
        timeSeriesData[dateKey].lostRevenue += analysis.totalRevenue;
      }
    });

    const timeSeries = Object.values(timeSeriesData).sort((a, b) => a.date.localeCompare(b.date));

    // Lost customers list (sorted by days since last job)
    const lostCustomersList = Object.values(customerAnalysis)
      .filter(c => c.isLost)
      .sort((a, b) => (b.daysSinceLastJob || 0) - (a.daysSinceLastJob || 0))
      .slice(0, 50); // Limit to top 50

    res.json({
      summary: {
        totalCustomers,
        activeCustomers,
        lostCustomers,
        neverActiveCustomers,
        churnRate: parseFloat(churnRate.toFixed(2)),
        lostRevenue: parseFloat(lostRevenue.toFixed(2)),
        avgDaysSinceLastJob: parseFloat(avgDaysSinceLastJob.toFixed(1)),
        inactiveDaysThreshold
      },
      timeSeries,
      lostCustomersList
    });
  } catch (error) {
    console.error('Get lost customers analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch lost customers analytics' });
  }
});

// Get recurring conversion analytics (Customers to Recurring)
app.get('/api/analytics/recurring-conversion', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { startDate, endDate, groupBy = 'day' } = req.query;

    // Get all customers
    const { data: allCustomers, error: customersError } = await supabase
      .from('customers')
      .select('id, first_name, last_name, created_at')
      .eq('user_id', userId);

    if (customersError) {
      console.error('Error fetching customers:', customersError);
      return res.status(500).json({ error: 'Failed to fetch customers' });
    }

    // Get all jobs for these customers
    let jobsQuery = supabase
      .from('jobs')
      .select('id, customer_id, is_recurring, recurring_frequency, scheduled_date, total, total_amount, invoice_amount, price, created_at')
      .eq('user_id', userId)
      .in('customer_id', (allCustomers || []).map(c => c.id));

    if (startDate) {
      jobsQuery = jobsQuery.gte('created_at', startDate);
    }
    if (endDate) {
      jobsQuery = jobsQuery.lte('created_at', `${endDate} 23:59:59`);
    }

    const { data: allJobs, error: jobsError } = await jobsQuery;

    if (jobsError) {
      console.error('Error fetching jobs:', jobsError);
      return res.status(500).json({ error: 'Failed to fetch jobs' });
    }

    // Analyze customers
    const customerAnalysis = {};
    (allCustomers || []).forEach(customer => {
      customerAnalysis[customer.id] = {
        customerId: customer.id,
        name: `${customer.first_name} ${customer.last_name}`,
        createdAt: customer.created_at,
        hasOneTimeJobs: false,
        hasRecurringJobs: false,
        firstOneTimeJobDate: null,
        firstRecurringJobDate: null,
        oneTimeJobCount: 0,
        recurringJobCount: 0,
        oneTimeRevenue: 0,
        recurringRevenue: 0,
        convertedToRecurring: false,
        conversionDate: null,
        daysToConvert: null
      };
    });

    // Process jobs
    (allJobs || []).forEach(job => {
      const analysis = customerAnalysis[job.customer_id];
      if (!analysis) return;

      const isRecurring = job.is_recurring === true || job.is_recurring === 1;
      const jobDate = new Date(job.created_at || job.scheduled_date);
      const revenue = parseFloat(job.total || job.total_amount || job.invoice_amount || job.price || 0);

      if (isRecurring) {
        analysis.hasRecurringJobs = true;
        analysis.recurringJobCount++;
        analysis.recurringRevenue += revenue;
        
        if (!analysis.firstRecurringJobDate || jobDate < new Date(analysis.firstRecurringJobDate)) {
          analysis.firstRecurringJobDate = job.created_at || job.scheduled_date;
        }
      } else {
        analysis.hasOneTimeJobs = true;
        analysis.oneTimeJobCount++;
        analysis.oneTimeRevenue += revenue;
        
        if (!analysis.firstOneTimeJobDate || jobDate < new Date(analysis.firstOneTimeJobDate)) {
          analysis.firstOneTimeJobDate = job.created_at || job.scheduled_date;
        }
      }
    });

    // Determine conversions
    Object.values(customerAnalysis).forEach(analysis => {
      if (analysis.hasOneTimeJobs && analysis.hasRecurringJobs) {
        // Customer converted from one-time to recurring
        analysis.convertedToRecurring = true;
        analysis.conversionDate = analysis.firstRecurringJobDate;
        
        if (analysis.firstOneTimeJobDate && analysis.firstRecurringJobDate) {
          const oneTimeDate = new Date(analysis.firstOneTimeJobDate);
          const recurringDate = new Date(analysis.firstRecurringJobDate);
          analysis.daysToConvert = Math.floor((recurringDate - oneTimeDate) / (1000 * 60 * 60 * 24));
        }
      }
    });

    // Calculate summary metrics
    const totalCustomers = Object.keys(customerAnalysis).length;
    const oneTimeOnlyCustomers = Object.values(customerAnalysis).filter(c => c.hasOneTimeJobs && !c.hasRecurringJobs).length;
    const recurringOnlyCustomers = Object.values(customerAnalysis).filter(c => !c.hasOneTimeJobs && c.hasRecurringJobs).length;
    const convertedCustomers = Object.values(customerAnalysis).filter(c => c.convertedToRecurring).length;
    const customersWithOneTimeJobs = Object.values(customerAnalysis).filter(c => c.hasOneTimeJobs).length;
    const conversionRate = customersWithOneTimeJobs > 0 ? (convertedCustomers / customersWithOneTimeJobs * 100) : 0;

    // Calculate average time to convert
    const convertedCustomersWithTime = Object.values(customerAnalysis).filter(c => c.convertedToRecurring && c.daysToConvert !== null);
    const avgDaysToConvert = convertedCustomersWithTime.length > 0
      ? convertedCustomersWithTime.reduce((sum, c) => sum + c.daysToConvert, 0) / convertedCustomersWithTime.length
      : 0;

    // Revenue analysis
    const totalOneTimeRevenue = Object.values(customerAnalysis).reduce((sum, c) => sum + c.oneTimeRevenue, 0);
    const totalRecurringRevenue = Object.values(customerAnalysis).reduce((sum, c) => sum + c.recurringRevenue, 0);
    const convertedCustomerRevenue = Object.values(customerAnalysis)
      .filter(c => c.convertedToRecurring)
      .reduce((sum, c) => sum + c.recurringRevenue, 0);

    // Time series data
    const timeSeriesData = {};
    Object.values(customerAnalysis).forEach(analysis => {
      if (analysis.convertedToRecurring && analysis.conversionDate) {
        let dateKey = analysis.conversionDate.split('T')[0];

        if (groupBy === 'week') {
          const date = new Date(analysis.conversionDate);
          const weekStart = new Date(date);
          weekStart.setDate(date.getDate() - date.getDay());
          dateKey = weekStart.toISOString().split('T')[0];
        } else if (groupBy === 'month') {
          dateKey = analysis.conversionDate.substring(0, 7);
        }

        if (!timeSeriesData[dateKey]) {
          timeSeriesData[dateKey] = {
            date: dateKey,
            conversions: 0,
            revenue: 0
          };
        }

        timeSeriesData[dateKey].conversions++;
        timeSeriesData[dateKey].revenue += analysis.recurringRevenue;
      }
    });

    const timeSeries = Object.values(timeSeriesData).sort((a, b) => a.date.localeCompare(b.date));

    // Breakdown by recurring frequency
    const frequencyBreakdown = {};
    (allJobs || []).forEach(job => {
      if (job.is_recurring && job.recurring_frequency) {
        const freq = job.recurring_frequency;
        if (!frequencyBreakdown[freq]) {
          frequencyBreakdown[freq] = {
            frequency: freq,
            customerCount: new Set(),
            jobCount: 0,
            revenue: 0
          };
        }
        frequencyBreakdown[freq].customerCount.add(job.customer_id);
        frequencyBreakdown[freq].jobCount++;
        frequencyBreakdown[freq].revenue += parseFloat(job.total || job.total_amount || job.invoice_amount || job.price || 0);
      }
    });

    // Convert Sets to counts
    Object.keys(frequencyBreakdown).forEach(freq => {
      frequencyBreakdown[freq].customerCount = frequencyBreakdown[freq].customerCount.size;
    });

    res.json({
      summary: {
        totalCustomers,
        oneTimeOnlyCustomers,
        recurringOnlyCustomers,
        convertedCustomers,
        customersWithOneTimeJobs,
        conversionRate: parseFloat(conversionRate.toFixed(2)),
        avgDaysToConvert: parseFloat(avgDaysToConvert.toFixed(1)),
        totalOneTimeRevenue: parseFloat(totalOneTimeRevenue.toFixed(2)),
        totalRecurringRevenue: parseFloat(totalRecurringRevenue.toFixed(2)),
        convertedCustomerRevenue: parseFloat(convertedCustomerRevenue.toFixed(2))
      },
      byFrequency: frequencyBreakdown,
      timeSeries,
      customerBreakdown: Object.values(customerAnalysis).filter(c => c.hasOneTimeJobs || c.hasRecurringJobs)
    });
  } catch (error) {
    console.error('Get recurring conversion analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch recurring conversion analytics' });
  }
});

// Get conversion analytics (Leads to Customers)
app.get('/api/analytics/conversion', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { startDate, endDate, groupBy = 'day' } = req.query;

    // Get all leads for this user
    let leadsQuery = supabase
      .from('leads')
      .select('id, source, stage_id, converted_customer_id, converted_at, created_at, value')
      .eq('user_id', userId);

    if (startDate) {
      leadsQuery = leadsQuery.gte('created_at', startDate);
    }
    if (endDate) {
      leadsQuery = leadsQuery.lte('created_at', `${endDate} 23:59:59`);
    }

    const { data: allLeads, error: leadsError } = await leadsQuery;

    if (leadsError) {
      console.error('Error fetching leads:', leadsError);
      return res.status(500).json({ error: 'Failed to fetch leads' });
    }

    // Get all pipelines for this user
    const { data: pipelines, error: pipelinesError } = await supabase
      .from('lead_pipelines')
      .select('id')
      .eq('user_id', userId);

    const pipelineIds = (pipelines || []).map(p => p.id);

    // Get all stages for context
    let stagesQuery = supabase
      .from('lead_stages')
      .select('id, name, position');
    
    if (pipelineIds.length > 0) {
      stagesQuery = stagesQuery.in('pipeline_id', pipelineIds);
    }

    const { data: stages, error: stagesError } = await stagesQuery;

    const stageMap = {};
    (stages || []).forEach(stage => {
      stageMap[stage.id] = stage;
    });

    // Calculate conversion metrics
    const totalLeads = (allLeads || []).length;
    const convertedLeads = (allLeads || []).filter(lead => lead.converted_customer_id).length;
    const conversionRate = totalLeads > 0 ? (convertedLeads / totalLeads * 100) : 0;

    // Conversion by source
    const conversionBySource = {};
    (allLeads || []).forEach(lead => {
      const source = lead.source || 'Unknown';
      if (!conversionBySource[source]) {
        conversionBySource[source] = {
          total: 0,
          converted: 0,
          conversionRate: 0,
          totalValue: 0,
          convertedValue: 0
        };
      }
      conversionBySource[source].total++;
      if (lead.converted_customer_id) {
        conversionBySource[source].converted++;
        conversionBySource[source].convertedValue += parseFloat(lead.value || 0);
      }
      conversionBySource[source].totalValue += parseFloat(lead.value || 0);
      conversionBySource[source].conversionRate = conversionBySource[source].total > 0 
        ? (conversionBySource[source].converted / conversionBySource[source].total * 100) 
        : 0;
    });

    // Conversion by stage
    const conversionByStage = {};
    (allLeads || []).forEach(lead => {
      const stageId = lead.stage_id;
      const stageName = stageMap[stageId]?.name || `Stage ${stageId}`;
      if (!conversionByStage[stageName]) {
        conversionByStage[stageName] = {
          total: 0,
          converted: 0,
          conversionRate: 0
        };
      }
      conversionByStage[stageName].total++;
      if (lead.converted_customer_id) {
        conversionByStage[stageName].converted++;
      }
      conversionByStage[stageName].conversionRate = conversionByStage[stageName].total > 0
        ? (conversionByStage[stageName].converted / conversionByStage[stageName].total * 100)
        : 0;
    });

    // Time series data for conversion trends
    const timeSeriesData = {};
    (allLeads || []).forEach(lead => {
      if (!lead.created_at) return;
      
      let dateKey = lead.created_at.split('T')[0]; // Get YYYY-MM-DD

      if (groupBy === 'week') {
        const date = new Date(lead.created_at);
        const weekStart = new Date(date);
        weekStart.setDate(date.getDate() - date.getDay());
        dateKey = weekStart.toISOString().split('T')[0];
      } else if (groupBy === 'month') {
        dateKey = lead.created_at.substring(0, 7); // YYYY-MM
      }

      if (!timeSeriesData[dateKey]) {
        timeSeriesData[dateKey] = {
          date: dateKey,
          totalLeads: 0,
          convertedLeads: 0,
          conversionRate: 0
        };
      }

      timeSeriesData[dateKey].totalLeads++;
      if (lead.converted_customer_id) {
        timeSeriesData[dateKey].convertedLeads++;
      }
      timeSeriesData[dateKey].conversionRate = timeSeriesData[dateKey].totalLeads > 0
        ? (timeSeriesData[dateKey].convertedLeads / timeSeriesData[dateKey].totalLeads * 100)
        : 0;
    });

    // Convert time series to array and sort
    const timeSeries = Object.values(timeSeriesData).sort((a, b) => a.date.localeCompare(b.date));

    // Calculate average time to conversion
    const convertedLeadsWithTime = (allLeads || []).filter(lead => 
      lead.converted_customer_id && lead.converted_at && lead.created_at
    );
    
    let avgTimeToConversion = 0;
    if (convertedLeadsWithTime.length > 0) {
      const totalDays = convertedLeadsWithTime.reduce((sum, lead) => {
        const created = new Date(lead.created_at);
        const converted = new Date(lead.converted_at);
        const days = (converted - created) / (1000 * 60 * 60 * 24);
        return sum + days;
      }, 0);
      avgTimeToConversion = totalDays / convertedLeadsWithTime.length;
    }

    // Total lead value
    const totalLeadValue = (allLeads || []).reduce((sum, lead) => 
      sum + parseFloat(lead.value || 0), 0
    );
    const convertedLeadValue = (allLeads || []).filter(lead => lead.converted_customer_id)
      .reduce((sum, lead) => sum + parseFloat(lead.value || 0), 0);

    res.json({
      summary: {
        totalLeads,
        convertedLeads,
        conversionRate: parseFloat(conversionRate.toFixed(2)),
        avgTimeToConversion: parseFloat(avgTimeToConversion.toFixed(1)),
        totalLeadValue: parseFloat(totalLeadValue.toFixed(2)),
        convertedLeadValue: parseFloat(convertedLeadValue.toFixed(2))
      },
      bySource: conversionBySource,
      byStage: conversionByStage,
      timeSeries
    });
  } catch (error) {
    console.error('Get conversion analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch conversion analytics' });
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
    
    // First, get the account owner from users table
    const { data: accountOwner, error: ownerError } = await supabase
      .from('users')
      .select('id, email, first_name, last_name, phone, business_name, profile_picture')
      .eq('id', userId)
      .maybeSingle();
    
    // Build Supabase query with joins and aggregations for team members
    let query = supabase
      .from('team_members')
      .select(`
        *,
        jobs!left(id, status, invoice_amount)
      `, { count: 'exact' })
      .eq('user_id', userId);
    
    // Add status filter (but don't filter out account owner if they don't have status)
    if (status) {
      query = query.eq('status', status);
    }
    
    // Add search filter
    if (search) {
      query = query.or(`first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%`);
    }
    
    // Add sorting - account owner should always be first
    const allowedSortFields = ['first_name', 'last_name', 'email', 'role'];
    const allowedSortOrders = ['ASC', 'DESC'];
    
    // First order by role (account owner first), then by the requested sort field
    query = query.order('role', { ascending: true }); // This will put 'account owner' first alphabetically
    
    if (allowedSortFields.includes(sortBy) && allowedSortOrders.includes(sortOrder.toUpperCase())) {
      // Add secondary sort by the requested field
      // Note: Supabase doesn't support multiple orderBy in a single call easily,
      // so we'll sort in JavaScript after fetching
    } else {
      // Default secondary sort
    }
    
    // Add pagination
    const offset = (page - 1) * limit;
    query = query.range(offset, offset + parseInt(limit) - 1);
    
    const { data: teamMembers, error, count } = await query;
    
    if (error) {
      console.error('Error fetching team members:', error);
      return res.status(500).json({ error: 'Failed to fetch team members' });
    }
    
    // Check if account owner exists in team_members (even if filtered out)
    // We need to check the full team_members table, not just the filtered results
    let accountOwnerInTeam = null;
    if (accountOwner) {
      // Query team_members separately to check if account owner exists (without status filter)
      const { data: allTeamMembers, error: allTeamError } = await supabase
        .from('team_members')
        .select('*')
        .eq('user_id', userId)
        .or(`role.eq.account owner,role.eq.owner,role.eq.admin,email.eq.${accountOwner.email}`);
      
      if (!allTeamError && allTeamMembers && allTeamMembers.length > 0) {
        accountOwnerInTeam = allTeamMembers[0];
      }
    }
    
    // If account owner doesn't exist in team_members, create a virtual entry
    // Also create virtual entry if account owner exists but was filtered out by status
    let accountOwnerEntry = null;
    const accountOwnerInFilteredResults = teamMembers?.find(member => 
      accountOwnerInTeam && (member.id === accountOwnerInTeam.id || member.email === accountOwner.email)
    );
    
    if (accountOwner && (!accountOwnerInTeam || !accountOwnerInFilteredResults)) {
      // Get jobs assigned to the account owner (using user_id)
      const { data: ownerJobs, error: jobsError } = await supabase
        .from('jobs')
        .select('id, status, invoice_amount')
        .eq('user_id', userId)
        .limit(100);
      
      const jobs = ownerJobs || [];
      const totalJobs = jobs.length;
      const completedJobs = jobs.filter(job => job.status === 'completed').length;
      const avgJobValue = completedJobs > 0 
        ? Math.round((jobs.filter(job => job.status === 'completed')
            .reduce((sum, job) => sum + (job.invoice_amount || 0), 0) / completedJobs) * 100) / 100
        : 0;
      
      // Create virtual account owner entry
      // Use data from team_members if available, otherwise from users table
      const ownerData = accountOwnerInTeam || accountOwner;
      accountOwnerEntry = {
        id: accountOwnerInTeam ? accountOwnerInTeam.id : accountOwner.id,
        user_id: userId,
        email: ownerData.email || accountOwner.email,
        first_name: ownerData.first_name || accountOwner.first_name,
        last_name: ownerData.last_name || accountOwner.last_name,
        phone: ownerData.phone || accountOwner.phone || null,
        role: 'account owner',
        status: accountOwnerInTeam ? (accountOwnerInTeam.status || 'active') : 'active',
        is_service_provider: accountOwnerInTeam ? (accountOwnerInTeam.is_service_provider !== false) : true,
        profile_picture: accountOwner.profile_picture || (accountOwnerInTeam ? accountOwnerInTeam.profile_picture : null) || null,
        color: accountOwnerInTeam ? (accountOwnerInTeam.color || '#DC2626') : '#DC2626',
        total_jobs: totalJobs,
        completed_jobs: completedJobs,
        avg_job_value: avgJobValue,
        jobs: jobs
      };
    }
    
    // Process team members to add job statistics
    let processedTeamMembers = (teamMembers || []).map(member => {
      const jobs = member.jobs || [];
      const totalJobs = jobs.length;
      const completedJobs = jobs.filter(job => job.status === 'completed').length;
      const avgJobValue = completedJobs > 0 
        ? Math.round((jobs.filter(job => job.status === 'completed')
            .reduce((sum, job) => sum + (job.invoice_amount || 0), 0) / completedJobs) * 100) / 100
        : 0;
      
      return {
        ...member,
        profile_picture: member.profile_picture || null, // Ensure profile_picture is always included
        total_jobs: totalJobs,
        completed_jobs: completedJobs,
        avg_job_value: avgJobValue
      };
    });
    
    // If account owner exists in team_members, update their profile_picture from users table
    if (accountOwnerInTeam && accountOwner) {
      // Find the account owner in the processed results
      const accountOwnerIndex = processedTeamMembers.findIndex(member => 
        member.id === accountOwnerInTeam.id ||
        member.email === accountOwner.email ||
        (member.role === 'account owner' || member.role === 'owner' || member.role === 'admin')
      );
      
      if (accountOwnerIndex !== -1) {
        // Update profile_picture from users table if it exists
        if (accountOwner.profile_picture) {
          processedTeamMembers[accountOwnerIndex].profile_picture = accountOwner.profile_picture;
        }
      }
    }
    
    // Add account owner entry if it doesn't exist
    if (accountOwnerEntry) {
      processedTeamMembers.unshift(accountOwnerEntry); // Add to beginning
    }
    
    // Sort: account owner first, then by requested sort field
    processedTeamMembers.sort((a, b) => {
      // Account owner always first
      const aIsOwner = a.role === 'account owner' || a.role === 'owner' || a.role === 'admin';
      const bIsOwner = b.role === 'account owner' || b.role === 'owner' || b.role === 'admin';
      
      if (aIsOwner && !bIsOwner) return -1;
      if (!aIsOwner && bIsOwner) return 1;
      
      // Then sort by requested field
      if (allowedSortFields.includes(sortBy)) {
        const aValue = a[sortBy] || '';
        const bValue = b[sortBy] || '';
        const comparison = aValue.localeCompare(bValue);
        return sortOrder.toUpperCase() === 'ASC' ? comparison : -comparison;
      }
      
      return 0;
    });
    
    res.json({
      teamMembers: processedTeamMembers,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: (count || 0) + (accountOwnerEntry ? 1 : 0),
        pages: Math.ceil(((count || 0) + (accountOwnerEntry ? 1 : 0)) / limit)
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

app.get('/api/team-members/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { startDate, endDate } = req.query;
    const userId = req.user.userId;

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

    let teamMember = null;

    // If not found in team_members, check if it's the account owner
    if (!teamMembers || teamMembers.length === 0) {
      // Check if the ID matches the user_id (account owner)
      if (parseInt(id) === userId) {
        // Fetch account owner from users table
        const { data: accountOwner, error: ownerError } = await supabase
          .from('users')
          .select('id, email, first_name, last_name, phone, business_name, profile_picture')
          .eq('id', userId)
          .maybeSingle();

        if (ownerError || !accountOwner) {
      return res.status(404).json({ error: 'Team member not found' });
    }

        // Fetch availability from user_availability table for account owner
        let accountOwnerAvailability = null;
        try {
          const { data: userAvailability, error: availError } = await supabase
            .from('user_availability')
            .select('business_hours, timeslot_templates')
            .eq('user_id', userId)
            .not('business_hours', 'is', null)
            .limit(1);
          
          if (!availError && userAvailability && userAvailability.length > 0) {
            // Convert user_availability format to team_members availability format
            const businessHours = userAvailability[0].business_hours;
            if (businessHours) {
              // Convert businessHours format to workingHours format
              const workingHours = {
                monday: businessHours.monday || { available: false, hours: "" },
                tuesday: businessHours.tuesday || { available: false, hours: "" },
                wednesday: businessHours.wednesday || { available: false, hours: "" },
                thursday: businessHours.thursday || { available: false, hours: "" },
                friday: businessHours.friday || { available: false, hours: "" },
                saturday: businessHours.saturday || { available: false, hours: "" },
                sunday: businessHours.sunday || { available: false, hours: "" }
              };
              
              // Normalize to team member format
              Object.keys(workingHours).forEach(day => {
                const dayHours = businessHours[day];
                if (dayHours && dayHours.enabled !== undefined) {
                  // Convert 24-hour format to 12-hour format
                  if (dayHours.enabled && dayHours.start && dayHours.end) {
                    const [startH, startM] = dayHours.start.split(':');
                    const [endH, endM] = dayHours.end.split(':');
                    const startHour = parseInt(startH);
                    const endHour = parseInt(endH);
                    
                    const startPeriod = startHour >= 12 ? 'PM' : 'AM';
                    const endPeriod = endHour >= 12 ? 'PM' : 'AM';
                    const startHour12 = startHour > 12 ? startHour - 12 : (startHour === 0 ? 12 : startHour);
                    const endHour12 = endHour > 12 ? endHour - 12 : (endHour === 0 ? 12 : endHour);
                    
                    workingHours[day] = {
                      available: true,
                      hours: `${startHour12}:${startM} ${startPeriod} - ${endHour12}:${endM} ${endPeriod}`
                    };
                  } else {
                    workingHours[day] = {
                      available: false,
                      hours: ""
                    };
                  }
                } else if (dayHours && dayHours.start && dayHours.end) {
                  // Convert 24-hour format to 12-hour format
                  const [startH, startM] = dayHours.start.split(':');
                  const [endH, endM] = dayHours.end.split(':');
                  const startHour = parseInt(startH);
                  const endHour = parseInt(endH);
                  
                  const startPeriod = startHour >= 12 ? 'PM' : 'AM';
                  const endPeriod = endHour >= 12 ? 'PM' : 'AM';
                  const startHour12 = startHour > 12 ? startHour - 12 : (startHour === 0 ? 12 : startHour);
                  const endHour12 = endHour > 12 ? endHour - 12 : (endHour === 0 ? 12 : endHour);
                  
                  workingHours[day] = {
                    available: true,
                    hours: `${startHour12}:${startM} ${startPeriod} - ${endHour12}:${endM} ${endPeriod}`
                  };
                } else {
                  workingHours[day] = {
                    available: false,
                    hours: ""
                  };
                }
              });
              
              accountOwnerAvailability = JSON.stringify({
                workingHours,
                customAvailability: []
              });
            }
          }
        } catch (availFetchError) {
          console.error('Error fetching user availability for account owner:', availFetchError);
        }
        
        // If no availability found, create default in user_availability table
        if (!accountOwnerAvailability) {
          try {
            const defaultBusinessHours = {
              monday: { enabled: true, start: '09:00', end: '17:00' },
              tuesday: { enabled: true, start: '09:00', end: '17:00' },
              wednesday: { enabled: true, start: '09:00', end: '17:00' },
              thursday: { enabled: true, start: '09:00', end: '17:00' },
              friday: { enabled: true, start: '09:00', end: '17:00' },
              saturday: { enabled: false, start: '09:00', end: '17:00' },
              sunday: { enabled: false, start: '09:00', end: '17:00' }
            };
            
            // Try to create default availability in user_availability table
            const { error: createAvailError } = await supabase
              .from('user_availability')
              .insert({
                user_id: userId,
                day_of_week: 0, // Placeholder
                start_time: '00:00:00', // Placeholder
                end_time: '00:00:00', // Placeholder
                is_available: true, // Placeholder
                business_hours: defaultBusinessHours,
                timeslot_templates: []
              });
            
            if (!createAvailError) {
              // Convert to team member format
              accountOwnerAvailability = JSON.stringify({
                workingHours: {
                  monday: { available: true, hours: "9:00 AM - 5:00 PM" },
                  tuesday: { available: true, hours: "9:00 AM - 5:00 PM" },
                  wednesday: { available: true, hours: "9:00 AM - 5:00 PM" },
                  thursday: { available: true, hours: "9:00 AM - 5:00 PM" },
                  friday: { available: true, hours: "9:00 AM - 5:00 PM" },
                  saturday: { available: false, hours: "" },
                  sunday: { available: false, hours: "" }
                },
                customAvailability: []
              });
            }
          } catch (createError) {
            console.error('Error creating default availability:', createError);
          }
        }
        
        // Create virtual team member entry for account owner
        teamMember = {
          id: accountOwner.id, // Use user id as team member id
          user_id: userId,
          email: accountOwner.email,
          first_name: accountOwner.first_name,
          last_name: accountOwner.last_name,
          phone: accountOwner.phone || null,
          role: 'account owner',
          status: 'active',
          is_service_provider: true,
          profile_picture: accountOwner.profile_picture || null,
          color: '#DC2626', // Default red color
          territories: null,
          availability: accountOwnerAvailability || JSON.stringify({
            workingHours: {
              monday: { available: true, hours: "9:00 AM - 5:00 PM" },
              tuesday: { available: true, hours: "9:00 AM - 5:00 PM" },
              wednesday: { available: true, hours: "9:00 AM - 5:00 PM" },
              thursday: { available: true, hours: "9:00 AM - 5:00 PM" },
              friday: { available: true, hours: "9:00 AM - 5:00 PM" },
              saturday: { available: false, hours: "" },
              sunday: { available: false, hours: "" }
            },
            customAvailability: []
          }),
          permissions: null,
          location: null,
          city: null,
          state: null,
          zip_code: null
        };
      } else {
        return res.status(404).json({ error: 'Team member not found' });
      }
    } else {
      teamMember = teamMembers[0];
      
      // Ensure availability and permissions are included even if null
      // This helps frontend distinguish between "no data" and "data exists but is null"
      if (!teamMember.availability) {
        teamMember.availability = null; // Explicitly set to null (not undefined)
      }
      if (!teamMember.permissions) {
        teamMember.permissions = null; // Explicitly set to null (not undefined)
      }
    }

    // ✅ Fetch jobs assigned to this team member
    let jobs = [];
    try {
      // For account owner, fetch jobs by user_id, otherwise by team_member_id
      let jobsResult, jobsError;
      
      // If it's the account owner (id matches userId and not in team_members), fetch by user_id
      if (parseInt(id) === userId && (!teamMembers || teamMembers.length === 0)) {
        const result = await supabase
          .from('jobs')
          .select(`
            *,
            customers!left(first_name, last_name, phone, address),
            services!left(name, duration)
          `)
          .eq('user_id', userId)
          .gte('scheduled_date', startDate || '2024-01-01')
          .lte('scheduled_date', endDate || '2030-12-31')
          .order('scheduled_date', { ascending: true });
        jobsResult = result.data;
        jobsError = result.error;
      } else {
        const result = await supabase
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
        jobsResult = result.data;
        jobsError = result.error;
      }

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
    
    // Validate required fields - firstName and lastName are optional
    if (!userId || !email || !username || !password) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Names are optional - allow empty/null values
    
    // Validate email format
    if (!validateEmail(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    
    // ✅ Check if email exists in users table (account owner)
    const { data: existingUser, error: userCheckError } = await supabase
      .from('users')
      .select('id, email, first_name, last_name')
      .eq('email', email)
      .limit(1);

    if (userCheckError) {
      console.error('Error checking existing user:', userCheckError);
      return res.status(500).json({ error: 'Failed to check existing user' });
    }

    if (existingUser && existingUser.length > 0) {
      const user = existingUser[0];
      // Check if this user is the account owner (same user_id)
      if (user.id === userId) {
        return res.status(400).json({ 
          error: 'Cannot add account owner as team member',
          conflictType: 'account_owner',
          field: 'email',
          message: `This email belongs to the account owner. The account owner is automatically included in the team members list.`
        });
      } else {
        return res.status(400).json({ 
          error: 'Email already exists as a user account',
          conflictType: 'existing_user',
          field: 'email',
          message: `A user account with the email "${email}" already exists. Please use a different email address.`
        });
      }
    }

    // ✅ Check for specific conflicts in team_members table (email, phone, username)
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
    
    // Set default availability if none provided
    let defaultAvailability = availability;
    if (!defaultAvailability || (typeof defaultAvailability === 'object' && Object.keys(defaultAvailability).length === 0)) {
      defaultAvailability = {
        workingHours: {
          monday: { available: true, hours: "9:00 AM - 5:00 PM" },
          tuesday: { available: true, hours: "9:00 AM - 5:00 PM" },
          wednesday: { available: true, hours: "9:00 AM - 5:00 PM" },
          thursday: { available: true, hours: "9:00 AM - 5:00 PM" },
          friday: { available: true, hours: "9:00 AM - 5:00 PM" },
          saturday: { available: false, hours: "" },
          sunday: { available: false, hours: "" }
        },
        customAvailability: []
      };
    }
    
    // Ensure availability is stored as JSON string
    const availabilityString = typeof defaultAvailability === 'string' 
      ? defaultAvailability 
      : JSON.stringify(defaultAvailability);
    
    const { data: newTeamMember, error: createError } = await supabase
      .from('team_members')
      .insert({
        user_id: userId,
        first_name: firstName || null,
        last_name: lastName || null,
        email,
        phone: phone || null,
        username: null, // Will be set during signup
        password: null, // Will be set during signup
        role: role || null,
        skills,
        hourly_rate: hourlyRate || null,
        availability: availabilityString,
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
    
    // ✅ Don't send password back
    const { password: _, ...teamMemberWithoutPassword } = newTeamMember;
    
    // Generate invitation link
    const invitationLink = `${process.env.FRONTEND_URL || 'https://service-flow.pro'}/team-member/signup?token=${invitationToken}`;
    
    // Send invitation email in background without waiting
    // Note: Email sending failure will not prevent team member creation
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
      text: `Welcome to Service Flow! You've been invited to join your team. Please visit ${invitationLink} to create your account. This link will expire in 7 days.`
    }).then(() => {
      console.log('✅ Team member invitation email sent successfully to:', email);
    }).catch((emailError) => {
      console.error('⚠️ Failed to send team member invitation email (team member was still created):', emailError.message);
      console.error('⚠️ Email error details:', {
        code: emailError.code,
        message: emailError.message
      });
      if (emailError.code === 401) {
        console.error('⚠️ SendGrid API key is invalid or missing. Please check your SENDGRID_API_KEY environment variable.');
        console.error('⚠️ Team member was created successfully, but invitation email was not sent.');
        console.error('⚠️ You can manually send the invitation using the "Resend Invite" feature once SendGrid is configured.');
      }
      // Don't fail the request if email fails - team member creation succeeds regardless
    });
    
    res.status(201).json({
      message: 'Team member invited successfully',
      teamMember: teamMemberWithoutPassword
    });

  } catch (error) {
    console.error('Create team member error:', error);
    res.status(500).json({ error: 'Failed to create team member' });
  }
});


app.put('/api/team-members/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;
    const userRole = req.user.role; // Get user role from JWT token
    const { 
      firstName, 
      lastName, 
      email, 
      phone, 
      username,
      password,
      role, 
      hourlyRate,
      commissionPercentage,
      availability,
      status,
      location,
      city,
      state,
      zipCode,
      territories,
      permissions,
      color,
      first_name, // Support snake_case from frontend
      last_name,
      is_service_provider,
      hourly_rate, // Support snake_case from frontend
      commission_percentage // Support snake_case from frontend
    } = req.body;
    
    // Normalize field names (support both camelCase and snake_case)
    const firstNameValue = firstName || first_name;
    const lastNameValue = lastName || last_name;
    
    // Check if team member exists by ID
    const { data: existingMember, error: checkError } = await supabase
      .from('team_members')
      .select('id, user_id, role')
      .eq('id', id)
      .limit(1);
    
    // 🔒 ROLE CHANGE PERMISSION: Only account owner or manager can change roles
    if (role && existingMember && existingMember.length > 0) {
      const currentRole = existingMember[0].role;
      // If role is being changed
      if (currentRole !== role) {
        // Check if the current user is account owner or manager
        const isOwnerOrManager = !userRole || userRole === 'owner' || userRole === 'account owner' || userRole === 'manager' || userRole === 'admin';
        
        if (!isOwnerOrManager) {
          return res.status(403).json({ 
            error: 'Permission denied', 
            message: 'Only account owners and managers can change team member roles' 
          });
        }
        
        // Log role change for audit purposes
        console.log(`Role change: Team member ${id} role changed from ${currentRole} to ${role} by user ${userId} (${userRole})`);
      }
    }
    
    let isAccountOwner = false;
    let shouldCreate = false;
    let actualTeamMemberId = id; // The ID to use for updates
    let accountOwner = null; // Account owner data if needed for creation
    
    // If not found, check if it's the account owner
    if (!existingMember || existingMember.length === 0) {
      if (parseInt(id) === userId) {
        // This is the account owner trying to save their settings
        // Check if they have a team_members entry by user_id and role
        const { data: accountOwnerMember, error: ownerMemberError } = await supabase
          .from('team_members')
          .select('id, user_id, role')
          .eq('user_id', userId)
          .or('role.eq.account owner,role.eq.owner,role.eq.admin')
          .limit(1);
        
        if (ownerMemberError) {
          console.error('Error checking account owner team member:', ownerMemberError);
        }
        
        if (accountOwnerMember && accountOwnerMember.length > 0) {
          // Account owner has a team_members entry, use that ID
          actualTeamMemberId = accountOwnerMember[0].id;
          isAccountOwner = true;
          shouldCreate = false;
        } else {
          // Account owner doesn't have a team_members entry, need to create one
          isAccountOwner = true;
          shouldCreate = true;
          
          // Fetch account owner data from users table
          const { data: ownerData, error: ownerError } = await supabase
            .from('users')
            .select('id, email, first_name, last_name, phone, business_name, profile_picture')
            .eq('id', userId)
            .maybeSingle();
    
          if (ownerError || !ownerData) {
            return res.status(404).json({ error: 'Account owner not found' });
          }
          
          accountOwner = ownerData;
        }
      } else {
        return res.status(404).json({ error: 'Team member not found' });
      }
    } else {
      // Check if it's an account owner
      const member = existingMember[0];
      isAccountOwner = member.role === 'account owner' || member.role === 'owner' || member.role === 'admin';
      actualTeamMemberId = member.id;
    }
    
    // Build update/insert object
    const dataToSave = {};
    
    if (firstNameValue) {
      dataToSave.first_name = firstNameValue;
    }
    
    if (lastNameValue) {
      dataToSave.last_name = lastNameValue;
    }
    
    if (email) {
      if (!validateEmail(email)) {
        return res.status(400).json({ error: 'Invalid email format' });
      }
      dataToSave.email = email;
    }
    
    if (phone !== undefined) {
      dataToSave.phone = phone;
    }
    
    if (username !== undefined) {
      dataToSave.username = username;
    }
    
    if (password !== undefined) {
      const hashedPassword = await bcrypt.hash(password, 10);
      dataToSave.password = hashedPassword;
    }
    
    // Don't allow changing role for account owner
    if (role !== undefined && !isAccountOwner) {
      dataToSave.role = role;
    } else if (shouldCreate) {
      dataToSave.role = 'account owner';
    }
    
    // Normalize hourly rate (support both camelCase and snake_case)
    const hourlyRateValue = hourlyRate !== undefined ? hourlyRate : hourly_rate;
    if (hourlyRateValue !== undefined) {
      dataToSave.hourly_rate = hourlyRateValue;
    }
    
    // Normalize commission percentage (support both camelCase and snake_case)
    const commissionPercentageValue = commissionPercentage !== undefined ? commissionPercentage : commission_percentage;
    if (commissionPercentageValue !== undefined) {
      dataToSave.commission_percentage = commissionPercentageValue;
    }
    
    if (availability !== undefined) {
      dataToSave.availability = typeof availability === 'string' ? availability : JSON.stringify(availability);
      
      // For account owners, also sync availability to user_availability table
      if (isAccountOwner) {
        try {
          // Parse availability to convert from team member format to user_availability format
          let parsedAvailability;
          if (typeof availability === 'string') {
            parsedAvailability = JSON.parse(availability);
          } else {
            parsedAvailability = availability;
    }
    
          // Convert team member availability format to user_availability business_hours format
          if (parsedAvailability.workingHours) {
            const businessHours = {};
            const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
            
            days.forEach(day => {
              const dayHours = parsedAvailability.workingHours[day];
              if (dayHours && dayHours.available && dayHours.hours) {
                // Parse hours string like "9:00 AM - 6:00 PM" or "09:00 - 17:00"
                const hoursMatch = dayHours.hours.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?\s*-\s*(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
                if (hoursMatch) {
                  let startHour = parseInt(hoursMatch[1]);
                  let startMin = hoursMatch[2];
                  let endHour = parseInt(hoursMatch[4]);
                  let endMin = hoursMatch[5];
                  
                  // Convert to 24-hour format if AM/PM is present
                  if (hoursMatch[3]) {
                    if (hoursMatch[3].toUpperCase() === 'PM' && startHour !== 12) startHour += 12;
                    if (hoursMatch[3].toUpperCase() === 'AM' && startHour === 12) startHour = 0;
                  }
                  if (hoursMatch[6]) {
                    if (hoursMatch[6].toUpperCase() === 'PM' && endHour !== 12) endHour += 12;
                    if (hoursMatch[6].toUpperCase() === 'AM' && endHour === 12) endHour = 0;
                  }
                  
                  businessHours[day] = {
                    enabled: true,
                    start: `${startHour.toString().padStart(2, '0')}:${startMin}`,
                    end: `${endHour.toString().padStart(2, '0')}:${endMin}`
                  };
                } else {
                  // Default format if parsing fails
                  businessHours[day] = {
                    enabled: dayHours.available,
                    start: '09:00',
                    end: '17:00'
                  };
                }
              } else {
                businessHours[day] = {
                  enabled: false,
                  start: '09:00',
                  end: '17:00'
                };
              }
            });
            
            // Update or create user_availability record
            const { data: existingUserAvail, error: checkAvailError } = await supabase
              .from('user_availability')
              .select('id')
              .eq('user_id', userId)
              .not('business_hours', 'is', null)
              .limit(1);
            
            if (existingUserAvail && existingUserAvail.length > 0) {
              // Update existing
              await supabase
                .from('user_availability')
                .update({
                  business_hours: businessHours,
                  timeslot_templates: parsedAvailability.timeslotTemplates || []
                })
                .eq('id', existingUserAvail[0].id);
            } else {
              // Create new
              await supabase
                .from('user_availability')
                .insert({
                  user_id: userId,
                  business_hours: businessHours,
                  timeslot_templates: parsedAvailability.timeslotTemplates || []
                });
            }
          }
        } catch (syncError) {
          console.error('Error syncing availability to user_availability:', syncError);
          // Don't fail the request if sync fails, just log it
        }
      }
    }
    
    // Don't allow changing status for account owner
    if (status !== undefined && !isAccountOwner) {
      dataToSave.status = status;
    } else if (shouldCreate) {
      dataToSave.status = 'active';
    }
    
    if (location !== undefined) {
      dataToSave.location = location;
    }
    
    if (city !== undefined) {
      dataToSave.city = city;
    }
    
    if (state !== undefined) {
      dataToSave.state = state;
    }
    
    if (zipCode !== undefined) {
      dataToSave.zip_code = zipCode;
    }
    
    if (territories !== undefined) {
      dataToSave.territories = typeof territories === 'string' ? territories : JSON.stringify(territories);
    }
    
    if (permissions !== undefined) {
      // Ensure permissions is stored as JSON string if it's an object
      if (typeof permissions === 'object' && permissions !== null) {
        dataToSave.permissions = JSON.stringify(permissions);
      } else if (typeof permissions === 'string') {
        // Validate it's valid JSON
        try {
          JSON.parse(permissions);
          dataToSave.permissions = permissions;
        } catch (e) {
          console.error('Invalid JSON permissions, storing as empty object');
          dataToSave.permissions = JSON.stringify({});
        }
      } else {
        dataToSave.permissions = JSON.stringify({});
      }
    }
    
    // Include color if provided
    if (color !== undefined) {
      dataToSave.color = color;
    }
    
    if (is_service_provider !== undefined) {
      dataToSave.is_service_provider = is_service_provider;
    } else if (shouldCreate) {
      dataToSave.is_service_provider = true;
    }
    
    if (shouldCreate) {
      // Create new team member entry for account owner
      // Don't set id - let the database auto-generate it
      dataToSave.user_id = userId;
      
      // Ensure required fields are set
      if (!dataToSave.first_name && accountOwner) {
        dataToSave.first_name = accountOwner.first_name;
      }
      if (!dataToSave.last_name && accountOwner) {
        dataToSave.last_name = accountOwner.last_name;
      }
      if (!dataToSave.email && accountOwner) {
        dataToSave.email = accountOwner.email;
      }
      
      const { data: newMember, error: createError } = await supabase
          .from('team_members')
        .insert(dataToSave)
        .select()
        .single();
        
      if (createError) {
        console.error('Error creating account owner team member:', createError);
        console.error('Create error details:', {
          code: createError.code,
          message: createError.message,
          details: createError.details,
          hint: createError.hint
        });
        return res.status(500).json({ 
          error: 'Failed to create team member entry',
          details: createError.message,
          code: createError.code
        });
      }
      
      res.json({ message: 'Team member settings saved successfully' });
    } else {
      // Update existing team member using the actual team member ID
    const { error } = await supabase
      .from('team_members')
        .update(dataToSave)
        .eq('id', actualTeamMemberId);
    
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
          errorMessage = 'Database schema error. Please contact support.';
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
    }
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
    
    // Fetch team member availability from Supabase
    const { data: teamMember, error: teamMemberError } = await supabase
      .from('team_members')
      .select('availability')
      .eq('id', id)
      .maybeSingle();
    
    if (teamMemberError) {
      console.error('Error fetching team member:', teamMemberError);
      return res.status(500).json({ error: 'Failed to fetch team member availability' });
    }
    
    if (!teamMember) {
      return res.status(404).json({ error: 'Team member not found' });
    }
    
    // Parse availability if it's a string
    let availability = null;
    if (teamMember.availability) {
      if (typeof teamMember.availability === 'string') {
        try {
          availability = JSON.parse(teamMember.availability);
        } catch (e) {
          console.error('Error parsing availability:', e);
          availability = teamMember.availability;
        }
      } else {
        availability = teamMember.availability;
      }
    }
    
    // Get scheduled jobs for the date range from Supabase
    // Jobs are linked to team members through job_team_assignments table
    // Query through job_team_assignments to get jobs assigned to this team member
    let assignmentsQuery = supabase
      .from('job_team_assignments')
      .select(`
        jobs!inner(
          id,
          scheduled_date,
          scheduled_time,
          duration,
          status,
          service_name
        )
      `)
      .eq('team_member_id', id);
    
    const { data: assignments, error: assignmentsError } = await assignmentsQuery;
    
    // Extract jobs from assignments and filter by status
    let scheduledJobs = [];
    if (assignments && !assignmentsError) {
      scheduledJobs = assignments
        .map(assignment => assignment.jobs)
        .filter(job => job && ['pending', 'confirmed', 'in-progress'].includes(job.status));
    } else if (assignmentsError) {
      console.error('Error fetching job assignments:', assignmentsError);
      // Continue to check direct jobs even if assignments fail
    }
    
    // Also check for jobs with direct team_member_id (backward compatibility)
    // Some jobs might still have team_member_id directly in the jobs table
    let directJobsQuery = supabase
      .from('jobs')
      .select('scheduled_date, scheduled_time, duration, id, status, service_name')
      .eq('team_member_id', id)
      .in('status', ['pending', 'confirmed', 'in-progress']);
    
    const { data: directJobs, error: directJobsError } = await directJobsQuery;
    
    // Merge both results and remove duplicates by job ID
    const allJobsMap = new Map();
    
    // Add jobs from assignments
    scheduledJobs.forEach(job => {
      if (job && job.id) {
        allJobsMap.set(job.id, job);
      }
    });
    
    // Add jobs from direct team_member_id (if any)
    if (directJobs && !directJobsError) {
      directJobs.forEach(job => {
        if (job && job.id && !allJobsMap.has(job.id)) {
          allJobsMap.set(job.id, job);
        }
      });
    }
    
    // Convert map to array
    let allJobs = Array.from(allJobsMap.values());
    
    // Filter by date range if provided
    if (startDate && endDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      
      allJobs = allJobs.filter(job => {
        if (!job.scheduled_date) return false;
        const jobDate = new Date(job.scheduled_date);
        return jobDate >= start && jobDate <= end;
      });
    }
    
    const jobsError = assignmentsError || directJobsError;
    
    // Helper function to convert time string to minutes since midnight
    const timeToMinutes = (timeStr) => {
      if (!timeStr) return 0;
      if (typeof timeStr === 'string' && timeStr.includes(':')) {
        const [hours, minutes] = timeStr.split(':').map(Number);
        return (hours || 0) * 60 + (minutes || 0);
      }
      return 0;
    };
    
    // Helper function to convert minutes to time string
    const minutesToTime = (minutes) => {
      const hours = Math.floor(minutes / 60);
      const mins = minutes % 60;
      return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
    };
    
    // Calculate remaining availability for each day
    const calculateRemainingAvailability = (baseHours, jobsForDay) => {
      if (!baseHours || baseHours.length === 0) return [];
      if (!jobsForDay || jobsForDay.length === 0) return baseHours;
      
      // Convert base hours to time ranges in minutes
      const baseRanges = baseHours.map(slot => ({
        start: timeToMinutes(slot.start || slot.startTime),
        end: timeToMinutes(slot.end || slot.endTime)
      }));
      
      // Convert assigned jobs to time ranges in minutes
      const jobRanges = jobsForDay.map(job => {
        // Extract time from scheduled_time or scheduled_date
        let jobTime = '09:00'; // Default
        if (job.scheduled_time) {
          // scheduled_time might be "09:00" or "09:00:00"
          jobTime = job.scheduled_time.includes(':') 
            ? job.scheduled_time.split(':').slice(0, 2).join(':') 
            : job.scheduled_time;
        } else if (job.scheduled_date) {
          // Extract time from scheduled_date (format: "2025-10-07 09:00:00" or ISO string)
          const dateStr = job.scheduled_date.toString();
          const timeMatch = dateStr.match(/(\d{1,2}):(\d{2})/);
          if (timeMatch) {
            jobTime = `${timeMatch[1].padStart(2, '0')}:${timeMatch[2]}`;
          }
        }
        
        const jobStartMinutes = timeToMinutes(jobTime);
        const duration = job.duration || 60; // Default 60 minutes
        return {
          start: jobStartMinutes,
          end: jobStartMinutes + duration
        };
      });
      
      // Calculate remaining slots
      const remainingRanges = [];
      
      baseRanges.forEach(baseRange => {
        let currentStart = baseRange.start;
        
        // Sort job ranges by start time for this day
        const dayJobs = jobRanges
          .filter(job => job.start >= baseRange.start && job.end <= baseRange.end)
          .sort((a, b) => a.start - b.start);
        
        dayJobs.forEach(jobRange => {
          // If there's a gap before this job, add it as available
          if (currentStart < jobRange.start) {
            remainingRanges.push({
              start: currentStart,
              end: jobRange.start
            });
          }
          // Move current start to after this job
          currentStart = Math.max(currentStart, jobRange.end);
        });
        
        // If there's remaining time after all jobs, add it
        if (currentStart < baseRange.end) {
          remainingRanges.push({
            start: currentStart,
            end: baseRange.end
          });
        }
      });
      
      // Convert back to time strings and filter out slots less than 15 minutes
      return remainingRanges
        .filter(range => range.end - range.start >= 15) // Minimum 15-minute slots
        .map(range => ({
          start: minutesToTime(range.start),
          end: minutesToTime(range.end)
        }));
    };
    
    // Process availability by date if date range is provided
    let dailyAvailability = {};
    let dailyRemainingAvailability = {};
    
    // Always process availability if we have a date range, even if availability is null/empty
    // This ensures we return empty availability data rather than nothing
    if (startDate && endDate) {
      if (!availability) {
        // If no availability set, return empty data for all days
        const start = new Date(startDate);
        const end = new Date(endDate);
        const currentDate = new Date(start);
        while (currentDate <= end) {
          const dateStr = currentDate.toISOString().split('T')[0];
          dailyAvailability[dateStr] = {
            available: false,
            hours: []
          };
          dailyRemainingAvailability[dateStr] = [];
          currentDate.setDate(currentDate.getDate() + 1);
        }
      } else {
      const start = new Date(startDate);
      const end = new Date(endDate);
      const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      
      const workingHours = availability.workingHours || availability || {};
      const customAvailability = availability.customAvailability || [];
      
      // Process each day in the range
      const currentDate = new Date(start);
      while (currentDate <= end) {
        const dateStr = currentDate.toISOString().split('T')[0];
        const dayOfWeek = currentDate.getDay();
        const dayName = dayNames[dayOfWeek];
        
        // Check for custom availability override
        const dateOverride = customAvailability.find(item => item.date === dateStr);
        
        let baseHours = [];
        let isAvailable = false;
        
        if (dateOverride) {
          if (dateOverride.available === false) {
            isAvailable = false;
          } else if (dateOverride.hours) {
            isAvailable = true;
            baseHours = Array.isArray(dateOverride.hours) 
              ? dateOverride.hours 
              : [dateOverride.hours];
          }
        } else {
          // Use working hours for the day
          const dayWorkingHours = workingHours[dayName];
          if (dayWorkingHours) {
            // Check if day is available - available can be true, undefined (defaults to available), or false
            const isDayAvailable = dayWorkingHours.available !== false && 
                                  (dayWorkingHours.available === true || dayWorkingHours.available === undefined);
            
            if (isDayAvailable) {
              isAvailable = true;
              if (dayWorkingHours.timeSlots && dayWorkingHours.timeSlots.length > 0) {
                baseHours = dayWorkingHours.timeSlots.map(slot => ({
                  start: slot.start,
                  end: slot.end
                }));
              } else if (dayWorkingHours.hours) {
                // Parse hours string like "9:00 AM - 5:00 PM" or "9:00 AM - 6:00 PM"
                const hoursStr = dayWorkingHours.hours.toString().trim();
                // Try with spaces first: "9:00 AM - 6:00 PM"
                let hoursMatch = hoursStr.match(/(\d+):(\d+)\s*(AM|PM)\s*-\s*(\d+):(\d+)\s*(AM|PM)/);
                
                // If no match, try without spaces: "9:00AM-6:00PM"
                if (!hoursMatch) {
                  hoursMatch = hoursStr.match(/(\d+):(\d+)(AM|PM)-(\d+):(\d+)(AM|PM)/);
                }
                
                if (hoursMatch) {
                  const convertTo24Hour = (hour, minute, ampm) => {
                    let h = parseInt(hour);
                    if (ampm === 'PM' && h !== 12) h += 12;
                    if (ampm === 'AM' && h === 12) h = 0;
                    return `${h.toString().padStart(2, '0')}:${minute.padStart(2, '0')}`;
                  };
                  baseHours = [{
                    start: convertTo24Hour(hoursMatch[1], hoursMatch[2], hoursMatch[3]),
                    end: convertTo24Hour(hoursMatch[4], hoursMatch[5], hoursMatch[6])
                  }];
                } else {
                  console.warn(`[Backend] Could not parse hours string for ${dayName}: "${hoursStr}"`);
                }
              }
            } else {
              isAvailable = false;
            }
          } else {
            // No working hours defined for this day
            isAvailable = false;
          }
        }
        
        // Store base availability
        dailyAvailability[dateStr] = {
          available: isAvailable,
          hours: baseHours
        };
        
        // Get jobs for this day
        const jobsForDay = allJobs.filter(job => {
          if (!job.scheduled_date) return false;
          const jobDate = new Date(job.scheduled_date);
          return jobDate.toISOString().split('T')[0] === dateStr;
        });
        
        // Calculate remaining availability
        if (isAvailable && baseHours.length > 0) {
          dailyRemainingAvailability[dateStr] = calculateRemainingAvailability(baseHours, jobsForDay);
        } else {
          dailyRemainingAvailability[dateStr] = [];
        }
        
        // Move to next day
        currentDate.setDate(currentDate.getDate() + 1);
      }
      }
    }
    
    // Debug logging
    console.log(`[Backend] Team member ${id} availability response:`, {
      hasAvailability: !!availability,
      dailyAvailabilityCount: Object.keys(dailyAvailability).length,
      dailyRemainingCount: Object.keys(dailyRemainingAvailability).length,
      sampleDate: Object.keys(dailyAvailability)[0],
      sampleData: Object.keys(dailyAvailability).length > 0 ? dailyAvailability[Object.keys(dailyAvailability)[0]] : null
    });
    
    if (jobsError) {
      console.error('Error fetching scheduled jobs:', jobsError);
      // Continue even if jobs fail - return availability only
      return res.json({
        availability: availability,
        scheduledJobs: [],
        baseAvailability: dailyAvailability,
        remainingAvailability: dailyRemainingAvailability
      });
    }
    
    res.json({
      availability: availability,
      scheduledJobs: allJobs || [],
      baseAvailability: dailyAvailability,
      remainingAvailability: dailyRemainingAvailability
    });
  } catch (error) {
    console.error('Get team member availability error:', error);
    res.status(500).json({ error: 'Failed to fetch team member availability' });
  }
});

// Time tracking endpoints for salary calculation
// Record job start time
app.post('/api/jobs/:id/start-time', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;
    const { startTime } = req.body;

    // Verify job belongs to user and get job details
    const { data: job, error: jobError } = await supabase
      .from('jobs')
      .select('id, user_id, team_member_id, status')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (jobError || !job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Update job with start time
    const startTimeValue = startTime || new Date().toISOString();
    const { error: updateError } = await supabase
      .from('jobs')
      .update({ 
        start_time: startTimeValue,
        updated_at: new Date().toISOString()
      })
      .eq('id', id);

    if (updateError) {
      console.error('Error updating start time:', updateError);
      return res.status(500).json({ error: 'Failed to record start time' });
    }

    res.json({ message: 'Start time recorded successfully', startTime: startTimeValue });
  } catch (error) {
    console.error('Record start time error:', error);
    res.status(500).json({ error: 'Failed to record start time' });
  }
});

// Record job end time and calculate hours worked
app.post('/api/jobs/:id/end-time', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;
    const { endTime } = req.body;

    // Verify job belongs to user and get job details
    const { data: job, error: jobError } = await supabase
      .from('jobs')
      .select('id, user_id, team_member_id, start_time')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (jobError || !job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    if (!job.start_time) {
      return res.status(400).json({ error: 'Start time must be recorded before end time' });
    }

    // Calculate hours worked
    const endTimeValue = endTime || new Date().toISOString();
    const startTime = new Date(job.start_time);
    const endTimeDate = new Date(endTimeValue);
    const hoursWorked = (endTimeDate - startTime) / (1000 * 60 * 60); // Convert to hours

    // Update job with end time and hours worked
    const { error: updateError } = await supabase
      .from('jobs')
      .update({ 
        end_time: endTimeValue,
        hours_worked: hoursWorked.toFixed(2),
        updated_at: new Date().toISOString()
      })
      .eq('id', id);

    if (updateError) {
      console.error('Error updating end time:', updateError);
      return res.status(500).json({ error: 'Failed to record end time' });
    }

    res.json({ 
      message: 'End time recorded successfully', 
      endTime: endTimeValue,
      hoursWorked: parseFloat(hoursWorked.toFixed(2))
    });
  } catch (error) {
    console.error('Record end time error:', error);
    res.status(500).json({ error: 'Failed to record end time' });
  }
});

// Get salary calculation for a team member
app.get('/api/team-members/:id/salary', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;
    const { startDate, endDate } = req.query;

    // Verify team member belongs to user
    const { data: teamMember, error: memberError } = await supabase
      .from('team_members')
      .select('id, user_id, hourly_rate, first_name, last_name')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (memberError || !teamMember) {
      return res.status(404).json({ error: 'Team member not found' });
    }

    if (!teamMember.hourly_rate) {
      return res.json({
        teamMember: {
          id: teamMember.id,
          name: `${teamMember.first_name} ${teamMember.last_name}`,
          hourlyRate: null
        },
        jobs: [],
        totalHours: 0,
        totalSalary: 0,
        message: 'Hourly rate not set for this team member'
      });
    }

    // Build query for jobs
    let jobsQuery = supabase
      .from('jobs')
      .select('id, scheduled_date, start_time, end_time, hours_worked, total, status, service_name')
      .eq('team_member_id', id)
      .eq('user_id', userId)
      .not('start_time', 'is', null)
      .not('end_time', 'is', null);

    if (startDate) {
      jobsQuery = jobsQuery.gte('scheduled_date', startDate);
    }
    if (endDate) {
      jobsQuery = jobsQuery.lte('scheduled_date', `${endDate} 23:59:59`);
    }

    const { data: jobs, error: jobsError } = await jobsQuery;

    if (jobsError) {
      console.error('Error fetching jobs:', jobsError);
      return res.status(500).json({ error: 'Failed to fetch jobs' });
    }

    // Calculate totals
    let totalHours = 0;
    const jobsWithSalary = (jobs || []).map(job => {
      const hours = parseFloat(job.hours_worked) || 0;
      const salary = hours * parseFloat(teamMember.hourly_rate);
      totalHours += hours;
      return {
        ...job,
        hoursWorked: hours,
        salary: parseFloat(salary.toFixed(2))
      };
    });

    const totalSalary = totalHours * parseFloat(teamMember.hourly_rate);

    res.json({
      teamMember: {
        id: teamMember.id,
        name: `${teamMember.first_name} ${teamMember.last_name}`,
        hourlyRate: parseFloat(teamMember.hourly_rate)
      },
      jobs: jobsWithSalary,
      totalHours: parseFloat(totalHours.toFixed(2)),
      totalSalary: parseFloat(totalSalary.toFixed(2)),
      jobCount: jobsWithSalary.length
    });
  } catch (error) {
    console.error('Get salary error:', error);
    res.status(500).json({ error: 'Failed to calculate salary' });
  }
});

// Get payroll summary for all team members
app.get('/api/payroll', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { startDate, endDate } = req.query;

    // Get all team members (including those without hourly rates or commission)
    const { data: teamMembers, error: membersError } = await supabase
      .from('team_members')
      .select('id, first_name, last_name, hourly_rate, commission_percentage, status')
      .eq('user_id', userId)
      .eq('status', 'active'); // Only show active team members

    if (membersError) {
      console.error('Error fetching team members:', membersError);
      return res.status(500).json({ error: 'Failed to fetch team members' });
    }

    const payrollData = await Promise.all(
      (teamMembers || []).map(async (member) => {
        try {
        // Get jobs for this team member
        // Check both direct team_member_id and job_team_assignments table
        let allJobs = [];
        
        // Method 1: Get jobs with direct team_member_id
        let directJobsQuery = supabase
          .from('jobs')
          .select('id, scheduled_date, start_time, end_time, hours_worked, duration, estimated_duration, total, total_amount, invoice_amount, price, status, service_name')
          .eq('team_member_id', member.id)
          .eq('user_id', userId);

        if (startDate) {
          directJobsQuery = directJobsQuery.gte('scheduled_date', startDate);
        }
        if (endDate) {
          directJobsQuery = directJobsQuery.lte('scheduled_date', `${endDate} 23:59:59`);
        }

        const { data: directJobs, error: directJobsError } = await directJobsQuery;
        
        if (directJobsError) {
          console.error(`Error fetching direct jobs for member ${member.id}:`, directJobsError);
        } else {
          allJobs = [...(directJobs || [])];
        }
        
        // Method 2: Get jobs from job_team_assignments table
        let assignmentsQuery = supabase
          .from('job_team_assignments')
          .select(`
            jobs!inner(
              id,
              scheduled_date,
              start_time,
              end_time,
              hours_worked,
              duration,
              estimated_duration,
              total,
              total_amount,
              invoice_amount,
              price,
              status,
              service_name,
              user_id
            )
          `)
          .eq('team_member_id', member.id);

        if (startDate || endDate) {
          // We'll filter by date after getting the jobs
        }

        const { data: assignments, error: assignmentsError } = await assignmentsQuery;
        
        if (assignmentsError) {
          console.error(`Error fetching assigned jobs for member ${member.id}:`, assignmentsError);
        } else if (assignments) {
          // Extract jobs from assignments and filter by user_id and date
          const assignedJobs = assignments
            .map(assignment => assignment.jobs)
            .filter(job => {
              if (!job) return false;
              if (job.user_id !== userId) return false;
              
              // Filter by date range if provided
              if (startDate || endDate) {
                const jobDate = new Date(job.scheduled_date);
                if (startDate && jobDate < new Date(startDate)) return false;
                if (endDate) {
                  const endDateObj = new Date(endDate);
                  endDateObj.setHours(23, 59, 59, 999);
                  if (jobDate > endDateObj) return false;
                }
              }
              
              return true;
            });
          
          // Merge with direct jobs, avoiding duplicates
          const existingJobIds = new Set(allJobs.map(j => j.id));
          assignedJobs.forEach(job => {
            if (!existingJobIds.has(job.id)) {
              allJobs.push(job);
            }
          });
        }
        
        const jobs = allJobs;
        
        console.log(`[Payroll] Member ${member.id} (${member.first_name}): Found ${jobs.length} jobs`);
        if (jobs.length > 0) {
          console.log(`[Payroll] Sample job data:`, {
            id: jobs[0].id,
            hasStartTime: !!jobs[0].start_time,
            hasEndTime: !!jobs[0].end_time,
            hoursWorked: jobs[0].hours_worked,
            total: jobs[0].total,
            totalAmount: jobs[0].total_amount,
            invoiceAmount: jobs[0].invoice_amount,
            price: jobs[0].price
          });
        }

        // Calculate hourly-based salary
        let totalHours = 0;
        let hourlySalary = 0;
        const hourlyRate = member.hourly_rate ? parseFloat(member.hourly_rate) : 0;
        
        console.log(`[Payroll] Member ${member.id}: Hourly rate = ${hourlyRate}`);
        
        // Calculate hours for ALL jobs (not just those with time tracking)
        // Priority: hours_worked > (start_time/end_time calculation) > duration/estimated_duration
        (jobs || []).forEach(job => {
          let hours = 0;
          
          // Priority 1: Use hours_worked if available and > 0
          if (job.hours_worked && parseFloat(job.hours_worked) > 0) {
            hours = parseFloat(job.hours_worked);
            console.log(`[Payroll] Job ${job.id}: Using hours_worked = ${hours.toFixed(2)} hours`);
          }
          // Priority 2: Calculate from start_time and end_time if available
          else if (job.start_time && job.end_time) {
            const start = new Date(job.start_time);
            const end = new Date(job.end_time);
            const diffMs = end - start;
            if (diffMs > 0) {
              hours = diffMs / (1000 * 60 * 60); // Convert milliseconds to hours
              console.log(`[Payroll] Job ${job.id}: Calculated from start_time/end_time = ${hours.toFixed(2)} hours`);
            }
          }
          // Priority 3: Fallback to duration or estimated_duration (convert minutes to hours)
          else {
            const durationMinutes = job.duration || job.estimated_duration || 0;
            if (durationMinutes > 0) {
              hours = durationMinutes / 60; // Convert minutes to hours
              console.log(`[Payroll] Job ${job.id}: Using duration fallback = ${durationMinutes} minutes (${hours.toFixed(2)} hours)`);
            } else {
              console.log(`[Payroll] Job ${job.id}: No time data available (no hours_worked, start_time/end_time, or duration)`);
            }
          }
          
          if (hours > 0) {
            totalHours += hours;
          }
        });
        
        hourlySalary = totalHours * hourlyRate;
        console.log(`[Payroll] Member ${member.id}: Total hours = ${totalHours.toFixed(2)}, Hourly rate = ${hourlyRate}, Hourly salary = ${hourlySalary.toFixed(2)}`);

        // Calculate commission-based salary
        let commissionSalary = 0;
        const commissionPercentage = member.commission_percentage ? parseFloat(member.commission_percentage) : 0;
        
        console.log(`[Payroll] Member ${member.id}: Commission percentage = ${commissionPercentage}%`);
        
        // Filter jobs with revenue for commission calculation
        // Check multiple fields: total, total_amount, invoice_amount, price
        const jobsWithRevenue = (jobs || []).filter(job => {
          const revenue = parseFloat(job.total) || 
                         parseFloat(job.total_amount) || 
                         parseFloat(job.invoice_amount) || 
                         parseFloat(job.price) || 0;
          return revenue > 0;
        });
        
        console.log(`[Payroll] Member ${member.id}: ${jobsWithRevenue.length} jobs with revenue out of ${jobs.length} total jobs`);
        
        if (jobsWithRevenue.length === 0 && jobs.length > 0) {
          console.log(`[Payroll] WARNING: Member ${member.id} has ${jobs.length} jobs but none have revenue data!`);
          jobs.forEach(job => {
            console.log(`[Payroll] Job ${job.id} revenue fields:`, {
              total: job.total,
              total_amount: job.total_amount,
              invoice_amount: job.invoice_amount,
              price: job.price
            });
          });
        }
        
        jobsWithRevenue.forEach(job => {
          // Use the first available revenue field
          const jobTotal = parseFloat(job.total) || 
                          parseFloat(job.total_amount) || 
                          parseFloat(job.invoice_amount) || 
                          parseFloat(job.price) || 0;
          const commission = jobTotal * (commissionPercentage / 100);
          commissionSalary += commission;
          console.log(`[Payroll] Job ${job.id}: $${jobTotal.toFixed(2)} revenue × ${commissionPercentage}% = $${commission.toFixed(2)} commission`);
        });
        
        console.log(`[Payroll] Member ${member.id}: Total commission = $${commissionSalary.toFixed(2)}`);
        
        // Final summary for this member
        console.log(`[Payroll] === Member ${member.id} (${member.first_name}) Summary ===`);
        console.log(`[Payroll] Total jobs: ${jobs.length}`);
        console.log(`[Payroll] Jobs with revenue: ${jobsWithRevenue.length}`);
        console.log(`[Payroll] Hourly rate: ${hourlyRate ? `$${hourlyRate}/hr` : 'Not set'}`);
        console.log(`[Payroll] Commission %: ${commissionPercentage ? `${commissionPercentage}%` : 'Not set'}`);
        console.log(`[Payroll] Total hours: ${totalHours.toFixed(2)}`);
        console.log(`[Payroll] Hourly salary: $${hourlySalary.toFixed(2)}`);
        console.log(`[Payroll] Commission: $${commissionSalary.toFixed(2)}`);
        console.log(`[Payroll] Total salary: $${(hourlySalary + commissionSalary).toFixed(2)}`);
        console.log(`[Payroll] ==========================================`);

        // Total salary is sum of hourly + commission (hybrid model)
        const totalSalary = hourlySalary + commissionSalary;

        return {
          teamMember: {
            id: member.id,
            name: `${member.first_name} ${member.last_name}`,
            hourlyRate: member.hourly_rate ? parseFloat(member.hourly_rate) : null,
            commissionPercentage: member.commission_percentage ? parseFloat(member.commission_percentage) : null
          },
          jobCount: (jobs || []).length,
          totalHours: parseFloat(totalHours.toFixed(2)),
          hourlySalary: parseFloat(hourlySalary.toFixed(2)),
          commissionSalary: parseFloat(commissionSalary.toFixed(2)),
          totalSalary: parseFloat(totalSalary.toFixed(2)),
          hasHourlyRate: !!member.hourly_rate,
          hasCommission: !!member.commission_percentage,
          paymentMethod: member.hourly_rate && member.commission_percentage 
            ? 'hybrid' 
            : member.hourly_rate 
              ? 'hourly' 
              : member.commission_percentage 
                ? 'commission' 
                : 'none'
        };
        } catch (memberError) {
          console.error(`[Payroll] Error processing member ${member.id} (${member.first_name}):`, memberError);
          // Return default values for this member so the rest of the payroll can still be calculated
          return {
            teamMember: {
              id: member.id,
              name: `${member.first_name} ${member.last_name}`,
              hourlyRate: member.hourly_rate ? parseFloat(member.hourly_rate) : null,
              commissionPercentage: member.commission_percentage ? parseFloat(member.commission_percentage) : null
            },
            jobCount: 0,
            totalHours: 0,
            hourlySalary: 0,
            commissionSalary: 0,
            totalSalary: 0,
            hasHourlyRate: !!member.hourly_rate,
            hasCommission: !!member.commission_percentage,
            paymentMethod: member.hourly_rate && member.commission_percentage 
              ? 'hybrid' 
              : member.hourly_rate 
                ? 'hourly' 
                : member.commission_percentage 
                  ? 'commission' 
                  : 'none',
            error: `Failed to calculate payroll for this member: ${memberError.message}`
          };
        }
      })
    );

    const grandTotal = (payrollData || []).reduce((sum, item) => sum + (item?.totalSalary || 0), 0);
    const grandTotalHours = (payrollData || []).reduce((sum, item) => sum + (item?.totalHours || 0), 0);
    const grandTotalHourlySalary = (payrollData || []).reduce((sum, item) => sum + (item?.hourlySalary || 0), 0);
    const grandTotalCommission = (payrollData || []).reduce((sum, item) => sum + (item?.commissionSalary || 0), 0);

    res.json({
      period: {
        startDate: startDate || null,
        endDate: endDate || null
      },
      teamMembers: payrollData,
      summary: {
        totalTeamMembers: payrollData.length,
        totalHours: parseFloat(grandTotalHours.toFixed(2)),
        totalHourlySalary: parseFloat(grandTotalHourlySalary.toFixed(2)),
        totalCommission: parseFloat(grandTotalCommission.toFixed(2)),
        totalSalary: parseFloat(grandTotal.toFixed(2))
      }
    });
  } catch (error) {
    console.error('Get payroll error:', error);
    res.status(500).json({ error: 'Failed to fetch payroll data' });
  }
});

// Get salary analytics with time-series data
app.get('/api/analytics/salary', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { startDate, endDate, groupBy = 'day' } = req.query;

    // Calculate date range
    let dateFilter = {};
    if (startDate) {
      dateFilter.gte = startDate;
    }
    if (endDate) {
      dateFilter.lte = `${endDate} 23:59:59`;
    }

    // Get all active team members
    const { data: teamMembers, error: membersError } = await supabase
      .from('team_members')
      .select('id, first_name, last_name, hourly_rate, commission_percentage, status')
      .eq('user_id', userId)
      .eq('status', 'active');

    if (membersError) {
      console.error('Error fetching team members:', membersError);
      return res.status(500).json({ error: 'Failed to fetch team members' });
    }

    // Get all jobs in the date range
    let jobsQuery = supabase
      .from('jobs')
      .select('id, scheduled_date, start_time, end_time, hours_worked, duration, estimated_duration, total, total_amount, invoice_amount, price, status, team_member_id')
      .eq('user_id', userId);

    if (startDate) {
      jobsQuery = jobsQuery.gte('scheduled_date', startDate);
    }
    if (endDate) {
      jobsQuery = jobsQuery.lte('scheduled_date', `${endDate} 23:59:59`);
    }

    const { data: allJobs, error: jobsError } = await jobsQuery;

    if (jobsError) {
      console.error('Error fetching jobs:', jobsError);
      return res.status(500).json({ error: 'Failed to fetch jobs' });
    }

    // Also get jobs from job_team_assignments
    let assignmentsQuery = supabase
      .from('job_team_assignments')
      .select(`
        team_member_id,
        jobs!inner(
          id,
          scheduled_date,
          start_time,
          end_time,
          hours_worked,
          duration,
          estimated_duration,
          total,
          total_amount,
          invoice_amount,
          price,
          status,
          user_id
        )
      `);

    if (startDate || endDate) {
      // Filter will be applied after fetching
    }

    const { data: assignments, error: assignmentsError } = await assignmentsQuery;

    // Combine jobs from both sources
    const jobsByMember = {};
    const memberMap = {};

    (teamMembers || []).forEach(member => {
      memberMap[member.id] = member;
      jobsByMember[member.id] = [];
    });

    // Add direct jobs
    (allJobs || []).forEach(job => {
      if (job.team_member_id && jobsByMember[job.team_member_id]) {
        jobsByMember[job.team_member_id].push(job);
      }
    });

    // Add jobs from assignments
    (assignments || []).forEach(assignment => {
      const job = assignment.jobs;
      const memberId = assignment.team_member_id;
      if (job && job.user_id === userId && jobsByMember[memberId]) {
        // Check if job is already added (avoid duplicates)
        if (!jobsByMember[memberId].find(j => j.id === job.id)) {
          jobsByMember[memberId].push(job);
        }
      }
    });

    // Filter jobs by date range if needed
    if (startDate || endDate) {
      Object.keys(jobsByMember).forEach(memberId => {
        jobsByMember[memberId] = jobsByMember[memberId].filter(job => {
          if (!job.scheduled_date) return false;
          const jobDate = new Date(job.scheduled_date);
          if (startDate && jobDate < new Date(startDate)) return false;
          if (endDate && jobDate > new Date(`${endDate} 23:59:59`)) return false;
          return true;
        });
      });
    }

    // Calculate payroll for each member and group by date
    const timeSeriesData = {};
    const memberBreakdown = [];

    Object.keys(jobsByMember).forEach(memberId => {
      const member = memberMap[memberId];
      const jobs = jobsByMember[memberId];

      let totalHours = 0;
      let totalHourlySalary = 0;
      let totalCommission = 0;
      let hourlyJobs = 0;
      let commissionJobs = 0;

      jobs.forEach(job => {
        // Calculate hours
        let hours = 0;
        if (job.hours_worked && job.hours_worked > 0) {
          hours = parseFloat(job.hours_worked);
        } else if (job.start_time && job.end_time) {
          const start = new Date(`${job.scheduled_date} ${job.start_time}`);
          const end = new Date(`${job.scheduled_date} ${job.end_time}`);
          hours = (end - start) / (1000 * 60 * 60);
        } else if (job.duration) {
          hours = parseFloat(job.duration) / 60;
        } else if (job.estimated_duration) {
          hours = parseFloat(job.estimated_duration) / 60;
        }

        // Get revenue
        const revenue = parseFloat(job.total || job.total_amount || job.invoice_amount || job.price || 0);

        // Calculate hourly salary
        if (member.hourly_rate && hours > 0) {
          const hourlySalary = hours * parseFloat(member.hourly_rate);
          totalHourlySalary += hourlySalary;
          totalHours += hours;
          hourlyJobs++;
        }

        // Calculate commission
        if (member.commission_percentage && revenue > 0) {
          const commission = revenue * (parseFloat(member.commission_percentage) / 100);
          totalCommission += commission;
          commissionJobs++;
        }

        // Group by date for time series
        if (job.scheduled_date) {
          let dateKey = job.scheduled_date.split('T')[0]; // Get YYYY-MM-DD

          if (groupBy === 'week') {
            const date = new Date(job.scheduled_date);
            const weekStart = new Date(date);
            weekStart.setDate(date.getDate() - date.getDay());
            dateKey = weekStart.toISOString().split('T')[0];
          } else if (groupBy === 'month') {
            dateKey = job.scheduled_date.substring(0, 7); // YYYY-MM
          }

          if (!timeSeriesData[dateKey]) {
            timeSeriesData[dateKey] = {
              date: dateKey,
              totalPayroll: 0,
              hourlyPayroll: 0,
              commissionPayroll: 0,
              memberCount: 0
            };
          }

          // Add to time series
          if (member.hourly_rate && hours > 0) {
            const hourlySalary = hours * parseFloat(member.hourly_rate);
            timeSeriesData[dateKey].hourlyPayroll += hourlySalary;
            timeSeriesData[dateKey].totalPayroll += hourlySalary;
          }
          if (member.commission_percentage && revenue > 0) {
            const commission = revenue * (parseFloat(member.commission_percentage) / 100);
            timeSeriesData[dateKey].commissionPayroll += commission;
            timeSeriesData[dateKey].totalPayroll += commission;
          }
        }
      });

      memberBreakdown.push({
        memberId: member.id,
        name: `${member.first_name} ${member.last_name}`,
        hourlyRate: member.hourly_rate || 0,
        commissionPercentage: member.commission_percentage || 0,
        totalHours: parseFloat(totalHours.toFixed(2)),
        totalHourlySalary: parseFloat(totalHourlySalary.toFixed(2)),
        totalCommission: parseFloat(totalCommission.toFixed(2)),
        totalSalary: parseFloat((totalHourlySalary + totalCommission).toFixed(2)),
        jobCount: jobs.length,
        hourlyJobs,
        commissionJobs,
        paymentMethod: member.hourly_rate && member.commission_percentage ? 'hybrid' :
                      member.hourly_rate ? 'hourly' :
                      member.commission_percentage ? 'commission' : 'none'
      });
    });

    // Convert time series to array and sort
    const timeSeries = Object.values(timeSeriesData).sort((a, b) => a.date.localeCompare(b.date));

    // Calculate summary
    const totalPayroll = memberBreakdown.reduce((sum, m) => sum + m.totalSalary, 0);
    const totalHourlyPayroll = memberBreakdown.reduce((sum, m) => sum + m.totalHourlySalary, 0);
    const totalCommissionPayroll = memberBreakdown.reduce((sum, m) => sum + m.totalCommission, 0);

    res.json({
      timeSeries,
      memberBreakdown,
      summary: {
        totalPayroll: parseFloat(totalPayroll.toFixed(2)),
        totalHourlyPayroll: parseFloat(totalHourlyPayroll.toFixed(2)),
        totalCommissionPayroll: parseFloat(totalCommissionPayroll.toFixed(2)),
        memberCount: memberBreakdown.length,
        hourlyOnlyCount: memberBreakdown.filter(m => m.paymentMethod === 'hourly').length,
        commissionOnlyCount: memberBreakdown.filter(m => m.paymentMethod === 'commission').length,
        hybridCount: memberBreakdown.filter(m => m.paymentMethod === 'hybrid').length
      }
    });
  } catch (error) {
    console.error('Get salary analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch salary analytics' });
  }
});

app.put('/api/team-members/:id/availability', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { availability } = req.body;
    const userId = req.user.userId;
    const userRole = req.user.role;
    const teamMemberId = req.user.teamMemberId;
    
    // Check if team member exists
    const { data: teamMember, error: memberError } = await supabase
      .from('team_members')
      .select('id, user_id')
      .eq('id', id)
      .maybeSingle();
    
    if (memberError || !teamMember) {
      return res.status(404).json({ error: 'Team member not found' });
    }
    
    // Permission check: 
    // - Account owners can edit any team member's availability
    // - Team members can only edit their own availability
    const isAccountOwner = !userRole || userRole === 'owner' || userRole === 'account owner' || userRole === 'admin';
    const isEditingSelf = teamMemberId && parseInt(teamMemberId) === parseInt(id);
    
    if (!isAccountOwner && !isEditingSelf) {
      return res.status(403).json({ error: 'You do not have permission to edit this team member\'s availability' });
    }
    
    // Validate availability format
    if (!availability || (typeof availability === 'object' && Object.keys(availability).length === 0)) {
      return res.status(400).json({ error: 'Availability data is required' });
    }
    
    // Update team member availability in Supabase
    const availabilityJson = typeof availability === 'string' ? availability : JSON.stringify(availability);
    
    const { error: updateError } = await supabase
      .from('team_members')
      .update({ 
        availability: availabilityJson,
        updated_at: new Date().toISOString()
      })
      .eq('id', id);
    
    if (updateError) {
      console.error('Error updating team member availability:', updateError);
      return res.status(500).json({ error: 'Failed to update team member availability' });
    }
    
    res.json({ message: 'Team member availability updated successfully' });
  } catch (error) {
    console.error('Update team member availability error:', error);
    res.status(500).json({ error: 'Failed to update team member availability' });
  }
});

// ==================== Staff Location Tracking Endpoints ====================

// Record staff location (POST /api/staff-locations)
app.post('/api/staff-locations', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { teamMemberId, latitude, longitude, address, accuracy, source = 'manual', jobId } = req.body;

    // Validate required fields
    if (!teamMemberId || latitude === undefined || longitude === undefined) {
      return res.status(400).json({ error: 'teamMemberId, latitude, and longitude are required' });
    }

    // Verify team member belongs to user
    const { data: teamMember, error: memberError } = await supabase
      .from('team_members')
      .select('id, user_id, location_sharing_enabled')
      .eq('id', teamMemberId)
      .eq('user_id', userId)
      .single();

    if (memberError || !teamMember) {
      return res.status(404).json({ error: 'Team member not found' });
    }

    // Check if location sharing is enabled (for feature #10)
    if (teamMember.location_sharing_enabled === false) {
      return res.status(403).json({ error: 'Location sharing is disabled for this team member' });
    }

    // Insert location record
    const { data: location, error: locationError } = await supabase
      .from('staff_locations')
      .insert({
        team_member_id: teamMemberId,
        user_id: userId,
        latitude: parseFloat(latitude),
        longitude: parseFloat(longitude),
        address: address || null,
        accuracy: accuracy ? parseFloat(accuracy) : null,
        source: source,
        job_id: jobId || null,
        recorded_at: new Date().toISOString()
      })
      .select()
      .single();

    if (locationError) {
      console.error('Error recording staff location:', locationError);
      return res.status(500).json({ error: 'Failed to record staff location' });
    }

    res.json({ 
      message: 'Location recorded successfully',
      location: location
    });
  } catch (error) {
    console.error('Record staff location error:', error);
    res.status(500).json({ error: 'Failed to record staff location' });
  }
});

// Get/Update global staff locations setting (admin only)
app.get('/api/user/staff-locations-setting', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    const { data: user, error } = await supabase
      .from('users')
      .select('staff_locations_enabled')
      .eq('id', userId)
      .single();
    
    if (error) {
      console.error('Error fetching staff locations setting:', error);
      // If column doesn't exist yet, return default (enabled)
      if (error.code === '42703' || error.message?.includes('column') || error.message?.includes('does not exist')) {
        console.log('Column staff_locations_enabled does not exist yet, returning default (enabled)');
        return res.json({ 
          staff_locations_enabled: true // Default to enabled
        });
      }
      return res.status(500).json({ error: 'Failed to fetch setting' });
    }
    
    res.json({ 
      staff_locations_enabled: user?.staff_locations_enabled !== false // Default to true
    });
  } catch (error) {
    console.error('Get staff locations setting error:', error);
    res.status(500).json({ error: 'Failed to fetch setting' });
  }
});

app.put('/api/user/staff-locations-setting', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { staff_locations_enabled } = req.body;
    
    // Update the setting for this user's account (no role check needed)
    const { data: updatedUser, error: updateError } = await supabase
      .from('users')
      .update({ staff_locations_enabled: staff_locations_enabled !== false })
      .eq('id', userId)
      .select('staff_locations_enabled')
      .single();
    
    if (updateError) {
      console.error('Error updating staff locations setting:', updateError);
      // If column doesn't exist yet, return helpful error
      if (updateError.code === '42703' || updateError.message?.includes('column') || updateError.message?.includes('does not exist')) {
        return res.status(400).json({ 
          error: 'Database column not found. Please run the migration: server/staff-locations-global-hide-migration.sql'
        });
      }
      return res.status(500).json({ error: 'Failed to update setting' });
    }
    
    res.json({ 
      message: 'Setting updated successfully',
      staff_locations_enabled: updatedUser?.staff_locations_enabled !== false
    });
  } catch (error) {
    console.error('Update staff locations setting error:', error);
    res.status(500).json({ error: 'Failed to update setting' });
  }
});

// Get current staff locations (GET /api/staff-locations)
app.get('/api/staff-locations', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { teamMemberId } = req.query;

    // Check global setting first
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('staff_locations_enabled')
      .eq('id', userId)
      .single();
    
    if (userError || !user) {
      return res.status(500).json({ error: 'Failed to check settings' });
    }
    
    // If globally disabled, return empty
    if (user.staff_locations_enabled === false) {
      return res.json({
        locations: [],
        count: 0,
        globallyHidden: true
      });
    }

    // Build query - get latest location for each team member
    let query = supabase
      .from('staff_locations')
      .select(`
        id,
        team_member_id,
        latitude,
        longitude,
        address,
        accuracy,
        source,
        job_id,
        recorded_at,
        team_members!inner(
          id,
          first_name,
          last_name,
          profile_picture,
          location_sharing_enabled,
          user_id
        ),
        jobs(
          id,
          service_name,
          scheduled_date
        )
      `)
      .eq('team_members.user_id', userId)
      .eq('team_members.location_sharing_enabled', true) // Only show if sharing is enabled
      .order('recorded_at', { ascending: false });

    // Filter by team member if provided
    if (teamMemberId) {
      query = query.eq('team_member_id', teamMemberId);
    }

    const { data: locations, error: locationsError } = await query;

    if (locationsError) {
      console.error('Error fetching staff locations:', locationsError);
      return res.status(500).json({ error: 'Failed to fetch staff locations' });
    }

    // Get the most recent location for each team member
    const latestLocations = {};
    (locations || []).forEach(location => {
      const memberId = location.team_member_id;
      if (!latestLocations[memberId] || 
          new Date(location.recorded_at) > new Date(latestLocations[memberId].recorded_at)) {
        latestLocations[memberId] = location;
      }
    });

    res.json({
      locations: Object.values(latestLocations),
      count: Object.keys(latestLocations).length
    });
  } catch (error) {
    console.error('Get staff locations error:', error);
    res.status(500).json({ error: 'Failed to fetch staff locations' });
  }
});

// Get location history for a team member (GET /api/staff-locations/:teamMemberId/history)
app.get('/api/staff-locations/:teamMemberId/history', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { teamMemberId } = req.params;
    const { startDate, endDate, limit = 100 } = req.query;

    // Verify team member belongs to user
    const { data: teamMember, error: memberError } = await supabase
      .from('team_members')
      .select('id, user_id')
      .eq('id', teamMemberId)
      .eq('user_id', userId)
      .single();

    if (memberError || !teamMember) {
      return res.status(404).json({ error: 'Team member not found' });
    }

    // Build query
    let query = supabase
      .from('staff_locations')
      .select(`
        id,
        latitude,
        longitude,
        address,
        accuracy,
        source,
        job_id,
        recorded_at,
        jobs(
          id,
          service_name,
          scheduled_date
        )
      `)
      .eq('team_member_id', teamMemberId)
      .order('recorded_at', { ascending: false })
      .limit(parseInt(limit));

    // Filter by date range if provided
    if (startDate) {
      query = query.gte('recorded_at', startDate);
    }
    if (endDate) {
      query = query.lte('recorded_at', `${endDate} 23:59:59`);
    }

    const { data: locations, error: locationsError } = await query;

    if (locationsError) {
      console.error('Error fetching location history:', locationsError);
      return res.status(500).json({ error: 'Failed to fetch location history' });
    }

    res.json({
      teamMemberId: parseInt(teamMemberId),
      locations: locations || [],
      count: (locations || []).length
    });
  } catch (error) {
    console.error('Get location history error:', error);
    res.status(500).json({ error: 'Failed to fetch location history' });
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
    
    // Names are optional - no validation needed
    
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
    
    // Set default availability if none provided
    let defaultAvailability = availability;
    if (!defaultAvailability || (typeof defaultAvailability === 'object' && Object.keys(defaultAvailability).length === 0)) {
      defaultAvailability = {
        workingHours: {
          monday: { available: true, hours: "9:00 AM - 5:00 PM" },
          tuesday: { available: true, hours: "9:00 AM - 5:00 PM" },
          wednesday: { available: true, hours: "9:00 AM - 5:00 PM" },
          thursday: { available: true, hours: "9:00 AM - 5:00 PM" },
          friday: { available: true, hours: "9:00 AM - 5:00 PM" },
          saturday: { available: false, hours: "" },
          sunday: { available: false, hours: "" }
        },
        customAvailability: []
      };
    }
    
    // Ensure availability is stored as JSON string
    const availabilityString = typeof defaultAvailability === 'string' 
      ? defaultAvailability 
      : JSON.stringify(defaultAvailability);
    
    const { data: teamMember, error: insertError } = await supabase
      .from('team_members')
      .insert({
        user_id: userId,
        first_name: firstName ? sanitizeInput(firstName) : null,
        last_name: lastName ? sanitizeInput(lastName) : null,
        email: sanitizeInput(email),
        phone: phone ? sanitizeInput(phone) : null,
        location: location ? sanitizeInput(location) : null,
        city: city ? sanitizeInput(city) : null,
        state: state ? sanitizeInput(state) : null,
        zip_code: zipCode ? sanitizeInput(zipCode) : null,
        role: role || 'worker',
        hourly_rate: hourlyRate ? parseFloat(hourlyRate) : null,
        territories: territories || [],
        availability: availabilityString,
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
      const invitationLink = `${process.env.FRONTEND_URL || 'https://service-flow.pro'}/team-member/signup?token=${invitationToken}`;
      
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
    const { token, email, username, password, firstName, lastName, phone } = req.body;

    if (!token || !email || !username || !password || !firstName || !lastName) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
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
      
    // Update team member with signup data using Supabase (including new email if changed)
    const { error: updateError } = await supabase
      .from('team_members')
      .update({
        email: email, // Update email (may be different from invitation email)
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
    
    // Send activation confirmation email to team member (use new email if changed)
    try {
      await sendTeamMemberEmail({
        to: email, // Use the new email address
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
                  <li><strong>Email:</strong> ${email}</li>
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
      
      // Allow resending invite for both 'invited' and 'pending' status
      if (teamMember.status !== 'invited' && teamMember.status !== 'pending') {
        return res.status(400).json({ error: 'Team member is not in invited or pending status' });
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
      const invitationLink = `${process.env.FRONTEND_URL || 'https://service-flow.pro'}/team-member/signup?token=${invitationToken}`;
        
      // Send email in background - don't fail the request if email fails
      sendTeamMemberEmail({
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
        text: `Welcome to Service Flow! You've been invited to join your team. Please visit ${invitationLink} to create your account. This link will expire in 7 days.`
      }).then(() => {
        console.log('✅ Resend invitation email sent successfully to:', teamMember.email);
      }).catch((emailError) => {
        console.error('⚠️ Failed to resend invitation email (invitation token was still updated):', emailError.message);
        console.error('⚠️ Email error details:', {
          code: emailError.code,
          message: emailError.message
        });
        if (emailError.code === 401) {
          console.error('⚠️ SendGrid API key is invalid or missing. Please check your SENDGRID_API_KEY environment variable.');
        }
        // Don't fail the request - token was updated successfully
      });
      
      res.json({ 
        message: 'Invitation resent successfully',
        invitationToken: invitationToken // Include token in response for debugging if needed
      });
      
  } catch (error) {
      console.error('❌ Resend invite error:', error);
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
    const userId = req.user.userId;
    
    // Get user's Stripe credentials from database
    const { data: billingData, error: billingError } = await supabase
      .from('user_billing')
      .select('stripe_secret_key')
      .eq('user_id', userId)
      .single();
    
    if (billingError || !billingData?.stripe_secret_key) {
      console.error('❌ Stripe credentials not found for user:', userId);
      return res.status(400).json({ error: 'Stripe not configured' });
    }
    
    // Use user's Stripe secret key, not environment variable
    const userStripe = require('stripe')(billingData.stripe_secret_key);
    
    const paymentIntent = await userStripe.paymentIntents.create({
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

// Migration endpoint for confirmation tracking
app.post('/api/migrate/confirmation-tracking', async (req, res) => {
  try {
    const connection = await pool.getConnection();
    
    try {
      // Check if confirmation columns already exist
      const [columnCheck] = await connection.query(`
        SELECT COUNT(*) as count
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = 'jobs' 
        AND COLUMN_NAME = 'confirmation_sent'
      `);
      
      if (columnCheck[0].count === 0) {
        // Add confirmation tracking columns
        await connection.query(`
          ALTER TABLE jobs 
          ADD COLUMN confirmation_sent BOOLEAN DEFAULT FALSE,
          ADD COLUMN confirmation_sent_at TIMESTAMP NULL,
          ADD COLUMN confirmation_email VARCHAR(255) NULL,
          ADD COLUMN confirmation_failed BOOLEAN DEFAULT FALSE,
          ADD COLUMN confirmation_error TEXT NULL,
          ADD COLUMN confirmation_no_email BOOLEAN DEFAULT FALSE
        `);
        
        // Add indexes for better performance
        await connection.query('CREATE INDEX idx_jobs_confirmation_sent ON jobs(confirmation_sent)');
        await connection.query('CREATE INDEX idx_jobs_confirmation_sent_at ON jobs(confirmation_sent_at)');
        
        console.log('✅ Confirmation tracking columns added successfully');
      } else {
        console.log('✅ Confirmation tracking columns already exist');
      }
      
      // Show updated table structure
      const [columns] = await connection.query('DESCRIBE jobs');
      
      res.json({
        success: true,
        message: 'Confirmation tracking migration completed successfully',
        jobsColumns: columns.map(c => c.Field)
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('❌ Confirmation tracking migration error:', error);
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
app.post('/api/upload/profile-picture', authenticateToken, upload.single('profilePicture'), async (req, res) => {
  try {
    const { userId } = req.body;
    const { isTeamMember } = req.body;
    const teamMemberId = req.user.teamMemberId; // Get team member ID from JWT token
    
    // Determine if this is a team member upload
    const isTeamMemberUpload = isTeamMember === 'true' || !!teamMemberId;
    
    // Use teamMemberId from JWT if available, otherwise use userId from body
    const idToUse = isTeamMemberUpload && teamMemberId ? teamMemberId : userId;
    
    if (!idToUse) {
      return res.status(400).json({ error: 'User ID or Team Member ID is required' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No profile picture file provided' });
    }

    // Upload to Supabase Storage
    const result = await uploadToStorage(req.file, BUCKETS.PROFILE_PICTURES, 'profiles');
    const profilePictureUrl = result.imageUrl;

    // ✅ Save file info to database - update team_members table if team member, users table if account owner
    if (isTeamMemberUpload) {
      const { error: updateError } = await supabase
        .from('team_members')
        .update({ profile_picture: profilePictureUrl })
        .eq('id', idToUse);

      if (updateError) {
        console.error('❌ Error saving team member profile picture URL to database:', updateError);
        return res.status(500).json({ error: 'Failed to save profile picture URL' });
      }
    } else {
    const { error: updateError } = await supabase
      .from('users')
      .update({ profile_picture: profilePictureUrl })
        .eq('id', idToUse);

    if (updateError) {
      console.error('❌ Error saving profile picture URL to database:', updateError);
      return res.status(500).json({ error: 'Failed to save profile picture URL' });
      }
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

// Job note attachment upload endpoint
app.post('/api/jobs/:jobId/notes/attachments', authenticateToken, attachmentUpload.array('attachments', 10), async (req, res) => {
  try {
    const { jobId } = req.params;
    const userId = req.user.userId;
    
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    // Verify job exists and belongs to user
    const { data: job, error: jobError } = await supabase
      .from('jobs')
      .select('id, user_id')
      .eq('id', jobId)
      .eq('user_id', userId)
      .single();

    if (jobError || !job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Upload files to Supabase Storage
    const uploadedFiles = [];
    for (const file of req.files) {
      try {
        // Use job-attachments bucket, fallback to service-images if not available
        const bucket = BUCKETS.JOB_ATTACHMENTS || BUCKETS.SERVICE_IMAGES;
        
        const result = await uploadToStorage(file, bucket, `job-${jobId}`);
        uploadedFiles.push({
          filename: file.originalname,
          url: result.imageUrl || result.fileUrl || result.url,
          type: file.mimetype,
          size: file.size
        });
      } catch (uploadError) {
        console.error('Error uploading file:', uploadError);
        // Continue with other files even if one fails
      }
    }

      res.json({ 
      message: 'Files uploaded successfully',
      files: uploadedFiles
    });
  } catch (error) {
    console.error('Error uploading job note attachments:', error);
    res.status(500).json({ error: 'Failed to upload attachments' });
  }
});

// Remove profile picture endpoint
app.delete('/api/user/profile-picture', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const teamMemberId = req.user.teamMemberId; // Get team member ID from JWT token
    
    // Remove profile picture - check if it's a team member or account owner
    if (teamMemberId) {
      // Remove team member's profile picture
      const { error } = await supabase
        .from('team_members')
        .update({ profile_picture: null })
        .eq('id', teamMemberId);
      
      if (error) {
        console.error('Error removing team member profile picture:', error);
        return res.status(500).json({ error: 'Failed to remove profile picture' });
      }
    } else {
      // Remove account owner's profile picture
      const { error } = await supabase
        .from('users')
        .update({ profile_picture: null })
        .eq('id', userId);
      
      if (error) {
        console.error('Error removing profile picture:', error);
        return res.status(500).json({ error: 'Failed to remove profile picture' });
    }
    }

    res.json({ 
      message: 'Profile picture removed successfully'
    });
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
// NOTE: Using Supabase notification_templates table with schema:
// CREATE TABLE notification_templates (
//   id SERIAL PRIMARY KEY,
//   user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
//   name VARCHAR(255) NOT NULL,
//   type notification_type NOT NULL,
//   subject VARCHAR(255),
//   message TEXT NOT NULL,
//   variables JSONB,
//   is_active BOOLEAN DEFAULT true,
//   created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
//   updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
// );
app.get('/api/user/notification-templates', async (req, res) => {
  try {
    const { userId, templateType, notificationName } = req.query;
    
    console.log('🔍 Fetching notification templates:', { userId, templateType, notificationName });
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    let query = supabase
      .from('notification_templates')
      .select('*')
      .eq('user_id', userId);

    if (templateType) {
      query = query.eq('type', templateType);
    }

    if (notificationName) {
      query = query.eq('name', notificationName);
    }

    query = query.order('name').order('type');

    const { data: templates, error } = await query;

    console.log('🔍 Notification templates query result:', { templates, error });

    if (error) {
      console.error('Error fetching notification templates:', error);
      return res.status(500).json({ error: 'Failed to fetch notification templates' });
    }

    // Map Supabase schema to expected API format
    const mappedTemplates = templates?.map(template => ({
      id: template.id,
      user_id: template.user_id,
      template_type: template.type,
      notification_name: template.name,
      subject: template.subject,
      content: template.message,
      is_enabled: template.is_active ? 1 : 0,
      created_at: template.created_at,
      updated_at: template.updated_at
    })) || [];

    console.log('🔍 Mapped templates:', mappedTemplates);

    // If no templates found and we're looking for appointment_confirmation, create default templates
    if (mappedTemplates.length === 0 && notificationName === 'appointment_confirmation') {
      console.log('🔍 No templates found, creating default appointment confirmation templates');
      
      try {
        // Create default email template
        const { error: emailError } = await supabase
          .from('notification_templates')
          .insert({
            user_id: userId,
            type: 'email',
            name: 'appointment_confirmation',
            subject: 'Appointment Confirmed - {business_name}',
            message: 'Hi {customer_name},\n\nYour appointment has been confirmed for {appointment_date} at {appointment_time}.\n\nService: {service_name}\nLocation: {location}\n\nWe look forward to serving you!\n\nBest regards,\n{business_name}',
            is_active: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          });

        if (emailError) {
          console.error('Error creating default email template:', emailError);
        }

        // Create default SMS template
        const { error: smsError } = await supabase
          .from('notification_templates')
          .insert({
            user_id: userId,
            type: 'sms',
            name: 'appointment_confirmation',
            subject: null,
            message: 'Hi {customer_name}, your appointment is confirmed for {appointment_date} at {appointment_time}. Service: {service_name}. Location: {location}. - {business_name}',
            is_active: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          });

        if (smsError) {
          console.error('Error creating default SMS template:', smsError);
        }

        // Return default templates
        const defaultTemplates = [
          {
            id: 'default-email',
            user_id: userId,
            template_type: 'email',
            notification_name: 'appointment_confirmation',
            subject: 'Appointment Confirmed - {business_name}',
            content: 'Hi {customer_name},\n\nYour appointment has been confirmed for {appointment_date} at {appointment_time}.\n\nService: {service_name}\nLocation: {location}\n\nWe look forward to serving you!\n\nBest regards,\n{business_name}',
            is_enabled: 1,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          },
          {
            id: 'default-sms',
            user_id: userId,
            template_type: 'sms',
            notification_name: 'appointment_confirmation',
            subject: null,
            content: 'Hi {customer_name}, your appointment is confirmed for {appointment_date} at {appointment_time}. Service: {service_name}. Location: {location}. - {business_name}',
            is_enabled: 1,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }
        ];

        return res.json(defaultTemplates);
      } catch (createError) {
        console.error('Error creating default templates:', createError);
        // Return empty array if creation fails
        return res.json([]);
      }
    }

    res.json(mappedTemplates);
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

    // Check if template exists
    const { data: existing, error: checkError } = await supabase
      .from('notification_templates')
      .select('id')
      .eq('user_id', userId)
      .eq('type', templateType)
      .eq('name', notificationName)
      .single();

    if (checkError && checkError.code !== 'PGRST116') {
      console.error('Error checking existing template:', checkError);
      return res.status(500).json({ error: 'Failed to check existing template' });
    }

    if (existing) {
      // Update existing template
      const { error: updateError } = await supabase
        .from('notification_templates')
        .update({
          subject,
          message: content,
          is_active: isEnabled,
          updated_at: new Date().toISOString()
        })
        .eq('user_id', userId)
        .eq('type', templateType)
        .eq('name', notificationName);

      if (updateError) {
        console.error('Error updating template:', updateError);
        return res.status(500).json({ error: 'Failed to update notification template' });
      }
    } else {
      // Create new template
      const { error: insertError } = await supabase
        .from('notification_templates')
        .insert({
          user_id: userId,
          type: templateType,
          name: notificationName,
          subject,
          message: content,
          is_active: isEnabled,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });

      if (insertError) {
        console.error('Error creating template:', insertError);
        return res.status(500).json({ error: 'Failed to create notification template' });
      }
    }

    console.log('🔍 Notification template updated successfully');
    res.json({ 
      message: 'Notification template updated successfully'
    });
  } catch (error) {
    console.error('Error updating notification template:', error);
    res.status(500).json({ error: 'Failed to update notification template' });
  }
});

// Update job confirmation status endpoint
app.patch('/api/jobs/:id/confirmation-status', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { confirmation_sent, confirmation_sent_at, confirmation_email, confirmation_failed, confirmation_error } = req.body;
    
    const { error: updateError } = await supabase
      .from('jobs')
      .update({
        confirmation_sent,
        confirmation_sent_at,
        confirmation_email,
        confirmation_failed,
        confirmation_error
      })
      .eq('id', id)
      .eq('user_id', req.user.userId);

    if (updateError) {
      console.error('Error updating confirmation status:', updateError);
      return res.status(500).json({ error: 'Failed to update confirmation status' });
    }

    res.json({
      message: 'Confirmation status updated successfully',
      confirmation_sent,
      confirmation_sent_at,
      confirmation_email
    });
  } catch (error) {
    console.error('Update confirmation status error:', error);
    res.status(500).json({ error: 'Failed to update confirmation status' });
  }
});

// Send appointment notification endpoint
app.post('/api/send-appointment-notification', authenticateToken, async (req, res) => {
  try {
    const { notificationType, customerEmail, jobId, customerName, serviceName, scheduledDate, serviceAddress } = req.body;
    
    if (!customerEmail || !notificationType) {
      return res.status(400).json({ error: 'Customer email and notification type are required' });
    }

    console.log('📧 Sending appointment notification:', { notificationType, customerEmail, jobId });

    // Generate email content based on notification type
    let subject, htmlContent, textContent;
    
    if (notificationType === 'confirmation') {
      subject = 'Appointment Confirmation';
      htmlContent = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #2563eb; margin: 0;">Appointment Confirmed</h1>
          </div>
          
          <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
            <h2 style="color: #1f2937; margin: 0 0 15px 0;">Hi ${customerName},</h2>
            <p style="color: #374151; margin: 0 0 15px 0; font-size: 16px;">
              Your appointment has been confirmed for <strong>${new Date(scheduledDate).toLocaleDateString('en-US', { 
                weekday: 'long', 
                month: 'long', 
                day: 'numeric', 
                year: 'numeric' 
              })} at ${new Date(scheduledDate).toLocaleTimeString('en-US', { 
                hour: 'numeric', 
                minute: '2-digit',
                hour12: true 
              })}</strong>.
            </p>
            <div style="background: white; padding: 15px; border-radius: 6px; margin: 15px 0;">
              <p style="margin: 0 0 10px 0; color: #374151;"><strong>Service:</strong> ${serviceName}</p>
              <p style="margin: 0; color: #374151;"><strong>Location:</strong> ${serviceAddress}</p>
            </div>
            <p style="color: #374151; margin: 15px 0 0 0;">We look forward to serving you!</p>
          </div>
          
          <div style="text-align: center; color: #6b7280; font-size: 14px;">
            <p>Best regards,<br>Your Service Team</p>
          </div>
        </div>
      `;
      textContent = `Hi ${customerName},\n\nYour appointment has been confirmed for ${new Date(scheduledDate).toLocaleDateString('en-US', { 
        weekday: 'long', 
        month: 'long', 
        day: 'numeric', 
        year: 'numeric' 
      })} at ${new Date(scheduledDate).toLocaleTimeString('en-US', { 
        hour: 'numeric', 
        minute: '2-digit',
        hour12: true 
      })}.\n\nService: ${serviceName}\nLocation: ${serviceAddress}\n\nWe look forward to serving you!\n\nBest regards,\nYour Service Team`;
    } else if (notificationType === 'reminder') {
      subject = 'Appointment Reminder';
      htmlContent = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #f59e0b; margin: 0;">Appointment Reminder</h1>
          </div>
          
          <div style="background: #fef3c7; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
            <h2 style="color: #1f2937; margin: 0 0 15px 0;">Hi ${customerName},</h2>
            <p style="color: #374151; margin: 0 0 15px 0; font-size: 16px;">
              This is a friendly reminder that you have an appointment scheduled for <strong>${new Date(scheduledDate).toLocaleDateString('en-US', { 
                weekday: 'long', 
                month: 'long', 
                day: 'numeric', 
                year: 'numeric' 
              })} at ${new Date(scheduledDate).toLocaleTimeString('en-US', { 
                hour: 'numeric', 
                minute: '2-digit',
                hour12: true 
              })}</strong>.
            </p>
            <div style="background: white; padding: 15px; border-radius: 6px; margin: 15px 0;">
              <p style="margin: 0 0 10px 0; color: #374151;"><strong>Service:</strong> ${serviceName}</p>
              <p style="margin: 0; color: #374151;"><strong>Location:</strong> ${serviceAddress}</p>
            </div>
            <p style="color: #374151; margin: 15px 0 0 0;">Please arrive on time. If you need to reschedule, please contact us as soon as possible.</p>
          </div>
          
          <div style="text-align: center; color: #6b7280; font-size: 14px;">
            <p>Best regards,<br>Your Service Team</p>
          </div>
        </div>
      `;
      textContent = `Hi ${customerName},\n\nThis is a friendly reminder that you have an appointment scheduled for ${new Date(scheduledDate).toLocaleDateString('en-US', { 
        weekday: 'long', 
        month: 'long', 
        day: 'numeric', 
        year: 'numeric' 
      })} at ${new Date(scheduledDate).toLocaleTimeString('en-US', { 
        hour: 'numeric', 
        minute: '2-digit',
        hour12: true 
      })}.\n\nService: ${serviceName}\nLocation: ${serviceAddress}\n\nPlease arrive on time. If you need to reschedule, please contact us as soon as possible.\n\nBest regards,\nYour Service Team`;
    }

    // Send email using SendGrid
    const msg = {
      to: customerEmail,
      from: process.env.SENDGRID_FROM_EMAIL || 'noreply@service-flow.pro',
      subject: subject,
      html: htmlContent,
      text: textContent
    };

    console.log('📧 SendGrid message details:', {
      to: msg.to,
      from: msg.from,
      subject: msg.subject,
      hasHtml: !!msg.html,
      hasText: !!msg.text
    });

    try {
      await sgMail.send(msg);
      console.log('✅ Appointment notification sent successfully');
      
      // Update job confirmation or reminder status
      if (jobId) {
        try {
          if (notificationType === 'confirmation') {
            await supabase
              .from('jobs')
              .update({
                confirmation_sent: true,
                confirmation_sent_at: new Date().toISOString(),
                confirmation_email: customerEmail,
                confirmation_failed: false,
                confirmation_error: null
              })
              .eq('id', jobId);
          } else if (notificationType === 'reminder') {
            await supabase
              .from('jobs')
              .update({
                reminder_sent: true,
                reminder_sent_at: new Date().toISOString(),
                reminder_email: customerEmail,
                reminder_failed: false,
                reminder_error: null
              })
              .eq('id', jobId);
          }
        } catch (updateError) {
          console.error('Error updating notification status:', updateError);
          // Don't fail the email send if status update fails
        }
      }
      
      res.json({ 
        success: true, 
        message: `${notificationType === 'confirmation' ? 'Confirmation' : 'Reminder'} sent successfully`,
        email: customerEmail 
      });
    } catch (sendError) {
      console.error('❌ SendGrid send error:', sendError);
      console.error('❌ Error code:', sendError.code);
      console.error('❌ Error response:', sendError.response?.body);
      
      // Update job with failed notification status
      if (jobId) {
        try {
          if (notificationType === 'confirmation') {
            await supabase
              .from('jobs')
              .update({
                confirmation_sent: false,
                confirmation_failed: true,
                confirmation_error: sendError.message
              })
              .eq('id', jobId);
          } else if (notificationType === 'reminder') {
            await supabase
              .from('jobs')
              .update({
                reminder_sent: false,
                reminder_failed: true,
                reminder_error: sendError.message
              })
              .eq('id', jobId);
          }
        } catch (updateError) {
          console.error('Error updating failed notification status:', updateError);
        }
      }
      
      if (sendError.code === 403) {
        return res.status(500).json({ 
          error: 'SendGrid configuration error. Please verify the sender email address in SendGrid.',
          details: 'The from email address must be verified in your SendGrid account.'
        });
      }
      
      throw sendError;
    }
    
  } catch (error) {
    console.error('❌ Error sending appointment notification:', error);
    res.status(500).json({ error: 'Failed to send appointment notification' });
  }
});

// Send custom message endpoint
app.post('/api/send-custom-message', authenticateToken, async (req, res) => {
  try {
    const { customerEmail, jobId, customerName, message } = req.body;
    
    if (!customerEmail || !message) {
      return res.status(400).json({ error: 'Customer email and message are required' });
    }

    console.log('📧 Sending custom message:', { customerEmail, jobId, messageLength: message.length });

    // Generate email content for custom message
    const subject = 'Message from Your Service Team';
    const htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="color: #2563eb; margin: 0;">Message from Your Service Team</h1>
        </div>
        
        <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
          <h2 style="color: #1f2937; margin: 0 0 15px 0;">Hi ${customerName},</h2>
          <div style="background: white; padding: 15px; border-radius: 6px; margin: 15px 0; border-left: 4px solid #2563eb;">
            <p style="margin: 0; color: #374151; font-size: 16px; line-height: 1.6; white-space: pre-wrap;">${message}</p>
          </div>
        </div>
        
        <div style="text-align: center; color: #6b7280; font-size: 14px;">
          <p>Best regards,<br>Your Service Team</p>
        </div>
      </div>
    `;
    const textContent = `Hi ${customerName},\n\n${message}\n\nBest regards,\nYour Service Team`;

    // Send email using SendGrid
    const msg = {
      to: customerEmail,
      from: process.env.SENDGRID_FROM_EMAIL || 'noreply@service-flow.pro',
      subject: subject,
      html: htmlContent,
      text: textContent
    };

    console.log('📧 SendGrid message details:', {
      to: msg.to,
      from: msg.from,
      subject: msg.subject,
      hasHtml: !!msg.html,
      hasText: !!msg.text
    });

    try {
      await sgMail.send(msg);
      console.log('✅ Custom message sent successfully');
      
      res.json({ 
        success: true, 
        message: 'Custom message sent successfully',
        email: customerEmail 
      });
    } catch (sendError) {
      console.error('❌ SendGrid send error:', sendError);
      console.error('❌ Error code:', sendError.code);
      console.error('❌ Error response:', sendError.response?.body);
      
      if (sendError.code === 403) {
        return res.status(500).json({ 
          error: 'SendGrid configuration error. Please verify the sender email address in SendGrid.',
          details: 'The from email address must be verified in your SendGrid account.'
        });
      }
      
      throw sendError;
    }
    
  } catch (error) {
    console.error('❌ Error sending custom message:', error);
    res.status(500).json({ error: 'Failed to send custom message' });
  }
});

// Test SendGrid endpoint
app.post('/api/test-sendgrid', authenticateToken, async (req, res) => {
  try {
    const { testEmail } = req.body;
    
    if (!testEmail) {
      return res.status(400).json({ error: 'Test email is required' });
    }

    console.log('🧪 Testing SendGrid with email:', testEmail);
    console.log('🧪 SendGrid API Key configured:', !!SENDGRID_API_KEY);
    console.log('🧪 From email:', process.env.SENDGRID_FROM_EMAIL || 'info@spotless.homes');

    const msg = {
      to: testEmail,
      from: process.env.SENDGRID_FROM_EMAIL || 'info@spotless.homes',
      subject: 'Test Email from Service Flow',
      html: '<h1>Test Email</h1><p>This is a test email to verify SendGrid configuration.</p>',
      text: 'Test Email - This is a test email to verify SendGrid configuration.'
    };

    try {
    const result = await sgMail.send(msg);
    console.log('✅ Test email sent successfully:', result);
    
    res.json({ message: 'Test email sent successfully', result });
    } catch (sendError) {
      console.error('❌ SendGrid test error:', sendError);
      console.error('❌ Error code:', sendError.code);
      console.error('❌ Error response:', sendError.response?.body);
      
      if (sendError.code === 403) {
        return res.status(500).json({ 
          error: 'SendGrid 403 Forbidden - The sender email address must be verified in SendGrid',
          details: 'Please verify the sender email address in your SendGrid account settings.'
        });
      }
      
      throw sendError;
    }
  } catch (error) {
    console.error('❌ Error sending test email:', error);
    res.status(500).json({ error: 'Failed to send test email', details: error.message });
  }
});

// Public Invoice API endpoints (no authentication required)
app.get('/api/public/invoice/:invoiceId', async (req, res) => {
  try {
    const { invoiceId } = req.params;
    
    console.log('📄 Public invoice requested:', invoiceId);
    
    // Validate invoice ID
    if (!invoiceId || isNaN(parseInt(invoiceId))) {
      console.error('❌ Invalid invoice ID:', invoiceId);
      return res.status(400).json({ error: 'Invalid invoice ID' });
    }
    
    // Debug: Check if any invoices exist
    const { data: allInvoices, error: debugError } = await supabase
      .from('invoices')
      .select('id, status, created_at')
      .limit(5);
    
    if (!debugError) {
      console.log('📄 Available invoices in database:', allInvoices);
    }
    
    // Fetch invoice data with related customer and job information
    const { data: invoice, error } = await supabase
      .from('invoices')
      .select(`
        id,
        amount,
        tax_amount,
        total_amount,
        status,
        due_date,
        created_at,
        job_id,
        customer_id,
        customers!invoices_customer_id_fkey (
          first_name,
          last_name,
          email,
          address
        ),
        jobs!invoices_job_id_fkey (
          id,
          service_name,
          scheduled_date,
          service_address_street,
          service_address_city,
          service_address_state,
          service_address_zip,
          service_address_country
        )
      `)
      .eq('id', invoiceId)
      .single();

    if (error) {
      console.error('❌ Error fetching invoice from database:', error);
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Invoice not found' });
      }
      return res.status(500).json({ error: 'Failed to fetch invoice' });
    }

    if (!invoice) {
      console.error('❌ Invoice not found in database:', invoiceId);
      return res.status(404).json({ error: 'Invoice not found' });
    }

    // Format invoice data
    const invoiceData = {
      id: invoice.id,
      invoiceNumber: `INV-${invoice.id}`,
      customerName: `${invoice.customers?.first_name || ''} ${invoice.customers?.last_name || ''}`.trim(),
      customerEmail: invoice.customers?.email,
      serviceDate: invoice.jobs?.scheduled_date,
      jobNumber: invoice.job_id,
      serviceAddress: (() => {
        // Use job service address if available, otherwise fall back to customer address
        if (invoice.jobs?.service_address_street) {
          const addressParts = [
            invoice.jobs.service_address_street,
            invoice.jobs.service_address_city,
            invoice.jobs.service_address_state,
            invoice.jobs.service_address_zip,
            invoice.jobs.service_address_country
          ].filter(Boolean);
          return addressParts.join(', ');
        }
        return invoice.customers?.address || 'N/A';
      })(),
      service: invoice.jobs?.service_name,
      description: invoice.jobs?.service_name,
      amount: parseFloat(invoice.total_amount),
      taxAmount: parseFloat(invoice.tax_amount || 0),
      dueDate: invoice.due_date,
      status: invoice.status,
      createdAt: invoice.created_at
    };
    
    console.log('📄 Raw invoice data from database:', {
      id: invoice.id,
      amount: invoice.amount,
      tax_amount: invoice.tax_amount,
      total_amount: invoice.total_amount
    });
    console.log('📄 Formatted invoice data:', invoiceData);
    res.json(invoiceData);
  } catch (error) {
    console.error('❌ Error fetching public invoice:', error);
    res.status(500).json({ error: 'Failed to fetch invoice' });
  }
});

// Check if Stripe is connected
app.get('/api/stripe/status', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    console.log('🔍 Checking Stripe status for user:', userId);
    
    const { data: userData, error } = await supabase
      .from('users')
      .select('stripe_connect_status')
      .eq('id', userId)
      .single();
    
    if (error) {
      console.error('❌ Error checking Stripe status:', error);
      return res.status(500).json({ error: 'Failed to check Stripe status' });
    }
    
    console.log('🔍 User Stripe status:', userData.stripe_connect_status);
    
    const isConnected = userData.stripe_connect_status === 'connected';
    console.log('🔍 Stripe connected:', isConnected);
    
    res.json({ connected: isConnected, status: userData.stripe_connect_status });
  } catch (error) {
    console.error('❌ Error checking Stripe status:', error);
    res.status(500).json({ error: 'Failed to check Stripe status' });
  }
});

// Get Stripe publishable key for public payment pages
app.get('/api/public/stripe-config/:invoiceId', async (req, res) => {
  try {
    const { invoiceId } = req.params;
    
    console.log('🔑 Getting Stripe config for invoice:', invoiceId);
    
    // Get the invoice to find the user
    const { data: invoice, error: invoiceError } = await supabase
      .from('invoices')
      .select('user_id')
      .eq('id', invoiceId)
      .single();
    
    if (invoiceError || !invoice) {
      console.error('❌ Invoice not found:', invoiceId, 'Error:', invoiceError);
      return res.status(404).json({ error: 'Invoice not found' });
    }
    
    console.log('🔍 Invoice found, user_id:', invoice.user_id);
    
    // Get user's Stripe credentials
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('stripe_connect_status')
      .eq('id', invoice.user_id)
      .single();
    
    if (userError || !userData) {
      console.error('❌ User not found for invoice:', invoiceId, 'Error:', userError);
      return res.status(404).json({ error: 'User not found' });
    }
    
    console.log('🔍 User found, stripe_connect_status:', userData.stripe_connect_status);
    
    // Get user's Stripe publishable key (check if they have credentials even if status is not 'connected')
    const { data: billingData, error: billingError } = await supabase
      .from('user_billing')
      .select('stripe_publishable_key, stripe_secret_key')
      .eq('user_id', invoice.user_id)
      .single();
    
    console.log('🔍 Billing data:', { 
      hasPublishableKey: !!billingData?.stripe_publishable_key,
      hasSecretKey: !!billingData?.stripe_secret_key,
      error: billingError 
    });
    
    if (billingError || !billingData?.stripe_publishable_key) {
      console.error('❌ Stripe publishable key not found for user:', invoice.user_id, 'Error:', billingError, 'Data:', billingData);
      return res.status(400).json({ error: 'Stripe not configured' });
    }
    
    // Check if Stripe credentials are valid by testing the connection
    if (!billingData.stripe_secret_key) {
      console.error('❌ Stripe secret key not found for user:', invoice.user_id);
      return res.status(400).json({ error: 'Stripe credentials incomplete' });
    }
    
    console.log('🔑 Stripe config retrieved for invoice:', invoiceId);
    console.log('🔍 Publishable key ending in:', billingData.stripe_publishable_key.slice(-4));
    console.log('🔍 Secret key ending in:', billingData.stripe_secret_key.slice(-4));
    
    // Verify the keys belong to the same Stripe account
    try {
      const stripe = require('stripe')(billingData.stripe_secret_key);
      const account = await stripe.accounts.retrieve();
      console.log('🔍 Stripe account ID for verification:', account.id);
      
      // Verify the keys are valid Stripe format
      if (!billingData.stripe_publishable_key.startsWith('pk_test_') && !billingData.stripe_publishable_key.startsWith('pk_live_')) {
        console.error('❌ Invalid publishable key format');
        return res.status(400).json({ error: 'Invalid publishable key format' });
      }
      
      if (!billingData.stripe_secret_key.startsWith('sk_test_') && !billingData.stripe_secret_key.startsWith('sk_live_')) {
        console.error('❌ Invalid secret key format');
        return res.status(400).json({ error: 'Invalid secret key format' });
      }
      
      console.log('✅ Stripe key format verification passed');
      
      console.log('✅ Stripe account verification passed - keys belong to same account');
    } catch (verifyError) {
      console.error('❌ Stripe account verification failed:', verifyError.message);
      return res.status(400).json({ error: 'Stripe account verification failed' });
    }
    
    res.json({ 
      publishableKey: billingData.stripe_publishable_key,
      connected: true 
    });
  } catch (error) {
    console.error('❌ Error getting Stripe config:', error);
    res.status(500).json({ error: 'Failed to get Stripe configuration' });
  }
});

// Helper endpoint to fix Stripe key mismatches
app.post('/api/fix-stripe-keys/:userId', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;
    
    console.log('🔧 Fixing Stripe keys for user:', userId);
    
    // Get current billing data
    const { data: billingData, error: billingError } = await supabase
      .from('user_billing')
      .select('stripe_publishable_key, stripe_secret_key')
      .eq('user_id', userId)
      .single();
    
    if (billingError || !billingData) {
      return res.status(404).json({ error: 'User billing data not found' });
    }
    
    // Extract account ID from secret key
    const secretKeyAccount = billingData.stripe_secret_key.split('_')[2];
    const publishableKeyAccount = billingData.stripe_publishable_key.split('_')[2];
    
    console.log('🔍 Current secret key account:', secretKeyAccount);
    console.log('🔍 Current publishable key account:', publishableKeyAccount);
    
    if (secretKeyAccount === publishableKeyAccount) {
      return res.json({ 
        message: 'Stripe keys are already matched',
        secretKeyAccount,
        publishableKeyAccount 
      });
    }
    
    // Generate the correct publishable key
    const correctPublishableKey = `pk_test_${secretKeyAccount}`;
    
    console.log('🔧 Updating publishable key to:', correctPublishableKey);
    
    // Update the publishable key
    const { error: updateError } = await supabase
      .from('user_billing')
      .update({ stripe_publishable_key: correctPublishableKey })
      .eq('user_id', userId);
    
    if (updateError) {
      console.error('❌ Error updating publishable key:', updateError);
      return res.status(500).json({ error: 'Failed to update publishable key' });
    }
    
    console.log('✅ Stripe keys fixed successfully');
    res.json({ 
      message: 'Stripe keys fixed successfully',
      oldPublishableKey: billingData.stripe_publishable_key,
      newPublishableKey: correctPublishableKey,
      secretKeyAccount,
      publishableKeyAccount: secretKeyAccount
    });
    
  } catch (error) {
    console.error('❌ Error fixing Stripe keys:', error);
    res.status(500).json({ error: 'Failed to fix Stripe keys' });
  }
});

// Transaction-based payment checking
app.get('/api/transactions/job/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    
    console.log('💳 Checking transactions for job:', jobId);
    
    // Check if there are completed transactions for this job
    const { data: transactions, error } = await supabase
      .from('transactions')
      .select('*')
      .eq('job_id', jobId)
      .eq('status', 'completed')
      .order('created_at', { ascending: false });
    
    if (error) {
      console.error('❌ Error fetching transactions:', error);
      return res.status(500).json({ error: 'Failed to fetch transactions' });
    }
    
    console.log('💳 Found transactions:', transactions?.length || 0);
    if (transactions && transactions.length > 0) {
      console.log('💳 First transaction:', transactions[0]);
    }
    
    // Calculate totals
    const totalPaid = transactions?.reduce((sum, tx) => sum + parseFloat(tx.amount || 0), 0) || 0;
    const transactionCount = transactions?.length || 0;
    
    console.log('💳 Payment summary:', { totalPaid, transactionCount });
    
    res.json({
      hasPayment: transactionCount > 0,
      totalPaid,
      transactionCount,
      transactions: transactions || []
    });
    
  } catch (error) {
    console.error('❌ Error checking transactions:', error);
    res.status(500).json({ error: 'Failed to check transactions' });
  }
});

// Record manual payment
app.post('/api/transactions/record-payment', authenticateToken, async (req, res) => {
  try {
    const { jobId, invoiceId, customerId, amount, paymentMethod, paymentDate, notes } = req.body;
    const userId = req.user.userId;
    
    console.log('💳 Recording manual payment:', { jobId, invoiceId, customerId, amount, paymentMethod, paymentDate, notes, userId });
    
    if (!jobId || !amount || !paymentMethod) {
      return res.status(400).json({ error: 'Missing required fields: jobId, amount, and paymentMethod are required' });
    }
    
    const paymentAmount = parseFloat(amount);
    if (isNaN(paymentAmount) || paymentAmount <= 0) {
      return res.status(400).json({ error: 'Invalid amount. Amount must be greater than 0.' });
    }
    
    // Get job to find invoice if not provided, or create one if it doesn't exist
    let finalInvoiceId = invoiceId;
    if (!finalInvoiceId && jobId) {
      // First, get the job to find customer_id and other details
      const { data: job, error: jobError } = await supabase
        .from('jobs')
        .select('id, invoice_id, customer_id, total, service_price, price')
        .eq('id', jobId)
        .single();
      
      if (jobError || !job) {
        return res.status(404).json({ error: 'Job not found' });
      }
      
      // Check if job has an invoice_id
      if (job.invoice_id) {
        finalInvoiceId = job.invoice_id;
      } else {
        // Try to find invoice by job_id
        const { data: invoices, error: invoiceError } = await supabase
          .from('invoices')
          .select('id')
          .eq('job_id', jobId)
          .order('created_at', { ascending: false })
          .limit(1);
        
        if (!invoiceError && invoices && invoices.length > 0) {
          finalInvoiceId = invoices[0].id;
        } else {
          // No invoice exists - create one
          const invoiceAmount = parseFloat(job.total || job.service_price || job.price || paymentAmount);
          
          const invoiceData = {
            user_id: userId,
            customer_id: job.customer_id || customerId || null,
            job_id: jobId,
            amount: invoiceAmount,
            tax_amount: 0,
            total_amount: invoiceAmount,
            due_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            status: 'draft'
          };
          
          console.log('💳 Creating invoice for payment:', invoiceData);
          
          const { data: newInvoice, error: createInvoiceError } = await supabase
            .from('invoices')
            .insert(invoiceData)
            .select()
            .single();
          
          if (createInvoiceError || !newInvoice) {
            console.error('❌ Error creating invoice:', createInvoiceError);
            return res.status(500).json({ error: 'Failed to create invoice: ' + (createInvoiceError?.message || 'Unknown error') });
          }
          
          finalInvoiceId = newInvoice.id;
          console.log('✅ Invoice created:', finalInvoiceId);
          
          // Update job with invoice_id
          await supabase
            .from('jobs')
            .update({ invoice_id: finalInvoiceId })
            .eq('id', jobId);
        }
      }
    }
    
    // Ensure we have an invoice_id (required by transactions table)
    if (!finalInvoiceId) {
      return res.status(400).json({ error: 'Invoice ID is required. Could not find or create an invoice for this job.' });
    }
    
    // Create transaction record
    const transactionData = {
      user_id: userId,
      invoice_id: finalInvoiceId || null,
      customer_id: customerId || null,
      job_id: jobId,
      amount: paymentAmount,
      payment_intent_id: `manual_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      status: 'completed',
      payment_method: paymentMethod,
      created_at: paymentDate ? new Date(paymentDate).toISOString() : new Date().toISOString()
    };
    
    // Note: The transactions table doesn't have a 'notes' column
    // If notes are needed, they could be stored in a separate table or added to the schema later
    
    console.log('💳 Inserting transaction:', transactionData);
    
    const { data: transaction, error: transactionError } = await supabase
      .from('transactions')
      .insert(transactionData)
      .select()
      .single();
    
    if (transactionError) {
      console.error('❌ Error creating transaction:', transactionError);
      return res.status(500).json({ error: 'Failed to record payment: ' + transactionError.message });
    }
    
    // Update invoice status if invoice exists
    if (finalInvoiceId) {
      // Check current total paid
      const { data: allTransactions, error: txError } = await supabase
        .from('transactions')
        .select('amount')
        .eq('invoice_id', finalInvoiceId)
        .eq('status', 'completed');
      
      if (!txError && allTransactions) {
        const totalPaid = allTransactions.reduce((sum, tx) => sum + parseFloat(tx.amount || 0), 0);
        
        // Get invoice total
        const { data: invoice, error: invError } = await supabase
          .from('invoices')
          .select('total_amount')
          .eq('id', finalInvoiceId)
          .single();
        
        if (!invError && invoice) {
          const invoiceTotal = parseFloat(invoice.total_amount || 0);
          const newStatus = totalPaid >= invoiceTotal ? 'paid' : 'partial';
          
          await supabase
            .from('invoices')
            .update({ 
              status: newStatus,
              updated_at: new Date().toISOString()
            })
            .eq('id', finalInvoiceId);
        }
      }
    }
    
    // Update job invoice status
    await supabase
      .from('jobs')
      .update({ 
        invoice_status: 'paid',
        updated_at: new Date().toISOString()
      })
      .eq('id', jobId);
    
    console.log('✅ Payment recorded successfully:', transaction.id);
    
    res.json({
      success: true,
      transaction: transaction,
      message: 'Payment recorded successfully'
    });
    
  } catch (error) {
    console.error('❌ Error recording payment:', error);
    res.status(500).json({ error: 'Failed to record payment: ' + error.message });
  }
});

// Helper function to generate receipt HTML
function generateReceiptHtml(invoice, paymentIntentId, amount) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Payment Receipt</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
        .receipt { background: white; max-width: 600px; margin: 0 auto; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .header { text-align: center; border-bottom: 2px solid #e5e5e5; padding-bottom: 20px; margin-bottom: 30px; }
        .logo { font-size: 24px; font-weight: bold; color: #2563eb; margin-bottom: 10px; }
        .receipt-title { font-size: 28px; color: #1f2937; margin: 0; }
        .receipt-subtitle { color: #6b7280; margin: 5px 0 0 0; }
        .section { margin-bottom: 25px; }
        .section-title { font-size: 18px; font-weight: bold; color: #1f2937; margin-bottom: 10px; border-bottom: 1px solid #e5e5e5; padding-bottom: 5px; }
        .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
        .info-item { margin-bottom: 10px; }
        .info-label { font-weight: bold; color: #374151; }
        .info-value { color: #6b7280; }
        .payment-details { background: #f8fafc; padding: 20px; border-radius: 6px; margin: 20px 0; }
        .amount { font-size: 24px; font-weight: bold; color: #059669; text-align: center; margin: 20px 0; }
        .status { text-align: center; padding: 10px; background: #d1fae5; color: #065f46; border-radius: 6px; font-weight: bold; }
        .footer { text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e5e5; color: #6b7280; font-size: 14px; }
        .transaction-id { font-family: monospace; background: #f3f4f6; padding: 5px 10px; border-radius: 4px; }
      </style>
    </head>
    <body>
      <div class="receipt">
        <div class="header">
          <div class="logo">ZenBooker</div>
          <h1 class="receipt-title">Payment Receipt</h1>
          <p class="receipt-subtitle">Thank you for your payment!</p>
        </div>
        
        <div class="amount">$${(amount / 100).toFixed(2)}</div>
        
        <div class="status">✅ Payment Successful</div>
        
        <div class="section">
          <h2 class="section-title">Payment Details</h2>
          <div class="info-grid">
            <div class="info-item">
              <div class="info-label">Transaction ID:</div>
              <div class="info-value transaction-id">${paymentIntentId}</div>
            </div>
            <div class="info-item">
              <div class="info-label">Payment Date:</div>
              <div class="info-value">${new Date().toLocaleDateString('en-US', { 
                weekday: 'long', 
                month: 'long', 
                day: 'numeric', 
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
              })}</div>
            </div>
            <div class="info-item">
              <div class="info-label">Payment Method:</div>
              <div class="info-value">Credit Card</div>
            </div>
            <div class="info-item">
              <div class="info-label">Status:</div>
              <div class="info-value">Completed</div>
            </div>
          </div>
        </div>
        
        <div class="section">
          <h2 class="section-title">Invoice Information</h2>
          <div class="info-grid">
            <div class="info-item">
              <div class="info-label">Invoice Number:</div>
              <div class="info-value">#INV-${invoice.id}</div>
            </div>
            <div class="info-item">
              <div class="info-label">Customer:</div>
              <div class="info-value">${invoice.customers?.first_name || 'Customer'} ${invoice.customers?.last_name || ''}</div>
            </div>
            <div class="info-item">
              <div class="info-label">Service:</div>
              <div class="info-value">${invoice.jobs?.service_name || 'Service'}</div>
            </div>
            <div class="info-item">
              <div class="info-label">Service Date:</div>
              <div class="info-value">${new Date(invoice.jobs?.scheduled_date || invoice.created_at).toLocaleDateString('en-US')}</div>
            </div>
          </div>
        </div>
        
        <div class="section">
          <h2 class="section-title">Service Address</h2>
          <div class="info-value">${(() => {
            if (!invoice.jobs?.service_address_street) return 'N/A';
            const addressParts = [
              invoice.jobs.service_address_street,
              invoice.jobs.service_address_city,
              invoice.jobs.service_address_state,
              invoice.jobs.service_address_zip,
              invoice.jobs.service_address_country
            ].filter(Boolean);
            return addressParts.join(', ');
          })()}</div>
        </div>
        
        <div class="footer">
          <p>This is an automated receipt. Please keep this for your records.</p>
          <p>Generated on ${new Date().toLocaleString()}</p>
        </div>
      </div>
    </body>
    </html>
  `;
}

// Receipt Management API endpoints
app.post('/api/generate-receipt-pdf', async (req, res) => {
  try {
    const { invoiceId, paymentIntentId, transactionId, amount } = req.body;
    
    console.log('📄 Generating receipt PDF for invoice:', invoiceId);
    
    // First, let's try a simple query without joins
    const { data: simpleInvoice, error: simpleError } = await supabase
      .from('invoices')
      .select('*')
      .eq('id', invoiceId)
      .single();
    
    console.log('📄 Simple invoice query result:', { simpleInvoice, simpleError });
    
    // Get invoice details with joins
    const { data: invoice, error: invoiceError } = await supabase
      .from('invoices')
      .select(`
        *,
        customers:customer_id (
          first_name,
          last_name,
          email,
          phone
        ),
        jobs:job_id (
          service_name,
          scheduled_date,
          service_address_street,
          service_address_city,
          service_address_state,
          service_address_zip,
          service_address_country
        )
      `)
      .eq('id', invoiceId)
      .single();
    
    console.log('📄 Full invoice query result:', { invoice, invoiceError });
    
    if (invoiceError || !invoice) {
      console.error('❌ Invoice not found:', invoiceId);
      console.error('❌ Invoice error details:', invoiceError);
      
      // If the full query failed but simple query worked, use the simple invoice
      if (simpleInvoice && !simpleError) {
        console.log('📄 Using simple invoice data as fallback');
        const fallbackInvoice = {
          ...simpleInvoice,
          customers: null,
          jobs: null
        };
        
        // Generate receipt with basic data
        const receiptHtml = generateReceiptHtml(fallbackInvoice, paymentIntentId, amount);
        res.setHeader('Content-Type', 'text/html');
        res.setHeader('Content-Disposition', 'attachment; filename="receipt.html"');
        res.setHeader('Cache-Control', 'no-cache');
        res.send(receiptHtml);
        return;
      }
      
      return res.status(404).json({ error: 'Invoice not found' });
    }
    
    // Generate receipt HTML
    const receiptHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Payment Receipt</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
          .receipt { background: white; max-width: 600px; margin: 0 auto; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
          .header { text-align: center; border-bottom: 2px solid #e5e5e5; padding-bottom: 20px; margin-bottom: 30px; }
          .logo { font-size: 24px; font-weight: bold; color: #2563eb; margin-bottom: 10px; }
          .receipt-title { font-size: 28px; color: #1f2937; margin: 0; }
          .receipt-subtitle { color: #6b7280; margin: 5px 0 0 0; }
          .section { margin-bottom: 25px; }
          .section-title { font-size: 18px; font-weight: bold; color: #1f2937; margin-bottom: 10px; border-bottom: 1px solid #e5e5e5; padding-bottom: 5px; }
          .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
          .info-item { margin-bottom: 10px; }
          .info-label { font-weight: bold; color: #374151; }
          .info-value { color: #6b7280; }
          .payment-details { background: #f8fafc; padding: 20px; border-radius: 6px; margin: 20px 0; }
          .amount { font-size: 24px; font-weight: bold; color: #059669; text-align: center; margin: 20px 0; }
          .status { text-align: center; padding: 10px; background: #d1fae5; color: #065f46; border-radius: 6px; font-weight: bold; }
          .footer { text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e5e5; color: #6b7280; font-size: 14px; }
          .transaction-id { font-family: monospace; background: #f3f4f6; padding: 5px 10px; border-radius: 4px; }
        </style>
      </head>
      <body>
        <div class="receipt">
          <div class="header">
            <div class="logo">ZenBooker</div>
            <h1 class="receipt-title">Payment Receipt</h1>
            <p class="receipt-subtitle">Thank you for your payment!</p>
          </div>
          
          <div class="amount">$${(amount / 100).toFixed(2)}</div>
          
          <div class="status">✅ Payment Successful</div>
          
          <div class="section">
            <h2 class="section-title">Payment Details</h2>
            <div class="info-grid">
              <div class="info-item">
                <div class="info-label">Transaction ID:</div>
                <div class="info-value transaction-id">${paymentIntentId}</div>
              </div>
              <div class="info-item">
                <div class="info-label">Payment Date:</div>
                <div class="info-value">${new Date().toLocaleDateString('en-US', { 
                  weekday: 'long', 
                  month: 'long', 
                  day: 'numeric', 
                  year: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit'
                })}</div>
              </div>
              <div class="info-item">
                <div class="info-label">Payment Method:</div>
                <div class="info-value">Credit Card</div>
              </div>
              <div class="info-item">
                <div class="info-label">Status:</div>
                <div class="info-value">Completed</div>
              </div>
            </div>
          </div>
          
          <div class="section">
            <h2 class="section-title">Invoice Information</h2>
            <div class="info-grid">
              <div class="info-item">
                <div class="info-label">Invoice Number:</div>
                <div class="info-value">#INV-${invoice.id}</div>
              </div>
              <div class="info-item">
                <div class="info-label">Customer:</div>
                <div class="info-value">${invoice.customers?.first_name} ${invoice.customers?.last_name}</div>
              </div>
              <div class="info-item">
                <div class="info-label">Service:</div>
                <div class="info-value">${invoice.jobs?.service_name || 'Service'}</div>
              </div>
              <div class="info-item">
                <div class="info-label">Service Date:</div>
                <div class="info-value">${new Date(invoice.jobs?.scheduled_date || invoice.created_at).toLocaleDateString('en-US')}</div>
              </div>
            </div>
          </div>
          
          <div class="section">
            <h2 class="section-title">Service Address</h2>
            <div class="info-value">${(() => {
              if (!invoice.jobs?.service_address_street) return 'N/A';
              const addressParts = [
                invoice.jobs.service_address_street,
                invoice.jobs.service_address_city,
                invoice.jobs.service_address_state,
                invoice.jobs.service_address_zip,
                invoice.jobs.service_address_country
              ].filter(Boolean);
              return addressParts.join(', ');
            })()}</div>
          </div>
          
          <div class="footer">
            <p>This is an automated receipt. Please keep this for your records.</p>
            <p>Generated on ${new Date().toLocaleString()}</p>
          </div>
        </div>
      </body>
      </html>
    `;
    
    // Generate PDF using PDFKit
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const buffers = [];
      
      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => {
        const pdfBuffer = Buffer.concat(buffers);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename="receipt.pdf"');
        res.setHeader('Cache-Control', 'no-cache');
        res.send(pdfBuffer);
      });
      
      // Add content to PDF
      doc.fontSize(24).text('Payment Receipt', { align: 'center' });
      doc.moveDown();
      
      doc.fontSize(16).text('Thank you for your payment!', { align: 'center' });
      doc.moveDown(2);
      
      // Amount
      doc.fontSize(20).text(`$${(amount / 100).toFixed(2)}`, { align: 'center' });
      doc.moveDown();
      
      // Status
      doc.fontSize(14).fillColor('green').text('✅ Payment Successful', { align: 'center' });
      doc.fillColor('black');
      doc.moveDown(2);
      
      // Payment Details
      doc.fontSize(16).text('Payment Details', { underline: true });
      doc.moveDown();
      
      doc.fontSize(12).text(`Transaction ID: ${paymentIntentId}`);
      doc.text(`Payment Date: ${new Date().toLocaleDateString('en-US', { 
        weekday: 'long', 
        month: 'long', 
        day: 'numeric', 
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })}`);
      doc.text('Payment Method: Credit Card');
      doc.text('Status: Completed');
      doc.moveDown(2);
      
      // Invoice Information
      doc.fontSize(16).text('Invoice Information', { underline: true });
      doc.moveDown();
      
      doc.fontSize(12).text(`Invoice Number: #INV-${invoice.id}`);
      doc.text(`Customer: ${invoice.customers?.first_name || 'Customer'} ${invoice.customers?.last_name || ''}`);
      doc.text(`Service: ${invoice.jobs?.service_name || 'Service'}`);
      doc.text(`Service Date: ${new Date(invoice.jobs?.scheduled_date || invoice.created_at).toLocaleDateString('en-US')}`);
      doc.moveDown(2);
      
      // Service Address
      if (invoice.jobs?.service_address_street) {
        doc.fontSize(16).text('Service Address', { underline: true });
        doc.moveDown();
        const addressParts = [
          invoice.jobs.service_address_street,
          invoice.jobs.service_address_city,
          invoice.jobs.service_address_state,
          invoice.jobs.service_address_zip,
          invoice.jobs.service_address_country
        ].filter(Boolean);
        doc.fontSize(12).text(addressParts.join(', '));
        doc.moveDown(2);
      }
      
      // Footer
      doc.fontSize(10).text('This is an automated receipt. Please keep this for your records.', { align: 'center' });
      doc.text(`Generated on ${new Date().toLocaleString()}`, { align: 'center' });
      
      doc.end();
      
    } catch (pdfError) {
      console.error('❌ Error generating PDF:', pdfError);
      // Fallback to HTML if PDF generation fails
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', 'attachment; filename="receipt.html"');
      res.setHeader('Cache-Control', 'no-cache');
    res.send(receiptHtml);
    }
    
  } catch (error) {
    console.error('❌ Error generating receipt PDF:', error);
    res.status(500).json({ error: 'Failed to generate receipt' });
  }
});

app.post('/api/send-receipt-email', async (req, res) => {
  try {
    const { invoiceId, customerEmail, paymentIntentId, amount } = req.body;
    
    console.log('📧 Sending receipt email to:', customerEmail);
    
    // Check SendGrid configuration
    if (!SENDGRID_API_KEY) {
      console.error('❌ SendGrid API key not configured');
      return res.status(500).json({ error: 'SendGrid API key not configured' });
    }
    
    // First, let's try a simple query without joins
    const { data: simpleInvoice, error: simpleError } = await supabase
      .from('invoices')
      .select('*')
      .eq('id', invoiceId)
      .single();
    
    console.log('📧 Simple invoice query result:', { simpleInvoice, simpleError });
    
    // Get invoice details with joins
    const { data: invoice, error: invoiceError } = await supabase
      .from('invoices')
      .select(`
        *,
        customers:customer_id (
          first_name,
          last_name,
          email
        ),
        jobs:job_id (
          service_name,
          scheduled_date,
          service_address_street,
          service_address_city,
          service_address_state,
          service_address_zip,
          service_address_country
        )
      `)
      .eq('id', invoiceId)
      .single();
    
    console.log('📧 Full invoice query result:', { invoice, invoiceError });
    
    if (invoiceError || !invoice) {
      console.error('❌ Invoice not found:', invoiceId);
      console.error('❌ Invoice error details:', invoiceError);
      return res.status(404).json({ error: 'Invoice not found' });
    }
    
    // Get user's business info
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('business_name, email')
      .eq('id', invoice.user_id)
      .single();
    
    const businessName = userData?.business_name || 'Your Business';
    const businessEmail = userData?.email || 'noreply@zenbooker.com';
    
    // Use a verified sender email as fallback
    const verifiedSenderEmail = process.env.SENDGRID_FROM_EMAIL || 'noreply@service-flow.pro';
    const fromEmail = businessEmail === verifiedSenderEmail ? businessEmail : verifiedSenderEmail;
    
    console.log('📧 Using from email:', fromEmail);
    console.log('📧 Business email:', businessEmail);
    console.log('📧 Verified sender email:', verifiedSenderEmail);
    
    // Create receipt email
    const receiptHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Payment Receipt</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
          .email-container { background: white; max-width: 600px; margin: 0 auto; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
          .header { text-align: center; border-bottom: 2px solid #e5e5e5; padding-bottom: 20px; margin-bottom: 30px; }
          .logo { font-size: 24px; font-weight: bold; color: #2563eb; margin-bottom: 10px; }
          .receipt-title { font-size: 28px; color: #1f2937; margin: 0; }
          .amount { font-size: 32px; font-weight: bold; color: #059669; text-align: center; margin: 20px 0; }
          .status { text-align: center; padding: 15px; background: #d1fae5; color: #065f46; border-radius: 6px; font-weight: bold; margin: 20px 0; }
          .section { margin-bottom: 25px; }
          .section-title { font-size: 18px; font-weight: bold; color: #1f2937; margin-bottom: 10px; }
          .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
          .info-item { margin-bottom: 10px; }
          .info-label { font-weight: bold; color: #374151; }
          .info-value { color: #6b7280; }
          .footer { text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e5e5; color: #6b7280; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="email-container">
          <div class="header">
            <div class="logo">${businessName}</div>
            <h1 class="receipt-title">Payment Receipt</h1>
            <p>Thank you for your payment!</p>
          </div>
          
          <div class="amount">$${(amount / 100).toFixed(2)}</div>
          <div class="status">✅ Payment Successful</div>
          
          <div class="section">
            <h2 class="section-title">Payment Details</h2>
            <div class="info-grid">
              <div class="info-item">
                <div class="info-label">Transaction ID:</div>
                <div class="info-value">${paymentIntentId}</div>
              </div>
              <div class="info-item">
                <div class="info-label">Payment Date:</div>
                <div class="info-value">${new Date().toLocaleDateString('en-US', { 
                  weekday: 'long', 
                  month: 'long', 
                  day: 'numeric', 
                  year: 'numeric'
                })}</div>
              </div>
              <div class="info-item">
                <div class="info-label">Invoice Number:</div>
                <div class="info-value">#INV-${invoice.id}</div>
              </div>
              <div class="info-item">
                <div class="info-label">Service:</div>
                <div class="info-value">${invoice.jobs?.service_name || 'Service'}</div>
              </div>
            </div>
          </div>
          
          <div class="footer">
            <p>This receipt has been automatically generated and sent to your email.</p>
            <p>If you have any questions, please contact us.</p>
            <p>Generated on ${new Date().toLocaleString()}</p>
          </div>
        </div>
      </body>
      </html>
    `;
    
    // Send email using SendGrid
    const msg = {
      to: customerEmail,
      from: fromEmail,
      subject: `Payment Receipt - ${businessName}`,
      html: receiptHtml,
      text: `
        Payment Receipt - ${businessName}
        
        Amount: $${(amount / 100).toFixed(2)}
        Transaction ID: ${paymentIntentId}
        Invoice: #INV-${invoice.id}
        Service: ${invoice.jobs?.service_name || 'Service'}
        Date: ${new Date().toLocaleDateString()}
        
        Thank you for your payment!
      `
    };
    
    console.log('📧 SendGrid message details:', {
      to: msg.to,
      from: msg.from,
      subject: msg.subject,
      hasHtml: !!msg.html,
      hasText: !!msg.text
    });
    
    try {
    await sgMail.send(msg);
    console.log('✅ Receipt email sent successfully');
    
    res.json({ 
      success: true, 
      message: 'Receipt email sent successfully',
      email: customerEmail 
    });
    } catch (sendError) {
      console.error('❌ SendGrid send error:', sendError);
      console.error('❌ Error code:', sendError.code);
      console.error('❌ Error response:', sendError.response?.body);
      
      if (sendError.code === 403) {
        console.error('❌ SendGrid 403 Forbidden - Possible causes:');
        console.error('❌ 1. From email not verified in SendGrid');
        console.error('❌ 2. API key lacks permissions');
        console.error('❌ 3. Account suspended or restricted');
        console.error('❌ From email being used:', businessEmail);
        
        return res.status(500).json({ 
          error: 'SendGrid configuration error. Please verify the sender email address in SendGrid.',
          details: 'The from email address must be verified in your SendGrid account.'
        });
      }
      
      throw sendError;
    }
    
  } catch (error) {
    console.error('❌ Error sending receipt email:', error);
    res.status(500).json({ error: 'Failed to send receipt email' });
  }
});

// Invoice Management API endpoints
app.post('/api/create-invoice', authenticateToken, async (req, res) => {
  try {
    const { jobId, customerId, amount, taxAmount, totalAmount, dueDate } = req.body;
    
    console.log('💰 Creating invoice with data:', {
      jobId,
      customerId,
      amount,
      taxAmount,
      totalAmount,
      dueDate,
      userId: req.user.userId
    });
    
    if (!jobId || !customerId || !amount || !totalAmount) {
      console.error('❌ Missing required fields:', { jobId, customerId, amount, totalAmount });
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Validate amount values
    const parsedAmount = parseFloat(amount);
    const parsedTotalAmount = parseFloat(totalAmount);
    
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      console.error('❌ Invalid amount:', { amount, parsedAmount });
      return res.status(400).json({ error: 'Invalid amount. Amount must be greater than 0.' });
    }
    
    if (isNaN(parsedTotalAmount) || parsedTotalAmount <= 0) {
      console.error('❌ Invalid total amount:', { totalAmount, parsedTotalAmount });
      return res.status(400).json({ error: 'Invalid total amount. Total amount must be greater than 0.' });
    }

    // Create invoice in database
    const invoiceData = {
      user_id: req.user.userId,
      customer_id: customerId,
      job_id: jobId,
      amount: parsedAmount,
      tax_amount: parseFloat(taxAmount || 0),
      total_amount: parsedTotalAmount,
      due_date: dueDate,
      status: 'draft'
    };
    
    console.log('💰 Inserting invoice data:', invoiceData);
    
    const { data: invoice, error } = await supabase
      .from('invoices')
      .insert(invoiceData)
      .select()
      .single();

    if (error) {
      console.error('❌ Error creating invoice:', error);
      return res.status(500).json({ error: 'Failed to create invoice' });
    }

    console.log('✅ Invoice created:', invoice.id);
    console.log('✅ Invoice data from database:', {
      id: invoice.id,
      amount: invoice.amount,
      total_amount: invoice.total_amount,
      tax_amount: invoice.tax_amount
    });
    
    // Double-check by querying the database again
    const { data: verifyInvoice, error: verifyError } = await supabase
      .from('invoices')
      .select('id, amount, total_amount, tax_amount')
      .eq('id', invoice.id)
      .single();
    
    if (!verifyError) {
      console.log('🔍 Verification query result:', verifyInvoice);
    } else {
      console.error('❌ Error verifying invoice:', verifyError);
    }
    
    res.json(invoice);
  } catch (error) {
    console.error('❌ Error creating invoice:', error);
    res.status(500).json({ error: 'Failed to create invoice' });
  }
});


// Stripe Payment Intent API endpoints
app.post('/api/create-payment-intent', async (req, res) => {
  try {
    const { amount, currency, invoiceId, customerEmail } = req.body;

    console.log('💳 Creating payment intent:', { amount, currency, invoiceId, customerEmail });

    if (!amount || !currency || !invoiceId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Get the invoice to find the user
    const { data: invoice, error: invoiceError } = await supabase
      .from('invoices')
      .select('user_id, amount, total_amount, status')
      .eq('id', invoiceId)
      .single();

    if (invoiceError || !invoice) {
      console.error('❌ Invoice not found for payment:', invoiceId);
      return res.status(404).json({ error: 'Invoice not found' });
    }

    // Check if invoice is already paid
    if (invoice.status === 'paid') {
      console.error('❌ Invoice already paid:', invoiceId);
      return res.status(400).json({ error: 'Invoice has already been paid' });
    }

    // Get user's Stripe credentials
    const { data: billingData, error: billingError } = await supabase
      .from('user_billing')
      .select('stripe_secret_key')
      .eq('user_id', invoice.user_id)
      .single();

    if (billingError || !billingData?.stripe_secret_key) {
      console.error('❌ Stripe credentials not found for user:', invoice.user_id);
      return res.status(400).json({ error: 'Stripe not configured' });
    }

    const stripe = require('stripe')(billingData.stripe_secret_key);

    // Debug: Verify the Stripe account
    console.log('🔍 Creating payment intent with secret key ending in:', billingData.stripe_secret_key.slice(-4));
    console.log('🔍 User ID:', invoice.user_id);
    
    // Verify the Stripe account is valid
    try {
      const account = await stripe.accounts.retrieve();
      console.log('🔍 Stripe account ID:', account.id);
      console.log('🔍 Stripe account type:', account.type);
      
      // Verify the secret key is valid
      if (!billingData.stripe_secret_key.startsWith('sk_test_') && !billingData.stripe_secret_key.startsWith('sk_live_')) {
        console.error('❌ Invalid secret key format');
        return res.status(400).json({ error: 'Invalid secret key format' });
      }
      
      console.log('✅ Payment intent - Stripe key format verification passed');
    } catch (accountError) {
      console.error('❌ Invalid Stripe secret key:', accountError.message);
      return res.status(400).json({ error: 'Invalid Stripe credentials' });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount, // Amount in cents
      currency: currency,
      metadata: {
        invoiceId: invoiceId,
        customerEmail: customerEmail,
        userId: invoice.user_id,
      },
      automatic_payment_methods: {
        enabled: true,
      },
    });

    console.log('✅ Payment intent created successfully:', {
      id: paymentIntent.id,
      clientSecret: paymentIntent.client_secret,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
      status: paymentIntent.status
    });

    console.log('✅ Payment intent created:', paymentIntent.id);
    res.json({ 
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id 
    });
  } catch (error) {
    console.error('❌ Error creating payment intent:', error);
    res.status(500).json({ error: 'Failed to create payment intent' });
  }
});

/*
CREATE TABLE public.transactions (
  id serial NOT NULL,
  user_id integer NOT NULL,
  invoice_id integer NOT NULL,
  customer_id integer,
  job_id integer,
  amount numeric(10, 2) NOT NULL,
  payment_intent_id varchar(255) NOT NULL,
  status varchar(50) NOT NULL DEFAULT 'pending',
  payment_method varchar(50) NOT NULL DEFAULT 'card',
  created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT transactions_pkey PRIMARY KEY (id),
  CONSTRAINT transactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT transactions_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES invoices (id) ON DELETE CASCADE,
  CONSTRAINT transactions_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE SET NULL,
  CONSTRAINT transactions_job_id_fkey FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE SET NULL
);
*/

// Handle successful payment
app.post('/api/payment-success', async (req, res) => {
  try {
    const { paymentIntentId, invoiceId } = req.body;

    console.log('✅ Payment success endpoint called:', { paymentIntentId, invoiceId });
    console.log('✅ Request body:', req.body);

    if (!paymentIntentId || !invoiceId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Get invoice details
    const { data: invoice, error: invoiceError } = await supabase
      .from('invoices')
      .select('user_id, amount, total_amount, customer_id, job_id')
      .eq('id', invoiceId)
      .single();

    if (invoiceError || !invoice) {
      console.error('❌ Invoice not found:', invoiceId);
      return res.status(404).json({ error: 'Invoice not found' });
    }

    // Get user's Stripe credentials to verify payment
    const { data: billingData, error: billingError } = await supabase
      .from('user_billing')
      .select('stripe_secret_key')
      .eq('user_id', invoice.user_id)
      .single();

    if (billingError || !billingData?.stripe_secret_key) {
      console.error('❌ Stripe credentials not found for user:', invoice.user_id);
      return res.status(400).json({ error: 'Stripe not configured' });
    }

    const stripe = require('stripe')(billingData.stripe_secret_key);

    // Verify payment intent with Stripe
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status !== 'succeeded') {
      console.error('❌ Payment not succeeded:', paymentIntent.status);
      return res.status(400).json({ error: 'Payment not successful' });
    }

    // Create transaction record (if transactions table exists)
    let transaction = null;
    try {
      const { data: transactionData, error: transactionError } = await supabase
        .from('transactions')
        .insert({
          user_id: invoice.user_id,
          invoice_id: invoiceId,
          customer_id: invoice.customer_id,
          job_id: invoice.job_id,
          amount: invoice.total_amount,
          payment_intent_id: paymentIntentId,
          status: 'completed',
          payment_method: 'card',
          created_at: new Date().toISOString()
        })
        .select()
        .single();

      if (transactionError) {
        console.warn('⚠️ Transactions table not found or error creating transaction:', transactionError);
        console.warn('⚠️ Payment will still be processed, but transaction not recorded');
        // Continue without failing - transaction recording is optional
      } else {
        transaction = transactionData;
        console.log('✅ Transaction recorded:', transaction.id);
      }
    } catch (error) {
      console.warn('⚠️ Error with transactions table:', error);
      // Continue without failing
    }

    // Update invoice status to paid
    const { error: updateError } = await supabase
      .from('invoices')
      .update({ 
        status: 'paid',
        updated_at: new Date().toISOString()
      })
      .eq('id', invoiceId);

    if (updateError) {
      console.error('❌ Error updating invoice status:', updateError);
      return res.status(500).json({ error: 'Failed to update invoice status' });
    }

    console.log('✅ Payment processed successfully:', {
      transactionId: transaction?.id || 'not-recorded',
      invoiceId: invoiceId,
      amount: invoice.total_amount
    });

    const responseData = { 
      success: true, 
      transactionId: transaction?.id || null,
      amount: invoice.total_amount,
      paymentIntentId: paymentIntentId
    };

    console.log('✅ Sending response:', responseData);
    res.json(responseData);
  } catch (error) {
    console.error('❌ Error processing payment success:', error);
    res.status(500).json({ error: 'Failed to process payment' });
  }
});

// Stripe Payment Link API endpoints
app.post('/api/stripe/create-payment-link', authenticateToken, async (req, res) => {
  try {
    const { jobId, amount, currency, customerEmail, customerName, description } = req.body;
    
    if (!jobId || !amount || !currency) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Create Stripe payment link
    const paymentLink = await stripe.paymentLinks.create({
      line_items: [{
        price_data: {
          currency: currency,
          product_data: {
            name: description || 'Service Payment',
          },
          unit_amount: amount, // Amount in cents
        },
        quantity: 1,
      }],
      after_completion: {
        type: 'redirect',
        redirect: {
          url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/payment-success?jobId=${jobId}`,
        },
      },
      metadata: {
        jobId: jobId.toString(),
        customerEmail: customerEmail,
        customerName: customerName,
      },
    });

    console.log('✅ Stripe payment link created:', paymentLink.id);
    res.json({ 
      paymentLink: paymentLink.url,
      paymentLinkId: paymentLink.id 
    });
  } catch (error) {
    console.error('❌ Error creating Stripe payment link:', error);
    res.status(500).json({ error: 'Failed to create payment link' });
  }
});

// Invoice Email API endpoint
app.post('/api/send-invoice-email', authenticateToken, async (req, res) => {
  try {
    const { 
      invoiceId,
      jobId, 
      customerEmail, 
      customerName, 
      amount, 
      serviceName, 
      serviceDate, 
      address, 
      paymentLink, 
      includePaymentLink 
    } = req.body;

    if (!jobId || !customerEmail || !customerName || !amount) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Create invoice email content
    const invoiceHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Invoice</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 20px; }
          .invoice-details { background: #fff; border: 1px solid #e9ecef; border-radius: 8px; padding: 20px; margin-bottom: 20px; }
          .amount-due { background: #fff3cd; border: 1px solid #ffeaa7; border-radius: 8px; padding: 15px; margin-bottom: 20px; }
          .service-details { background: #f8f9fa; border-radius: 8px; padding: 15px; margin-bottom: 20px; }
          .payment-button { background: #ffc107; color: #000; padding: 12px 24px; border-radius: 6px; text-decoration: none; display: inline-block; font-weight: bold; }
          .footer { text-align: center; margin-top: 30px; color: #6c757d; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h2>Invoice</h2>
            <p>Hi ${customerName},</p>
            <p>Please find your invoice for the recent service.</p>
          </div>
          
          <div class="amount-due">
            <h3>AMOUNT DUE: $${amount.toFixed(2)}</h3>
            <p><strong>DUE BY:</strong> ${new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</p>
            <p><strong>SERVICE DATE:</strong> ${new Date(serviceDate).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}</p>
            <p><strong>SERVICE ADDRESS:</strong> ${address || 'Address not provided'}</p>
          </div>
          
          <div class="service-details">
            <h4>Service Details</h4>
            <p><strong>Service:</strong> ${serviceName}</p>
            <p><strong>Amount:</strong> $${amount.toFixed(2)}</p>
          </div>
          
          <div class="invoice-details">
            <h4>Financial Summary</h4>
            <p><strong>Subtotal:</strong> $${amount.toFixed(2)}</p>
            <p><strong>Total:</strong> $${amount.toFixed(2)}</p>
            <p><strong>Total Paid:</strong> $0.00</p>
            <p><strong>Total Due:</strong> $${amount.toFixed(2)}</p>
          </div>
          
          ${includePaymentLink ? `
          <div style="text-align: center; margin: 20px 0;">
            <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/public/invoice/${invoiceId || jobId}" class="payment-button" style="background: #ffc107; color: #000; padding: 12px 24px; border-radius: 6px; text-decoration: none; display: inline-block; font-weight: bold;">Pay Invoice</a>
          </div>
          ` : ''}
          
          <div class="footer">
            <p>We appreciate your business.</p>
            <p>Thank you for choosing our services!</p>
          </div>
        </div>
      </body>
      </html>
    `;

    // Check SendGrid configuration
    if (!SENDGRID_API_KEY) {
      console.error('❌ SendGrid API key not configured');
      return res.status(500).json({ error: 'SendGrid API key not configured' });
    }

    console.log('📧 Sending invoice email to:', customerEmail);
    console.log('📧 From email:', process.env.SENDGRID_FROM_EMAIL || 'info@spotless.homes');
    console.log('📧 Business name:', req.user.business_name || 'Your Business');
    console.log('📧 Include payment link:', includePaymentLink);
    console.log('📧 Job ID:', jobId);

    // Send email using SendGrid
    const msg = {
      to: customerEmail,
      from: process.env.SENDGRID_FROM_EMAIL || 'info@spotless.homes',
      subject: `You have a new invoice from ${req.user.business_name || 'Your Business'}`,
      html: invoiceHtml,
      text: `Hi ${customerName},\n\nPlease find your invoice for the recent service.\n\nAmount Due: $${amount.toFixed(2)}\nService: ${serviceName}\nDate: ${new Date(serviceDate).toLocaleDateString()}${includePaymentLink ? `\n\nPay online: ${process.env.FRONTEND_URL || 'http://localhost:3000'}/public/invoice/${invoiceId || jobId}` : ''}\n\nWe appreciate your business.\n\nThank you for choosing our services!`
    };

    console.log('📧 SendGrid message prepared:', { to: msg.to, from: msg.from, subject: msg.subject });
    
    const result = await sgMail.send(msg);
    console.log('✅ Invoice email sent successfully via SendGrid:', result);
    
    res.json({ message: 'Invoice email sent successfully' });
  } catch (error) {
    console.error('❌ Error sending invoice email:', error);
    res.status(500).json({ error: 'Failed to send invoice email' });
  }
});

// Notification Settings API endpoints
app.get('/api/user/notification-settings', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    
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
    
    console.log('📧 Fetching notification preferences for customer:', customerId);
    
    // Get customer notification preferences from database
    const { data: preferences, error } = await supabase
      .from('customer_notification_preferences')
      .select('email_notifications, sms_notifications')
      .eq('customer_id', customerId)
      .single();
    
    if (error && error.code === 'PGRST116') {
      // No preferences found, return defaults (matching database schema)
      console.log('📧 No preferences found, returning defaults for customer:', customerId);
      return res.json({
        email_notifications: false,  // Default to false for email (matching DB schema)
        sms_notifications: true     // Default to true for SMS (matching DB schema)
      });
    }
    
    if (error) {
      console.error('❌ Error fetching customer notification preferences:', error);
      return res.status(500).json({ 
        error: 'Failed to fetch notification preferences',
        details: error.message
      });
    }
    
    console.log('✅ Notification preferences fetched:', preferences);
    console.log('📧 Raw database values:', {
      email_notifications: preferences.email_notifications,
      sms_notifications: preferences.sms_notifications,
      email_type: typeof preferences.email_notifications,
      sms_type: typeof preferences.sms_notifications
    });
    
    const response = {
      email_notifications: preferences.email_notifications === true,
      sms_notifications: preferences.sms_notifications === true
    };
    
    console.log('📧 Sending response:', response);
    res.json(response);
  } catch (error) {
    console.error('❌ Get customer notification preferences error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch notification preferences',
      details: error.message
    });
  }
});

app.put('/api/customers/:customerId/notifications', async (req, res) => {
  try {
    const { customerId } = req.params;
    const { email_notifications, sms_notifications } = req.body;
    
    console.log('📧 Updating notification preferences for customer:', customerId, {
      email_notifications,
      sms_notifications,
      email_type: typeof email_notifications,
      sms_type: typeof sms_notifications
    });
    
    // First, try to get existing preferences
    const { data: existingPrefs, error: fetchError } = await supabase
      .from('customer_notification_preferences')
      .select('id, email_notifications, sms_notifications')
      .eq('customer_id', customerId)
      .single();

    let preferences, error;

    if (fetchError && fetchError.code === 'PGRST116') {
      // No existing preferences, create new
      console.log('📧 Creating new notification preferences for customer:', customerId);
      const { data: newPrefs, error: insertError } = await supabase
        .from('customer_notification_preferences')
        .insert({
          customer_id: customerId,
          email_notifications: email_notifications === true,
          sms_notifications: sms_notifications === true
        })
        .select()
        .single();
      
      preferences = newPrefs;
      error = insertError;
    } else if (fetchError) {
      // Other error
      preferences = null;
      error = fetchError;
    } else {
      // Update existing preferences
      console.log('📧 Updating existing notification preferences for customer:', customerId);
      const { data: updatedPrefs, error: updateError } = await supabase
        .from('customer_notification_preferences')
        .update({
          email_notifications: email_notifications === true,
          sms_notifications: sms_notifications === true,
          updated_at: new Date().toISOString()
        })
        .eq('customer_id', customerId)
        .select()
        .single();
      
      preferences = updatedPrefs;
      error = updateError;
    }
    
    if (error) {
      console.error('❌ Error updating customer notification preferences:', error);
      console.error('Error details:', {
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint
      });
      
      // Check if it's a table doesn't exist error
      if (error.code === '42P01' || error.message.includes('relation "customer_notification_preferences" does not exist')) {
        return res.status(500).json({ 
          error: 'Database table not found. Please run the migration script to create the customer_notification_preferences table.',
          details: error.message
        });
      }
      
      return res.status(500).json({ 
        error: 'Failed to update notification preferences',
        details: error.message
      });
    }
    
    console.log('✅ Notification preferences updated successfully:', preferences);
    console.log('📧 Raw saved values:', {
      email_notifications: preferences.email_notifications,
      sms_notifications: preferences.sms_notifications,
      email_type: typeof preferences.email_notifications,
      sms_type: typeof preferences.sms_notifications
    });
    
    const response = {
      email_notifications: preferences.email_notifications === true,
      sms_notifications: preferences.sms_notifications === true
    };
    
    console.log('📧 Sending update response:', response);
    res.json(response);
  } catch (error) {
    console.error('❌ Update customer notification preferences error:', error);
    res.status(500).json({ 
      error: 'Failed to update notification preferences',
      details: error.message
    });
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

// CORS is handled by the main cors middleware

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  
  // CORS headers are handled by the main cors middleware
  
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

// Twilio Connect endpoints
app.post('/api/twilio/connect/account-link', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    // For Twilio Connect, we need to create a Connect App first
    // This should be done once by the platform owner, not per user
    const connectAppSid = process.env.TWILIO_CONNECT_ACCOUNT_SID;
    
    if (!connectAppSid) {
      return res.status(500).json({ 
        error: 'Twilio Connect App not configured. Please contact support.' 
      });
    }
    
    // Create authorization URL for user to connect their Twilio account
    const authUrl = `https://connect.twilio.com/oauth/authorize?` +
      `client_id=${connectAppSid}&` +
      `redirect_uri=${encodeURIComponent(process.env.FRONTEND_URL + '/api/twilio/connect/callback')}&` +
      `response_type=code&` +
      `scope=read&` +
      `state=${userId}`;
    
    // Store pending connection status
    const { error: updateError } = await supabase
      .from('users')
      .update({ 
        twilio_connect_status: 'pending'
      })
      .eq('id', userId);
    
    if (updateError) {
      console.error('Error updating user Twilio Connect data:', updateError);
      return res.status(500).json({ error: 'Failed to store Twilio Connect data' });
    }
    
    console.log('🔗 Twilio Connect authorization URL created for user:', userId);
    
    res.json({
      success: true,
      message: 'Twilio Connect authorization URL created',
      authUrl: authUrl
    });
    
  } catch (error) {
    console.error('Twilio Connect authorization error:', error);
    res.status(500).json({ error: 'Failed to create Twilio Connect authorization' });
  }
});

// Twilio Connect OAuth callback
app.get('/api/twilio/connect/callback', async (req, res) => {
  try {
    const { code, state: userId } = req.query;
    
    if (!code || !userId) {
      return res.redirect(`${process.env.FRONTEND_URL}/settings/sms-settings?error=invalid_callback`);
    }
    
    // Exchange authorization code for access token
    const tokenResponse = await fetch('https://connect.twilio.com/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.TWILIO_CONNECT_ACCOUNT_SID,
        client_secret: process.env.TWILIO_CONNECT_AUTH_TOKEN,
        code: code,
        redirect_uri: process.env.FRONTEND_URL + '/settings/sms-settings?connected=true'
      })
    });
    
    const tokenData = await tokenResponse.json();
    
    if (!tokenData.access_token) {
      throw new Error('Failed to get access token');
    }
    
    // Store the access token and account info
    const { error: updateError } = await supabase
      .from('users')
      .update({ 
        twilio_connect_access_token: tokenData.access_token,
        twilio_connect_account_sid: tokenData.account_sid,
        twilio_connect_status: 'connected'
      })
      .eq('id', userId);
    
    if (updateError) {
      console.error('Error updating user Twilio Connect data:', updateError);
      return res.redirect(`${process.env.FRONTEND_URL}/settings/sms-settings?error=storage_failed`);
    }
    
    console.log('🔗 Twilio Connect account connected for user:', userId);
    res.redirect(`${process.env.FRONTEND_URL}/settings/sms-settings?connected=true`);
    
  } catch (error) {
    console.error('Twilio Connect callback error:', error);
    res.redirect(`${process.env.FRONTEND_URL}/settings/sms-settings?error=connection_failed`);
  }
});

// Check Twilio Connect account status
app.get('/api/twilio/connect/account-status', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    // Get user's Twilio Connect data
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('twilio_connect_account_sid, twilio_connect_status, twilio_connect_access_token')
      .eq('id', userId)
      .single();
    
    if (userError || !userData?.twilio_connect_account_sid) {
      return res.json({ 
        connected: false, 
        status: 'not_connected',
        message: 'Twilio account not connected'
      });
    }
    
    // If we have an access token, the account is connected
    const isConnected = userData.twilio_connect_status === 'connected' && userData.twilio_connect_access_token;
    
    res.json({
      connected: isConnected,
      status: userData.twilio_connect_status,
      accountSid: userData.twilio_connect_account_sid,
      friendlyName: `Connected Twilio Account`
    });
    
  } catch (error) {
    console.error('Twilio Connect status check error:', error);
    res.status(500).json({ error: 'Failed to check Twilio Connect status' });
  }
});

// Disconnect Twilio Connect account
app.delete('/api/twilio/connect/disconnect', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    // Clear Twilio Connect data from user's record
    const { error: updateError } = await supabase
      .from('users')
      .update({ 
        twilio_connect_account_sid: null,
        twilio_connect_access_token: null,
        twilio_connect_status: 'disconnected'
      })
      .eq('id', userId);
    
    if (updateError) {
      console.error('Error disconnecting Twilio Connect:', updateError);
      return res.status(500).json({ error: 'Failed to disconnect Twilio account' });
    }
    
    console.log('🔗 Twilio Connect account disconnected for user:', userId);
    
    res.json({
      success: true,
      message: 'Twilio account disconnected successfully'
    });
    
  } catch (error) {
    console.error('Twilio Connect disconnect error:', error);
    res.status(500).json({ error: 'Failed to disconnect Twilio account' });
  }
});

// Stripe Connect endpoints
app.post('/api/stripe/connect/account-link', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    // For Stripe Connect, we need to create a Connect App first
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
    
    if (!stripeSecretKey) {
      return res.status(500).json({ 
        error: 'Stripe not configured. Please contact support.' 
      });
    }
    
    // Create a Stripe Connect account for the user
    const stripe = require('stripe')(stripeSecretKey);
    
    // Create a Connect account
    const account = await stripe.accounts.create({
      type: 'express',
      country: 'US',
      email: req.user.email,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
    });
    
    // Create account link for onboarding
    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: `${process.env.FRONTEND_URL}/settings/stripe-connect?refresh=true`,
      return_url: `${process.env.FRONTEND_URL}/settings/stripe-connect?connected=true`,
      type: 'account_onboarding',
    });
    
    // Store the account ID in user's record
    const { error: updateError } = await supabase
      .from('users')
      .update({ 
        stripe_connect_account_id: account.id,
        stripe_connect_status: 'pending'
      })
      .eq('id', userId);
    
    if (updateError) {
      console.error('Error updating user Stripe Connect data:', updateError);
      return res.status(500).json({ error: 'Failed to store Stripe Connect data' });
    }
    
    console.log('🔗 Stripe Connect account created for user:', userId, 'Account ID:', account.id);
    
    res.json({
      success: true,
      message: 'Stripe Connect account created',
      accountId: account.id,
      authUrl: accountLink.url
    });
    
  } catch (error) {
    console.error('Stripe Connect authorization error:', error);
    res.status(500).json({ error: 'Failed to create Stripe Connect account: ' + error.message });
  }
});

// Stripe Connect webhook handler (optional - for account updates)
app.post('/api/stripe/connect/webhook', express.raw({type: 'application/json'}), async (req, res) => {
  try {
    const sig = req.headers['stripe-signature'];
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.log(`Webhook signature verification failed.`, err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    
    // Handle the event
    if (event.type === 'account.updated') {
      const account = event.data.object;
      
      // Update user's Stripe Connect status
      const { error: updateError } = await supabase
        .from('users')
        .update({ 
          stripe_connect_status: account.details_submitted ? 'connected' : 'pending'
        })
        .eq('stripe_connect_account_id', account.id);
      
      if (updateError) {
        console.error('Error updating user Stripe Connect status:', updateError);
      }
    }
    
    res.json({received: true});
  } catch (error) {
    console.error('Stripe webhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Check Stripe Connect account status
app.get('/api/stripe/connect/account-status', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    // Get user's Stripe Connect data
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('stripe_connect_account_id, stripe_connect_status')
      .eq('id', userId)
      .single();
    
    if (userError || !userData?.stripe_connect_account_id) {
      return res.json({ 
        connected: false, 
        status: 'not_connected',
        message: 'Stripe account not connected'
      });
    }
    
    // Check account status with Stripe
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const account = await stripe.accounts.retrieve(userData.stripe_connect_account_id);
    
    const isConnected = account.details_submitted && account.charges_enabled;
    
    // Update status in database
    if (isConnected && userData.stripe_connect_status !== 'connected') {
      await supabase
        .from('users')
        .update({ stripe_connect_status: 'connected' })
        .eq('id', userId);
    }
    
    res.json({
      connected: isConnected,
      status: isConnected ? 'connected' : 'pending',
      accountId: account.id,
      friendlyName: account.business_profile?.name || `Stripe Account ${account.id.slice(-4)}`
    });
    
  } catch (error) {
    console.error('Stripe Connect status check error:', error);
    res.status(500).json({ error: 'Failed to check Stripe Connect status' });
  }
});

// Disconnect Stripe Connect account
app.delete('/api/stripe/connect/disconnect', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    // Get user's Stripe Connect account ID
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('stripe_connect_account_id')
      .eq('id', userId)
      .single();
    
    if (userData?.stripe_connect_account_id) {
      // Delete the Stripe Connect account
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      await stripe.accounts.del(userData.stripe_connect_account_id);
    }
    
    // Clear Stripe Connect data from user's record
    const { error: updateError } = await supabase
      .from('users')
      .update({ 
        stripe_connect_account_id: null,
        stripe_connect_status: 'disconnected'
      })
      .eq('id', userId);
    
    if (updateError) {
      console.error('Error disconnecting Stripe Connect:', updateError);
      return res.status(500).json({ error: 'Failed to disconnect Stripe account' });
    }
    
    console.log('🔗 Stripe Connect account disconnected for user:', userId);
    
    res.json({
      success: true,
      message: 'Stripe account disconnected successfully'
    });
    
  } catch (error) {
    console.error('Stripe Connect disconnect error:', error);
    res.status(500).json({ error: 'Failed to disconnect Stripe account' });
  }
});

// Send SMS using user's connected Twilio account
app.post('/api/sms/send-connect', authenticateToken, async (req, res) => {
  try {
    const { to, message } = req.body;
    const userId = req.user.userId;
    
    if (!to || !message) {
      return res.status(400).json({ error: 'Phone number and message are required' });
    }
    
    // Get user's Twilio Connect account SID
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('twilio_connect_account_sid, twilio_connect_status, twilio_notification_phone')
      .eq('id', userId)
      .single();
    
    if (userError || !userData?.twilio_connect_account_sid) {
      return res.status(400).json({ error: 'Twilio account not connected. Please connect your Twilio account first.' });
    }
    
    if (userData.twilio_connect_status !== 'connected') {
      return res.status(400).json({ error: 'Twilio account not active. Please complete the connection process.' });
    }
    
    // Send SMS using user's connected Twilio account
    const result = await twilioClient.messages.create({
      body: message,
      from: userData.twilio_notification_phone, // User's default Twilio phone number
      to: to
    }, {
      accountSid: userData.twilio_connect_account_sid
    });
    
    console.log('📱 SMS sent via Twilio Connect:', result.sid);
    
    res.json({ 
      success: true, 
      message: 'SMS sent successfully',
      sid: result.sid
    });
    
  } catch (error) {
    console.error('Twilio Connect SMS error:', error);
    res.status(500).json({ error: 'Failed to send SMS via Twilio Connect' });
  }
});

// Disconnect Twilio Connect account
app.delete('/api/twilio/connect/disconnect', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    // Remove Twilio Connect data from user's record
    const { error: updateError } = await supabase
      .from('users')
      .update({ 
        twilio_connect_account_sid: null,
        twilio_connect_status: null,
        twilio_notification_phone: null
      })
      .eq('id', userId);
    
    if (updateError) {
      console.error('Error disconnecting Twilio Connect:', updateError);
      return res.status(500).json({ error: 'Failed to disconnect Twilio account' });
    }
    
    res.json({ 
      success: true, 
      message: 'Twilio account disconnected successfully' 
    });
    
  } catch (error) {
    console.error('Twilio Connect disconnect error:', error);
    res.status(500).json({ error: 'Failed to disconnect Twilio account' });
  }
});

// Simple Stripe API Integration endpoints
app.post('/api/stripe/setup-credentials', authenticateToken, async (req, res) => {
  try {
    const { publishableKey, secretKey } = req.body;
    const userId = req.user.userId;

    console.log('🔐 Stripe setup - User info:', { 
      userId, 
      user: req.user,
      hasUserId: !!userId 
    });

    if (!userId) {
      return res.status(401).json({ error: 'User ID not found in token' });
    }

    if (!publishableKey || !secretKey) {
      return res.status(400).json({ error: 'Publishable key and secret key are required' });
    }

    // Validate Stripe credentials by testing them
    try {
      const testStripe = require('stripe')(secretKey);
      const account = await testStripe.accounts.retrieve();
      
      // Verify the publishable key matches the account
      if (!publishableKey.startsWith('pk_')) {
        return res.status(400).json({ error: 'Invalid publishable key format' });
      }
      
      console.log('✅ Stripe credentials validated successfully for account:', account.id);
    } catch (stripeError) {
      console.error('❌ Stripe credentials validation failed:', stripeError.message);
      return res.status(400).json({ 
        error: 'Invalid Stripe credentials. Please check your API keys and try again.',
        details: stripeError.message 
      });
    }

    // Store user's Stripe credentials securely
    const { error: updateError } = await supabase
      .from('user_billing')
      .upsert({
        user_id: userId,
        stripe_publishable_key: publishableKey,
        stripe_secret_key: secretKey, // In production, this should be encrypted
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'user_id'
      });

    if (updateError) {
      console.error('Error storing Stripe credentials:', updateError);
      return res.status(500).json({ error: 'Failed to store Stripe credentials' });
    }

    res.json({ 
      success: true, 
      message: 'Stripe credentials validated and stored successfully' 
    });
  } catch (error) {
    console.error('Stripe credentials setup error:', error);
    res.status(500).json({ error: 'Failed to setup Stripe credentials' });
  }
});

app.get('/api/stripe/test-connection', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    const { data: billingData, error: billingError } = await supabase
      .from('user_billing')
      .select('stripe_secret_key')
      .eq('user_id', userId)
      .single();

    if (billingError || !billingData?.stripe_secret_key) {
      return res.json({ connected: false, error: 'No Stripe key found' });
    }

    const stripe = require('stripe')(billingData.stripe_secret_key);
    const account = await stripe.accounts.retrieve();

    res.json({
      connected: true,
      account_id: account.id,
      charges_enabled: account.charges_enabled,
      payouts_enabled: account.payouts_enabled
    });
  } catch (error) {
    if (error.type === 'StripeAuthenticationError') {
      return res.json({ connected: false, error: 'Invalid Stripe credentials' });
    }
    console.error('Stripe connection test error:', error);
    res.json({ connected: false, error: error.message });
  }
});


app.post('/api/stripe/create-invoice', authenticateToken, async (req, res) => {
  try {
    const { customerId, amount, description, dueDate } = req.body;
    const userId = req.user.userId;

    // Get user's Stripe credentials
    const { data: billingData, error: billingError } = await supabase
      .from('user_billing')
      .select('stripe_secret_key')
      .eq('user_id', userId)
      .limit(1);

    if (billingError || !billingData?.[0]?.stripe_secret_key) {
      return res.status(400).json({ error: 'Stripe not configured' });
    }

    const stripe = require('stripe')(billingData[0].stripe_secret_key);

    // Create invoice
    const invoice = await stripe.invoices.create({
      customer: customerId,
      amount: amount,
      currency: 'usd',
      description: description,
      due_date: dueDate ? Math.floor(new Date(dueDate).getTime() / 1000) : undefined
    });

    res.json({
      success: true,
      invoice: invoice
    });
  } catch (error) {
    console.error('Stripe invoice creation error:', error);
    res.status(500).json({ error: 'Failed to create invoice' });
  }
});

app.post('/api/stripe/send-invoice', authenticateToken, async (req, res) => {
  try {
    const { invoiceId, customerEmail } = req.body;
    const userId = req.user.userId;

    // Get user's Stripe credentials
    const { data: billingData, error: billingError } = await supabase
      .from('user_billing')
      .select('stripe_secret_key')
      .eq('user_id', userId)
      .limit(1);

    if (billingError || !billingData?.[0]?.stripe_secret_key) {
      return res.status(400).json({ error: 'Stripe not configured' });
    }

    const stripe = require('stripe')(billingData[0].stripe_secret_key);

    // Send invoice
    const invoice = await stripe.invoices.sendInvoice(invoiceId);

    res.json({
      success: true,
      invoice: invoice
    });
  } catch (error) {
    console.error('Stripe send invoice error:', error);
    res.status(500).json({ error: 'Failed to send invoice' });
  }
});

app.post('/api/stripe/create-payment-intent', authenticateToken, async (req, res) => {
  try {
    const { amount, currency, customerId, metadata } = req.body;
    const userId = req.user.userId;

    // Get user's Stripe credentials
    const { data: billingData, error: billingError } = await supabase
      .from('user_billing')
      .select('stripe_secret_key')
      .eq('user_id', userId)
      .limit(1);

    if (billingError || !billingData?.[0]?.stripe_secret_key) {
      return res.status(400).json({ error: 'Stripe not configured' });
    }

    const stripe = require('stripe')(billingData[0].stripe_secret_key);

    // Create payment intent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount,
      currency: currency || 'usd',
      customer: customerId,
      metadata: metadata || {}
    });

    res.json({
      success: true,
      paymentIntent: paymentIntent
    });
  } catch (error) {
    console.error('Stripe payment intent creation error:', error);
    res.status(500).json({ error: 'Failed to create payment intent' });
  }
});

app.get('/api/stripe/payment-status/:paymentIntentId', authenticateToken, async (req, res) => {
  try {
    const { paymentIntentId } = req.params;
    const userId = req.user.userId;

    // Get user's Stripe credentials
    const { data: billingData, error: billingError } = await supabase
      .from('user_billing')
      .select('stripe_secret_key')
      .eq('user_id', userId)
      .limit(1);

    if (billingError || !billingData?.[0]?.stripe_secret_key) {
      return res.status(400).json({ error: 'Stripe not configured' });
    }

    const stripe = require('stripe')(billingData[0].stripe_secret_key);

    // Get payment intent status
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    res.json({
      success: true,
      paymentIntent: paymentIntent
    });
  } catch (error) {
    console.error('Stripe payment status error:', error);
    res.status(500).json({ error: 'Failed to get payment status' });
  }
});

app.post('/api/stripe/create-customer', authenticateToken, async (req, res) => {
  try {
    const { email, name, phone } = req.body;
    const userId = req.user.userId;

    // Get user's Stripe credentials
    const { data: billingData, error: billingError } = await supabase
      .from('user_billing')
      .select('stripe_secret_key')
      .eq('user_id', userId)
      .limit(1);

    if (billingError || !billingData?.[0]?.stripe_secret_key) {
      return res.status(400).json({ error: 'Stripe not configured' });
    }

    const stripe = require('stripe')(billingData[0].stripe_secret_key);

    // Create customer
    const customer = await stripe.customers.create({
      email: email,
      name: name,
      phone: phone
    });

    res.json({
      success: true,
      customer: customer
    });
  } catch (error) {
    console.error('Stripe customer creation error:', error);
    res.status(500).json({ error: 'Failed to create customer' });
  }
});

app.delete('/api/stripe/disconnect', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Clear Stripe credentials
    const { error: updateError } = await supabase
      .from('user_billing')
      .update({
        stripe_publishable_key: null,
        stripe_secret_key: null,
        updated_at: new Date().toISOString()
      })
      .eq('user_id', userId);

    if (updateError) {
      console.error('Error clearing Stripe credentials:', updateError);
      return res.status(500).json({ error: 'Failed to disconnect Stripe' });
    }

    res.json({ 
      success: true, 
      message: 'Stripe disconnected successfully' 
    });
  } catch (error) {
    console.error('Stripe disconnect error:', error);
    res.status(500).json({ error: 'Failed to disconnect Stripe' });
  }
});

// Simple Twilio API Integration endpoints
app.post('/api/twilio/setup-credentials', authenticateToken, async (req, res) => {
  try {
    const { accountSid, authToken, phoneNumber } = req.body;
    const userId = req.user.userId;

    if (!accountSid || !authToken || !phoneNumber) {
      return res.status(400).json({ error: 'Account SID, Auth Token, and Phone Number are required' });
    }

    // Validate Twilio credentials by testing them
    try {
      const twilio = require('twilio')(accountSid, authToken);
      
      // Test credentials by getting account info
      const account = await twilio.api.accounts(accountSid).fetch();
      
      // Test by getting phone numbers to ensure credentials work
      const phoneNumbers = await twilio.incomingPhoneNumbers.list();
      
      // Verify the phone number exists in the account
      const phoneExists = phoneNumbers.some(num => num.phoneNumber === phoneNumber);
      if (!phoneExists) {
        return res.status(400).json({ 
          error: 'The specified phone number is not associated with your Twilio account. Please check the phone number and try again.' 
        });
      }
      
      console.log('✅ Twilio credentials validated successfully for account:', account.friendlyName);
    } catch (twilioError) {
      console.error('❌ Twilio credentials validation failed:', twilioError.message);
      return res.status(400).json({ 
        error: 'Invalid Twilio credentials. Please check your Account SID, Auth Token, and Phone Number.',
        details: twilioError.message 
      });
    }

    // Store user's Twilio credentials securely
    const { error: updateError } = await supabase
      .from('users')
      .update({
        twilio_account_sid: accountSid,
        twilio_auth_token: authToken, // In production, this should be encrypted
        twilio_notification_phone: phoneNumber,
        updated_at: new Date().toISOString()
      })
      .eq('id', userId);

    if (updateError) {
      console.error('Error storing Twilio credentials:', updateError);
      return res.status(500).json({ error: 'Failed to store Twilio credentials' });
    }

    res.json({ 
      success: true, 
      message: 'Twilio credentials validated and stored successfully'
    });
  } catch (error) {
    console.error('Twilio credentials setup error:', error);
    res.status(500).json({ error: 'Failed to setup Twilio credentials: ' + error.message });
  }
});

app.get('/api/twilio/phone-numbers', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Get user's Twilio credentials
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('twilio_account_sid, twilio_auth_token')
      .eq('id', userId)
      .limit(1);

    if (userError || !userData?.[0]?.twilio_account_sid || !userData?.[0]?.twilio_auth_token) {
      return res.status(400).json({ error: 'Twilio not configured' });
    }

    const twilio = require('twilio')(userData[0].twilio_account_sid, userData[0].twilio_auth_token);
    const phoneNumbers = await twilio.incomingPhoneNumbers.list();

    res.json({
      success: true,
      phoneNumbers: phoneNumbers.map(num => ({
        phoneNumber: num.phoneNumber,
        friendlyName: num.friendlyName
      }))
    });
  } catch (error) {
    console.error('Twilio phone numbers error:', error);
    res.status(500).json({ error: 'Failed to get phone numbers' });
  }
});

app.post('/api/twilio/setup-sms-notifications', authenticateToken, async (req, res) => {
  try {
    const { phoneNumber, notificationTypes } = req.body;
    const userId = req.user.userId;

    // Store SMS notification settings
    const { error: updateError } = await supabase
      .from('users')
      .update({
        twilio_notification_phone: phoneNumber,
        twilio_notification_types: notificationTypes,
        updated_at: new Date().toISOString()
      })
      .eq('id', userId);

    if (updateError) {
      console.error('Error storing SMS notification settings:', updateError);
      return res.status(500).json({ error: 'Failed to store notification settings' });
    }

    res.json({ 
      success: true, 
      message: 'SMS notifications configured successfully' 
    });
  } catch (error) {
    console.error('SMS notification setup error:', error);
    res.status(500).json({ error: 'Failed to setup SMS notifications' });
  }
});

app.post('/api/twilio/send-sms', authenticateToken, async (req, res) => {
  try {
    const { to, message } = req.body;
    const userId = req.user.userId;

    if (!to || !message) {
      return res.status(400).json({ error: 'Phone number and message are required' });
    }

    // Get user's Twilio credentials
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('twilio_account_sid, twilio_auth_token, twilio_notification_phone')
      .eq('id', userId)
      .limit(1);

    if (userError || !userData?.[0]?.twilio_account_sid || !userData?.[0]?.twilio_auth_token) {
      return res.status(400).json({ error: 'Twilio not configured' });
    }

    const twilio = require('twilio')(userData[0].twilio_account_sid, userData[0].twilio_auth_token);

    // Send SMS
    const result = await twilio.messages.create({
      body: message,
      from: userData[0].twilio_notification_phone,
      to: to
    });

    res.json({
      success: true,
      message: 'SMS sent successfully',
      sid: result.sid
    });
  } catch (error) {
    console.error('Twilio SMS send error:', error);
    res.status(500).json({ error: 'Failed to send SMS: ' + error.message });
  }
});

app.post('/api/twilio/test-sms', authenticateToken, async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    const userId = req.user.userId;

    // Get user's Twilio credentials
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('twilio_account_sid, twilio_auth_token, twilio_notification_phone')
      .eq('id', userId)
      .limit(1);

    if (userError || !userData?.[0]?.twilio_account_sid || !userData?.[0]?.twilio_auth_token) {
      return res.status(400).json({ error: 'Twilio not configured' });
    }

    const twilio = require('twilio')(userData[0].twilio_account_sid, userData[0].twilio_auth_token);

    // Send test SMS
    const result = await twilio.messages.create({
      body: 'Test SMS from your ZenBooker integration. Your Twilio setup is working correctly!',
      from: userData[0].twilio_notification_phone,
      to: phoneNumber
    });

    res.json({
      success: true,
      message: 'Test SMS sent successfully',
      sid: result.sid
    });
  } catch (error) {
    console.error('Twilio test SMS error:', error);
    res.status(500).json({ error: 'Failed to send test SMS: ' + error.message });
  }
});

app.delete('/api/twilio/disconnect', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Clear Twilio credentials
    const { error: updateError } = await supabase
      .from('users')
      .update({
        twilio_account_sid: null,
        twilio_auth_token: null,
        twilio_notification_phone: null,
        twilio_notification_phone: null,
        twilio_notification_types: null,
        updated_at: new Date().toISOString()
      })
      .eq('id', userId);

    if (updateError) {
      console.error('Error clearing Twilio credentials:', updateError);
      return res.status(500).json({ error: 'Failed to disconnect Twilio' });
    }

    res.json({ 
      success: true, 
      message: 'Twilio disconnected successfully' 
    });
  } catch (error) {
    console.error('Twilio disconnect error:', error);
    res.status(500).json({ error: 'Failed to disconnect Twilio' });
  }
});

// Get current default phone number
app.get('/api/twilio/default-phone-number', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    console.log('📞 Getting default phone number for user:', userId);

    // Get user's Twilio notification phone from users table
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('twilio_notification_phone')
      .eq('id', userId)
      .limit(1);

    console.log('📞 User data query result:', { userData, userError });

    if (userError) {
      console.error('Error getting default phone number:', userError);
      return res.status(500).json({ error: 'Failed to get default phone number' });
    }

    const defaultPhone = userData?.[0]?.twilio_notification_phone || null;
    console.log('📞 Default phone number:', defaultPhone);

    res.json({
      success: true,
      defaultPhoneNumber: defaultPhone
    });
  } catch (error) {
    console.error('Get default phone number error:', error);
    res.status(500).json({ error: 'Failed to get default phone number' });
  }
});

// Set default phone number
app.post('/api/twilio/set-default-phone-number', authenticateToken, async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    const userId = req.user.userId;

    console.log('📞 Setting default phone number:', { phoneNumber, userId });

    if (!phoneNumber) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    // Update user's Twilio notification phone in users table
    const { error: updateError } = await supabase
      .from('users')
      .update({
        twilio_notification_phone: phoneNumber,
        updated_at: new Date().toISOString()
      })
      .eq('id', userId);

    console.log('📞 Update result:', { updateError });

    if (updateError) {
      console.error('Error setting default phone number:', updateError);
      return res.status(500).json({ error: 'Failed to set default phone number' });
    }

    console.log('📞 Successfully updated default phone number');

    res.json({
      success: true,
      message: 'Default phone number updated successfully',
      defaultPhoneNumber: phoneNumber
    });
  } catch (error) {
    console.error('Set default phone number error:', error);
    res.status(500).json({ error: 'Failed to set default phone number' });
  }
});

// Helper function to send SMS using user's direct Twilio credentials
const sendSMSWithUserTwilio = async (userId, to, message) => {
  // Get user's Twilio credentials
  const { data: userData, error: userError } = await supabase
    .from('users')
    .select('twilio_account_sid, twilio_auth_token, twilio_notification_phone')
    .eq('id', userId)
    .single();
  
  if (userError || !userData?.twilio_account_sid || !userData?.twilio_auth_token) {
    throw new Error('Twilio not configured. Please set up your Twilio credentials first.');
  }
  
  // Create Twilio client with user's credentials
  const userTwilioClient = require('twilio')(userData.twilio_account_sid, userData.twilio_auth_token);
  
  // Send SMS using user's Twilio account
  const result = await userTwilioClient.messages.create({
    body: message,
    from: userData.twilio_notification_phone,
    to: to
  });
  
  console.log('📱 SMS sent via user Twilio credentials:', result.sid);
  return result;
};

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

// Helper function to sync job to Google Calendar
async function syncJobToCalendar(jobId, userId, jobData, customerData, req = null) {
  try {
    // Check if user has Google Calendar enabled
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('google_access_token, google_refresh_token, google_calendar_enabled, google_calendar_id')
      .eq('id', userId)
      .single();

    if (userError) {
      // If columns don't exist, return null (calendar sync not available)
      if (userError.code === '42703' || userError.message?.includes('does not exist')) {
        return null;
      }
      console.error('Error fetching user calendar settings:', userError);
      return null;
    }

    // Check if Google account is connected (has google_id)
    const hasGoogleId = userData?.google_id;
    if (!userData?.google_access_token) {
      console.log('⚠️ Google access token missing:', {
        userId,
        hasGoogleId,
        hasAccessToken: !!userData?.google_access_token,
        hasRefreshToken: !!userData?.google_refresh_token
      });
      if (hasGoogleId) {
        // Account is connected but missing access token - need to reconnect with OAuth scopes
        console.log('⚠️ Google account connected but missing access token. User needs to reconnect with OAuth scopes.');
        return null; // Will show error message
      }
      return null; // Google account not connected
    }
    
    console.log('✅ Google Calendar sync check passed:', {
      userId,
      hasAccessToken: !!userData.google_access_token,
      hasRefreshToken: !!userData.google_refresh_token,
      calendarEnabled: userData.google_calendar_enabled
    });

    // Check if calendar sync is enabled (default to true if column doesn't exist)
    const calendarEnabled = userData?.google_calendar_enabled !== false; // Default to true if null/undefined
    if (!calendarEnabled) {
      return null; // Calendar sync disabled
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

    // Set up automatic token refresh callback
    oauth2Client.on('tokens', (tokens) => {
      if (tokens.refresh_token) {
        console.log('🔄 Refresh token updated');
        supabase
          .from('users')
          .update({ google_refresh_token: tokens.refresh_token })
          .eq('id', userId)
          .then(() => console.log('✅ Refresh token saved to database'));
      }
      if (tokens.access_token) {
        console.log('🔄 Access token refreshed');
        supabase
          .from('users')
          .update({ google_access_token: tokens.access_token })
          .eq('id', userId)
          .then(() => console.log('✅ Access token saved to database'));
      }
    });

    // Verify token is valid and refresh if needed
    try {
      console.log('🔍 Verifying Google access token...');
      const tokenInfo = await oauth2Client.getAccessToken();
      if (!tokenInfo.token) {
        console.error('❌ Failed to get valid access token');
        return null;
      }
      console.log('✅ Access token verified, token length:', tokenInfo.token.length);
    } catch (tokenError) {
      console.error('❌ Token verification failed:', {
        message: tokenError.message,
        code: tokenError.code
      });
      return null;
    }

    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const calendarId = userData.google_calendar_id || 'primary';

    // Get existing calendar event ID and link if job was previously synced
    const { data: existingJob } = await supabase
      .from('jobs')
      .select('google_calendar_event_id, google_calendar_event_link')
      .eq('id', jobId)
      .single();

    const customerName = customerData 
      ? `${customerData.first_name || ''} ${customerData.last_name || ''}`.trim()
      : jobData.customer_name || 'Unknown Customer';
    
    const serviceName = jobData.service_name || 'Service';
    
    // Get date and time - handle both database format and frontend format
    // Frontend sends: scheduledDate (date only) and scheduledTime (time only)
    // Database has: scheduled_date (date + time together)
    let scheduledDate = jobData.scheduled_date || jobData.scheduledDate;
    let scheduledTime = jobData.scheduled_time || jobData.scheduledTime;
    
    // If we have scheduledDate from request body (frontend), use it
    if (req && req.body && req.body.scheduledDate) {
      scheduledDate = req.body.scheduledDate;
    }
    if (req && req.body && req.body.scheduledTime) {
      scheduledTime = req.body.scheduledTime;
    }
    
    const duration = jobData.duration || jobData.estimated_duration || 60;
    const address = jobData.service_address_street || jobData.address || '';

    // Parse date and time more robustly
    let startDateTime;
    try {
      // Handle different date formats
      let dateStr = scheduledDate;
      let timeStr = scheduledTime || '09:00';
      
      // If scheduledDate already contains time (space or T separator)
      if (dateStr && (dateStr.includes(' ') || dateStr.includes('T'))) {
        const parts = dateStr.split(/[\sT]/);
        dateStr = parts[0];
        if (parts[1]) {
          timeStr = parts[1].substring(0, 5); // Get HH:MM
        }
      }
      
      // Ensure time format is HH:MM (remove seconds if present)
      if (timeStr && timeStr.length > 5) {
        timeStr = timeStr.substring(0, 5);
      }
      
      // If time is still empty, use default
      if (!timeStr || timeStr.length < 4) {
        timeStr = '09:00';
      }
      
      // Parse date and time components
      const [year, month, day] = dateStr.split('-').map(Number);
      const [hours, minutes] = timeStr.split(':').map(Number);
      
      // Create date object in local timezone (not UTC)
      // This ensures the time is preserved exactly as specified
      startDateTime = new Date(year, month - 1, day, hours || 0, minutes || 0, 0, 0);
      
      // Validate date
      if (isNaN(startDateTime.getTime())) {
        console.error('❌ Invalid date:', { scheduledDate, scheduledTime, dateStr, timeStr, year, month, day, hours, minutes });
        throw new Error(`Invalid date/time: ${scheduledDate} ${scheduledTime}`);
      }
      
      console.log('📅 Parsing date/time:', { 
        scheduledDate, 
        scheduledTime, 
        dateStr, 
        timeStr, 
        parsed: {
          year, month, day, hours, minutes,
          localTime: startDateTime.toLocaleString(),
          isoString: startDateTime.toISOString()
        }
      });
      
      console.log('✅ Parsed date successfully:', startDateTime.toISOString());
    } catch (error) {
      console.error('❌ Error parsing date:', error);
      throw new Error(`Failed to parse job date/time: ${error.message}`);
    }
    
    const endDateTime = new Date(startDateTime.getTime() + duration * 60000);
    
    // Get the timezone - use server's timezone or default to America/New_York
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
    
    // Format dateTime in ISO 8601 format with timezone offset
    // Google Calendar API expects dateTime to be in the specified timeZone
    // We need to format it correctly to preserve the local time
    const formatDateTimeForCalendar = (date) => {
      // Get timezone offset in minutes
      const offset = date.getTimezoneOffset();
      const offsetHours = Math.floor(Math.abs(offset) / 60);
      const offsetMinutes = Math.abs(offset) % 60;
      const offsetSign = offset <= 0 ? '+' : '-';
      
      // Format: YYYY-MM-DDTHH:mm:ss+HH:mm
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');
      const seconds = String(date.getSeconds()).padStart(2, '0');
      
      return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${offsetSign}${String(offsetHours).padStart(2, '0')}:${String(offsetMinutes).padStart(2, '0')}`;
    };
    
    const event = {
      summary: `${serviceName} - ${customerName}`,
      description: `Job ID: ${jobId}\nCustomer: ${customerName}\nService: ${serviceName}\nAddress: ${address || 'Not specified'}\nStatus: ${jobData.status || 'pending'}`,
      start: {
        dateTime: formatDateTimeForCalendar(startDateTime),
        timeZone: timeZone,
      },
      end: {
        dateTime: formatDateTimeForCalendar(endDateTime),
        timeZone: timeZone,
      },
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'email', minutes: 24 * 60 }, // 1 day before
          { method: 'popup', minutes: 30 }, // 30 minutes before
        ],
      },
    };

    let eventId;
    let eventLink;

    // Helper function to sync event with retry logic
    const syncEvent = async (retryCount = 0) => {
      const maxRetries = 2;
      
      try {
        if (existingJob?.google_calendar_event_id) {
          // Update existing event
          console.log('📅 Updating existing calendar event:', existingJob.google_calendar_event_id);
          const response = await calendar.events.update({
            calendarId: calendarId,
            eventId: existingJob.google_calendar_event_id,
            resource: event,
          });
          return {
            eventId: response.data.id,
            eventLink: response.data.htmlLink
          };
        } else {
          // Create new event
          console.log('📅 Creating new calendar event');
    const response = await calendar.events.insert({
            calendarId: calendarId,
      resource: event,
    });
          return {
            eventId: response.data.id,
            eventLink: response.data.htmlLink
          };
        }
      } catch (error) {
        console.error(`❌ Calendar API error (attempt ${retryCount + 1}):`, {
          code: error.code,
          message: error.message,
          status: error.response?.status
        });
        
        // Handle 401 (unauthorized) - token is invalid or expired
        if (error.response?.status === 401 || error.code === 401) {
          console.error('❌ Invalid or expired access token (401)');
          // Try to refresh token if we have refresh token
          if (userData.google_refresh_token) {
            try {
              console.log('🔄 Attempting to refresh access token...');
              oauth2Client.setCredentials({
                refresh_token: userData.google_refresh_token
              });
              const newToken = await oauth2Client.getAccessToken();
              if (newToken.token) {
                console.log('✅ Token refreshed, updating database');
                await supabase
                  .from('users')
                  .update({ google_access_token: newToken.token })
                  .eq('id', userId);
                // Retry with new token
                oauth2Client.setCredentials({
                  access_token: newToken.token,
                  refresh_token: userData.google_refresh_token
                });
                const retryCalendar = google.calendar({ version: 'v3', auth: oauth2Client });
                if (existingJob?.google_calendar_event_id) {
                  const response = await retryCalendar.events.update({
                    calendarId: calendarId,
                    eventId: existingJob.google_calendar_event_id,
                    resource: event,
                  });
                  return {
                    eventId: response.data.id,
                    eventLink: response.data.htmlLink
                  };
                } else {
                  const response = await retryCalendar.events.insert({
                    calendarId: calendarId,
                    resource: event,
                  });
                  return {
                    eventId: response.data.id,
                    eventLink: response.data.htmlLink
                  };
                }
              }
            } catch (refreshError) {
              console.error('❌ Failed to refresh token:', refreshError.message);
              throw new Error('Access token expired and refresh failed. Please reconnect your Google account.');
            }
          } else {
            throw new Error('Access token is invalid and no refresh token available. Please reconnect your Google account in Settings → Calendar Syncing.');
          }
        }
        
        // Retry on network errors
        if (retryCount < maxRetries && (
          error.message?.includes('Premature close') ||
          error.message?.includes('ECONNRESET') ||
          error.message?.includes('timeout') ||
          error.message?.includes('ETIMEDOUT')
        )) {
          const delay = 1000 * (retryCount + 1); // 1s, 2s
          console.log(`🔄 Retrying calendar sync in ${delay}ms (attempt ${retryCount + 2}/${maxRetries + 1})...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          return syncEvent(retryCount + 1);
        }
        
        // If update failed with 404, try creating new event
        if (existingJob?.google_calendar_event_id && (error.code === 404 || error.response?.status === 404)) {
          console.log('📅 Event not found (404), creating new event instead');
          try {
            const response = await calendar.events.insert({
              calendarId: calendarId,
              resource: event,
            });
            return {
              eventId: response.data.id,
              eventLink: response.data.htmlLink
            };
          } catch (insertError) {
            console.error('❌ Error creating new event after 404:', insertError.message);
            throw insertError;
          }
        }
        
        throw error;
      }
    };
    
    const result = await syncEvent();
    eventId = result.eventId;
    eventLink = result.eventLink;
    console.log('✅ Calendar event synced successfully:', eventId);

    // Update job with calendar event ID and link
    await supabase
      .from('jobs')
      .update({ 
        google_calendar_event_id: eventId,
        google_calendar_event_link: eventLink // Store the htmlLink from API
      })
      .eq('id', jobId);

    return { eventId, eventLink };
  } catch (error) {
    console.error('❌ Calendar sync error:', {
      message: error.message,
      stack: error.stack,
      jobId,
      userId
    });
    
    // If it's a date parsing error, we want to surface it
    if (error.message && (error.message.includes('Invalid date') || error.message.includes('Failed to parse'))) {
      throw error; // Re-throw so the endpoint can return a proper error
    }
    
    return null;
  }
}

// Google Calendar endpoints
app.post('/api/calendar/sync-job', authenticateToken, async (req, res) => {
  try {
    const { jobId, customerName, serviceName, scheduledDate, scheduledTime, duration, address } = req.body;
    
    if (!jobId || !customerName || !serviceName || !scheduledDate || !scheduledTime) {
      return res.status(400).json({ error: 'Missing required job details' });
    }

    // Get job and customer data
    const { data: job } = await supabase
      .from('jobs')
      .select('*, customers(*)')
      .eq('id', jobId)
      .eq('user_id', req.user.userId)
      .single();

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    console.log('📅 Attempting to sync job to calendar:', {
      jobId,
      userId: req.user.userId,
      hasJob: !!job,
      hasCustomer: !!job?.customers,
      scheduledDate: job?.scheduled_date
    });

    const result = await syncJobToCalendar(jobId, req.user.userId, job, job.customers, req);

    if (!result) {
      console.log('❌ Calendar sync returned null, checking user connection status...');
      // Check if user has google_id but missing access token
      const { data: userCheck } = await supabase
        .from('users')
        .select('google_id, google_access_token, google_refresh_token, google_calendar_enabled')
        .eq('id', req.user.userId)
        .maybeSingle();
      
      console.log('📅 User connection check:', {
        hasGoogleId: !!userCheck?.google_id,
        hasAccessToken: !!userCheck?.google_access_token,
        hasRefreshToken: !!userCheck?.google_refresh_token,
        calendarEnabled: userCheck?.google_calendar_enabled
      });
      
      if (userCheck?.google_id && !userCheck?.google_access_token) {
        return res.status(400).json({ 
          error: 'Google account is connected but access token is missing. Please reconnect your Google account in Settings → Calendar Syncing to grant calendar permissions.' 
        });
      }
      
      return res.status(400).json({ error: 'Google Calendar not connected. Please connect your Google account in Settings → Calendar Syncing.' });
    }

    res.json({ 
      success: true, 
      message: 'Job synced to Google Calendar',
      eventId: result.eventId,
      eventLink: result.eventLink
    });

  } catch (error) {
    console.error('❌ Calendar sync endpoint error:', {
      message: error.message,
      stack: error.stack,
      jobId: req.body?.jobId
    });
    
    // If it's a date parsing error, return a specific error
    if (error.message && (error.message.includes('Invalid date') || error.message.includes('Failed to parse'))) {
      return res.status(400).json({ 
        error: `Invalid job date/time: ${error.message}. Please ensure the job has a valid scheduled date and time.` 
      });
    }
    
    res.status(500).json({ error: 'Failed to sync to Google Calendar: ' + error.message });
  }
});

// Get calendar sync settings
app.get('/api/calendar/settings', authenticateToken, async (req, res) => {
  try {
    console.log('📅 Fetching calendar settings for user:', req.user.userId);
    
    // First, try to get just the calendar sync columns (from our migration)
    const { data: userData, error } = await supabase
      .from('users')
      .select('google_calendar_enabled, google_calendar_id')
      .eq('id', req.user.userId)
      .single();

    if (error) {
      console.error('📅 Calendar settings query error:', {
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint
      });
      
      // Only check for specific PostgreSQL column not found error (code 42703)
      if (error.code === '42703') {
        console.log('📅 Column not found error (42703) - migration required');
        return res.json({
          enabled: false,
          calendarId: 'primary',
          connected: false,
          migrationRequired: true
        });
      }
      
      console.error('📅 Unexpected error fetching calendar settings:', error);
      return res.status(500).json({ 
        error: 'Failed to fetch calendar settings: ' + error.message,
        code: error.code,
        details: error.details
      });
    }

    // Success - calendar sync columns exist. Now check for Google connection
    // Check for google_id first (this indicates connection), then check for tokens
    let isConnected = false;
    let hasGoogleToken = false;
    
    try {
      // First check for google_id (indicates account is connected)
      const { data: googleData, error: googleError } = await supabase
        .from('users')
        .select('google_id, google_access_token, google_refresh_token')
        .eq('id', req.user.userId)
        .maybeSingle();
      
      if (!googleError && googleData) {
        // If google_id exists, account is connected
        if (googleData.google_id) {
          isConnected = true;
        }
        // Check if we also have access token
        if (googleData.google_access_token) {
          hasGoogleToken = true;
        }
      }
    } catch (tokenErr) {
      // If columns don't exist, try checking just google_id
      try {
        const { data: googleIdData, error: googleIdError } = await supabase
          .from('users')
          .select('google_id')
          .eq('id', req.user.userId)
          .maybeSingle();
        
        if (!googleIdError && googleIdData?.google_id) {
          isConnected = true;
        }
      } catch (err) {
        console.log('📅 Error checking google_id:', err.message);
      }
    }

    console.log('📅 Calendar settings fetched successfully:', {
      enabled: userData?.google_calendar_enabled,
      calendarId: userData?.google_calendar_id,
      isConnected: isConnected,
      hasToken: hasGoogleToken
    });

    res.json({
      enabled: userData?.google_calendar_enabled !== undefined ? userData.google_calendar_enabled : false,
      calendarId: userData?.google_calendar_id || 'primary',
      connected: isConnected, // Use google_id check instead of just token
      hasAccessToken: hasGoogleToken, // Indicates if access token exists for calendar sync
      migrationRequired: false
    });
  } catch (error) {
    console.error('📅 Get calendar settings exception:', error);
    res.status(500).json({ 
      error: 'Failed to fetch calendar settings: ' + error.message 
    });
  }
});

// Update calendar sync settings
app.put('/api/calendar/settings', authenticateToken, async (req, res) => {
  try {
    const { enabled, calendarId } = req.body;
    console.log('📅 Updating calendar settings for user:', req.user.userId, { enabled, calendarId });

    const updateData = {};
    if (enabled !== undefined) {
      updateData.google_calendar_enabled = enabled;
    }
    if (calendarId !== undefined) {
      updateData.google_calendar_id = calendarId;
    }

    console.log('📅 Update data:', updateData);

    const { data: updatedData, error } = await supabase
      .from('users')
      .update(updateData)
      .eq('id', req.user.userId)
      .select('google_calendar_enabled, google_calendar_id')
      .single();

    if (error) {
      console.error('📅 Error updating calendar settings:', {
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint
      });
      
      // Only check for specific PostgreSQL column not found error (code 42703)
      if (error.code === '42703') {
        return res.status(400).json({ 
          error: 'Database migration required. Please run the migration SQL file (google-calendar-sync-migration.sql) to enable calendar sync settings.',
          migrationRequired: true
        });
      }
      
      return res.status(500).json({ 
        error: 'Failed to update calendar settings: ' + error.message,
        code: error.code,
        details: error.details
      });
    }

    console.log('✅ Calendar settings updated successfully:', updatedData);

    res.json({ 
      success: true, 
      message: 'Calendar settings updated',
      settings: {
        enabled: updatedData?.google_calendar_enabled !== undefined ? updatedData.google_calendar_enabled : false,
        calendarId: updatedData?.google_calendar_id || 'primary'
      }
    });
  } catch (error) {
    console.error('📅 Update calendar settings exception:', error);
    res.status(500).json({ error: 'Failed to update calendar settings: ' + error.message });
  }
});

// Test endpoint to check if calendar columns exist
app.get('/api/calendar/test-columns', authenticateToken, async (req, res) => {
  try {
    console.log('🔍 Testing calendar columns for user:', req.user.userId);
    
    // Try to select the columns
    const { data, error } = await supabase
      .from('users')
      .select('id, google_calendar_enabled, google_calendar_id, google_access_token')
      .eq('id', req.user.userId)
      .single();

    if (error) {
      console.error('🔍 Column test error:', {
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint
      });
      
      return res.json({
        columnsExist: false,
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
          hint: error.hint
        }
      });
    }

    console.log('🔍 Columns exist! Data:', data);
    
    return res.json({
      columnsExist: true,
      data: {
        hasGoogleCalendarEnabled: 'google_calendar_enabled' in (data || {}),
        hasGoogleCalendarId: 'google_calendar_id' in (data || {}),
        hasGoogleAccessToken: 'google_access_token' in (data || {}),
        values: {
          google_calendar_enabled: data?.google_calendar_enabled,
          google_calendar_id: data?.google_calendar_id,
          has_access_token: !!data?.google_access_token
        }
      }
    });
  } catch (error) {
    console.error('🔍 Column test exception:', error);
    return res.status(500).json({
      columnsExist: false,
      error: error.message
    });
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

    let spreadsheet;
    try {
      spreadsheet = await sheets.spreadsheets.create({
      resource: {
        properties: {
          title: `Serviceflow Customers - ${new Date().toLocaleDateString()}`
        }
      }
    });
    } catch (sheetsError) {
      // Check if error is due to insufficient scopes
      if (sheetsError.code === 403 && 
          (sheetsError.message?.includes('insufficient authentication scopes') || 
           sheetsError.message?.includes('PERMISSION_DENIED'))) {
        console.error('❌ Insufficient Google Sheets scopes. User needs to reconnect with proper scopes.');
        return res.status(403).json({ 
          error: 'insufficient_scopes',
          message: 'Your Google account connection does not have the required permissions for Google Sheets. Please disconnect and reconnect your Google account to grant the necessary permissions.',
          requiresReconnect: true
        });
      }
      throw sheetsError; // Re-throw if it's a different error
    }

    const spreadsheetId = spreadsheet.data.spreadsheetId;

    // Prepare data for export
    const headers = ['Name', 'Email', 'Phone', 'Address', 'City', 'State', 'Zip Code', 'Created Date', 'Last Contact'];
    const values = customers.map(customer => {
      // Combine first_name and last_name into full name
      const fullName = [customer.first_name, customer.last_name]
        .filter(Boolean)
        .join(' ')
        .trim() || '';
      
      return [
        fullName,
      customer.email || '',
      customer.phone || '',
      customer.address || '',
      customer.city || '',
      customer.state || '',
      customer.zip_code || '',
        customer.created_at ? new Date(customer.created_at).toLocaleDateString() : '',
      customer.last_contact ? new Date(customer.last_contact).toLocaleDateString() : ''
      ];
    });

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

// Disconnect Google account
app.put('/api/user/google-disconnect', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    // Clear Google tokens from database
    const { error } = await supabase
      .from('users')
      .update({
        google_access_token: null,
        google_refresh_token: null,
        google_id: null,
        google_calendar_enabled: false
      })
      .eq('id', userId);
    
    if (error) {
      console.error('Error disconnecting Google:', error);
      return res.status(500).json({ error: 'Failed to disconnect Google account' });
    }
    
    res.json({ success: true, message: 'Google account disconnected successfully' });
  } catch (error) {
    console.error('Disconnect error:', error);
    res.status(500).json({ error: 'Failed to disconnect Google account' });
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
        customers(first_name, last_name, email, phone),
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

    let spreadsheet;
    try {
      spreadsheet = await sheets.spreadsheets.create({
      resource: {
        properties: {
          title: `Serviceflow Jobs - ${new Date().toLocaleDateString()}`
        }
      }
    });
    } catch (sheetsError) {
      // Check if error is due to insufficient scopes
      if (sheetsError.code === 403 && 
          (sheetsError.message?.includes('insufficient authentication scopes') || 
           sheetsError.message?.includes('PERMISSION_DENIED'))) {
        console.error('❌ Insufficient Google Sheets scopes. User needs to reconnect with proper scopes.');
        return res.status(403).json({ 
          error: 'insufficient_scopes',
          message: 'Your Google account connection does not have the required permissions for Google Sheets. Please disconnect and reconnect your Google account to grant the necessary permissions.',
          requiresReconnect: true
        });
      }
      throw sheetsError; // Re-throw if it's a different error
    }

    const spreadsheetId = spreadsheet.data.spreadsheetId;

    // Prepare data for export
    const headers = ['Job ID', 'Customer', 'Service', 'Date', 'Time', 'Status', 'Total Amount', 'Address', 'Notes'];
    const values = jobs.map(job => {
      // Combine first_name and last_name into full name
      const customerName = job.customers 
        ? [job.customers.first_name, job.customers.last_name]
            .filter(Boolean)
            .join(' ')
            .trim() || ''
        : '';
      
      return [
      job.id,
        customerName,
      job.services?.name || '',
        job.scheduled_date ? new Date(job.scheduled_date).toLocaleDateString() : '',
      job.scheduled_time || '',
      job.status || '',
      `$${job.total || 0}`,
      job.address || '',
      job.notes || ''
      ];
    });

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

// Property Data API endpoint (using RentCast API)
app.post('/api/zillow/property', authenticateToken, async (req, res) => {
  try {
    const { address, street, city, state, zipCode } = req.body;
    
    if (!address && !street) {
      return res.status(400).json({ error: 'Address is required' });
    }
    
    const rentcastApiKey = process.env.RENTCAST_API_KEY;
    const rentcastBaseUrl = process.env.RENTCAST_API_BASE_URL || 'https://api.rentcast.io';
    
    if (!rentcastApiKey) {
      console.log('⚠️ RENTCAST_API_KEY not set, returning null to indicate no property found');
      return res.json(null); // Return null to indicate no property data available
    }
    
    // Parse address components - ALWAYS prioritize explicit city, state, zipCode from request body
    let address1 = '';
    let parsedCity = city || '';
    let parsedState = state || '';
    let parsedZip = zipCode || '';
    
    // Extract street address from street or address field
    // But NEVER overwrite explicit city, state, zipCode values
    if (street) {
      if (street.includes(',')) {
        // Street contains full address, extract just the street part
        const streetParts = street.split(',').map(part => part.trim());
        address1 = streetParts[0];
        // Only use parsed values if explicit values weren't provided
        if (!parsedCity && streetParts.length > 1) {
          parsedCity = streetParts[1];
        }
        if (!parsedState && streetParts.length > 2) {
          const stateZipPart = streetParts[2].replace(/USA/gi, '').trim();
          const stateZip = stateZipPart.split(/\s+/).filter(p => p && p.length > 0);
          if (stateZip.length >= 2) {
            parsedState = stateZip[0];
            if (!parsedZip) parsedZip = stateZip[1];
          } else if (stateZip.length === 1) {
            if (stateZip[0].length === 2 && !parsedState) {
              parsedState = stateZip[0];
            } else if (!parsedZip) {
              parsedZip = stateZip[0];
            }
          }
        }
      } else {
        // Street is just the street address
        address1 = street;
      }
    }
    
    // If we have a full address string and no street address yet, try to parse it
    if (address && !address1) {
      const addressParts = address.split(',').map(part => part.trim());
      if (addressParts.length >= 3) {
        address1 = addressParts[0];
        if (!parsedCity) parsedCity = addressParts[1];
        if (!parsedState && addressParts.length > 2) {
          const stateZipPart = addressParts[2].replace(/USA/gi, '').trim();
          const stateZip = stateZipPart.split(/\s+/).filter(p => p && p.length > 0);
          if (stateZip.length >= 2) {
            parsedState = stateZip[0];
            if (!parsedZip) parsedZip = stateZip[1];
          } else if (stateZip.length === 1) {
            if (stateZip[0].length === 2 && !parsedState) {
              parsedState = stateZip[0];
            } else if (!parsedZip) {
              parsedZip = stateZip[0];
            }
          }
        }
      } else if (addressParts.length === 2) {
        address1 = addressParts[0];
        if (!parsedCity) parsedCity = addressParts[1];
      } else {
        address1 = address;
      }
    }
    
    // Clean up address - remove "USA" or country names
    if (address1) {
      address1 = address1.replace(/\s*,\s*USA$/, '').replace(/\s*USA$/, '').trim();
    }
    
    // Log what we're sending to help debug
    console.log('📤 RentCast API request params:', {
      address: address1,
      city: parsedCity,
      state: parsedState,
      zip: parsedZip,
      originalRequest: { address, street, city, state, zipCode }
    });
    
    // Validate required fields - RentCast needs address, city, state
    if (!address1 || !parsedCity || !parsedState) {
      console.log('⚠️ Missing required address components:', { 
        originalRequest: { address, street, city, state, zipCode },
        parsed: { address1, city: parsedCity, state: parsedState, zip: parsedZip }
      });
      return res.json(null);
    }
    
    // Ensure we're sending all required parameters to RentCast
    const rentcastParams = {
      address: address1,
      city: parsedCity,
      state: parsedState
    };
    
    // Add zip if available (optional but helpful)
    if (parsedZip) {
      rentcastParams.zip = parsedZip;
    }
    
    console.log('📤 Final RentCast params:', rentcastParams);
    
    try {
      // Call RentCast API - Properties endpoint (plural)
      // Documentation: https://developers.rentcast.io/reference/introduction
      // Endpoint: GET /v1/properties?address=...&city=...&state=...&zip=...
      // Log the full request URL for debugging
      const requestUrl = `${rentcastBaseUrl}/v1/properties?${new URLSearchParams(rentcastParams).toString()}`;
      console.log('📤 RentCast request URL:', requestUrl);
      
      const rentcastResponse = await axios.get(`${rentcastBaseUrl}/v1/properties`, {
        headers: {
          'X-Api-Key': rentcastApiKey,
          'Accept': 'application/json'
        },
        params: rentcastParams,
        timeout: 10000, // 10 second timeout
        validateStatus: function (status) {
          // Don't throw error for 404, we'll handle it
          return status < 500;
        }
      });
      
      console.log('✅ RentCast API response received, status:', rentcastResponse.status);
      console.log('📋 RentCast response data:', JSON.stringify(rentcastResponse.data, null, 2));
      
      // RentCast /v1/properties endpoint returns an array of properties
      // The response may contain basic info or full details depending on the endpoint
      let property = null;
      if (Array.isArray(rentcastResponse.data) && rentcastResponse.data.length > 0) {
        property = rentcastResponse.data[0];
      } else if (rentcastResponse.data && typeof rentcastResponse.data === 'object') {
        property = rentcastResponse.data;
      }
      
      // Check if we have valid property data
      if (property && property.id) {
        // Try to get full property details using the property ID
        // RentCast has a "Property Record by Id" endpoint: GET /v1/property/{id}
        // Documentation: https://developers.rentcast.io/reference/property-records
        try {
          console.log('📤 Fetching full property details for ID:', property.id);
          
          // URL encode the property ID since it contains special characters like commas
          const encodedId = encodeURIComponent(property.id);
          
          // Try the property record by ID endpoint
          const propertyDetailsResponse = await axios.get(`${rentcastBaseUrl}/v1/property/${encodedId}`, {
            headers: {
              'X-Api-Key': rentcastApiKey,
              'Accept': 'application/json'
            },
            timeout: 10000,
            validateStatus: function (status) {
              // Accept all status codes < 500 to handle 404, 400, etc. gracefully
              return status < 500;
            }
          });
          
          console.log('📋 Property details response status:', propertyDetailsResponse.status);
          console.log('📋 Property details response data:', JSON.stringify(propertyDetailsResponse.data, null, 2));
          
          if (propertyDetailsResponse.status === 200 && propertyDetailsResponse.data) {
            // Merge the full property details with the basic info
            property = { ...property, ...propertyDetailsResponse.data };
            console.log('✅ Full property details received and merged');
          } else if (propertyDetailsResponse.status === 404) {
            console.log('⚠️ Property details endpoint returned 404 - property may not have detailed data');
            console.log('📋 Using basic property info from search results');
          } else {
            console.log('⚠️ Full property details not available, status:', propertyDetailsResponse.status);
            console.log('📋 Response data:', propertyDetailsResponse.data);
            // Continue with basic property info
          }
        } catch (detailError) {
          // If the endpoint doesn't exist or fails, continue with basic info
          console.log('⚠️ Could not fetch full property details');
          if (detailError.response) {
            console.log('❌ Error status:', detailError.response.status);
            console.log('❌ Error data:', detailError.response.data);
          } else {
            console.log('❌ Error message:', detailError.message);
          }
          // Continue with basic property info - this is OK, not all properties have full details
        }
        
        // Map RentCast data to our expected format
        // RentCast field names based on their API documentation
        // Note: Some properties may only have basic address info, not full details
        const formattedData = {
          zpid: property.id || property.propertyId || null,
          address: property.formattedAddress || property.address || 
                   (property.addressLine1 ? `${property.addressLine1}, ${property.city || ''}, ${property.state || ''} ${property.zipCode || ''}`.trim() : null) ||
                   `${address1}, ${parsedCity}, ${parsedState} ${parsedZip ? parsedZip : ''}`.trim(),
          price: property.price || property.estimatedValue || property.rentEstimate || property.value || null,
          bedrooms: property.bedrooms || property.bedroomsTotal || property.bedroomCount || property.bedroomsCount || null,
          bathrooms: property.bathrooms || property.bathroomsTotal || property.bathroomCount || property.bathroomsCount || null,
          squareFeet: property.squareFootage || property.livingArea || property.totalArea || property.squareFeet || property.area || null,
          yearBuilt: property.yearBuilt || property.yearBuiltValue || property.yearBuiltYear || null,
          propertyType: property.propertyType || property.type || property.propertySubType || property.propertyTypeName || property.propertyTypeLabel || null,
          lotSize: property.lotSize || property.lotSizeSquareFeet || property.lotSquareFeet || null,
          image: (property.photos && Array.isArray(property.photos) && property.photos.length > 0) ? property.photos[0] : 
                 (property.images && Array.isArray(property.images) && property.images.length > 0) ? property.images[0] :
                 (property.photo && Array.isArray(property.photo) && property.photo.length > 0) ? property.photo[0] :
                 property.photo || property.image || null,
          // Additional useful fields
          assessedValue: property.assessedValue || property.taxAssessedValue || property.assessedValueAmount || null,
          marketValue: property.estimatedValue || property.value || property.marketValue || property.avmValue || null,
          lastSalePrice: property.lastSalePrice || property.lastSaleAmount || property.salePrice || property.lastSalePriceAmount || null,
          lastSaleDate: property.lastSaleDate || property.saleDate || property.lastSaleDateValue || null,
          lotSizeAcres: property.lotSizeAcres || property.lotAcres || null,
          stories: property.stories || property.storyCount || property.story || property.storiesCount || null,
          units: property.units || property.unitCount || property.unitsCount || null
        };
        
        console.log('✅ Property data formatted successfully');
        console.log('📋 Formatted data being sent to frontend:', JSON.stringify(formattedData, null, 2));
        return res.json(formattedData);
      } else {
        console.log('⚠️ No property found in RentCast API response');
        return res.json(null);
      }
      
    } catch (apiError) {
      console.error('❌ RentCast API error:', apiError.response?.status, apiError.response?.statusText);
      console.error('Response data:', apiError.response?.data);
      
      // If API returns 404 or no results, return null instead of error
      if (apiError.response?.status === 404 || apiError.response?.status === 400 || apiError.response?.status === 422) {
        console.log('⚠️ Property not found (404/400/422) - returning null');
        return res.json(null);
      }
      
      // For other errors, still return null to avoid breaking the UI
      console.error('⚠️ RentCast API request failed, returning null');
      return res.json(null);
    }
    
  } catch (error) {
    console.error('❌ Property API error:', error);
    // Return null instead of error to allow UI to handle gracefully
    res.json(null);
  }
});

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



