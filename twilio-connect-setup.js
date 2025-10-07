// Twilio Connect Integration - Similar to Stripe Connect
// Users connect their own Twilio accounts instead of using your credentials

const express = require('express');
const twilio = require('twilio');

// Twilio Connect Configuration
const TWILIO_CONNECT_ACCOUNT_SID = process.env.TWILIO_CONNECT_ACCOUNT_SID; // Your Twilio Connect Account SID
const TWILIO_CONNECT_AUTH_TOKEN = process.env.TWILIO_CONNECT_AUTH_TOKEN; // Your Twilio Connect Auth Token

// Initialize Twilio Connect client
const twilioConnectClient = twilio(TWILIO_CONNECT_ACCOUNT_SID, TWILIO_CONNECT_AUTH_TOKEN);

// Twilio Connect endpoints
app.post('/api/twilio/connect/account-link', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    // Create Twilio Connect account for user
    const connectAccount = await twilioConnectClient.accounts.create({
      friendlyName: `Serviceflow User ${userId}`,
      type: 'full' // Full access to Twilio services
    });
    
    // Create account link for user to authorize
    const accountLink = await twilioConnectClient.accounts(connectAccount.sid)
      .accountLinks.create({
        type: 'account_link',
        returnUrl: `${process.env.FRONTEND_URL}/settings/twilio?connected=true`,
        refreshUrl: `${process.env.FRONTEND_URL}/settings/twilio?refresh=true`
      });
    
    // Store connect account SID in user's database record
    const { error: updateError } = await supabase
      .from('users')
      .update({ 
        twilio_connect_account_sid: connectAccount.sid,
        twilio_connect_status: 'pending'
      })
      .eq('id', userId);
    
    if (updateError) {
      console.error('Error updating user Twilio Connect data:', updateError);
      return res.status(500).json({ error: 'Failed to store Twilio Connect data' });
    }
    
    console.log('🔗 Twilio Connect account created:', connectAccount.sid);
    
    res.json({
      success: true,
      message: 'Twilio Connect account created',
      accountSid: connectAccount.sid,
      accountLinkUrl: accountLink.url
    });
    
  } catch (error) {
    console.error('Twilio Connect account creation error:', error);
    res.status(500).json({ error: 'Failed to create Twilio Connect account' });
  }
});

// Check Twilio Connect account status
app.get('/api/twilio/connect/account-status', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    // Get user's Twilio Connect account SID
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('twilio_connect_account_sid, twilio_connect_status')
      .eq('id', userId)
      .single();
    
    if (userError || !userData?.twilio_connect_account_sid) {
      return res.json({ 
        connected: false, 
        status: 'not_connected',
        message: 'Twilio account not connected'
      });
    }
    
    // Check account status with Twilio
    const account = await twilioConnectClient.accounts(userData.twilio_connect_account_sid).fetch();
    
    const isConnected = account.status === 'active';
    
    // Update status in database
    if (isConnected && userData.twilio_connect_status !== 'connected') {
      await supabase
        .from('users')
        .update({ twilio_connect_status: 'connected' })
        .eq('id', userId);
    }
    
    res.json({
      connected: isConnected,
      status: account.status,
      accountSid: account.sid,
      friendlyName: account.friendlyName
    });
    
  } catch (error) {
    console.error('Twilio Connect status check error:', error);
    res.status(500).json({ error: 'Failed to check Twilio Connect status' });
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
      .select('twilio_connect_account_sid, twilio_connect_status')
      .eq('id', userId)
      .single();
    
    if (userError || !userData?.twilio_connect_account_sid) {
      return res.status(400).json({ error: 'Twilio account not connected. Please connect your Twilio account first.' });
    }
    
    if (userData.twilio_connect_status !== 'connected') {
      return res.status(400).json({ error: 'Twilio account not active. Please complete the connection process.' });
    }
    
    // Send SMS using user's connected Twilio account
    const result = await twilioConnectClient.messages.create({
      body: message,
      from: userData.twilio_phone_number, // User's Twilio phone number
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

module.exports = {
  twilioConnectClient
};
