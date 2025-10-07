// Google Sheets/Calendar Import System with Field Mapping
// Allows users to import data from Google Sheets/Calendar with manual field mapping

const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');

// Export function to setup Google import endpoints
function setupGoogleImportEndpoints(app, authenticateToken, supabase, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI) {
  
// Google Sheets Import endpoints
app.get('/api/google/sheets/list', authenticateToken, async (req, res) => {
  try {
    console.log('📊 Google Sheets List Request:', { userId: req.user?.userId });
    const userId = req.user.userId;
    
    // Get user's Google access token
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('google_access_token, google_refresh_token')
      .eq('id', userId)
      .single();

    if (userError || !userData?.google_access_token) {
      return res.status(400).json({ error: 'Google account not connected. Please connect your Google account first.' });
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

    // Get user's spreadsheets
    const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    // List spreadsheets
    const response = await drive.files.list({
      q: "mimeType='application/vnd.google-apps.spreadsheet'",
      fields: 'files(id, name, modifiedTime, webViewLink)',
      orderBy: 'modifiedTime desc',
      pageSize: 50
    });

    const spreadsheets = response.data.files.map(file => ({
      id: file.id,
      name: file.name,
      modifiedTime: file.modifiedTime,
      url: file.webViewLink
    }));

    res.json({
      success: true,
      spreadsheets: spreadsheets
    });

  } catch (error) {
    console.error('Error listing Google Sheets:', error);
    res.status(500).json({ error: 'Failed to list Google Sheets' });
  }
});

// Get spreadsheet data for preview and mapping
app.get('/api/google/sheets/:spreadsheetId/data', authenticateToken, async (req, res) => {
  try {
    const { spreadsheetId } = req.params;
    const { range = 'A1:Z1000' } = req.query;
    const userId = req.user.userId;
    
    // Get user's Google access token
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('google_access_token, google_refresh_token')
      .eq('id', userId)
      .single();

    if (userError || !userData?.google_access_token) {
      return res.status(400).json({ error: 'Google account not connected' });
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

    // Get spreadsheet data
    const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: spreadsheetId,
      range: range
    });

    const values = response.data.values || [];
    
    if (values.length === 0) {
      return res.json({
        success: true,
        data: [],
        headers: [],
        rows: []
      });
    }

    // First row is headers
    const headers = values[0];
    const rows = values.slice(1);

    // Get spreadsheet info
    const spreadsheetInfo = await sheets.spreadsheets.get({
      spreadsheetId: spreadsheetId,
      fields: 'properties(title, locale, timeZone)'
    });

    res.json({
      success: true,
      spreadsheet: {
        id: spreadsheetId,
        title: spreadsheetInfo.data.properties.title,
        locale: spreadsheetInfo.data.properties.locale,
        timeZone: spreadsheetInfo.data.properties.timeZone
      },
      headers: headers,
      rows: rows.slice(0, 10), // Preview first 10 rows
      totalRows: rows.length
    });

  } catch (error) {
    console.error('Error getting spreadsheet data:', error);
    res.status(500).json({ error: 'Failed to get spreadsheet data' });
  }
});

// Import data with field mapping
app.post('/api/google/sheets/import', authenticateToken, async (req, res) => {
  try {
    const { 
      spreadsheetId, 
      importType, // 'customers' or 'jobs'
      fieldMappings, 
      importSettings 
    } = req.body;
    const userId = req.user.userId;
    
    if (!spreadsheetId || !importType || !fieldMappings) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    // Get user's Google access token
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('google_access_token, google_refresh_token')
      .eq('id', userId)
      .single();

    if (userError || !userData?.google_access_token) {
      return res.status(400).json({ error: 'Google account not connected' });
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

    // Get all spreadsheet data
    const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: spreadsheetId,
      range: 'A1:Z1000'
    });

    const values = response.data.values || [];
    if (values.length < 2) {
      return res.status(400).json({ error: 'Spreadsheet has no data to import' });
    }

    const headers = values[0];
    const rows = values.slice(1);

    // Transform data using field mappings
    const transformedData = transformData(rows, headers, fieldMappings, importType, userId);

    // Import data to database
    let importResult;
    if (importType === 'customers') {
      importResult = await importCustomers(transformedData, importSettings);
    } else if (importType === 'jobs') {
      importResult = await importJobs(transformedData, importSettings);
    } else {
      return res.status(400).json({ error: 'Invalid import type' });
    }

    res.json({
      success: true,
      message: `Successfully imported ${importResult.imported} ${importType}`,
      imported: importResult.imported,
      skipped: importResult.skipped,
      errors: importResult.errors
    });

  } catch (error) {
    console.error('Error importing data:', error);
    res.status(500).json({ error: 'Failed to import data' });
  }
});

  // Transform data using field mappings
  function transformData(rows, headers, fieldMappings, importType, userId) {
  const transformedData = [];
  const errors = [];

  rows.forEach((row, index) => {
    try {
      const transformedRow = {
        user_id: userId,
        created_at: new Date().toISOString()
      };

      // Apply field mappings
      Object.entries(fieldMappings).forEach(([targetField, sourceField]) => {
        if (sourceField && sourceField !== '') {
          const sourceIndex = headers.indexOf(sourceField);
          if (sourceIndex !== -1 && row[sourceIndex]) {
            transformedRow[targetField] = row[sourceIndex];
          }
        }
      });

      // Add import type specific fields
      if (importType === 'customers') {
        transformedRow.id = `import_${Date.now()}_${index}`;
      } else if (importType === 'jobs') {
        transformedRow.id = `import_${Date.now()}_${index}`;
        transformedRow.status = 'pending';
      }

      transformedData.push(transformedRow);
    } catch (error) {
      errors.push({
        row: index + 1,
        error: error.message
      });
    }
  });

  return { transformedData, errors };
}

  // Import customers to database
  async function importCustomers(data, settings) {
  const { updateExisting = false, skipDuplicates = true } = settings;
  let imported = 0;
  let skipped = 0;
  const errors = [];

  for (const customer of data.transformedData) {
    try {
      // Check for duplicates if skipDuplicates is true
      if (skipDuplicates) {
        const { data: existing } = await supabase
          .from('customers')
          .select('id')
          .eq('email', customer.email)
          .eq('user_id', customer.user_id)
          .single();

        if (existing) {
          skipped++;
          continue;
        }
      }

      // Insert customer
      const { error } = await supabase
        .from('customers')
        .insert(customer);

      if (error) {
        errors.push({
          email: customer.email,
          error: error.message
        });
      } else {
        imported++;
      }
    } catch (error) {
      errors.push({
        email: customer.email,
        error: error.message
      });
    }
  }

  return { imported, skipped, errors };
}

  // Import jobs to database
  async function importJobs(data, settings) {
  const { updateExisting = false, skipDuplicates = true } = settings;
  let imported = 0;
  let skipped = 0;
  const errors = [];

  for (const job of data.transformedData) {
    try {
      // Check for duplicates if skipDuplicates is true
      if (skipDuplicates) {
        const { data: existing } = await supabase
          .from('jobs')
          .select('id')
          .eq('service_name', job.service_name)
          .eq('scheduled_date', job.scheduled_date)
          .eq('user_id', job.user_id)
          .single();

        if (existing) {
          skipped++;
          continue;
        }
      }

      // Insert job
      const { error } = await supabase
        .from('jobs')
        .insert(job);

      if (error) {
        errors.push({
          service_name: job.service_name,
          error: error.message
        });
      } else {
        imported++;
      }
    } catch (error) {
      errors.push({
        service_name: job.service_name,
        error: error.message
      });
    }
  }

  return { imported, skipped, errors };
}

