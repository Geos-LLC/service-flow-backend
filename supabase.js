const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Supabase configuration
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase = null;

// Create a mock client for fallback
function createMockClient() {
  console.log('⚠️  Creating mock Supabase client due to connection issues');
  
  return {
    from: (table) => ({
      select: () => ({ eq: () => ({ limit: () => ({ data: [], error: null }) }) }),
      insert: () => ({ select: () => ({ data: [], error: null }) }),
      update: () => ({ eq: () => ({ select: () => ({ data: [], error: null }) }) }),
      delete: () => ({ eq: () => ({ error: null }) })
    })
  };
}

// Initialize Supabase client
if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Missing Supabase environment variables');
  console.error('Please set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in your .env file');
  supabase = createMockClient();
} else {
  // Create Supabase client with service role key for admin operations
  supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}

// Test Supabase connection
async function testSupabaseConnection() {
  try {
    console.log('Testing Supabase connection...');
    console.log('Supabase URL:', supabaseUrl);
    console.log('Has service key:', !!supabaseServiceKey);
    
    // Test basic connectivity first
    console.log('Testing basic connectivity...');
    
    const { data, error } = await supabase
      .from('users')
      .select('count')
      .limit(1);
    
    if (error) {
      console.error('Supabase connection test failed:', {
        message: error.message,
        details: error.details,
        hint: error.hint,
        code: error.code
      });
      
      // Additional debugging
      if (error.code === 'PGRST301') {
        console.error('This might be an authentication issue. Check your API key.');
      } else if (error.code === 'PGRST116') {
        console.error('This might be a network connectivity issue.');
      }
      
      console.log('⚠️  Using mock client due to connection issues');
      supabase = createMockClient();
      return false;
    }
    
    console.log('Supabase connected successfully');
    console.log('Supabase config:', {
      url: supabaseUrl,
      hasServiceKey: !!supabaseServiceKey
    });
    return true;
  } catch (error) {
    console.error('Supabase connection test failed:', {
      message: error.message,
      details: error.details || error.stack,
      hint: error.hint,
      code: error.code
    });
    
    // Check if it's a network issue
    if (error.message.includes('fetch failed') || error.message.includes('ENOTFOUND') || error.message.includes('ETIMEDOUT')) {
      console.error('This appears to be a network connectivity issue.');
      console.error('Please check:');
      console.error('1. Your internet connection');
      console.error('2. Your Supabase URL is correct');
      console.error('3. No firewall/proxy is blocking the connection');
      console.error('4. Your Supabase project is active');
    }
    
    console.log('⚠️  Using mock client due to connection issues');
    supabase = createMockClient();
    return false;
  }
}

// Database helper functions to replace MySQL queries
db = {
  // Generic query function
  async query(table, options = {}) {
    const { select = '*', where = {}, orderBy = null, limit = null, offset = null } = options;
    
    let query = supabase.from(table).select(select);
    
    // Add where conditions
    Object.keys(where).forEach(key => {
      query = query.eq(key, where[key]);
    });
    
    // Add ordering
    if (orderBy) {
      query = query.order(orderBy.column, { ascending: orderBy.ascending !== false });
    }
    
    // Add limit and offset
    if (limit) query = query.limit(limit);
    if (offset) query = query.range(offset, offset + (limit || 1000) - 1);
    
    const { data, error } = await query;
    
    if (error) {
      console.error(`Database query error for table ${table}:`, error);
      throw error;
    }
    
    return data;
  },
  
  // Insert function
  async insert(table, data) {
    const { data: result, error } = await supabase
      .from(table)
      .insert(data)
      .select();
    
    if (error) {
      console.error(`Database insert error for table ${table}:`, error);
      throw error;
    }
    
    return result[0];
  },
  
  // Update function
  async update(table, data, where) {
    let query = supabase.from(table).update(data);
    
    Object.keys(where).forEach(key => {
      query = query.eq(key, where[key]);
    });
    
    const { data: result, error } = await query.select();
    
    if (error) {
      console.error(`Database update error for table ${table}:`, error);
      throw error;
    }
    
    return result[0];
  },
  
  // Delete function
  async delete(table, where) {
    let query = supabase.from(table).delete();
    
    Object.keys(where).forEach(key => {
      query = query.eq(key, where[key]);
    });
    
    const { error } = await query;
    
    if (error) {
      console.error(`Database delete error for table ${table}:`, error);
      throw error;
    }
    
    return true;
  },
  
  // Raw SQL function (for complex queries)
  async raw(sql, params = []) {
    const { data, error } = await supabase.rpc('exec_sql', {
      sql_query: sql,
      sql_params: params
    });
    
    if (error) {
      console.error('Raw SQL error:', error);
      throw error;
    }
    
    return data;
  },
  
  // Transaction support (Supabase doesn't support transactions in the same way)
  async transaction(callback) {
    // For now, we'll just execute the callback
    // In a real implementation, you might want to use Supabase's transaction support
    return await callback();
  }
};

// Test connection on startup
testSupabaseConnection();

module.exports = { supabase, db, testSupabaseConnection };

