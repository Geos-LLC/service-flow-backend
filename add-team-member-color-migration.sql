-- Add color field to team_members table
-- This migration adds a color field to store team member colors for calendar display

-- Add color column to team_members table
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS color VARCHAR(7) DEFAULT '#2563EB';

-- Update existing team members with default colors if they don't have one
UPDATE team_members 
SET color = CASE 
  WHEN id % 7 = 1 THEN '#2563EB'  -- Blue
  WHEN id % 7 = 2 THEN '#DC2626'  -- Red
  WHEN id % 7 = 3 THEN '#059669'  -- Green
  WHEN id % 7 = 4 THEN '#D97706'  -- Orange
  WHEN id % 7 = 5 THEN '#7C3AED'  -- Purple
  WHEN id % 7 = 6 THEN '#DB2777'  -- Pink
  ELSE '#6B7280'  -- Gray
END
WHERE color IS NULL OR color = '#2563EB';

-- Add comment to the column
COMMENT ON COLUMN team_members.color IS 'Hex color code for team member display in calendar and UI';
