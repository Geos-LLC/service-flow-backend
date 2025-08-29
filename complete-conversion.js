// Complete MySQL to Supabase Conversion Script
// This script will convert all remaining MySQL endpoints to Supabase

const fs = require('fs');
const path = require('path');

// Conversion patterns for different endpoint types
const conversionPatterns = {
  // Basic SELECT queries
  'const [rows] = await connection.query(\'SELECT * FROM table WHERE id = ?\', [id]);': 
    'const { data: rows, error } = await supabase.from(\'table\').select(\'*\').eq(\'id\', id);',
  
  // INSERT queries
  'const [result] = await connection.query(\'INSERT INTO table (field) VALUES (?)\', [value]);': 
    'const { data: result, error } = await supabase.from(\'table\').insert({ field: value }).select().single();',
  
  // UPDATE queries
  'await connection.query(\'UPDATE table SET field = ? WHERE id = ?\', [value, id]);': 
    'const { data, error } = await supabase.from(\'table\').update({ field: value }).eq(\'id\', id);',
  
  // DELETE queries
  'await connection.query(\'DELETE FROM table WHERE id = ?\', [id]);': 
    'const { error } = await supabase.from(\'table\').delete().eq(\'id\', id);',
  
  // Connection patterns
  'const connection = await pool.getConnection();': '// Supabase connection handled automatically',
  'connection.release();': '// No connection release needed with Supabase',
  
  // Error handling patterns
  'if (rows.length === 0)': 'if (!rows || rows.length === 0)',
  'if (result.length === 0)': 'if (!result || result.length === 0)',
  
  // Add error handling
  'const { data: rows, error } = await supabase': 'const { data: rows, error } = await supabase',
  'if (error) {': 'if (error) {',
  'console.error(\'Error:\', error);': 'console.error(\'Error:\', error);',
  'return res.status(500).json({ error: \'Database error\' });': 'return res.status(500).json({ error: \'Database error\' });',
  '}': '}',
};

// Endpoint conversion templates
const endpointTemplates = {
  // Basic GET endpoint
  getEndpoint: (table) => `
app.get('/api/${table}', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { page = 1, limit = 20, search, sortBy = 'created_at', sortOrder = 'DESC' } = req.query;
    
    let query = supabase
      .from('${table}')
      .select('*', { count: 'exact' })
      .eq('user_id', userId);
    
    if (search) {
      query = query.or(\`name.ilike.%\${search}%,description.ilike.%\${search}%\`);
    }
    
    query = query.order(sortBy, { ascending: sortOrder === 'ASC' });
    
    const offset = (page - 1) * limit;
    query = query.range(offset, offset + parseInt(limit) - 1);
    
    const { data, error, count } = await query;
    
    if (error) {
      console.error('Error fetching ${table}:', error);
      return res.status(500).json({ error: 'Failed to fetch ${table}' });
    }
    
    res.json({
      ${table}: data || [],
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count || 0,
        pages: Math.ceil((count || 0) / limit)
      }
    });
  } catch (error) {
    console.error('Get ${table} error:', error);
    res.status(500).json({ error: 'Failed to fetch ${table}' });
  }
});`,

  // Individual GET endpoint
  getByIdEndpoint: (table) => `
app.get('/api/${table}/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    
    const { data, error } = await supabase
      .from('${table}')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .limit(1);
    
    if (error) {
      console.error('Error fetching ${table}:', error);
      return res.status(500).json({ error: 'Failed to fetch ${table}' });
    }
    
    if (!data || data.length === 0) {
      return res.status(404).json({ error: '${table} not found' });
    }
    
    res.json(data[0]);
  } catch (error) {
    console.error('Get ${table} error:', error);
    res.status(500).json({ error: 'Failed to fetch ${table}' });
  }
});`,

  // POST endpoint
  postEndpoint: (table) => `
app.post('/api/${table}', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const data = req.body;
    
    const { data: new${table}, error } = await supabase
      .from('${table}')
      .insert({ ...data, user_id: userId })
      .select()
      .single();
    
    if (error) {
      console.error('Error creating ${table}:', error);
      return res.status(500).json({ error: 'Failed to create ${table}' });
    }
    
    res.status(201).json({
      message: '${table} created successfully',
      ${table}: new${table}
    });
  } catch (error) {
    console.error('Create ${table} error:', error);
    res.status(500).json({ error: 'Failed to create ${table}' });
  }
});`,

  // PUT endpoint
  putEndpoint: (table) => `
app.put('/api/${table}/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    const data = req.body;
    
    const { data: updated${table}, error } = await supabase
      .from('${table}')
      .update(data)
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single();
    
    if (error) {
      console.error('Error updating ${table}:', error);
      return res.status(500).json({ error: 'Failed to update ${table}' });
    }
    
    res.json({
      message: '${table} updated successfully',
      ${table}: updated${table}
    });
  } catch (error) {
    console.error('Update ${table} error:', error);
    res.status(500).json({ error: 'Failed to update ${table}' });
  }
});`,

  // DELETE endpoint
  deleteEndpoint: (table) => `
app.delete('/api/${table}/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    
    const { error } = await supabase
      .from('${table}')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);
    
    if (error) {
      console.error('Error deleting ${table}:', error);
      return res.status(500).json({ error: 'Failed to delete ${table}' });
    }
    
    res.json({ message: '${table} deleted successfully' });
  } catch (error) {
    console.error('Delete ${table} error:', error);
    res.status(500).json({ error: 'Failed to delete ${table}' });
  }
});`
};

// Tables that need conversion
const tables = [
  'jobs',
  'customers', 
  'team_members',
  'estimates',
  'invoices',
  'territories',
  'coupons',
  'requests',
  'service_categories'
];

// Generate complete conversion
function generateCompleteConversion() {
  let conversion = '';
  
  // Add imports
  conversion += `// Complete Supabase conversion\n`;
  conversion += `const { supabase, db } = require('./supabase');\n\n`;
  
  // Generate endpoints for each table
  tables.forEach(table => {
    conversion += `// ${table} endpoints\n`;
    conversion += endpointTemplates.getEndpoint(table);
    conversion += '\n';
    conversion += endpointTemplates.getByIdEndpoint(table);
    conversion += '\n';
    conversion += endpointTemplates.postEndpoint(table);
    conversion += '\n';
    conversion += endpointTemplates.putEndpoint(table);
    conversion += '\n';
    conversion += endpointTemplates.deleteEndpoint(table);
    conversion += '\n\n';
  });
  
  return conversion;
}

// Export the conversion
module.exports = {
  conversionPatterns,
  endpointTemplates,
  generateCompleteConversion,
  tables
};

// If run directly, generate the conversion
if (require.main === module) {
  const conversion = generateCompleteConversion();
  console.log('Complete Supabase conversion generated:');
  console.log(conversion);
}
