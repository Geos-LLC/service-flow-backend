const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

// Initialize Supabase client for storage
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('❌ Supabase Storage: Missing environment variables');
  console.error('Required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

// Storage bucket names
const BUCKETS = {
  SERVICE_IMAGES: 'service-images',
  MODIFIER_IMAGES: 'modifier-images',
  INTAKE_IMAGES: 'intake-images',
  PROFILE_PICTURES: 'profile-pictures',
  LOGOS: 'logos',
  HERO_IMAGES: 'hero-images',
  FAVICONS: 'favicons'
};

// Ensure all buckets exist
const ensureBuckets = async () => {
  try {
    for (const [bucketName, bucketId] of Object.entries(BUCKETS)) {
      const { data: buckets, error } = await supabase.storage.listBuckets();
      
      if (error) {
        console.error(`❌ Error listing buckets:`, error);
        continue;
      }
      
      const bucketExists = buckets.some(bucket => bucket.name === bucketId);
      
      if (!bucketExists) {
        console.log(`🔄 Creating bucket: ${bucketId}`);
        const { error: createError } = await supabase.storage.createBucket(bucketId, {
          public: true, // Make buckets public for easy access
          allowedMimeTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
          fileSizeLimit: 10 * 1024 * 1024 // 10MB limit
        });
        
        if (createError) {
          console.error(`❌ Error creating bucket ${bucketId}:`, createError);
        } else {
          console.log(`✅ Created bucket: ${bucketId}`);
        }
      } else {
        console.log(`✅ Bucket exists: ${bucketId}`);
      }
    }
  } catch (error) {
    console.error('❌ Error ensuring buckets:', error);
  }
};

// Upload file to Supabase Storage
const uploadToStorage = async (file, bucketName, folder = '') => {
  try {
    if (!file) {
      throw new Error('No file provided');
    }

    // Generate unique filename
    const timestamp = Date.now();
    const randomString = Math.random().toString(36).substring(2, 15);
    const extension = path.extname(file.originalname);
    const filename = `${folder ? folder + '/' : ''}${timestamp}-${randomString}${extension}`;

    // Read file buffer
    const fileBuffer = fs.readFileSync(file.path);
    
    // Upload to Supabase Storage
    const { data, error } = await supabase.storage
      .from(bucketName)
      .upload(filename, fileBuffer, {
        contentType: file.mimetype,
        upsert: false
      });

    if (error) {
      console.error(`❌ Upload error for ${bucketName}/${filename}:`, error);
      throw error;
    }

    // Get public URL
    const { data: urlData } = supabase.storage
      .from(bucketName)
      .getPublicUrl(filename);

    console.log(`✅ Uploaded to ${bucketName}/${filename}`);
    
    // Clean up local file
    try {
      fs.unlinkSync(file.path);
    } catch (cleanupError) {
      console.warn('⚠️ Could not clean up local file:', cleanupError.message);
    }

    return {
      success: true,
      imageUrl: urlData.publicUrl,
      filename: filename,
      message: `Image uploaded successfully to ${bucketName}`
    };

  } catch (error) {
    console.error(`❌ Error uploading to ${bucketName}:`, error);
    throw error;
  }
};

// Delete file from Supabase Storage
const deleteFromStorage = async (bucketName, filename) => {
  try {
    const { error } = await supabase.storage
      .from(bucketName)
      .remove([filename]);

    if (error) {
      console.error(`❌ Delete error for ${bucketName}/${filename}:`, error);
      throw error;
    }

    console.log(`✅ Deleted ${bucketName}/${filename}`);
    return { success: true };

  } catch (error) {
    console.error(`❌ Error deleting from ${bucketName}:`, error);
    throw error;
  }
};

// Get file URL from Supabase Storage
const getFileUrl = (bucketName, filename) => {
  const { data } = supabase.storage
    .from(bucketName)
    .getPublicUrl(filename);
  
  return data.publicUrl;
};

module.exports = {
  BUCKETS,
  ensureBuckets,
  uploadToStorage,
  deleteFromStorage,
  getFileUrl
};