// Google Calendar Import endpoints
app.get('/api/google/calendar/list', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    // Get user's Google access token
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('google_access_token, google_refresh_token')
      .eq('id', userId)
      .single();

    if (userError || !userData?.google_access_token) {
      return res.status(400).json({ error: 'Google account not connected. Please connect your Google account first.' });
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

    // Get user's calendars
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const response = await calendar.calendarList.list();

    const calendars = response.data.items.map(cal => ({
      id: cal.id,
      summary: cal.summary,
      description: cal.description,
      backgroundColor: cal.backgroundColor,
      primary: cal.primary
    }));

    res.json({
      success: true,
      calendars: calendars
    });

  } catch (error) {
    console.error('Error listing Google Calendars:', error);
    res.status(500).json({ error: 'Failed to list Google Calendars' });
  }
});

// Get calendar events for preview
app.get('/api/google/calendar/:calendarId/events', authenticateToken, async (req, res) => {
  try {
    const { calendarId } = req.params;
    const { start, end } = req.query;
    const userId = req.user.userId;
    
    // Get user's Google access token
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('google_access_token, google_refresh_token')
      .eq('id', userId)
      .single();

    if (userError || !userData?.google_access_token) {
      return res.status(400).json({ error: 'Google account not connected' });
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

    // Get calendar events
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const response = await calendar.events.list({
      calendarId: calendarId,
      timeMin: start ? new Date(start).toISOString() : new Date().toISOString(),
      timeMax: end ? new Date(end).toISOString() : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      singleEvents: true,
      orderBy: 'startTime'
    });

    const events = response.data.items || [];
    
    // Get calendar info
    const calendarInfo = await calendar.calendars.get({
      calendarId: calendarId
    });

    res.json({
      success: true,
      calendar: {
        id: calendarInfo.data.id,
        summary: calendarInfo.data.summary,
        description: calendarInfo.data.description
      },
      events: events
    });

  } catch (error) {
    console.error('Error getting calendar events:', error);
    res.status(500).json({ error: 'Failed to get calendar events' });
  }
});

// Import calendar events as jobs
app.post('/api/google/calendar/import', authenticateToken, async (req, res) => {
  try {
    const { 
      calendarId, 
      fieldMappings, 
      importSettings 
    } = req.body;
    const userId = req.user.userId;
    
    if (!calendarId || !fieldMappings) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    // Get user's Google access token
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('google_access_token, google_refresh_token')
      .eq('id', userId)
      .single();

    if (userError || !userData?.google_access_token) {
      return res.status(400).json({ error: 'Google account not connected' });
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

    // Get all calendar events
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const response = await calendar.events.list({
      calendarId: calendarId,
      timeMin: importSettings.dateRange?.start ? new Date(importSettings.dateRange.start).toISOString() : new Date().toISOString(),
      timeMax: importSettings.dateRange?.end ? new Date(importSettings.dateRange.end).toISOString() : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      singleEvents: true,
      orderBy: 'startTime'
    });

    const events = response.data.items || [];
    if (events.length === 0) {
      return res.status(400).json({ error: 'No events found in the selected date range' });
    }

    // Transform events using field mappings
    const transformedData = transformCalendarEvents(events, fieldMappings, userId);

    // Import events as jobs
    const importResult = await importJobs(transformedData, importSettings);

    res.json({
      success: true,
      message: `Successfully imported ${importResult.imported} jobs from calendar events`,
      imported: importResult.imported,
      skipped: importResult.skipped,
      errors: importResult.errors
    });

  } catch (error) {
    console.error('Error importing calendar events:', error);
    res.status(500).json({ error: 'Failed to import calendar events' });
  }
});

  // Transform calendar events using field mappings
  function transformCalendarEvents(events, fieldMappings, userId) {
  const transformedData = [];
  const errors = [];

  events.forEach((event, index) => {
    try {
      const transformedEvent = {
        user_id: userId,
        created_at: new Date().toISOString(),
        status: 'pending'
      };

      // Apply field mappings
      Object.entries(fieldMappings).forEach(([targetField, sourceField]) => {
        if (sourceField && sourceField !== '') {
          let value = null;
          
          // Extract value based on source field
          if (sourceField === 'summary') {
            value = event.summary;
          } else if (sourceField === 'description') {
            value = event.description;
          } else if (sourceField === 'start.dateTime') {
            value = event.start?.dateTime;
          } else if (sourceField === 'start.date') {
            value = event.start?.date;
          } else if (sourceField === 'location') {
            value = event.location;
          } else if (sourceField === 'attendees') {
            value = event.attendees?.map(a => a.email).join(', ');
          }
          
          if (value) {
            transformedEvent[targetField] = value;
          }
        }
      });

      // Set default values for required fields
      if (!transformedEvent.service_name && event.summary) {
        transformedEvent.service_name = event.summary;
      }
      
      if (!transformedEvent.scheduled_date && event.start?.dateTime) {
        transformedEvent.scheduled_date = event.start.dateTime;
      } else if (!transformedEvent.scheduled_date && event.start?.date) {
        transformedEvent.scheduled_date = event.start.date;
      }

      transformedData.push(transformedEvent);
    } catch (error) {
      errors.push({
        event: event.summary || `Event ${index + 1}`,
        error: error.message
      });
    }
  });

  return { transformedData, errors };
}

}

module.exports = {
  setupGoogleImportEndpoints
};
