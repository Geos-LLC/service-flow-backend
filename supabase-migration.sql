-- Supabase Migration File
-- Converted from MySQL to PostgreSQL for Supabase

-- Enable necessary extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Create custom types
CREATE TYPE user_status AS ENUM ('active', 'inactive', 'archived');
CREATE TYPE job_status AS ENUM ('pending', 'confirmed', 'in-progress', 'completed', 'cancelled');
CREATE TYPE invoice_status AS ENUM ('draft', 'sent', 'paid', 'overdue', 'cancelled');
CREATE TYPE estimate_status AS ENUM ('pending', 'sent', 'accepted', 'rejected');
CREATE TYPE notification_type AS ENUM ('email', 'sms');
CREATE TYPE notification_status AS ENUM ('pending', 'sent', 'failed');
CREATE TYPE request_type AS ENUM ('booking', 'quote');
CREATE TYPE request_status AS ENUM ('pending', 'approved', 'rejected', 'cancelled');
CREATE TYPE team_member_status AS ENUM ('active', 'inactive', 'on_leave', 'invited');
CREATE TYPE territory_status AS ENUM ('active', 'inactive', 'archived');
CREATE TYPE discount_type AS ENUM ('percentage', 'fixed');
CREATE TYPE application_type AS ENUM ('all', 'specific');
CREATE TYPE recurring_application_type AS ENUM ('all', 'first');

-- Users table
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    business_name VARCHAR(255),
    business_email VARCHAR(255),
    phone VARCHAR(20),
    email_notifications BOOLEAN DEFAULT true,
    sms_notifications BOOLEAN DEFAULT false,
    profile_picture VARCHAR(500),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT true,
    business_slug VARCHAR(255) UNIQUE
);

-- Service Flow table (renamed from booking_settings)
CREATE TABLE service_flow (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    settings JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id)
);

-- Customers table
CREATE TABLE customers (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100),
    email VARCHAR(255),
    phone VARCHAR(20),
    address TEXT,
    suite VARCHAR(255),
    city VARCHAR(100),
    state VARCHAR(10),
    zip_code VARCHAR(20),
    notes TEXT,
    status user_status DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Service Categories table
CREATE TABLE service_categories (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    color VARCHAR(7) DEFAULT '#3B82F6',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, name)
);

-- Services table
CREATE TABLE services (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    price DECIMAL(10,2),
    duration INTEGER,
    category VARCHAR(100),
    image VARCHAR(500),
    modifiers JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    require_payment_method BOOLEAN DEFAULT false,
    is_active BOOLEAN DEFAULT true,
    intake_questions JSONB,
    category_id INTEGER REFERENCES service_categories(id) ON DELETE SET NULL
);

-- Team Members table
CREATE TABLE team_members (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    email VARCHAR(255) NOT NULL,
    phone VARCHAR(20),
    role VARCHAR(100),
    username VARCHAR(100) UNIQUE,
    password VARCHAR(255),
    is_active BOOLEAN DEFAULT true,
    is_verified BOOLEAN DEFAULT false,
    verification_token VARCHAR(255),
    reset_token VARCHAR(255),
    reset_token_expires TIMESTAMP,
    last_login TIMESTAMP,
    skills JSONB,
    hourly_rate DECIMAL(10,2),
    availability JSONB,
    profile_picture VARCHAR(500),
    status team_member_status DEFAULT 'active',
    permissions JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    location VARCHAR(255),
    city VARCHAR(100),
    state VARCHAR(50),
    zip_code VARCHAR(20),
    is_service_provider BOOLEAN DEFAULT true,
    territories JSONB,
    invitation_token VARCHAR(255),
    invitation_expires TIMESTAMP,
    settings JSONB
);

-- Territories table
CREATE TABLE territories (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    zip_codes JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    location VARCHAR(255),
    radius_miles DECIMAL(5,2) DEFAULT 25.00,
    timezone VARCHAR(50) DEFAULT 'America/New_York',
    status territory_status DEFAULT 'active',
    business_hours JSONB,
    team_members JSONB,
    services JSONB,
    pricing_multiplier DECIMAL(3,2) DEFAULT 1.00
);

