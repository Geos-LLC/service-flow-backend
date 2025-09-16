# Environment Variables Setup

## Required Environment Variables

Add these to your deployment platform (Railway, Heroku, etc.):

### SendGrid Configuration
```
SENDGRID_API_KEY=your_sendgrid_api_key_here
SENDGRID_FROM_EMAIL=info@spotless.homes
```

### Database Configuration
```
SUPABASE_URL=your_supabase_url_here
SUPABASE_ANON_KEY=your_supabase_anon_key_here
```

### JWT Secret
```
JWT_SECRET=your_jwt_secret_here
```

### Email Configuration (SendGrid Only)
```
# SendGrid is the only email service used
# No SMTP/Gmail configuration needed
```

## How to Set Up SendGrid

1. Go to [SendGrid Dashboard](https://app.sendgrid.com/)
2. Navigate to **Settings** → **API Keys**
3. Click **Create API Key**
4. Choose **Full Access** or **Restricted Access** with **Mail Send** permission
5. Copy the API key
6. Add it to your environment variables as `SENDGRID_API_KEY`

## Verify Sender Email

1. In SendGrid, go to **Settings** → **Sender Authentication**
2. Add and verify `info@spotless.homes`
3. Or use an already verified email address

## Security Notes

- Never commit API keys to code
- Use environment variables for all sensitive data
- Keep your repository private or use proper .gitignore