-- Jobs table
CREATE TABLE jobs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
    service_id INTEGER REFERENCES services(id) ON DELETE SET NULL,
    team_member_id INTEGER REFERENCES team_members(id) ON DELETE SET NULL,
    territory_id INTEGER REFERENCES territories(id) ON DELETE SET NULL,
    scheduled_date TIMESTAMP NOT NULL,
    notes TEXT,
    status job_status,
    invoice_status VARCHAR(100),
    invoice_id INTEGER,
    invoice_amount DECIMAL(10,2),
    invoice_date DATE,
    payment_date DATE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_recurring BOOLEAN DEFAULT false,
    recurring_frequency VARCHAR(100),
    next_billing_date DATE,
    stripe_payment_intent_id VARCHAR(255),
    duration INTEGER DEFAULT 360,
    workers INTEGER DEFAULT 1,
    skills_required INTEGER DEFAULT 0,
    price DECIMAL(10,2) DEFAULT 0.00,
    discount DECIMAL(10,2) DEFAULT 0.00,
    additional_fees DECIMAL(10,2) DEFAULT 0.00,
    taxes DECIMAL(10,2) DEFAULT 0.00,
    total DECIMAL(10,2) DEFAULT 0.00,
    payment_method VARCHAR(50),
    territory VARCHAR(255),
    schedule_type VARCHAR(100),
    let_customer_schedule BOOLEAN DEFAULT false,
    offer_to_providers BOOLEAN DEFAULT false,
    internal_notes TEXT,
    contact_info JSONB,
    customer_notes TEXT,
    scheduled_time TIME DEFAULT '09:00:00',
    service_address_street VARCHAR(255),
    service_address_city VARCHAR(100),
    service_address_state VARCHAR(50),
    service_address_zip VARCHAR(20),
    service_address_country VARCHAR(100) DEFAULT 'USA',
    service_address_lat DECIMAL(10,8),
    service_address_lng DECIMAL(11,8),
    service_name VARCHAR(255),
    bathroom_count VARCHAR(100),
    workers_needed INTEGER DEFAULT 1,
    skills JSONB,
    service_price DECIMAL(10,2) DEFAULT 0.00,
    total_amount DECIMAL(10,2) DEFAULT 0.00,
    estimated_duration INTEGER,
    special_instructions TEXT,
    payment_status VARCHAR(100),
    priority VARCHAR(100),
    quality_check BOOLEAN DEFAULT true,
    photos_required BOOLEAN DEFAULT false,
    customer_signature BOOLEAN DEFAULT false,
    auto_invoice BOOLEAN DEFAULT true,
    auto_reminders BOOLEAN DEFAULT true,
    recurring_end_date DATE,
    tags JSONB,
    intake_question_answers JSONB,
    service_modifiers JSONB,
    service_intake_questions JSONB
);

-- Invoices table
CREATE TABLE invoices (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
    job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
    estimate_id INTEGER,
    amount DECIMAL(10,2) NOT NULL,
    tax_amount DECIMAL(10,2) DEFAULT 0.00,
    total_amount DECIMAL(10,2) NOT NULL,
    status invoice_status DEFAULT 'draft',
    due_date DATE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Estimates table
CREATE TABLE estimates (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
    services JSONB,
    total_amount DECIMAL(10,2) NOT NULL,
    status estimate_status DEFAULT 'pending',
    valid_until DATE,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Coupons table
CREATE TABLE coupons (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    code VARCHAR(50) UNIQUE NOT NULL,
    discount_type discount_type NOT NULL,
    discount_amount DECIMAL(10,2) NOT NULL,
    application_type application_type DEFAULT 'all',
    selected_services JSONB,
    doesnt_expire BOOLEAN DEFAULT false,
    expiration_date DATE,
    restrict_before_expiration BOOLEAN DEFAULT false,
    limit_total_uses BOOLEAN DEFAULT false,
    total_uses_limit INTEGER,
    current_uses INTEGER DEFAULT 0,
    can_combine_with_recurring BOOLEAN DEFAULT false,
    recurring_application_type recurring_application_type DEFAULT 'all',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Requests table
CREATE TABLE requests (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
    customer_name VARCHAR(255),
    customer_email VARCHAR(255),
    service_id INTEGER REFERENCES services(id) ON DELETE SET NULL,
    type request_type NOT NULL,
    status request_status DEFAULT 'pending',
    scheduled_date DATE,
    scheduled_time TIME,
    estimated_duration VARCHAR(50),
    estimated_price DECIMAL(10,2),
    notes TEXT,
    rejection_reason TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ===== MISSING TABLES FROM service_flow.sql =====

-- Coupon Usage table
CREATE TABLE coupon_usage (
    id SERIAL PRIMARY KEY,
    coupon_id INTEGER REFERENCES coupons(id) ON DELETE CASCADE,
    customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
    job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
    invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
    used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    discount_amount DECIMAL(10,2) NOT NULL
);

-- Customer Notifications table
CREATE TABLE customer_notifications (
    id SERIAL PRIMARY KEY,
    customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
    job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
    type notification_type NOT NULL,
    title VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    status notification_status DEFAULT 'pending',
    sent_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Customer Notification Preferences table
CREATE TABLE customer_notification_preferences (
    id SERIAL PRIMARY KEY,
    customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
    email_notifications BOOLEAN DEFAULT false,
    sms_notifications BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(customer_id)
);

-- Custom Payment Methods table
CREATE TABLE custom_payment_methods (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Job Answers table
CREATE TABLE job_answers (
    id SERIAL PRIMARY KEY,
    job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
    question_id VARCHAR(255) NOT NULL,
    question_text TEXT NOT NULL,
    question_type VARCHAR(50) NOT NULL,
    answer TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Job Team Assignments table
CREATE TABLE job_team_assignments (
    id SERIAL PRIMARY KEY,
    job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
    team_member_id INTEGER REFERENCES team_members(id) ON DELETE CASCADE,
    is_primary BOOLEAN DEFAULT false,
    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- Job Templates table
CREATE TABLE job_templates (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    service_id INTEGER REFERENCES services(id) ON DELETE CASCADE,
    estimated_duration INTEGER,
    estimated_price DECIMAL(10,2),
    default_notes TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Notification Templates table
CREATE TABLE notification_templates (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    type notification_type NOT NULL,
    subject VARCHAR(255),
    message TEXT NOT NULL,
    variables JSONB,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Service Availability table
CREATE TABLE service_availability (
    id SERIAL PRIMARY KEY,
    service_id INTEGER REFERENCES services(id) ON DELETE CASCADE,
    day_of_week INTEGER NOT NULL CHECK (day_of_week >= 0 AND day_of_week <= 6),
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    is_available BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(service_id, day_of_week, start_time)
);

-- Service Scheduling Rules table
CREATE TABLE service_scheduling_rules (
    id SERIAL PRIMARY KEY,
    service_id INTEGER REFERENCES services(id) ON DELETE CASCADE,
    rule_type VARCHAR(50) NOT NULL,
    rule_value JSONB NOT NULL,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Service Timeslot Templates table
CREATE TABLE service_timeslot_templates (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    time_slots JSONB NOT NULL,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Team Member Job Assignments table (duplicate of job_team_assignments - keeping for compatibility)
CREATE TABLE team_member_job_assignments (
    id SERIAL PRIMARY KEY,
    job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
    team_member_id INTEGER REFERENCES team_members(id) ON DELETE CASCADE,
    is_primary BOOLEAN DEFAULT false,
    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- Team Member Notifications table
CREATE TABLE team_member_notifications (
    id SERIAL PRIMARY KEY,
    team_member_id INTEGER REFERENCES team_members(id) ON DELETE CASCADE,
    type notification_type NOT NULL,
    title VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    status notification_status DEFAULT 'pending',
    sent_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Team Member Sessions table
CREATE TABLE team_member_sessions (
    id SERIAL PRIMARY KEY,
    team_member_id INTEGER REFERENCES team_members(id) ON DELETE CASCADE,
    session_token VARCHAR(255) UNIQUE NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Territory Pricing table
CREATE TABLE territory_pricing (
    id SERIAL PRIMARY KEY,
    territory_id INTEGER REFERENCES territories(id) ON DELETE CASCADE,
    service_id INTEGER REFERENCES services(id) ON DELETE CASCADE,
    base_price DECIMAL(10,2) NOT NULL,
    multiplier DECIMAL(3,2) DEFAULT 1.00,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(territory_id, service_id)
);

-- User Availability table
CREATE TABLE user_availability (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    day_of_week INTEGER NOT NULL CHECK (day_of_week >= 0 AND day_of_week <= 6),
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    is_available BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, day_of_week, start_time)
);

-- User Billing table
CREATE TABLE user_billing (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    stripe_customer_id VARCHAR(255),
    stripe_subscription_id VARCHAR(255),
    plan_type VARCHAR(50),
    billing_cycle VARCHAR(20),
    next_billing_date DATE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id)
);

-- User Branding table
CREATE TABLE user_branding (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    logo_url VARCHAR(500),
    primary_color VARCHAR(7) DEFAULT '#3B82F6',
    secondary_color VARCHAR(7),
    font_family VARCHAR(100),
    custom_css TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id)
);

-- User Notification Settings table
CREATE TABLE user_notification_settings (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    email_notifications BOOLEAN DEFAULT true,
    sms_notifications BOOLEAN DEFAULT false,
    push_notifications BOOLEAN DEFAULT true,
    notification_types JSONB,
    quiet_hours_start TIME,
    quiet_hours_end TIME,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id)
);

-- User Payment Settings table
CREATE TABLE user_payment_settings (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    stripe_account_id VARCHAR(255),
    stripe_publishable_key VARCHAR(255),
    stripe_secret_key VARCHAR(255),
    payment_methods JSONB,
    auto_invoice BOOLEAN DEFAULT true,
    invoice_reminders BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id)
);

-- User Service Areas table
CREATE TABLE user_service_areas (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    zip_codes JSONB,
    radius_miles DECIMAL(5,2) DEFAULT 25.00,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for better performance
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_business_slug ON users(business_slug);
CREATE INDEX idx_customers_user_id ON customers(user_id);
CREATE INDEX idx_customers_status ON customers(status);
CREATE INDEX idx_services_user_id ON services(user_id);
CREATE INDEX idx_services_is_active ON services(is_active);
CREATE INDEX idx_jobs_user_id ON jobs(user_id);
CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_scheduled_date ON jobs(scheduled_date);
CREATE INDEX idx_jobs_customer_id ON jobs(customer_id);
CREATE INDEX idx_invoices_user_id ON invoices(user_id);
CREATE INDEX idx_invoices_customer_id ON invoices(customer_id);
CREATE INDEX idx_team_members_user_id ON team_members(user_id);
CREATE INDEX idx_team_members_email ON team_members(email);
CREATE INDEX idx_territories_user_id ON territories(user_id);
CREATE INDEX idx_coupons_user_id ON coupons(user_id);
CREATE INDEX idx_coupons_code ON coupons(code);
CREATE INDEX idx_requests_user_id ON requests(user_id);
CREATE INDEX idx_requests_status ON requests(status);

-- Additional indexes for new tables
CREATE INDEX idx_coupon_usage_coupon_id ON coupon_usage(coupon_id);
CREATE INDEX idx_coupon_usage_customer_id ON coupon_usage(customer_id);
CREATE INDEX idx_customer_notifications_customer_id ON customer_notifications(customer_id);
CREATE INDEX idx_customer_notifications_status ON customer_notifications(status);
CREATE INDEX idx_job_answers_job_id ON job_answers(job_id);
CREATE INDEX idx_job_team_assignments_job_id ON job_team_assignments(job_id);
CREATE INDEX idx_job_team_assignments_team_member_id ON job_team_assignments(team_member_id);
CREATE INDEX idx_service_availability_service_id ON service_availability(service_id);
CREATE INDEX idx_team_member_sessions_team_member_id ON team_member_sessions(team_member_id);
CREATE INDEX idx_team_member_sessions_session_token ON team_member_sessions(session_token);
CREATE INDEX idx_user_availability_user_id ON user_availability(user_id);

-- Create updated_at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply updated_at triggers to all tables
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_service_flow_updated_at BEFORE UPDATE ON service_flow FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_customers_updated_at BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_services_updated_at BEFORE UPDATE ON services FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_jobs_updated_at BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_invoices_updated_at BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_estimates_updated_at BEFORE UPDATE ON estimates FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_coupons_updated_at BEFORE UPDATE ON coupons FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_requests_updated_at BEFORE UPDATE ON requests FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_team_members_updated_at BEFORE UPDATE ON team_members FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_territories_updated_at BEFORE UPDATE ON territories FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_service_categories_updated_at BEFORE UPDATE ON service_categories FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Triggers for new tables
CREATE TRIGGER update_customer_notification_preferences_updated_at BEFORE UPDATE ON customer_notification_preferences FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_custom_payment_methods_updated_at BEFORE UPDATE ON custom_payment_methods FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_job_answers_updated_at BEFORE UPDATE ON job_answers FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_job_templates_updated_at BEFORE UPDATE ON job_templates FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_notification_templates_updated_at BEFORE UPDATE ON notification_templates FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_service_availability_updated_at BEFORE UPDATE ON service_availability FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_service_scheduling_rules_updated_at BEFORE UPDATE ON service_scheduling_rules FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_service_timeslot_templates_updated_at BEFORE UPDATE ON service_timeslot_templates FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_territory_pricing_updated_at BEFORE UPDATE ON territory_pricing FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_user_availability_updated_at BEFORE UPDATE ON user_availability FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_user_billing_updated_at BEFORE UPDATE ON user_billing FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_user_branding_updated_at BEFORE UPDATE ON user_branding FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_user_notification_settings_updated_at BEFORE UPDATE ON user_notification_settings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_user_payment_settings_updated_at BEFORE UPDATE ON user_payment_settings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_user_service_areas_updated_at BEFORE UPDATE ON user_service_areas FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Enable Row Level Security (RLS)
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_flow ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE services ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE estimates ENABLE ROW LEVEL SECURITY;
ALTER TABLE coupons ENABLE ROW LEVEL SECURITY;
ALTER TABLE requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE territories ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_categories ENABLE ROW LEVEL SECURITY;

-- Enable RLS for new tables
ALTER TABLE coupon_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_payment_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_team_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_availability ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_scheduling_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_timeslot_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_member_job_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_member_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_member_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE territory_pricing ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_availability ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_billing ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_branding ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_notification_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_payment_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_service_areas ENABLE ROW LEVEL SECURITY;

-- Create RLS policies (basic example - you'll need to customize these)
-- Note: For now, we'll disable RLS policies since your app uses service role key
-- You can enable these later when implementing proper user authentication

-- For users table, we'll use a simple policy
CREATE POLICY "Users can view own data" ON users FOR SELECT USING (true);
CREATE POLICY "Users can update own data" ON users FOR UPDATE USING (true);

-- For all other tables, we'll use permissive policies for now
-- You can customize these later based on your authentication needs
CREATE POLICY "Allow all operations on service_flow" ON service_flow FOR ALL USING (true);
CREATE POLICY "Allow all operations on customers" ON customers FOR ALL USING (true);
CREATE POLICY "Allow all operations on services" ON services FOR ALL USING (true);
CREATE POLICY "Allow all operations on jobs" ON jobs FOR ALL USING (true);
CREATE POLICY "Allow all operations on invoices" ON invoices FOR ALL USING (true);
CREATE POLICY "Allow all operations on estimates" ON estimates FOR ALL USING (true);
CREATE POLICY "Allow all operations on coupons" ON coupons FOR ALL USING (true);
CREATE POLICY "Allow all operations on requests" ON requests FOR ALL USING (true);
CREATE POLICY "Allow all operations on team_members" ON team_members FOR ALL USING (true);
CREATE POLICY "Allow all operations on territories" ON territories FOR ALL USING (true);
CREATE POLICY "Allow all operations on service_categories" ON service_categories FOR ALL USING (true);

-- RLS policies for new tables
CREATE POLICY "Allow all operations on coupon_usage" ON coupon_usage FOR ALL USING (true);
CREATE POLICY "Allow all operations on customer_notifications" ON customer_notifications FOR ALL USING (true);
CREATE POLICY "Allow all operations on customer_notification_preferences" ON customer_notification_preferences FOR ALL USING (true);
CREATE POLICY "Allow all operations on custom_payment_methods" ON custom_payment_methods FOR ALL USING (true);
CREATE POLICY "Allow all operations on job_answers" ON job_answers FOR ALL USING (true);
CREATE POLICY "Allow all operations on job_team_assignments" ON job_team_assignments FOR ALL USING (true);
CREATE POLICY "Allow all operations on job_templates" ON job_templates FOR ALL USING (true);
CREATE POLICY "Allow all operations on notification_templates" ON notification_templates FOR ALL USING (true);
CREATE POLICY "Allow all operations on service_availability" ON service_availability FOR ALL USING (true);
CREATE POLICY "Allow all operations on service_scheduling_rules" ON service_scheduling_rules FOR ALL USING (true);
CREATE POLICY "Allow all operations on service_timeslot_templates" ON service_timeslot_templates FOR ALL USING (true);
CREATE POLICY "Allow all operations on team_member_job_assignments" ON team_member_job_assignments FOR ALL USING (true);
CREATE POLICY "Allow all operations on team_member_notifications" ON team_member_notifications FOR ALL USING (true);
CREATE POLICY "Allow all operations on team_member_sessions" ON team_member_sessions FOR ALL USING (true);
CREATE POLICY "Allow all operations on territory_pricing" ON territory_pricing FOR ALL USING (true);
CREATE POLICY "Allow all operations on user_availability" ON user_availability FOR ALL USING (true);
CREATE POLICY "Allow all operations on user_billing" ON user_billing FOR ALL USING (true);
CREATE POLICY "Allow all operations on user_branding" ON user_branding FOR ALL USING (true);
CREATE POLICY "Allow all operations on user_notification_settings" ON user_notification_settings FOR ALL USING (true);
CREATE POLICY "Allow all operations on user_payment_settings" ON user_payment_settings FOR ALL USING (true);
CREATE POLICY "Allow all operations on user_service_areas" ON user_service_areas FOR ALL USING (true);

